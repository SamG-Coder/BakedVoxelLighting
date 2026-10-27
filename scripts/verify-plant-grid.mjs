import assert from "node:assert/strict";
let result;
globalThis.self = {
  postMessage: (data) => {
    result = data;
  },
};
await import("../src/atlas-worker.js");
const sources = Array.from({ length: 10 }, (_, i) => ({
  w: 8,
  h: 8,
  data: Uint8Array.from(
    { length: 256 },
    (_, k) => [20 + i * 20, 50, 80, 255][k % 4],
  ),
  normals: Uint8Array.from(
    { length: 256 },
    (_, k) => [128, 128, 255, 255][k % 4],
  ),
}));
self.onmessage({ data: { id: 1, sources, tileSize: 8 } });
assert.equal(result.levels[0].width, 32);
assert.equal(result.levels[0].height, 24);
for (const l of result.levels) {
  const cell = l.width / 4;
  for (let f = 0; f < 10; f++) {
    const offset = (Math.floor(f / 4) * cell * l.width + (f % 4) * cell) * 4;
    assert.ok(
      Math.abs(l.data[offset] - (20 + f * 20)) <= 1,
      "species colours stay separate through every mip",
    );
    assert.ok(
      l.data[offset + 3] >= 87,
      "opaque source keeps coverage at the runtime alpha cutoff",
    );
  }
  assert.equal(
    l.data[(2 * cell * l.width + 2 * cell) * 4 + 3],
    0,
    "unused atlas slots stay transparent",
  );
}
console.log(
  "Plant grid atlas preserves resolution, per-species colours and alpha at every mip.",
);
