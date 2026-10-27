import assert from "node:assert/strict";
import { nearestRoutePoint } from "../src/route-network.js";
import {
  routes,
  terrainSample,
  terrainHeight,
  inRoadVerge,
} from "../src/terrain-field.js";
import { sampleHydrology } from "../src/watershed.js";
import { routeLandmarks } from "../src/road-torch-layout.js";

assert.deepEqual(
  nearestRoutePoint(
    [
      [0, 0],
      [0, 100],
    ],
    [7, 37],
  ),
  [0, 37],
);
assert.deepEqual(
  nearestRoutePoint(
    [
      [0, 0],
      [0, 100],
    ],
    [7, 140],
  ),
  [0, 100],
);
assert.deepEqual(
  nearestRoutePoint(
    [
      [0, 0],
      [0, 0],
      [100, 0],
    ],
    [30, 9],
  ),
  [30, 0],
);
assert.deepEqual(nearestRoutePoint([[3, 7]], [0, 0]), [3, 7]);
assert.throws(() => nearestRoutePoint([], [0, 0]));

const junctions = [];
let samples = 0;
for (let r = 1; r < routes.length; r++) {
  const branch = routes[r];
  const connection = nearestRoutePoint(routes[0], branch[0]);
  assert.ok(
    Math.hypot(connection[0] - branch[0][0], connection[1] - branch[0][1]) <
      1e-7,
    "every branch starts exactly on the main road, including between grid vertices",
  );
  assert.ok(
    routeLandmarks([routes[0], branch]).length > 0,
    "lamp placement recognises the attachment",
  );
  junctions.push(branch[0]);
  for (let i = 1; i < branch.length; i++) {
    const a = branch[i - 1],
      b = branch[i];
    assert.ok(b.every(Number.isFinite));
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert.ok(
      length < 4,
      "junction snapping must not introduce a long straight shortcut",
    );
    for (let j = 0; j <= 2; j++) {
      const x = a[0] + ((b[0] - a[0]) * j) / 2;
      const z = a[1] + ((b[1] - a[1]) * j) / 2;
      assert.ok(
        inRoadVerge(x, z),
        "tree exclusion follows the entire connected road",
      );
      assert.ok(
        terrainSample(x, z).traffic > 0.15,
        "connected road has no unbaked material gaps",
      );
      samples++;
    }
  }
}
// The new eastern connection is dry. The existing western river crossing remains
// a separate bridge/ford task, not hidden by this connectivity assertion.
const h = {};
for (const [x, z] of routes[1]) {
  sampleHydrology(x, z, h);
  assert.ok(
    h.distance >= h.width || terrainHeight(x, z) >= h.level,
    "connecting the isolated branch must not add a submerged road",
  );
}
console.log(
  JSON.stringify(
    {
      passed: true,
      junctions,
      checkedSurfaceSamples: samples,
      routeVertices: routes.map((r) => r.length),
    },
    null,
    2,
  ),
);
