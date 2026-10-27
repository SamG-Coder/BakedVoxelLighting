import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  riverSegments,
  watershedStats,
  sampleHydrology,
  regionalHeight,
} from "../src/watershed.js";
import { terrainHeight, terrainSample } from "../src/terrain-field.js";
import { makeWorld } from "../src/world-data.js";
import { buildRiverData } from "../src/river-data.js";
const nodes = new Map(riverSegments.map((s) => [s.node, s]));
let junctions = 0,
  centreSamples = 0,
  minDepth = Infinity;
const incoming = new Map();
for (const s of riverSegments) {
  assert.ok(s.ay > s.by, "every water reach must descend");
  assert.ok(s.wb >= s.wa, "accumulating reaches must not narrow at junctions");
  incoming.set(s.receiver, (incoming.get(s.receiver) || 0) + 1);
  const seen = new Set();
  let cursor = s;
  while (cursor) {
    assert.ok(!seen.has(cursor.node), "drainage must be acyclic");
    seen.add(cursor.node);
    cursor = nodes.get(cursor.receiver);
  }
  const x = (s.ax + s.bx) / 2,
    z = (s.az + s.bz) / 2;
  if (Math.abs(x) < 1980 && Math.abs(z) < 1980) {
    const depth = (s.ay + s.by) / 2 - terrainHeight(x, z);
    assert.ok(depth > 0.05, "channel bed must be below water");
    minDepth = Math.min(depth, minDepth);
    centreSamples++;
    const h = sampleHydrology(x, z, {});
    assert.ok(h.distance < 1e-6, "indexed lookup must find channel");
  }
}
for (const n of incoming.values()) if (n > 1) junctions++;
assert.ok(junctions > 5);
const data = buildRiverData(terrainHeight);
let flipped = 0,
  triangles = 0;
for (const chunk of data.chunks) {
  assert.ok(chunk.position.every(Number.isFinite));
  for (let k = 0; k < chunk.index.length; k += 3) {
    const a = chunk.index[k] * 3,
      b = chunk.index[k + 1] * 3,
      c = chunk.index[k + 2] * 3,
      p = chunk.position;
    const y =
      (p[b + 2] - p[a + 2]) * (p[c] - p[a]) -
      (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
    if (y <= 0) flipped++;
    triangles++;
  }
}
assert.equal(flipped, 0, "all river faces point upward");
const world = makeWorld(),
  hectares = new Uint16Array(1600);
for (const t of world.trees) {
  assert.ok(terrainSample(t.x, t.z).riverDistance >= 13);
  hectares[
    Math.floor((t.z + 2000) / 100) * 40 + Math.floor((t.x + 2000) / 100)
  ]++;
}
const grid = [];
for (let z = -2000; z <= 2000; z += 20)
  for (let x = -2000; x <= 2000; x += 20) {
    const s = terrainSample(x, z);
    assert.ok(
      Number.isFinite(s.riverDistance),
      "streamed habitat distances stay finite away from rivers",
    );
    grid.push([s.height, s.forest, s.moisture]);
  }
const report = {
  ...watershedStats,
  junctions,
  centreSamples,
  minDepth,
  waterPages: data.chunks.length,
  triangles,
  trees: world.trees.length,
  deadwood: world.deadwood.length,
  minTreesPerHectare: Math.min(...hectares),
  maxTreesPerHectare: Math.max(...hectares),
  meanTreesPerHectare: world.trees.length / 1600,
};
await writeFile(
  "evidence/watershed-report.json",
  JSON.stringify(report, null, 2),
);
await writeFile(
  "evidence/watershed-map.json",
  JSON.stringify({
    grid,
    rivers: riverSegments.map((s) => [s.ax, s.az, s.bx, s.bz]),
    trees: world.trees.filter((_, i) => i % 8 === 0).map((t) => [t.x, t.z]),
    hectares: [...hectares],
  }),
);
console.log(report);
