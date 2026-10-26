import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../src/atlas-worker.js", import.meta.url),
  "utf8",
);
function bake(payload) {
  let result;
  const self = {
    postMessage(value) {
      result = value.levels;
    },
  };
  vm.runInNewContext(source, { self, Uint8Array, Float32Array, Math });
  const w = 16,
    h = 16,
    data = new Uint8Array(w * h * 4),
    normals = new Uint8Array(data.length);
  for (let i = 0; i < w * h; i++) {
    data.set([60, 95, 20, i % 3 ? 255 : 0], i * 4);
    normals.set([128, 255, 128, 128], i * 4);
  }
  self.onmessage({
    data: {
      id: 1,
      record: { w, h, views: 1, data, normals, mossPayload: payload },
    },
  });
  return result;
}
const potential = bake(true),
  legacy = bake(false);
for (let lod = 0; lod < potential.length; lod++) {
  assert.deepEqual(
    Array.from(potential[lod].data),
    Array.from(legacy[lod].data),
    "moss payload must not change silhouette coverage",
  );
  for (let i = 3; i < potential[lod].normals.length; i += 4) {
    if (potential[lod].data[i])
      assert.equal(
        potential[lod].normals[i],
        128,
        "moss potential must not receive alpha-coverage amplification",
      );
  }
}
console.log(
  "Moss payload retained across mip levels without changing silhouette alpha",
);
