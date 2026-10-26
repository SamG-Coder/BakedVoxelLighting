import assert from "node:assert/strict";
import test from "node:test";
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector2,
  Vector3,
} from "three/webgpu";
import { updateLOD, replaceLODLevel } from "../src/vegetation-lod.js";

const distances = [85, 190, 420];
function group(ready = false) {
  const result = new Group();
  const material = new MeshBasicMaterial();
  material.userData.fade = { value: new Vector2(0, 1) };
  result.add(new Mesh(undefined, material));
  result.visible = false;
  result.userData.pipelineReady = ready;
  return result;
}
function fixture(resident) {
  const c = {
    kind: "tree",
    center: new Vector3(),
    levels: [0, 1, 2, 3].map((i) => group(resident.includes(i))),
  };
  const items = [c],
    scene = new Scene(),
    camera = { position: new Vector3() };
  const requests = new Map();
  items.prepareGroup = (object) =>
    new Promise((resolve, reject) => {
      assert.ok(
        !requests.has(object),
        "preparation must be deduplicated while pending",
      );
      requests.set(object, {
        complete() {
          object.userData.pipelineReady = true;
          items.lodRevision = (items.lodRevision || 0) + 1;
          resolve();
        },
        reject,
      });
    });
  function draw(distance, now, force = -1) {
    camera.position.set(distance, 0, 0);
    return updateLOD(items, camera, force, distances, scene, now);
  }
  return { c, items, scene, camera, requests, draw };
}
function ranges(f) {
  return f.c.levels.flatMap((g, level) =>
    !g.visible
      ? []
      : [
          {
            level,
            low: g.children[0].material.userData.fade.value.x,
            high: g.children[0].material.userData.fade.value.y,
          },
        ],
  );
}
function coverage(f) {
  const visible = ranges(f).sort((a, b) => a.low - b.low);
  let end = 0;
  for (const { level, low, high } of visible) {
    assert.equal(
      f.c.levels[level].parent,
      f.scene,
      "visible LOD must be attached",
    );
    assert.ok(
      f.c.levels[level].userData.pipelineReady,
      "never present pending geometry",
    );
    assert.ok(
      Math.abs(low - end) < 1e-9,
      "fade ranges must have no holes or overlaps",
    );
    assert.ok(high > low && high <= 1 + 1e-9);
    end = high;
  }
  assert.ok(
    Math.abs(end - 1) < 1e-9,
    `resident trees need full coverage, got ${end}`,
  );
  // Check the actual screen-door domain rather than just counting visible LODs.
  for (let pixel = 0; pixel < 64; pixel++) {
    const noise = (pixel + 0.5) / 64;
    assert.equal(
      visible.filter((r) => noise >= r.low && noise < r.high).length,
      1,
    );
  }
}

for (const [boundary, distance] of distances.entries()) {
  for (const direction of [-1, 1]) {
    test(`boundary ${boundary}/${boundary + 1}, direction ${direction}: wait, swap, stop`, async () => {
      const old = direction === -1 ? boundary + 1 : boundary;
      const incoming = direction === -1 ? boundary : boundary + 1;
      const f = fixture([old]);
      f.draw(distance - direction * 50, 0, old);
      // A deliberately stalled upload for 120 frames inside the fade band.
      for (let frame = 1; frame <= 120; frame++) {
        f.draw(distance, frame * 16);
        coverage(f);
        assert.deepEqual(ranges(f), [{ level: old, low: 0, high: 1 }]);
      }
      assert.equal(f.requests.size, 1);
      f.requests.get(f.c.levels[incoming]).complete();
      await Promise.resolve();
      f.draw(distance, 1936);
      coverage(f);
      assert.deepEqual(
        ranges(f),
        [{ level: old, low: 0, high: 1 }],
        "upload completion must not instantly steal the old tree's pixels",
      );
      f.draw(distance, 1952);
      coverage(f);
      assert.equal(ranges(f).length, 2);
      for (let now = 1968; now <= 2240; now += 16) {
        f.draw(distance, now); // No movement or readiness revision during handoff.
        coverage(f);
      }
      assert.equal(
        f.items.lodTransitions.size,
        0,
        "stationary camera must finish handoff",
      );
      assert.ok(
        ranges(f).every(({ low, high }) => Math.abs(high - low - 0.5) < 1e-9),
      );
      let traversals = 0;
      for (const g of f.c.levels) g.traverse = () => traversals++;
      f.draw(distance, 2256);
      assert.equal(
        traversals,
        0,
        "settled, stationary LODs must not be traversed again",
      );
    });
  }
}

test("fast travel and reversing direction retain coverage until both LODs finish", () => {
  const f = fixture([0, 3]);
  f.draw(600, 0);
  f.draw(20, 16);
  for (let now = 32; now <= 112; now += 16) {
    f.draw(20, now);
    coverage(f);
  }
  const before = [...f.c.lodBlend.weights];
  f.draw(600, 128);
  coverage(f);
  assert.ok(
    f.c.lodBlend.weights[0] < before[0],
    "reversal fades back from the current pose",
  );
  for (let now = 144; now <= 500; now += 16) {
    f.draw(600, now);
    coverage(f);
  }
  assert.deepEqual(ranges(f), [{ level: 3, low: 0, high: 1 }]);
});

test("keep the current resident LOD instead of falling back to an unrelated coarse one", () => {
  const f = fixture([1, 3]);
  f.draw(130, 0);
  f.draw(20, 16);
  coverage(f);
  assert.deepEqual(ranges(f), [{ level: 1, low: 0, high: 1 }]);
  assert.ok(f.requests.has(f.c.levels[0]));
});

test("moving within a settled distance band does not traverse every tree material", () => {
  const f = fixture([3]);
  f.draw(600, 0);
  let traversals = 0;
  for (const g of f.c.levels) g.traverse = () => traversals++;
  for (let i = 1; i <= 60; i++) f.draw(600 + i, i * 16);
  assert.equal(traversals, 0);
});

test("failed replacement and a paused frame cannot blank the fallback", async () => {
  const f = fixture([3]);
  f.draw(600, 0);
  f.draw(420, 16);
  f.requests.get(f.c.levels[2]).reject(new Error("simulated upload failure"));
  await Promise.resolve();
  await Promise.resolve();
  f.draw(420, 30000);
  coverage(f);
  assert.deepEqual(ranges(f), [{ level: 3, low: 0, high: 1 }]);
  f.c.levels[2].userData.pipelineReady = true;
  f.items.lodRevision = 1;
  f.draw(420, 60000);
  f.draw(420, 90000);
  coverage(f);
  assert.ok(
    f.c.lodBlend.weights[2] <= 50 / 240 + 1e-9,
    "time suspended must not turn the first visible frame into a full swap",
  );
});

test("ready merged replacement inherits coverage and joins before source removal", () => {
  const f = fixture([2, 3]);
  f.draw(420, 0);
  const old = f.c.levels[3],
    replacement = group(true);
  const range = old.children[0].material.userData.fade.value.toArray();
  let installed = false;
  replacement.addEventListener("added", () => {
    installed = true;
    assert.equal(old.parent, f.scene);
    assert.ok(old.visible);
    assert.deepEqual(
      replacement.children[0].material.userData.fade.value.toArray(),
      range,
    );
  });
  assert.equal(replaceLODLevel(f.c, 3, replacement), old);
  assert.ok(installed);
  assert.equal(old.parent, null);
  assert.equal(old.visible, false);
  coverage(f);
  f.items.lodRevision = 1;
  f.draw(420, 16);
  coverage(f);
  const hidden = group(true);
  replaceLODLevel(f.c, 1, hidden);
  assert.equal(hidden.parent, null, "a hidden merge must stay detached");
  assert.equal(hidden.visible, false);
});

test("grass fallback uses its resolved fade and missing patches still fade to terrain", () => {
  const f = fixture([2, 3]);
  f.c.kind = "grass";
  f.items.prepareGroup = null; // Grass publishes groups only after preparation.
  f.c.levels[0] = null;
  f.c.levels[1] = null;
  f.draw(10, 0);
  assert.deepEqual(ranges({ c: { levels: f.c.levels.filter(Boolean) } }), [
    { level: 0, low: 0, high: 1 },
  ]);
  f.draw(370, 16);
  assert.ok(f.c.levels.every((g) => !g || !g.visible));
});

test("newly resident grass fades from ground fallback instead of popping", () => {
  const f = fixture([3]);
  f.c.kind = "grass";
  f.items.prepareGroup = null;
  const next = f.c.levels[0];
  f.c.levels[0] = f.c.levels[1] = f.c.levels[2] = null;
  f.draw(10, 0);
  f.c.levels[0] = next;
  f.items.lodRevision = 1;
  f.draw(10, 60000);
  assert.equal(f.c.lodBlend.weights[0], 0);
  f.draw(10, 60016);
  assert.ok(f.c.lodBlend.weights[0] > 0 && f.c.lodBlend.weights[0] < 0.1);
  for (let now = 60032; now < 61000; now += 16) f.draw(10, now);
  assert.equal(f.c.lodBlend.weights[0], 1);
});
