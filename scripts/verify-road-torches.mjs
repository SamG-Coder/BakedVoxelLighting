import assert from "node:assert/strict";
import { roadTorchLayout, treeClearance } from "../src/road-torch-layout.js";
import {
  routes,
  terrainHeight,
  terrainSample,
  inRoadVerge,
} from "../src/terrain-field.js";
import { seededRandom } from "../src/habitat.js";
import { makeWorld } from "../src/world-data.js";
const a = roadTorchLayout(
  [
    [
      [0, 0],
      [0, 200],
    ],
  ],
  () => 12,
  () => 0.5,
);
const b = roadTorchLayout(
  [
    [
      [0, 0],
      [0, 30],
      [0, 45],
      [0, 200],
    ],
  ],
  () => 12,
  () => 0.5,
);
assert.deepEqual(a, b);
assert.ok(a.every((p) => p.x < 0 && p.y === 12 && p.head === 4));
for (let i = 1; i < a.length; i++)
  assert.equal(a[i].distance - a[i - 1].distance, 18);
const world = makeWorld();
assert.ok(world.trees.every((t) => !inRoadVerge(t.x, t.z)));
assert.equal(
  world.clusters.reduce((n, c) => n + c.trees.length, 0),
  world.trees.length,
);
const clear = treeClearance(world.trees);
const options = { traffic: (x, z) => terrainSample(x, z).traffic, clear };
const records = roadTorchLayout(
  routes,
  terrainHeight,
  seededRandom(731903),
  options,
);
assert.ok(records.length > 200);
for (const p of records) {
  assert.ok(clear(p.x, p.z));
  assert.ok(terrainSample(p.x, p.z).traffic < 0.25);
  assert.ok(p.head + 0.8 >= 4.6 && p.head + 0.8 <= 5);
  assert.ok(Math.abs(p.y - terrainHeight(p.x, p.z)) < 1e-6);
  assert.ok(
    Math.abs((p.distance - 8) / 18 - Math.round((p.distance - 8) / 18)) < 1e-8,
  );
}
console.log(
  JSON.stringify(
    {
      passed: true,
      torches: records.length,
      spacing: 18,
      height: [4.6, 5],
      maxVerge: Math.max(...records.map((p) => p.verge)),
      checks: [
        "route tessellation invariance",
        "continuous side",
        "18m arc spacing",
        "terrain edge mask",
        "tree clearance",
        "ground contact",
        "height",
      ],
    },
    null,
    2,
  ),
);

// Exercise production constructor wiring too: malformed arguments can otherwise
// pass the pure layout checks but create NaN instance transforms in the scene.
const T = await import("three/webgpu");
const { createRoadTorches } = await import("../src/road-torches.js");
const scene = new T.Scene();
const system = createRoadTorches(
  scene,
  {
    sample: () => {
      throw new Error("Shader not compiled in layout check");
    },
  },
  new T.MeshStandardNodeMaterial(),
  new T.MeshBasicNodeMaterial(),
  new T.CylinderGeometry(0.067, 0.052, 0.23, 24, 32),
  makeWorld().trees,
);
assert.equal(system.stats.total, records.length);
for (const o of scene.children)
  if (o.isInstancedMesh)
    assert.ok(o.instanceMatrix.array.every(Number.isFinite));
const camera = new T.PerspectiveCamera();
camera.position.set(records[0].x, records[0].y + 2, records[0].z);
system.update(camera, 1, 120, 0.6);
assert.ok(system.stats.lights > 0 && system.stats.flames > 0);
console.log(
  "Production constructor: finite instances and active light/fire pools passed",
);
