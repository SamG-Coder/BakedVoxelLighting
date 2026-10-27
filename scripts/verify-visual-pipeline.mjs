import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { installCompilationContext } from "../src/renderer-jobs.js";

// A shader build can resume after the renderer has returned to the canvas.
let target = { name: "scene" },
  mrt = { name: "motion" },
  previousCalls = 0;
const renderer = {
  debug: { onNodeBuilderCreated: () => previousCalls++ },
  getRenderTarget: () => target,
  getMRT: () => mrt,
  get currentSamples() {
    return 4;
  },
};
installCompilationContext(renderer);
const context = { renderTarget: target, mrt, sampleCount: 0 };
const builder = { renderer };
renderer.debug.onNodeBuilderCreated(builder, { context });
target = null;
mrt = null;
await Promise.resolve();
assert.equal(builder.renderer.getRenderTarget(), context.renderTarget);
assert.equal(builder.renderer.getMRT(), context.mrt);
assert.equal(builder.renderer.currentSamples, 0);
assert.equal(renderer.currentSamples, 4);
assert.equal(previousCalls, 1);
const computeBuilder = { renderer };
renderer.debug.onNodeBuilderCreated(computeBuilder, {});
assert.equal(computeBuilder.renderer, renderer);

// Cutout coverage must not overwrite the independently baked transmission.
let result;
const self = { postMessage: (value) => (result = value) };
vm.runInNewContext(
  await readFile(new URL("../src/atlas-worker.js", import.meta.url), "utf8"),
  { self },
);
const data = new Uint8Array(4 * 4 * 4),
  normals = new Uint8Array(data.length);
for (let i = 0; i < data.length; i += 4) {
  data.set([45, 100, 20, i % 8 ? 0 : 255], i);
  normals.set([128, 255, 128, i % 8 ? 240 : 72], i);
}
self.onmessage({
  data: {
    id: 1,
    record: {
      data,
      normals,
      w: 4,
      h: 4,
      views: 1,
      cutoff: 82,
      materialPayload: true,
    },
  },
});
for (const level of result.levels.slice(1)) {
  for (let i = 0; i < level.data.length; i += 4) {
    assert.equal(
      level.normals[i + 3],
      72,
      "transparent pixels do not contaminate material payload",
    );
    assert.equal(level.data[i], 45, "mips retain covered albedo");
    assert.equal(level.data[i + 1], 100);
  }
}
self.onmessage({
  data: { id: 2, sources: [{ data, normals, w: 4, h: 4 }], tileSize: 4 },
});
assert.equal(
  result.levels.at(-1).normals[3],
  72,
  "packing preserves material response through the final mip",
);
console.log(
  "Visual pipeline: async render context and coverage-weighted material mip regressions passed.",
);
