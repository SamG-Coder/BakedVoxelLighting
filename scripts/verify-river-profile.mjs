import assert from "node:assert/strict";
import { carveRiverHeight } from "../src/river-profile.js";
import { riverSegments, sampleHydrology } from "../src/watershed.js";

// A synthetic bend isolates the cross-section from regional terrain height.
for (const width of [2, 8, 15]) {
  const section = (shore, cutBank, pointBar) =>
    carveRiverHeight(30, 317, -811, {
      level: 10,
      width,
      distance: width + shore,
      cutBank,
      pointBar,
    });
  assert.ok(
    section(2, 1, 0) > section(2, 0, 1) + 1,
    "outer bend rises to a cut bank; inner bend has a depositional shelf",
  );
  assert.ok(
    section(-width, 1, 0) < section(-width, 0, 1),
    "scour makes the outer cross-section deeper",
  );
  for (const [cut, bar] of [
    [1, 0],
    [0, 1],
    [0, 0],
  ]) {
    for (const boundary of [0, 3 + width * 0.25, 18 + width]) {
      assert.ok(
        Math.abs(
          section(boundary - 1e-5, cut, bar) -
            section(boundary + 1e-5, cut, bar),
        ) < 1e-3,
        "shore, shelf and floodplain have no height discontinuity",
      );
    }
    assert.equal(section(40, cut, bar), 30);
  }
}
let bends = 0;
for (const s of riverSegments) {
  const bend = (s.bendA + s.bendB) / 2;
  if (Math.abs(bend) < 0.15 || Math.abs(s.ax) > 1800 || Math.abs(s.az) > 1800)
    continue;
  const x = (s.ax + s.bx) / 2,
    z = (s.az + s.bz) / 2;
  const width = (s.wa + s.wb) / 2;
  const side = Math.sign(bend);
  const inner = sampleHydrology(
    x - s.fz * width * side,
    z + s.fx * width * side,
    {},
  );
  const outer = sampleHydrology(
    x + s.fz * width * side,
    z - s.fx * width * side,
    {},
  );
  // At junctions the nearest tributary may be a different cross-section.
  if (inner.segment !== s.id || outer.segment !== s.id) continue;
  assert.ok(inner.pointBar > 0 && inner.cutBank === 0);
  assert.ok(outer.cutBank > 0 && outer.pointBar === 0);
  bends++;
}
assert.ok(bends > 50);
console.log({
  bends,
  checks:
    "bend handedness, scour depth, bank shelves and continuous floodplain passed",
});
