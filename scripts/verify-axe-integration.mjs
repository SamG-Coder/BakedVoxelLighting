import assert from "node:assert/strict";
import * as T from "three/webgpu";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { axeHeadGeometry, AXE_EDGE_POINTS } from "../src/axe-geometry.js";
import { AXE_REST_ROTATION } from "../src/axe-sweep.js";
import {
  createCutState,
  cutState,
  packGeometry,
  unpackGeometry,
  disposeCutState,
} from "../src/tree-cut-core.js";

// Reproduce the exact worker -> render path: CSG outputs non-indexed surfaces.
const original = new T.CylinderGeometry(0.35, 0.35, 4, 24);
original.translate(0, 2, 0);
const state = createCutState(
  packGeometry(original),
  { x: 0, y: 1, z: 0, radius: 0.35 },
  600,
  { x: 0.03, y: 2, z: 0 },
);
for (let hit = 1; hit <= 3; hit++) {
  const result = cutState(state, {
    angle: 0,
    y: 1,
    depth: hit * 0.045,
    halfWidth: 0.085,
    halfHeight: 0.095,
    slope: -0.4,
  });
  const geometry = unpackGeometry(result.band);
  assert.equal(geometry.index, null);
  const bvh = new MeshBVH(geometry, { indirect: true, maxLeafSize: 8 });
  const serialized = structuredClone(MeshBVH.serialize(bvh));
  const restored = unpackGeometry(result.band);
  restored.clearGroups();
  restored.boundsTree = MeshBVH.deserialize(serialized, restored, {
    setIndex: false,
  });
  const proxy = new T.Mesh(
    restored,
    new T.MeshBasicMaterial({ side: T.DoubleSide }),
  );
  proxy.raycast = acceleratedRaycast;
  proxy.updateMatrixWorld();
  const ray = new T.Raycaster(new T.Vector3(2, 1, 0), new T.Vector3(-1, 0, 0));
  ray.firstHitOnly = true;
  const hits = [];
  proxy.raycast(ray, hits);
  assert(hits.length > 0);
  assert(Number.isFinite(hits[0].distance));
  const chunk = unpackGeometry(result.chunk);
  chunk.computeBoundingBox();
  assert(
    chunk.boundingBox.max.z - chunk.boundingBox.min.z <= 0.171,
    "chip width stays blade-sized",
  );
  restored.dispose();
  geometry.dispose();
  chunk.dispose();
}
disposeCutState(state);
const head = axeHeadGeometry();
head.computeBoundingBox();
assert(head.boundingBox.max.x - head.boundingBox.min.x < 0.25);
assert.equal(head.groups.length, 2, "two head material batches");
for (const point of AXE_EDGE_POINTS) {
  let nearest = Infinity;
  const p = head.attributes.position;
  for (let i = 0; i < p.count; i++)
    nearest = Math.min(
      nearest,
      point.distanceTo(new T.Vector3().fromBufferAttribute(p, i)),
    );
  assert(nearest < 0.00031, "collision samples lie on rendered edge");
}
const forward = new T.Vector3(1, 0, 0).applyQuaternion(AXE_REST_ROTATION);
assert(
  forward.distanceTo(new T.Vector3(0, 0, -1)) < 1e-6,
  "ready blade faces forward",
);
assert(
  new T.Vector3(0, 1, 0).applyQuaternion(AXE_REST_ROTATION).y > 0.999,
  "ready handle upright",
);
console.log(
  "Non-indexed CSG BVH restores and raycasts across 3 cuts; bounded chips, shared edge and forward rest passed.",
);
