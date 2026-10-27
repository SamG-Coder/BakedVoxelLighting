import assert from "node:assert/strict";
import * as T from "three";
import { applyTreeEdits } from "../src/tree-edit-visibility.js";
import { WalkCollision } from "../src/walk-collision.js";
import {
  createCutState,
  cutState,
  packGeometry,
  sectionStrength,
  disposeCutState,
} from "../src/tree-cut-core.js";
const g = new T.CylinderGeometry(0.4, 0.4, 8, 24, 1);
g.translate(0, 4, 0);
const section = { x: 0, y: 1, z: 0, radius: 0.4 };
const state = createCutState(packGeometry(g), section, 900, {
  x: 0.06,
  y: 4,
  z: 0,
});
let last = 1,
  failed = false,
  removed = 0;
for (let i = 1; i <= 12; i++) {
  const result = cutState(state, { angle: 0, depth: i * 0.075 });
  assert(result.strength.fraction <= last + 0.0001);
  last = result.strength.fraction;
  for (const name of ["band", "chunk", "stump", "fallen"])
    if (result[name]) {
      const r = result[name];
      for (const a of Object.values(r.attributes))
        assert(a.array.every(Number.isFinite));
      assert(
        r.groups.every((g) => g.materialIndex === 0 || g.materialIndex === 1),
      );
    }
  removed += result.chunk.attributes.position.array.length;
  assert(
    result.band.groups.some((g) => g.materialIndex === 1),
    "exposed wood has its own material",
  );
  if (result.strength.failed) {
    assert(result.stump && result.fallen);
    failed = true;
    break;
  }
}
assert(removed > 0, "solid chunks removed");
assert(failed, "remaining section eventually fails");
assert(
  !sectionStrength(section, [], 900, { x: 0.06, y: 4, z: 0 }).failed,
  "intact tree stable",
);
disposeCutState(state);
g.dispose();
console.log(
  "Progressive notch, solid chunks, exposed wood, section failure and stump split passed.",
);

const tree = { x: 10, y: 0, z: 20, rotation: 0, scale: 1, variant: 0 };
const cluster = { trees: [tree], editedTrees: new Set([tree]) };
const prototypes = [
  {
    center: new T.Vector3(0, 4, 0),
    paths: [
      {
        rootFlare: true,
        points: [new T.Vector3(0, 0, 0), new T.Vector3(0, 8, 0)],
        radii: [0.4, 0.3],
      },
    ],
  },
];
const group = new T.Group(),
  instances = new T.InstancedMesh(
    new T.BoxGeometry(),
    new T.MeshBasicMaterial(),
    2,
  );
instances.setMatrixAt(0, new T.Matrix4().makeTranslation(10, 0, 20));
instances.setMatrixAt(1, new T.Matrix4().makeTranslation(13, 0, 20));
group.add(instances);
const quad = new T.Mesh(new T.PlaneGeometry(), new T.MeshBasicMaterial());
quad.userData.visibilityMerged = true;
group.add(quad);
applyTreeEdits(cluster, group, prototypes);
assert.equal(instances.instanceMatrix.array[13], -100000);
assert.equal(instances.instanceMatrix.array[28], 13);
assert(quad.geometry.index.array.every((i) => i === 0));
const collision = new WalkCollision([tree], prototypes);
assert.equal(
  collision.pickTree(new T.Vector3(10, 1.5, 22), new T.Vector3(0, 0, -1), 3, [
    tree,
  ]),
  0,
);
tree.felled = true;
assert.equal(
  collision.pickTree(new T.Vector3(10, 1.5, 22), new T.Vector3(0, 0, -1), 3, [
    tree,
  ]),
  -1,
);
collision.logs.push({ ax: 0, az: -2, ay: 0.5, bx: 0, bz: 2, by: 0.5, r: 0.3 });
assert(collision.move(-2, 0, 2, 0, 0).x < -0.5, "fallen trunk blocks walking");
console.log(
  "Edited-tree instance and merged HLOD masking, interaction selection and fallen-log collision passed.",
);
