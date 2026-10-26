import assert from "node:assert/strict";
import {
  buildVoxelDetails,
  buildVoxelDetailsStreamed,
} from "../src/voxel-core.js";
import { GRASS_TYPES } from "../src/plant-catalog.js";
import { Group, Scene, Vector3 } from "three/webgpu";
import { updateLOD } from "../src/vegetation-lod.js";
import { PreparationQueue } from "../src/preparation-queue.js";
import { WorkerClient } from "../src/worker-client.js";
import { PerspectiveCamera } from "three/webgpu";
import {
  BoxGeometry,
  MeshStandardMaterial,
  Matrix4,
  Euler,
  Quaternion,
  Color,
} from "three/webgpu";
import { VegetationInstancePool } from "../src/vegetation-instance-pool.js";
import { updateStreamingView, prioritizeArea } from "../src/streaming-view.js";
const patches = Array.from({ length: 20 }, (_, i) => ({ x: i, z: 0 }));
const records = new Map(
  patches.map((p) => {
    const matrices = new Float32Array(32);
    matrices[5] = matrices[21] = 1;
    matrices[12] = matrices[28] = p.x;
    return [
      p,
      [
        {
          matrices,
          colours: new Float32Array(6).fill(0.8),
          types: new Float32Array(2),
        },
      ],
    ];
  }),
);
const world = {
  materialProfiles: Object.fromEntries(
    GRASS_TYPES.map((t) => [
      t.name,
      { colour: [0.1, 0.3, 0.05], coverage: 0.5 },
    ]),
  ),
  areaIndexes: {
    grass: { query: () => patches },
    trees: { query: () => [] },
    objects: { query: () => [] },
  },
};
const args = [world, 16, { x: -10, y: -4, z: -10 }, { x: 40, y: 16, z: 40 }];
const expected = buildVoxelDetails(...args, records);
let active = 0,
  max = 0;
const actual = await buildVoxelDetailsStreamed(...args, async (p) => {
  active++;
  max = Math.max(max, active);
  await Promise.resolve();
  active--;
  return records.get(p);
});
assert.deepEqual(actual, expected);
assert.equal(max, 1);
const c = {
  kind: "tree",
  center: new Vector3(),
  keepDetail: [true, true],
  levels: [0, 1, 2, 3].map(() => new Group()),
};
let releases = 0;
c.releaseDetail = (i) => {
  c.keepDetail[i] = false;
  c.levels[i] = null;
  releases++;
};
const items = [c],
  scene = new Scene(),
  camera = { position: new Vector3(10, 0, 0) };
updateLOD(items, camera, -1, [85, 190, 420], scene, 0);
camera.position.x = 500;
updateLOD(items, camera, -1, [85, 190, 420], scene, 50);
assert.ok(c.levels[0], "visible transition source must survive");
camera.position.x = 501;
updateLOD(items, camera, -1, [85, 190, 420], scene, 100);
assert.equal(c.levels[0], null);
assert.equal(releases, 2);
console.log(
  "Streamed voxel bytes match bulk output; one grass load at a time; tree eviction preserves active fades.",
);
const view = new PerspectiveCamera(60, 1, 0.1, 1000);
view.updateMatrixWorld();
updateStreamingView(view);
assert.ok(
  prioritizeArea(new Vector3(0, 0, -200), 200, 8) <
    prioritizeArea(new Vector3(0, 0, 100), 100, 8),
);
view.rotation.y = Math.PI;
view.updateMatrixWorld();
updateStreamingView(view);
assert.ok(
  prioritizeArea(new Vector3(0, 0, 200), 200, 8) <
    prioritizeArea(new Vector3(0, 0, -100), 100, 8),
);
const queue = new PreparationQueue(),
  calls = [];
let unblock,
  stale = false,
  front = 100;
const gate = queue.run(
  () =>
    new Promise((resolve) => {
      unblock = resolve;
    }),
);
const abandoned = queue.run(
  () => calls.push("stale"),
  () => (stale ? Infinity : 0),
);
const offscreen = queue.run(
  () => calls.push("offscreen"),
  () => 2000,
);
const onscreen = queue.run(
  () => calls.push("onscreen"),
  () => front,
);
stale = true;
front = 10;
unblock();
await Promise.all([gate, abandoned, offscreen, onscreen]);
assert.deepEqual(calls, ["onscreen", "offscreen"]);
assert.equal(queue.jobs.length, 0);
const messages = [],
  worker = { postMessage: (message) => messages.push(message) };
const client = new WorkerClient(worker, "test"),
  controller = new AbortController();
const job = client.run("details", {}, [], controller.signal);
controller.abort();
await assert.rejects(job, { name: "AbortError" });
assert.equal(client.pending.size, 0);
assert.equal(messages.at(-1).type, "cancel");
worker.onmessage({ data: { id: messages[0].id, result: "stale" } });
assert.equal(client.stats.completed, 0);
console.log(
  "Frustum priorities respond to rotation; pending stale jobs never run; aborted worker replies cannot publish.",
);
const geometry = new BoxGeometry(),
  pool = new VegetationInstancePool(1);
let made = 0,
  disposedGeometry = 0;
geometry.addEventListener("dispose", () => disposedGeometry++);
const material = () => {
  made++;
  return new MeshStandardMaterial();
};
const a = [
  { p: [1, 2, 3], r: [0, 0.2, 0], s: [1, 2, 1], colour: [0.2, 0.5, 0.3] },
];
const mesh = pool.acquire(geometry, material, a),
  holder = new Group();
holder.add(mesh);
const matrixAttribute = mesh.instanceMatrix,
  colourAttribute = mesh.instanceColor;
pool.releaseGroup(holder);
const b = [
  { p: [15, 4, -40], r: [0.1, 1, 0.3], s: [2, 3, 2], colour: [0.7, 0.2, 0.1] },
  { p: [30, 2, 15], r: [0, -1, 0], s: [1, 1, 1], colour: [0.3, 0.4, 0.5] },
];
const reused = pool.acquire(geometry, material, b);
assert.equal(reused, mesh);
assert.equal(reused.instanceMatrix, matrixAttribute);
assert.equal(reused.instanceColor, colourAttribute);
assert.equal(made, 1);
assert.equal(reused.count, 2);
for (let i = 0; i < b.length; i++) {
  const t = b[i],
    expected = new Matrix4().compose(
      new Vector3(...t.p),
      new Quaternion().setFromEuler(new Euler(...t.r)),
      new Vector3(...t.s),
    );
  assert.deepEqual(
    [...reused.instanceMatrix.array.slice(i * 16, i * 16 + 16)],
    [...new Float32Array(expected.elements)],
  );
  assert.deepEqual(
    [...reused.instanceColor.array.slice(i * 3, i * 3 + 3)],
    [...new Float32Array(t.colour)],
  );
}
assert.ok(reused.boundingSphere.containsPoint(new Vector3(...b[0].p)));
const overflow = pool.acquire(geometry, material, a);
holder.add(reused, overflow);
pool.releaseGroup(holder);
assert.equal(pool.stats.retained, 1);
assert.equal(pool.stats.disposed, 1);
assert.equal(disposedGeometry, 0);
console.log(
  "Tree instance pool preserves transforms, colours, attribute identities and shared geometry; spare capacity is bounded.",
);
