import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { Vector4 } from "three/webgpu";
import { needsMotionVectors } from "../src/motion-pass.js";

// Execute the actual pure helper without importing Vite's shader ?raw modules.
const source = await readFile(
  new URL("../src/world-light.js", import.meta.url),
  "utf8",
);
const helper = source.slice(
  source.indexOf("export function horizonSunParameters"),
  source.indexOf("function runtimeField"),
);
const parameters = vm.runInNewContext(
  `(${helper.replace("export ", "").trim()})`,
);
const out = new Vector4();
for (let i = 0; i < 10000; i++) {
  const azimuth = (i * Math.PI * 2) / 9999 - Math.PI;
  const elevation = (Math.sin(i * 0.071) * Math.PI) / 2;
  const sun = {
    x: Math.sin(azimuth) * Math.cos(elevation),
    y: Math.sin(elevation),
    z: Math.cos(azimuth) * Math.cos(elevation),
  };
  assert.equal(parameters(sun, out), out, "reuse the uniform value");
  const index = (Math.atan2(sun.x, sun.z) / (Math.PI / 4) + 8) % 8;
  assert.equal(out.x, Math.floor(index) + 1);
  assert.equal(out.y, ((Math.floor(index) + 1) % 8) + 1);
  assert.equal(out.z, index - Math.floor(index));
  assert.ok(
    Math.abs(
      out.w - sun.y / Math.max(Math.sqrt(sun.x ** 2 + sun.z ** 2), 0.001),
    ) < 1e-9,
  );
}
for (const outputs of [
  null,
  new Set(["output"]),
  new Set(["output", "normal"]),
]) {
  assert.equal(
    needsMotionVectors({ renderer: { getMRT: () => outputs } }),
    false,
  );
}
assert.equal(
  needsMotionVectors({
    renderer: { getMRT: () => new Set(["output", "velocity"]) },
  }),
  true,
);
console.log(
  "Render regression: shared sun parameters preserve horizon lookup and reuse storage; only velocity passes request previous positions.",
);
