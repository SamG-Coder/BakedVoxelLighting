import assert from "node:assert/strict";
import { buildRiverData } from "../src/river-data.js";
import { riverSegments } from "../src/watershed.js";
const nodes = new Map(riverSegments.map((s) => [s.node, s]));
let joins = 0;
for (const s of riverSegments) {
  assert.ok(s.ay > s.by, "flow must descend");
  const next = nodes.get(s.receiver);
  if (!next) continue;
  assert.deepEqual(
    [s.bx, s.bz, s.by, s.wb],
    [next.ax, next.az, next.ay, next.wa],
  );
  assert.ok(
    Math.abs(s.station - s.length - next.station) < 0.001,
    "scroll phase follows graph distance",
  );
  joins++;
}
const data = buildRiverData(() => -1000);
let faces = 0;
for (const c of data.chunks) {
  for (let i = 0; i < c.flow.length; i += 4) {
    assert.ok(Math.abs(Math.hypot(c.flow[i], c.flow[i + 1]) - 1) < 1e-6);
    assert.ok(c.flow[i + 2] >= 0.179 && c.flow[i + 2] <= 0.961);
    assert.ok(Number.isFinite(c.flow[i + 3]));
  }
  for (let i = 0; i < c.index.length; i += 3) {
    const a = c.index[i] * 3,
      b = c.index[i + 1] * 3,
      d = c.index[i + 2] * 3,
      p = c.position;
    assert.ok(
      (p[b + 2] - p[a + 2]) * (p[d] - p[a]) -
        (p[b] - p[a]) * (p[d + 2] - p[a + 2]) >
        0,
    );
    faces++;
  }
}
assert.ok(joins > 100 && data.length > 10000);
console.log({
  passed: true,
  joins,
  pages: data.chunks.length,
  faces,
  lengthMetres: data.length,
});
