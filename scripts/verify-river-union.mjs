import assert from "node:assert/strict";
import { buildRiverData } from "../src/river-data.js";
import { riverData, terrainHeight } from "../src/terrain-field.js";
import { riverSegments } from "../src/watershed.js";

// Compare independent page copies of the same surface location. Different
// heights, depth or flow here would tear when the vertex animation runs.
const shared = new Map();
let copies = 0,
  bytes = 0,
  faces = 0;
const buckets = new Map();
for (const c of riverData.chunks) {
  for (const a of Object.values(c)) {
    assert.ok(a.every(Number.isFinite));
    bytes += a.byteLength;
  }
  for (let i = 0; i < c.position.length / 3; i++) {
    const key = `${c.position[i * 3]},${c.position[i * 3 + 2]}`;
    const attributes = [
      c.position[i * 3 + 1],
      ...c.flow.subarray(i * 4, i * 4 + 4),
      ...c.coord.subarray(i * 2, i * 2 + 2),
    ];
    if (shared.has(key)) {
      assert.deepEqual(attributes, shared.get(key), "shared vertex attributes");
      copies++;
    } else shared.set(key, attributes);
  }
  for (let k = 0; k < c.index.length; k += 3) {
    const ids = [c.index[k], c.index[k + 1], c.index[k + 2]];
    const p = ids.map((i) => [c.position[i * 3], c.position[i * 3 + 2]]);
    for (
      let z = Math.floor(Math.min(...p.map((v) => v[1])) / 2);
      z <= Math.floor(Math.max(...p.map((v) => v[1])) / 2);
      z++
    )
      for (
        let x = Math.floor(Math.min(...p.map((v) => v[0])) / 2);
        x <= Math.floor(Math.max(...p.map((v) => v[0])) / 2);
        x++
      ) {
        const key = `${x},${z}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(p);
      }
    faces++;
  }
}
function count(x, z, includeBoundary = false) {
  let hits = 0;
  for (const p of buckets.get(`${Math.floor(x / 2)},${Math.floor(z / 2)}`) ||
    []) {
    const [a, b, c] = p,
      den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / den;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / den;
    if (
      includeBoundary
        ? u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7
        : u > 1e-7 && v > 1e-7 && u + v < 1 - 1e-7
    )
      hits++;
  }
  return hits;
}
const incoming = new Map();
for (const s of riverSegments) {
  const a = incoming.get(s.receiver) || [];
  a.push(s);
  incoming.set(s.receiver, a);
}
let checks = 0,
  wet = 0;
for (const arms of incoming.values()) {
  if (arms.length < 2) continue;
  const s = arms[0];
  if (Math.abs(s.bx) > 1980 || Math.abs(s.bz) > 1980) continue;
  for (let z = -12.73; z < 13; z += 0.83)
    for (let x = -12.37; x < 13; x += 0.79) {
      const hits = count(s.bx + x, s.bz + z);
      assert.ok(hits <= 1, "no double water at confluence");
      checks++;
      if (hits) wet++;
    }
  // The channel centre at each junction must remain wet and covered once.
  assert.equal(count(s.bx + 0.113, s.bz + 0.071), 1, "no hole in confluence");
}
assert.ok(copies > 100 && wet > 1000);
let centres = 0;
for (const s of riverSegments) {
  for (const t of [0.137, 0.517, 0.879]) {
    const x = s.ax + (s.bx - s.ax) * t + 0.013,
      z = s.az + (s.bz - s.az) * t + 0.017;
    if (Math.abs(x) > 1998 || Math.abs(z) > 1998) continue;
    // A point on a shared diagonal belongs to both adjacent closed triangles.
    // Strict interiors above test overlap; closed triangles here test coverage.
    assert.ok(count(x, z, true) >= 1, `channel centre coverage ${x},${z}`);
    centres++;
  }
}
const synthetic = (ax, az, bx, bz) => {
  const length = Math.hypot(bx - ax, bz - az);
  return {
    ax,
    az,
    bx,
    bz,
    ay: 2,
    by: 1,
    wa: 3,
    wb: 4,
    length,
    fx: (bx - ax) / length,
    fz: (bz - az) / length,
  };
};
assert.equal(
  buildRiverData(() => 4, { segments: [synthetic(-20, 0, 20, 0)], extent: 100 })
    .chunks.length,
  0,
  "fully dry terrain produces no water",
);
assert.equal(buildRiverData(() => 0, { segments: [] }).chunks.length, 0);
console.log({
  passed: true,
  pages: riverData.chunks.length,
  faces,
  bytes,
  sharedVertices: copies,
  confluenceSamples: checks,
  wetSamples: wet,
  centreSamples: centres,
});
