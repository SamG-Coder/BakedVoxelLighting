import assert from "node:assert/strict";
import {
  riverData,
  terrainHeight,
  TERRAIN_SIZE,
} from "../src/terrain-field.js";
import { sampleHydrology } from "../src/watershed.js";
import { carveRiverHeight } from "../src/river-profile.js";
import {
  TERRAIN_TILE_COUNT,
  TERRAIN_FINE_SEGMENTS,
} from "../src/terrain-mesh-layout.js";

const size = TERRAIN_SIZE / TERRAIN_TILE_COUNT,
  step = size / TERRAIN_FINE_SEGMENTS;
// Sample the rendered triangle, not the bilinear erosion field. This caught
// shoreline gaps up to 66 cm with the old independent 2 m water lattice.
function ground(x, z) {
  const tx =
    Math.floor((x + TERRAIN_SIZE / 2) / size) * size - TERRAIN_SIZE / 2;
  const tz =
    Math.floor((z + TERRAIN_SIZE / 2) / size) * size - TERRAIN_SIZE / 2;
  const gx = (x - tx) / step,
    gz = (z - tz) / step;
  const ix = Math.floor(gx),
    iz = Math.floor(gz),
    u = gx - ix,
    v = gz - iz;
  const xx = tx + ix * step,
    zz = tz + iz * step;
  const a = terrainHeight(xx, zz),
    b = terrainHeight(xx, zz + step);
  const c = terrainHeight(xx + step, zz + step),
    d = terrainHeight(xx + step, zz);
  return u + v <= 1
    ? a + (d - a) * u + (b - a) * v
    : c + (b - c) * (1 - u) + (d - c) * (1 - v);
}
const edges = new Map();
let checked = 0,
  shore = 0,
  maxError = 0;
for (const chunk of riverData.chunks) {
  const p = chunk.position,
    flow = chunk.flow;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1],
      z = p[i + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    if (Math.abs(x) >= 1997 || Math.abs(z) >= 1997) continue;
    const error = Math.abs(y - ground(x, z) - flow[(i / 3) * 4 + 3]);
    maxError = Math.max(maxError, error);
    assert.ok(
      error < 0.002,
      `baked depth matches visible terrain at ${x},${z}: ${error}`,
    );
    checked++;
  }
  const cx =
    Math.floor(((minX + maxX) / 2 + 2000) / size) * size - 2000 + size / 2;
  const cz =
    Math.floor(((minZ + maxZ) / 2 + 2000) / size) * size - 2000 + size / 2;
  assert.ok(
    sampleHydrology(cx, cz, {}).distance < size * 0.75 + 20,
    "every wet terrain page retains the matching fine mesh at all distances",
  );
  for (let i = 0; i < chunk.index.length; i += 3)
    for (let j = 0; j < 3; j++) {
      const a = chunk.index[i + j],
        b = chunk.index[i + ((j + 1) % 3)];
      const ax = p[a * 3],
        az = p[a * 3 + 2],
        bx = p[b * 3],
        bz = p[b * 3 + 2];
      if ([ax, az, bx, bz].some((v) => Math.abs(v) >= 1997)) continue;
      const ka = `${ax},${az}`,
        kb = `${bx},${bz}`,
        key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const old = edges.get(key);
      if (old) old.uses++;
      else
        edges.set(key, {
          uses: 1,
          depth: Math.max(flow[a * 4 + 3], flow[b * 4 + 3]),
        });
    }
}
for (const edge of edges.values())
  if (edge.uses === 1) {
    assert.ok(
      edge.depth < 0.012,
      "water must meet the bank, not stop at a deep width cap",
    );
    shore++;
  }
assert.ok(checked > 50000 && shore > 1000);
for (const original of [8, 10, 30]) {
  const h = { level: 10, width: 8, distance: 8, cutBank: 0, pointBar: 0 };
  assert.equal(
    carveRiverHeight(original, 0, 0, h),
    10,
    "low floodplain still joins the waterline",
  );
  assert.ok(
    Math.abs(
      carveRiverHeight(original, 0, 0, { ...h, distance: 8 - 1e-5 }) -
        carveRiverHeight(original, 0, 0, { ...h, distance: 8 + 1e-5 }),
    ) < 1e-3,
  );
}
console.log({ checked, shorelineEdges: shore, maxDepthErrorMetres: maxError });
