import assert from "node:assert/strict";
import test from "node:test";
import {
  GrassStreamQueue,
  requestGrassAhead,
} from "../src/grass-stream-queue.js";
import { updateLOD } from "../src/vegetation-lod.js";
import { Group, Scene, Vector3 } from "three/webgpu";
import { PreparationQueue } from "../src/preparation-queue.js";

test("near grass bypasses a renderer backlog without overlapping GPU jobs or starving it", async () => {
  const q = new PreparationQueue(),
    order = [];
  let release;
  const first = q.run(() => new Promise((r) => (release = r)));
  const background = q.run(() => order.push("background"));
  const grass = Array.from({ length: 12 }, (_, i) =>
    q.run(
      () => order.push(i),
      () => i,
    ),
  );
  release();
  await Promise.all([first, background, ...grass]);
  assert.equal(order[0], 0);
  assert.ok(order.indexOf("background") < 8);
  assert.equal(order.length, 13);
});

test("generation runs ahead of blocked GPU preparation, with bounded concurrency", async () => {
  const tasks = [],
    started = [],
    gates = [];
  const q = new GrassStreamQueue({
    concurrency: 4,
    schedule: (fn) => tasks.push(fn),
  });
  for (let i = 7; i >= 0; i--) {
    const p = {
      generation: 0,
      pending: new Map([[0, 0]]),
      requestPriority: [i],
      build: () => {
        started.push(i);
        return new Promise((resolve) => gates.push(resolve));
      },
    };
    q.enqueue(p, 0, 0);
  }
  tasks.shift()();
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(q.stats.active, 4);
  assert.equal(q.stats.queued, 4);
  const done = q.finish();
  gates.splice(0).forEach((r) => r());
  await new Promise((r) => setImmediate(r));
  tasks.splice(0).forEach((fn) => fn());
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
  gates.splice(0).forEach((r) => r());
  await new Promise((r) => setImmediate(r));
  tasks.splice(0).forEach((fn) => fn());
  await done;
  assert.equal(q.stats.completed, 8);
});

test("stale requests are dropped and a failed tile does not stop streaming", async (t) => {
  t.mock.method(console, "error", () => {});
  const q = new GrassStreamQueue();
  const make = () => ({
    generation: 0,
    pending: new Map([[0, 0]]),
    requestPriority: [1],
    build: async () => {},
  });
  const released = make(),
    unwanted = make(),
    failed = make(),
    healthy = make();
  let ran = 0;
  released.build = unwanted.build = async () =>
    assert.fail("obsolete tile built");
  failed.build = async () => {
    throw new Error("expected fixture failure");
  };
  healthy.build = async () => ran++;
  for (const p of [released, unwanted, failed, healthy]) q.enqueue(p, 0, 0);
  released.generation++;
  unwanted.requestPriority[0] = Infinity;
  await q.finish();
  assert.equal(ran, 1);
  assert.equal(q.stats.cancelled, 2);
  assert.equal(q.stats.errors.length, 1);
  for (const p of [released, unwanted, failed, healthy])
    assert.equal(p.pending.size, 0);
});

test("obsolete GPU preparation is skipped and failure cannot poison the renderer queue", async () => {
  const q = new PreparationQueue();
  let release,
    wanted = true;
  const block = q.run(() => new Promise((r) => (release = r)));
  const stale = q.run(
    () => assert.fail("stale geometry compiled"),
    () => (wanted ? 1 : Infinity),
  );
  const failed = q.run(() => {
    throw new Error("fixture");
  });
  const rejection = assert.rejects(failed, /fixture/);
  const next = q.run(() => 42);
  wanted = false;
  release();
  await Promise.all([block, stale, rejection]);
  assert.equal(await next, 42);
});

test("fine grass is requested before the visible transition, and moving ahead gets lead time", () => {
  const requested = [];
  const c = { levels: [null, null, {}, {}], ensure: (i) => requested.push(i) };
  requestGrassAhead(c, [0, 1, 0, 0], 60, 60, [38, 82, 155]);
  assert.ok(
    requested.includes(0),
    "prepare high detail before entering its 42m fade edge",
  );
  assert.ok(
    c.requestPriority[1] < c.requestPriority[0],
    "visible work precedes prefetch",
  );
  requested.length = 0;
  requestGrassAhead(c, [0, 0, 0, 1], 210, 162, [38, 82, 155]);
  assert.deepEqual(
    requested,
    [2],
    "request an approaching far tile before it is visible",
  );
  requested.length = 0;
  requestGrassAhead(c, [0, 0, 0, 1], 240, 240, [38, 82, 155]);
  assert.deepEqual(
    requested,
    [],
    "do not generate distant tiles indiscriminately",
  );
});

test("grass requested while still in ground-only LOD is released beyond retention", () => {
  let releases = 0;
  const c = {
    kind: "grass",
    center: new Vector3(370, 0, 0),
    current: 3,
    levels: [null, null, new Group(), new Group()],
    pending: new Map(),
    release() {
      releases++;
      this.levels[2] = null;
    },
  };
  updateLOD([c], { position: new Vector3() }, -1, [38, 82, 155], new Scene());
  assert.equal(releases, 1);
});
