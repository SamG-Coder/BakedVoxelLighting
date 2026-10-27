import assert from "node:assert/strict";
import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";
import {
  createCutState,
  cutState,
  packGeometry,
  unpackGeometry,
  disposeCutState,
  bridgeFracture,
} from "../src/tree-cut-core.js";
const geometry = new T.CylinderGeometry(0.35, 0.35, 3, 32);
geometry.translate(0, 1.5, 0);
const section = { x: 0, y: 1, z: 0, radius: 0.35, low: 0.2, high: 2 };
const make = () =>
  createCutState(packGeometry(geometry), section, 100, { x: 0, y: 1.5, z: 0 });
const upper = {
  key: "same-bucket",
  angle: 0,
  y: 1.1,
  depth: 0.25,
  halfWidth: 0.12,
  halfHeight: 0.025,
  slope: -0.6,
};
const lower = { ...upper, y: 0.9, slope: 0.6 };
function volume(record) {
  const g = unpackGeometry(record),
    p = g.attributes.position;
  let sum = 0;
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    sum += a.dot(b.cross(c)) / 6;
  }
  g.dispose();
  return Math.abs(sum);
}
function contains(record, point) {
  const g = unpackGeometry(record);
  g.clearGroups();
  const bvh = new MeshBVH(g, { indirect: true });
  const h = bvh.raycastFirst(
    new T.Ray(point, new T.Vector3(1, 0, 0)),
    T.DoubleSide,
  );
  g.dispose();
  return h && h.face.normal.x > 0;
}
const state = make();
let result = cutState(state, upper),
  last = volume(result.band);
const middle = new T.Vector3(0.27, 1, 0);
assert(contains(result.band, middle), "middle attached after upper cut only");
result = cutState(state, lower);
assert(result.released.length > 0, "opposing cuts free actual middle geometry");
assert(
  result.released.reduce((s, r) => s + volume(r), 0) > 0.0001,
  "released chunk has solid volume",
);
assert(!contains(result.band, middle), "middle removed from remaining trunk");
assert(volume(result.band) < last);
last = volume(result.band);
const moved = { ...upper, angle: 0.18, y: 1.15, depth: 0.14 };
result = cutState(state, moved);
assert(
  volume(result.band) <= last + 1e-6,
  "same key different position cannot restore wood",
);
assert(
  !contains(result.band, middle),
  "freed middle remains absent after nearby hit",
);
last = volume(result.band);
result = cutState(state, { ...upper, depth: 0.1 });
assert(
  volume(result.band) <= last + 1e-6,
  "shallower replay cannot fill a deeper cut",
);
assert(
  result.released.reduce((s, r) => s + volume(r), 0) < 1e-7,
  "old middle chunk is not emitted twice",
);
const replay = make();
let replayed;
for (const cut of [upper, lower, moved, { ...upper, depth: 0.1 }])
  replayed = cutState(replay, cut);
assert(
  Math.abs(volume(replayed.band) - volume(result.band)) < 1e-7,
  "worker target switch/replay preserves removed volume",
);
assert(
  !bridgeFracture(
    { ...upper, depth: 0.03 },
    { ...lower, depth: 0.03 },
    section,
  ),
  "scratches retain middle",
);
assert(
  !bridgeFracture(upper, { ...lower, angle: Math.PI }, section),
  "opposite sides do not create a giant chunk",
);
disposeCutState(state);
disposeCutState(replay);
console.log(
  "Paired cuts release solid middle chunks; moved/same-key/shallow cuts and worker replay never restore removed wood.",
);
