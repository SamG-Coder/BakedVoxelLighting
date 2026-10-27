import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { makeWorld } from "../src/world-data.js";
import {
  TERRAIN_SIZE,
  TERRAIN_GRID,
  terrainSample,
} from "../src/terrain-field.js";
import { riverSegments } from "../src/watershed.js";
const w = makeWorld();
assert.equal(TERRAIN_SIZE, 4000);
assert.equal(TERRAIN_GRID, 2001);
assert.ok(w.trees.length > 30000);
const counts = w.clusters.map((c) => c.trees.length);
assert.ok(Math.min(...counts) < 5);
assert.ok(Math.max(...counts) > 90);
for (const t of w.trees) {
  assert.ok(Math.abs(t.x) < 2000 && Math.abs(t.z) < 2000);
  assert.ok(terrainSample(t.x, t.z).riverDistance >= 13);
}
let submerged = 0;
for (const s of riverSegments) {
  const x = (s.ax + s.bx) / 2,
    z = (s.az + s.bz) / 2;
  if (Math.abs(x) > 1980 || Math.abs(z) > 1980) continue;
  assert.ok(terrainSample(x, z).height < (s.ay + s.by) / 2);
  submerged++;
}
assert.ok(submerged > 100);
const dense = w.trees.filter(
  (t) => terrainSample(t.x, t.z).forest > 0.55,
).length;
const report = {
  areaKm2: 16,
  width: 4000,
  length: 4000,
  grid: TERRAIN_GRID,
  trees: w.trees.length,
  batches: w.clusters.length,
  minTreesPerBatch: Math.min(...counts),
  maxTreesPerBatch: Math.max(...counts),
  treesInForestCore: dense,
  riverSamplesBelowWater: submerged,
};
await writeFile(
  "evidence/landscape-data.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
