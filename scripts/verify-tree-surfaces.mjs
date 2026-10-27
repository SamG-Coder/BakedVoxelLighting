import assert from "node:assert/strict";
import { growPlant, skinPath } from "../src/growth.js";
import { growStructure } from "../src/plant-growth.js";
import {
  treeTint,
  barkColour,
  leafColour,
  mossCoverage,
} from "../src/plant-appearance.js";
import { bakeMergedCluster } from "../src/merged-data.js";
import { grassHabitat } from "../src/habitat.js";
import { unionWood } from "../src/wood-union.js";
import { Vector3 } from "three/webgpu";

const graft = unionWood(
  [
    {
      points: [new Vector3(0, -0.5, 0), new Vector3(0, 2, 0)],
      radii: [0.35, 0.25],
    },
    {
      points: [new Vector3(0, 0.7, 0), new Vector3(1.4, 1.4, 0)],
      radii: [0.2, 0.08],
    },
  ],
  { seed: 19, species: 0 },
);
const edgeUse = new Map();
const ix = graft.index.array;
for (let i = 0; i < ix.length; i += 3)
  for (const [a, b] of [
    [ix[i], ix[i + 1]],
    [ix[i + 1], ix[i + 2]],
    [ix[i + 2], ix[i]],
  ]) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
  }
assert.ok(
  [...edgeUse.values()].every((n) => n === 2),
  "trunk/branch union is closed with shared edges, not overlapping collars",
);
graft.dispose();

const rooted = unionWood(
  [
    {
      points: [new Vector3(0, -0.22, 0), new Vector3(0, 2, 0)],
      radii: [0.35, 0.2],
      rootFlare: { reach: 1.3, phase: 0.7 },
    },
  ],
  { seed: 19, species: 0, age: 1 },
);
const rp = rooted.attributes.position;
for (let i = 0; i < rp.count; i++)
  assert.ok(
    rp.getY(i) >= -0.22001,
    "root union must not generate a buried capsule bulb",
  );
const rootEdges = new Map();
const ri = rooted.index.array;
for (let i = 0; i < ri.length; i += 3)
  for (let j = 0; j < 3; j++) {
    const a = ri[i + j],
      b = ri[i + ((j + 1) % 3)];
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    rootEdges.set(key, (rootEdges.get(key) || 0) + 1);
  }
assert.ok(
  [...rootEdges.values()].every((n) => n === 2),
  "trimmed root base remains closed",
);
rooted.dispose();

let vertices = 0;
for (let species = 0; species < 4; species++) {
  const source = growStructure(9801 + species * 137, species, false, 1);
  assert.equal(source.paths.filter((p) => p.rootFlare).length, 1);
  const attached = source.paths.find((p) => p.attachment && p.radii[0] > 0.025);
  const skin = skinPath(attached);
  const first = skin.points[1].clone().sub(skin.points[0]).normalize();
  assert.ok(
    first.dot(attached.attachment.d) > 0.5,
    "collar initially follows parent growth",
  );
  assert.ok(skin.radii.every((r) => r > 0 && Number.isFinite(r)));
  const plant = growPlant(9801 + species * 137, species, false, 1);
  assert.ok(
    plant.low.attributes.position.count <
      plant.high.attributes.position.count * 0.8,
  );
  for (const g of [plant.high, plant.low, plant.farWood]) {
    for (let i = 0; i < g.attributes.position.count; i++)
      assert.ok(
        g.attributes.position.getY(i) >= -0.22001,
        "all wood LODs share the root base",
      );
    for (const name of ["position", "normal", "uv", "color"])
      assert.ok(g.attributes[name].array.every(Number.isFinite));
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++)
      assert.ok(
        Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 0.001,
      );
    g.dispose();
  }
  vertices += plant.high.attributes.position.count;
  const root = plant.paths.find((p) => p.rootFlare);
  assert.ok(
    root.radii[0] > root.radii[10] * 1.5,
    "voxel source includes buttresses",
  );
}
assert.notDeepEqual(treeTint(10), treeTint(20));
assert.deepEqual(treeTint(10), treeTint(10));
assert.notDeepEqual(leafColour(1, 4, 2, 10), leafColour(1, 4, 2, 20));
assert.notDeepEqual(
  barkColour(0.3, 0.1, 0.1, 10, 0),
  barkColour(0.3, 5, 0.1, 10, 0),
);
const tree = { x: 0, y: 0, z: 0, scale: 1, rotation: 0, variant: 0, seed: 817 };
const merged = bakeMergedCluster(
  [tree],
  [{ center: [0, 5, 0], width: 8, height: 10 }],
);
for (let vertex = 0; vertex < 4; vertex++)
  treeTint(tree.seed).forEach((v, c) =>
    assert.ok(Math.abs(v - merged.color[vertex * 3 + c]) < 1e-6),
  );
const land = { forest: 0, canopy: 0, moisture: 0.4 };
const colours = Array.from(
  { length: 40 },
  (_, i) => grassHabitat(i * 25, 80, land).colour[0],
);
assert.ok(
  Math.max(...colours) - Math.min(...colours) > 0.18,
  "large meadow gradients remain present in the ground bake input",
);
console.log({
  checks:
    "junction normals, root footprint, reduced LOD geometry, seed colours and merged colour parity passed",
  highVerticesAcrossFourSpecies: vertices,
});

const moss = [0, 1, 2].map((age) =>
  Array.from({ length: 100 }, (_, i) =>
    mossCoverage(Math.cos(i) * 0.4, 0.3, Math.sin(i) * 0.4, 9801, age),
  ).reduce((a, b) => a + b, 0),
);
assert.ok(
  moss[1] > moss[0] * 4 && moss[2] > moss[1],
  "older bark must carry visibly more moss",
);
