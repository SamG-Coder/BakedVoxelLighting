import { fbm, noise } from "./terrain-noise.js";

// A regional solve surrounds the playable square. Every consumer (including
// workers) uses this deterministic, compact graph, never a per-frame simulation.
export const WATERSHED_VERSION = "catchments-1";
const N = 257,
  EXTENT = 5120,
  HALF = EXTENT / 2,
  STEP = EXTENT / (N - 1);
const COUNT = N * N;
const elevation = new Float32Array(COUNT);
const parent = new Int32Array(COUNT);
const area = new Float32Array(COUNT);
const order = new Uint32Array(COUNT);
const heap = new Uint32Array(COUNT);
const visited = new Uint8Array(COUNT);
let heapSize = 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

for (let z = 0; z < N; z++)
  for (let x = 0; x < N; x++) {
    const wx = x * STEP - HALF,
      wz = z * STEP - HALF;
    const lateral = Math.abs(wx + 280 + (noise(wz * 0.0007, 31) - 0.5) * 260);
    const ridge = Math.pow(lateral / 2300, 1.18);
    elevation[z * N + x] =
      18 +
      (wz + HALF) * 0.018 +
      ridge * 330 +
      (fbm(wx * 0.0018 + 73, wz * 0.0018 - 51) - 0.35) *
        150 *
        Math.min(1, lateral / 380) +
      (fbm(wx * 0.005 + 4, wz * 0.005 - 17) - 0.5) * 32;
  }
function push(i) {
  let p = heapSize++;
  while (p) {
    const q = (p - 1) >> 1;
    if (elevation[heap[q]] <= elevation[i]) break;
    heap[p] = heap[q];
    p = q;
  }
  heap[p] = i;
}
function pop() {
  const result = heap[0],
    last = heap[--heapSize];
  let p = 0;
  while (p * 2 + 1 < heapSize) {
    let q = p * 2 + 1;
    if (q + 1 < heapSize && elevation[heap[q + 1]] < elevation[heap[q]]) q++;
    if (elevation[last] <= elevation[heap[q]]) break;
    heap[p] = heap[q];
    p = q;
  }
  heap[p] = last;
  return result;
}
function drain() {
  visited.fill(0);
  parent.fill(-1);
  area.fill(STEP * STEP);
  heapSize = 0;
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      if (x && z && x !== N - 1 && z !== N - 1) continue;
      const i = z * N + x;
      visited[i] = 1;
      push(i);
    }
  let count = 0;
  while (heapSize) {
    const i = pop(),
      x = i % N,
      z = Math.floor(i / N);
    order[count++] = i;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (
          (!dx && !dz) ||
          x + dx < 0 ||
          x + dx >= N ||
          z + dz < 0 ||
          z + dz >= N
        )
          continue;
        const j = i + dz * N + dx;
        if (visited[j]) continue;
        visited[j] = 1;
        // The flood traversal resolves flats and pits with an explicit downhill
        // receiver. A small gradient avoids zero-direction water at filled pits.
        elevation[j] = Math.max(elevation[j], elevation[i] + 0.015);
        parent[j] = i;
        push(j);
      }
  }
  for (let k = COUNT - 1; k >= 0; k--) {
    const i = order[k];
    if (parent[i] >= 0) area[parent[i]] += area[i];
  }
}
// Stream-power-inspired incision: drainage accumulation and slope determine
// erosion. Re-route between passes, so tributaries and ridges evolve together.
for (let pass = 0; pass < 5; pass++) {
  drain();
  for (let k = COUNT - 1; k >= 0; k--) {
    const i = order[k],
      p = parent[i];
    if (p < 0) continue;
    const drop = elevation[i] - elevation[p];
    elevation[i] -= Math.min(
      drop * 0.35,
      3.2 * Math.sqrt(area[i] / 40000) * Math.pow(drop / STEP, 0.7),
    );
  }
}
drain();

const channel = new Uint8Array(COUNT);
const majorChild = new Int32Array(COUNT);
majorChild.fill(-1);
const px = new Float32Array(COUNT),
  pz = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) {
  px[i] = (i % N) * STEP - HALF;
  pz[i] = Math.floor(i / N) * STEP - HALF;
  channel[i] = area[i] >= 180000 ? 1 : 0;
  const p = parent[i];
  if (p >= 0 && (majorChild[p] < 0 || area[i] > area[majorChild[p]]))
    majorChild[p] = i;
}
// Smooth channel coordinates without changing connectivity or water elevations.
for (let i = 0; i < COUNT; i++) {
  const p = parent[i],
    c = majorChild[i];
  if (!channel[i] || p < 0 || c < 0 || !channel[c]) continue;
  px[i] =
    ((i % N) * STEP - HALF) * 0.5 +
    ((p % N) + (c % N)) * STEP * 0.25 -
    HALF * 0.5;
  pz[i] =
    (Math.floor(i / N) * STEP - HALF) * 0.5 +
    (Math.floor(p / N) + Math.floor(c / N)) * STEP * 0.25 -
    HALF * 0.5;
}
const widths = new Float32Array(COUNT),
  station = new Float32Array(COUNT);
for (let k = 0; k < COUNT; k++) {
  const i = order[k],
    p = parent[i];
  widths[i] = clamp(1.1 + Math.sqrt(area[i] / 1e6) * 1.65, 1.4, 11);
  if (p >= 0)
    station[i] = station[p] + Math.hypot(px[i] - px[p], pz[i] - pz[p]);
}
export const riverSegments = [];
for (let i = 0; i < COUNT; i++) {
  const p = parent[i];
  if (!channel[i] || p < 0) continue;
  const dx = px[p] - px[i],
    dz = pz[p] - pz[i],
    length = Math.hypot(dx, dz);
  riverSegments.push({
    id: riverSegments.length,
    node: i,
    receiver: p,
    ax: px[i],
    az: pz[i],
    ay: elevation[i],
    bx: px[p],
    bz: pz[p],
    by: elevation[p],
    wa: widths[i],
    wb: widths[p],
    area: area[i],
    length,
    fx: dx / length,
    fz: dz / length,
    station: station[i],
  });
}

// Raster index of the nearest channel, with a halo for interpolation. Local
// consumers evaluate exact segment distance from four indexed candidates.
const INDEX_N = 641,
  INDEX_STEP = EXTENT / (INDEX_N - 1);
const nearest = new Int32Array(INDEX_N * INDEX_N);
nearest.fill(-1);
const distance2 = new Float32Array(nearest.length);
distance2.fill(Infinity);
for (const s of riverSegments) {
  const radius = 200;
  const x0 = clamp(
    Math.floor((Math.min(s.ax, s.bx) - radius + HALF) / INDEX_STEP),
    0,
    INDEX_N - 1,
  );
  const x1 = clamp(
    Math.ceil((Math.max(s.ax, s.bx) + radius + HALF) / INDEX_STEP),
    0,
    INDEX_N - 1,
  );
  const z0 = clamp(
    Math.floor((Math.min(s.az, s.bz) - radius + HALF) / INDEX_STEP),
    0,
    INDEX_N - 1,
  );
  const z1 = clamp(
    Math.ceil((Math.max(s.az, s.bz) + radius + HALF) / INDEX_STEP),
    0,
    INDEX_N - 1,
  );
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const wx = x * INDEX_STEP - HALF,
        wz = z * INDEX_STEP - HALF;
      const t = clamp(
        ((wx - s.ax) * s.fx + (wz - s.az) * s.fz) / s.length,
        0,
        1,
      );
      const d =
        (wx - s.ax - s.fx * s.length * t) ** 2 +
        (wz - s.az - s.fz * s.length * t) ** 2;
      const j = z * INDEX_N + x;
      if (d < distance2[j]) {
        distance2[j] = d;
        nearest[j] = s.id;
      }
    }
}
export function sampleHydrology(x, z, out) {
  const gx = clamp(Math.floor((x + HALF) / INDEX_STEP), 0, INDEX_N - 2);
  const gz = clamp(Math.floor((z + HALF) / INDEX_STEP), 0, INDEX_N - 2);
  let best = Infinity,
    found = -1,
    along = 0;
  for (let dz = 0; dz < 2; dz++)
    for (let dx = 0; dx < 2; dx++) {
      const id = nearest[(gz + dz) * INDEX_N + gx + dx];
      if (id < 0) continue;
      const s = riverSegments[id];
      const t = clamp(((x - s.ax) * s.fx + (z - s.az) * s.fz) / s.length, 0, 1);
      const d =
        (x - s.ax - s.fx * s.length * t) ** 2 +
        (z - s.az - s.fz * s.length * t) ** 2;
      if (d < best) {
        best = d;
        found = id;
        along = t;
      }
    }
  out.distance = Math.sqrt(best);
  out.segment = found;
  if (found < 0) {
    out.level = 0;
    out.width = 0;
    out.wetness = 0;
    return out;
  }
  const s = riverSegments[found];
  out.level = s.ay + (s.by - s.ay) * along;
  out.width = s.wa + (s.wb - s.wa) * along;
  out.wetness = Math.exp(
    -Math.max(0, out.distance - out.width) / (14 + out.width * 3),
  );
  return out;
}
export function regionalHeight(x, z) {
  const gx = clamp((x + HALF) / STEP, 0, N - 1.001),
    gz = clamp((z + HALF) / STEP, 0, N - 1.001);
  const ix = Math.floor(gx),
    iz = Math.floor(gz),
    u = gx - ix,
    v = gz - iz,
    i = iz * N + ix;
  return (
    (elevation[i] * (1 - u) + elevation[i + 1] * u) * (1 - v) +
    (elevation[i + N] * (1 - u) + elevation[i + N + 1] * u) * v
  );
}
export const watershedStats = {
  grid: N,
  regionalExtent: EXTENT,
  segments: riverSegments.length,
  channelMetres: riverSegments.reduce((sum, s) => sum + s.length, 0),
  minHeight: elevation.reduce((a, b) => Math.min(a, b), Infinity),
  maxHeight: elevation.reduce((a, b) => Math.max(a, b), -Infinity),
};
