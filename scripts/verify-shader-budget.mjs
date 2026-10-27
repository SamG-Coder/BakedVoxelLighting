import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { patchAsyncBuilder } from "./patch-three-allocations.mjs";

const source = (
  await readFile(
    new URL(
      "../node_modules/three/src/nodes/core/NodeBuilder.js",
      import.meta.url,
    ),
    "utf8",
  )
).replaceAll("\r\n", "\n");
function fixture(source, hook) {
  const start = source.indexOf("\tasync buildAsync() {"),
    end = source.indexOf("\n\t}\n", start) + 4;
  let clock = 0;
  const trace = [],
    charges = [];
  const Type = new Function(
    "defaultBuildStages",
    "shaderStages",
    "yieldToMain",
    "performance",
    `return class { ${source.slice(start, end)} }`,
  )(
    ["setup", "analyze", "generate"],
    ["vertex", "fragment", "compute"],
    async () => {
      clock += 100;
    },
    { now: () => clock },
  );
  const b = new Type();
  b.renderer = {
    nodeBuildBudgetYield: hook
      ? async (ms) => {
          charges.push(ms);
          clock += 100;
        }
      : undefined,
  };
  b.context = {};
  b.setBuildStage = (s) => {
    b.stage = s;
    trace.push(["stage", s]);
  };
  b.setShaderStage = (s) => {
    b.shader = s;
    trace.push(["shader", s]);
  };
  const work = () => {
    clock += 2;
    trace.push(["work", b.stage, b.shader]);
  };
  b.flowNodes = Object.fromEntries(
    ["vertex", "fragment", "compute"].map((s) => [s, [{ build: work }]]),
  );
  b.flowNode = work;
  b.prebuild = () => {
    clock++;
    trace.push("prebuild");
  };
  b.buildCode = () => {
    clock++;
    trace.push("code");
  };
  b.buildUpdateNodes = () => {
    clock++;
    trace.push("updates");
  };
  return { b, trace, charges };
}
const original = fixture(source, false),
  revised = fixture(patchAsyncBuilder(source), true),
  noHook = fixture(patchAsyncBuilder(source), false);
for (const f of [original, revised, noHook])
  assert.equal(await f.b.buildAsync(), f.b);
assert.deepEqual(revised.trace, original.trace);
assert.deepEqual(noHook.trace, original.trace);
assert.deepEqual(
  revised.charges,
  [3, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  "CPU slices exclude time spent awaiting the host",
);
let release;
const gated = fixture(patchAsyncBuilder(source), false);
gated.b.renderer.nodeBuildBudgetYield = () =>
  new Promise((resolve) => {
    release = resolve;
  });
let finished = false;
const pending = gated.b.buildAsync().then(() => {
  finished = true;
});
assert.equal(gated.trace.filter((x) => x[0] === "work").length, 1);
assert.equal(finished, false);
// The method captures one hook for its entire build. Release all ten CPU slices.
for (let i = 0; i < 10; i++) {
  release();
  await Promise.resolve();
}
await pending;
assert.equal(finished, true);
console.log(
  "Async builder: identical stage order, CPU-only accounting, optional hook and awaited backpressure passed.",
);
