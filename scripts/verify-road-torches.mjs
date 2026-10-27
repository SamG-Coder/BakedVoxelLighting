import assert from "node:assert/strict";
import {
  roadTorchLayout,
  treeClearance,
  routeLandmarks,
} from "../src/road-torch-layout.js";
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
  { landmarks: [{ route: 0, distance: 100, kind: "junction" }] },
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
  { landmarks: [{ route: 0, distance: 100, kind: "junction" }] },
);
assert.deepEqual(a, b);
assert.ok(a.every((p) => p.x < 0 && p.y === 12 && p.head === 4));
assert.equal(a.length, 1);
assert.deepEqual(
  roadTorchLayout(
    [
      [
        [0, 0],
        [0, 200],
      ],
    ],
    () => 0,
    () => 0.5,
  ),
  [],
  "ordinary road stays unlit",
);
assert.deepEqual(
  roadTorchLayout(
    [],
    () => 0,
    () => 0.5,
  ),
  [],
);
const junctionRoutes = [
  [
    [0, 0],
    [0, 100],
    [0, 200],
  ],
  [
    [-30, 100],
    [0, 100],
    [30, 100],
  ],
];
const junctions = routeLandmarks(junctionRoutes);
assert.equal(junctions.length, 1, "shared-vertex crossing is one junction");
assert.equal(junctions[0].distance, 100);
assert.equal(
  routeLandmarks([
    [
      [0, 0],
      [0, 200],
    ],
    [
      [10, 20],
      [10, 150],
    ],
  ]).length,
  0,
  "nearby parallel paths are not junctions",
);
const switched = roadTorchLayout(
  junctionRoutes,
  () => 0,
  () => 0.5,
  { clear: (x) => x > 0 },
);
assert.equal(switched.length, 1);
assert.ok(switched[0].x > 0, "blocked verge falls back to opposite side");
const world = makeWorld();
assert.ok(world.trees.every((t) => !inRoadVerge(t.x, t.z)));
assert.equal(
  world.clusters.reduce((n, c) => n + c.trees.length, 0),
  world.trees.length,
);
const clear = treeClearance(world.trees);
const options = {
  traffic: (x, z) => terrainSample(x, z).traffic,
  clear: (x, z) => terrainSample(x, z).riverDistance > 9 && clear(x, z),
};
const records = roadTorchLayout(
  routes,
  terrainHeight,
  seededRandom(731903),
  options,
);
assert.ok(
  records.length > 0 && records.length <= routeLandmarks(routes).length,
);
for (const p of records) {
  assert.ok(clear(p.x, p.z));
  assert.ok(terrainSample(p.x, p.z).traffic < 0.25);
  assert.ok(p.head + 0.8 >= 4.6 && p.head + 0.8 <= 5);
  assert.ok(Math.abs(p.y - terrainHeight(p.x, p.z)) < 1e-6);
  assert.ok(
    terrainSample(p.x, p.z).riverDistance > 9,
    "lamp stays out of channel",
  );
  assert.ok(
    routeLandmarks(routes).some((j) => Math.hypot(j.x - p.x, j.z - p.z) < 15),
  );
}
console.log(
  JSON.stringify(
    {
      passed: true,
      torches: records.length,
      placement: "junction approaches",
      height: [4.6, 5],
      maxVerge: Math.max(...records.map((p) => p.verge)),
      checks: [
        "route tessellation invariance",
        "actual crossings only",
        "dry verge / opposite-side fallback",
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
  world.trees,
);
assert.equal(system.stats.total, records.length);
for (const o of scene.children)
  if (o.isInstancedMesh)
    assert.ok(o.instanceMatrix.array.every(Number.isFinite));
const camera = new T.PerspectiveCamera();
camera.position.set(records[0].x, records[0].y + 2, records[0].z);
system.update(camera, 1, 120, 0.6);
assert.ok(system.stats.lights > 0 && system.stats.flames > 0);
assert.equal(system.stats.lightCapacity, Math.min(12, records.length));
assert.equal(system.stats.flameCapacity, Math.min(48, records.length));
system.update(camera, 2, 0, 0.6);
assert.equal(system.stats.lights, 0);
assert.equal(system.stats.flames, 0);
assert.ok(
  scene.children.filter((o) => o.isPointLight).every((o) => o.intensity === 0),
);
camera.position.x += 1200;
assert.equal(system.update(camera, 3, 120, 0.6), false);
assert.equal(system.stats.flames, 0);
assert.equal(system.stats.lights, 0);
console.log(
  "Production constructor: finite instances and active light/fire pools passed",
);
