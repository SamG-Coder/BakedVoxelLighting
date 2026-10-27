import assert from "node:assert/strict";
import { grassHabitat } from "../src/habitat.js";
import { GRASS_TYPES, GRASS_MIXES } from "../src/plant-catalog.js";
import { grassLand, generateGrassBatches } from "../src/grass-data.js";
import {
  copyTerrainRegion,
  sampleTerrainRegion,
} from "../src/terrain-snapshot.js";
import { deadwoodSegments } from "../src/deadwood-data.js";
import { buildVoxelDetails } from "../src/voxel-core.js";
const meadow = {
  height: 0,
  traffic: 0,
  slope: 0,
  root: 0,
  riverDistance: 100,
  moisture: 0.55,
  forest: 0.9,
  wetness: 0,
  canopy: 0,
};
const forest = { ...meadow, canopy: 0.95 };
for (const mix of GRASS_MIXES) {
  assert.equal(
    mix.length,
    GRASS_TYPES.length,
    "every source participates in each habitat palette",
  );
  assert.ok(mix.every((weight) => Number.isFinite(weight) && weight >= 0));
  assert.ok(Math.abs(mix.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6);
}
for (let z = -100; z <= 100; z += 11)
  for (let x = -100; x <= 100; x += 13) {
    const a = grassHabitat(x, z, meadow),
      b = grassHabitat(x, z, forest);
    assert.ok(Math.abs(a.mixes.reduce((s, v) => s + v, 0) - 1) < 1e-6);
    assert.ok(a.mixes.every((v) => v >= 0 && v <= 1));
    assert.ok(
      Math.abs(a.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6,
    );
    assert.ok(
      b.density < a.density * 0.15,
      "closed canopy suppresses meadow cover",
    );
    assert.ok(b.height < a.height);
    const adjacent = grassHabitat(x + 1e-4, z, meadow);
    assert.ok(
      a.colour.every((v, i) => Math.abs(v - adjacent.colour[i]) < 1e-4),
    );
  }
const wet = grassHabitat(19, 22, { ...meadow, moisture: 0.9 });
const dry = grassHabitat(19, 22, { ...meadow, moisture: 0.05 });
assert.ok(dry.colour[0] / dry.colour[1] > wet.colour[0] / wet.colour[1]);
const job = { x: 0, z: 0, seed: 42, land: grassLand(0, 0, () => meadow) };
const near = generateGrassBatches({ ...job, level: 0 });
for (const name of ["grass-upright", "grass-fine"]) {
  const type = GRASS_TYPES.findIndex((plant) => plant.name === name);
  assert.ok(
    type >= 0 && near[0].types.includes(type),
    `${name} reaches near generation`,
  );
}
const shade = generateGrassBatches({
  ...job,
  land: grassLand(0, 0, () => forest),
  level: 0,
});
assert.ok(shade[0].matrices.length < near[0].matrices.length * 0.2);
assert.equal(generateGrassBatches({ ...job, level: 2 }).length, 4);
assert.deepEqual(generateGrassBatches({ ...job, level: 0 }), near);
const pixels = new Float32Array(5 * 5 * 4),
  roots = new Float32Array(25),
  canopy = Float32Array.from({ length: 25 }, (_, i) => i / 25);
const snapshot = copyTerrainRegion(pixels, roots, 5, 8, -4, -4, 4, 4, canopy);
assert.ok(
  Math.abs(sampleTerrainRegion(snapshot, 0, 0).canopy - canopy[12]) < 1e-6,
);
const log = {
  x: 0,
  z: 0,
  rotation: 0.4,
  scale: 1,
  length: 8,
  radius: 0.3,
  seed: 9,
  decay: 0.5,
};
const segments = deadwoodSegments(log, () => meadow);
assert.equal(segments.length, 6);
assert.equal(segments.filter((s) => s.trunk).length, 2);
for (const s of segments)
  assert.ok([...s.a, ...s.b, s.r].every(Number.isFinite));
assert.equal(
  deadwoodSegments(log, () => ({ ...meadow, traffic: 1 })).length,
  0,
);
assert.equal(
  deadwoodSegments(log, () => ({ ...meadow, riverDistance: 2 })).length,
  0,
);
console.log(
  "Habitat continuity, canopy suppression, worker parity, colour gradients and deadwood placement passed.",
);
const emptyIndex = { query: () => [] };
const voxelWorld = {
  areaIndexes: {
    trees: emptyIndex,
    grass: emptyIndex,
    objects: { query: () => segments.map((s) => ({ ...s, wood: true })) },
  },
};
const voxel = buildVoxelDetails(
  voxelWorld,
  32,
  { x: -2, y: -2, z: -2 },
  { x: 14, y: 8, z: 14 },
  new Map(),
);
assert.equal(voxel.counts.deadwood, segments.length);
assert.ok(voxel.kinds.some((v) => (v & 8) !== 0));
assert.ok(voxel.data.some((v, i) => i % 4 === 3 && v > 0));
console.log(
  "Fallen wood contributes occupied voxels without visible render meshes.",
);
