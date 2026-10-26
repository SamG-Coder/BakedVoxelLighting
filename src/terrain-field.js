import {
  noise,
  fbm,
  riverCenter,
  riverLevel,
  landscape,
  TERRAIN_SIZE,
} from "./terrain-math.js";
import { copyTerrainRegion } from "./terrain-snapshot.js";
export {
  riverCenter,
  riverLevel,
  landscape,
  TERRAIN_SIZE,
} from "./terrain-math.js";
// Deterministic erosion and slope-aware foot traffic. Units are metres.
export const TERRAIN_GRID = 2001;
const N = TERRAIN_GRID,
  CELL = TERRAIN_SIZE / (N - 1);
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const canopyInfluence = new Float32Array(N * N);
export const rootInfluence = new Float32Array(N * N);
const heights = new Float32Array(N * N),
  original = new Float32Array(N * N),
  drainage = new Float32Array(N * N),
  traffic = new Float32Array(N * N),
  moisture = new Float32Array(N * N),
  slopes = new Float32Array(N * N);
for (let z = 0; z < N; z++)
  for (let x = 0; x < N; x++) {
    const wx = x * CELL - TERRAIN_SIZE / 2,
      wz = z * CELL - TERRAIN_SIZE / 2;
    const valley = Math.exp(
      -Math.pow((wx - 15 * Math.sin(wz * 0.012)) / 49, 2),
    );
    heights[z * N + x] =
      fbm(wx * 0.0011 - 30, wz * 0.0011 + 60) * 95 +
      fbm(wx * 0.009 + 30, wz * 0.009 + 50) * 25 +
      fbm(wx * 0.035 + 10, wz * 0.035 + 10) * 3 -
      valley * 7 -
      8;
  }
original.set(heights);
function sampleGrid(field, x, z) {
  x = Math.max(0, Math.min(N - 1.001, x));
  z = Math.max(0, Math.min(N - 1.001, z));
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = x - ix,
    v = z - iz,
    i = iz * N + ix;
  return (
    (field[i] * (1 - u) + field[i + 1] * u) * (1 - v) +
    (field[i + N] * (1 - u) + field[i + N + 1] * u) * v
  );
}
function add(field, x, z, amount) {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = x - ix,
    v = z - iz,
    i = iz * N + ix;
  field[i] += amount * (1 - u) * (1 - v);
  field[i + 1] += amount * u * (1 - v);
  field[i + N] += amount * (1 - u) * v;
  field[i + N + 1] += amount * u * v;
}
const rand = rng(107731);
let eroded = 0,
  deposited = 0;
// Hydraulic droplets carry sediment downhill; capacity falls with slope and water.
for (let d = 0; d < 42000; d++) {
  let x = 2 + rand() * (N - 5),
    z = 2 + rand() * (N - 5),
    dx = 0,
    dz = 0,
    water = 1,
    speed = 1,
    sediment = 0;
  for (let step = 0; step < 45; step++) {
    const h = sampleGrid(heights, x, z),
      gx = sampleGrid(heights, x + 0.5, z) - sampleGrid(heights, x - 0.5, z),
      gz = sampleGrid(heights, x, z + 0.5) - sampleGrid(heights, x, z - 0.5);
    dx = dx * 0.25 - gx * 0.75;
    dz = dz * 0.25 - gz * 0.75;
    const len = Math.hypot(dx, dz);
    if (len < 0.00001) break;
    dx /= len;
    dz /= len;
    const nx = x + dx,
      nz = z + dz;
    if (nx < 2 || nz < 2 || nx > N - 3 || nz > N - 3) break;
    const nh = sampleGrid(heights, nx, nz),
      drop = h - nh;
    const cap = Math.max(0.015, drop) * speed * water * 3.2;
    if (sediment > cap || drop < 0) {
      const put = drop < 0 ? Math.min(sediment, -drop) : (sediment - cap) * 0.2;
      add(heights, x, z, put);
      sediment -= put;
      deposited += put;
    } else {
      const take = Math.min((cap - sediment) * 0.18, Math.max(0, drop) * 0.35);
      add(heights, x, z, -take);
      sediment += take;
      eroded += take;
    }
    drainage[Math.floor(z) * N + Math.floor(x)] += water;
    speed = Math.sqrt(Math.max(0.05, speed * speed + drop * 2.5));
    water *= 0.965;
    x = nx;
    z = nz;
  }
  if (sediment > 0) {
    add(heights, x, z, sediment);
    deposited += sediment;
  }
}
// Thermal relaxation moves material off excessively steep local slopes.
for (let pass = 0; pass < 7; pass++) {
  const delta = new Float32Array(N * N);
  for (let z = 1; z < N - 1; z++)
    for (let x = 1; x < N - 1; x++) {
      const i = z * N + x;
      for (const off of [1, N]) {
        const diff = heights[i] - heights[i + off],
          move = Math.max(0, Math.abs(diff) - CELL * 0.68) * 0.12;
        if (move) {
          delta[i] -= Math.sign(diff) * move;
          delta[i + off] += Math.sign(diff) * move;
        }
      }
    }
  for (let i = 0; i < heights.length; i++) heights[i] += delta[i];
}
// Incise one continuous, downhill channel after erosion; blend floodplain into the hills.
for (let z = 0; z < N; z++)
  for (let x = 0; x < N; x++) {
    const wx = x * CELL - TERRAIN_SIZE / 2,
      wz = z * CELL - TERRAIN_SIZE / 2,
      d = Math.abs(wx - riverCenter(wz)),
      i = z * N + x;
    const bank = riverLevel(wz) - 1.6 + Math.pow(d / 8, 2) * 1.8;
    const blend = Math.max(0, 1 - d / 320);
    const smooth = blend * blend * (3 - 2 * blend);
    heights[i] = Math.min(
      heights[i],
      heights[i] * (1 - smooth) +
        (riverLevel(wz) + Math.min(15, d * 0.18)) * smooth,
    );
    if (d < 11) heights[i] = Math.min(heights[i], bank);
  }
for (let z = 0; z < N; z++)
  for (let x = 0; x < N; x++) {
    const i = z * N + x,
      gx =
        (sampleGrid(heights, x + 1, z) - sampleGrid(heights, x - 1, z)) /
        (2 * CELL),
      gz =
        (sampleGrid(heights, x, z + 1) - sampleGrid(heights, x, z - 1)) /
        (2 * CELL);
    slopes[i] = Math.hypot(gx, gz);
    moisture[i] = Math.min(
      1,
      0.18 +
        0.55 *
          Math.exp(
            -Math.abs(
              x * CELL -
                TERRAIN_SIZE / 2 -
                riverCenter(z * CELL - TERRAIN_SIZE / 2),
            ) / 40,
          ) +
        Math.log1p(drainage[i]) * 0.13 +
        Math.max(0, original[i] - heights[i]) * 0.25,
    );
  }
// Min-heap Dijkstra routing: humans prefer gentle slopes and avoid wet channels.
class Heap {
  constructor() {
    this.a = [];
  }
  push(item) {
    let i = this.a.length;
    this.a.push(item);
    while (i) {
      const p = (i - 1) >> 1;
      if (this.a[p][0] <= item[0]) break;
      this.a[i] = this.a[p];
      i = p;
    }
    this.a[i] = item;
  }
  pop() {
    const first = this.a[0],
      last = this.a.pop();
    if (this.a.length) {
      let i = 0;
      while (i * 2 + 1 < this.a.length) {
        let c = i * 2 + 1;
        if (c + 1 < this.a.length && this.a[c + 1][0] < this.a[c][0]) c++;
        if (this.a[c][0] >= last[0]) break;
        this.a[i] = this.a[c];
        i = c;
      }
      this.a[i] = last;
    }
    return first;
  }
}
function gridPoint(p) {
  return [
    Math.round((p[0] + TERRAIN_SIZE / 2) / CELL),
    Math.round((p[1] + TERRAIN_SIZE / 2) / CELL),
  ];
}
function route(from, to, width, wear) {
  const [sx, sz] = gridPoint(from),
    [tx, tz] = gridPoint(to),
    start = sz * N + sx,
    end = tz * N + tx,
    cost = new Float64Array(N * N);
  cost.fill(Infinity);
  const prev = new Int32Array(N * N);
  prev.fill(-1);
  cost[start] = 0;
  const heap = new Heap();
  heap.push([0, start]);
  while (heap.a.length) {
    const [c, i] = heap.pop();
    if (c > cost[i]) continue;
    if (i === end) break;
    const x = i % N,
      z = Math.floor(i / N);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const xx = x + dx,
          zz = z + dz;
        if (xx < 2 || zz < 2 || xx > N - 3 || zz > N - 3) continue;
        const j = zz * N + xx,
          dist = Math.hypot(dx, dz) * CELL,
          grade = Math.abs(heights[j] - heights[i]) / dist,
          edge =
            dist *
            (1 +
              grade * grade * 32 +
              Math.max(0, moisture[j] - 0.7) * 2 +
              noise(xx * 0.06, zz * 0.06) * 0.15);
        const nc = c + edge;
        if (nc < cost[j]) {
          cost[j] = nc;
          prev[j] = i;
          heap.push([nc, j]);
        }
      }
  }
  const path = [];
  for (let i = end; i !== -1; i = prev[i]) {
    path.push([
      (i % N) * CELL - TERRAIN_SIZE / 2,
      Math.floor(i / N) * CELL - TERRAIN_SIZE / 2,
    ]);
    if (i === start) break;
  }
  path.reverse();
  // Repeated smoothing models corners worn by walkers, then splat traffic density.
  for (let pass = 0; pass < 4; pass++)
    for (let k = 1; k < path.length - 1; k++) {
      path[k][0] = (path[k - 1][0] + path[k][0] * 2 + path[k + 1][0]) / 4;
      path[k][1] = (path[k - 1][1] + path[k][1] * 2 + path[k + 1][1]) / 4;
    }
  for (const p of path) {
    const [gx, gz] = gridPoint(p),
      radius = Math.ceil((width * 2) / CELL);
    for (let z = gz - radius; z <= gz + radius; z++)
      for (let x = gx - radius; x <= gx + radius; x++) {
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const dist = Math.hypot(
            x * CELL - TERRAIN_SIZE / 2 - p[0],
            z * CELL - TERRAIN_SIZE / 2 - p[1],
          ),
          v = Math.exp(-(dist * dist) / (width * width * 0.48)) * wear;
        traffic[z * N + x] = Math.max(traffic[z * N + x], v);
      }
  }
  return path;
}
export const routes = [
  route([6, TERRAIN_SIZE / 2 - 30], [-7, -TERRAIN_SIZE / 2 + 30], 4.2, 1),
  route([-4, 12], [290, -180], 2.3, 0.7),
  route([-6, -30], [-310, -260], 1.7, 0.45),
];
// Cleared verge, built once from the road curves for indexed tree lookups.
const roadVerge = new Uint8Array(N * N);
routes.forEach((path, routeIndex) => {
  const radius = [4.2, 2.3, 1.7][routeIndex] + 5;
  const steps = Math.ceil(radius / CELL);
  for (const [px, pz] of path) {
    const [gx, gz] = gridPoint([px, pz]);
    for (let z = Math.max(0, gz - steps); z <= Math.min(N - 1, gz + steps); z++)
      for (
        let x = Math.max(0, gx - steps);
        x <= Math.min(N - 1, gx + steps);
        x++
      )
        if (
          Math.hypot(
            x * CELL - TERRAIN_SIZE / 2 - px,
            z * CELL - TERRAIN_SIZE / 2 - pz,
          ) < radius
        )
          roadVerge[z * N + x] = 1;
  }
});
export function inRoadVerge(x, z) {
  return (
    sampleGrid(
      roadVerge,
      (x + TERRAIN_SIZE / 2) / CELL,
      (z + TERRAIN_SIZE / 2) / CELL,
    ) > 0.01
  );
}
// Compact heavily used soil slightly; the terrain and material mask share this result.
for (let i = 0; i < heights.length; i++) heights[i] -= 0.12 * traffic[i];
export function terrainSample(x, z) {
  const gx = (x + TERRAIN_SIZE / 2) / CELL,
    gz = (z + TERRAIN_SIZE / 2) / CELL;
  return {
    height: sampleGrid(heights, gx, gz),
    traffic: sampleGrid(traffic, gx, gz),
    moisture: sampleGrid(moisture, gx, gz),
    slope: sampleGrid(slopes, gx, gz),
    root: sampleGrid(rootInfluence, gx, gz),
    canopy: sampleGrid(canopyInfluence, gx, gz),
    ...landscape(x, z),
  };
}
export function terrainHeight(x, z) {
  return sampleGrid(
    heights,
    (x + TERRAIN_SIZE / 2) / CELL,
    (z + TERRAIN_SIZE / 2) / CELL,
  );
}
export const terrainPixels = new Float32Array(N * N * 4);
for (let i = 0; i < heights.length; i++)
  terrainPixels.set([heights[i], traffic[i], moisture[i], slopes[i]], i * 4);
export const terrainStats = {
  droplets: 42000,
  steps: 45,
  eroded,
  deposited,
  grid: N,
  extent: TERRAIN_SIZE,
  routes: routes.map((p) => p.length),
  maxChange: heights.reduce(
    (m, h, i) => Math.max(m, Math.abs(h - original[i])),
    0,
  ),
};
export const terrainSamplingGLSL = `uniform sampler2D terrainField;
vec4 terrainData(vec2 p){vec2 uv=clamp((p+${(TERRAIN_SIZE / 2).toFixed(1)})/${TERRAIN_SIZE.toFixed(1)},0.,1.);vec2 g=uv*${N - 1}.;ivec2 a=ivec2(min(floor(g),vec2(${N - 2}.)));vec2 f=fract(g);return mix(mix(texelFetch(terrainField,a,0),texelFetch(terrainField,a+ivec2(1,0),0),f.x),mix(texelFetch(terrainField,a+ivec2(0,1),0),texelFetch(terrainField,a+ivec2(1,1),0),f.x),f.y);}
float terrain(vec2 p){return terrainData(p).r;}`;

export function applyTreeInfluence(trees) {
  for (const tree of trees) {
    const crownRadius =
        [5.8, 4.3, 5.3, 4.6][tree.variant % 4] *
        tree.scale *
        [0.6, 1, 1.24][Math.floor(tree.variant / 4)],
      radius = 3.6 * tree.scale,
      gx = (tree.x + TERRAIN_SIZE / 2) / CELL,
      gz = (tree.z + TERRAIN_SIZE / 2) / CELL,
      steps = Math.ceil(Math.max(radius * 2, crownRadius) / CELL);
    for (
      let z = Math.max(0, Math.floor(gz) - steps);
      z <= Math.min(N - 1, Math.ceil(gz) + steps);
      z++
    )
      for (
        let x = Math.max(0, Math.floor(gx) - steps);
        x <= Math.min(N - 1, Math.ceil(gx) + steps);
        x++
      ) {
        const dx = x * CELL - TERRAIN_SIZE / 2 - tree.x,
          dz = z * CELL - TERRAIN_SIZE / 2 - tree.z,
          a = Math.atan2(dz, dx),
          r = Math.hypot(dx, dz),
          irregular = 1 + 0.17 * Math.sin(a * 5 + tree.seed);
        const value = Math.exp(-Math.pow(r / (radius * irregular), 2) * 1.8);
        const index = z * N + x;
        rootInfluence[index] = Math.max(rootInfluence[index], value);
        if (r < crownRadius) {
          const shade =
            [0.86, 0.65, 0.74, 0.86][tree.variant % 4] *
            Math.pow(1 - (r / crownRadius) ** 2, 0.55);
          canopyInfluence[index] =
            1 - (1 - canopyInfluence[index]) * (1 - shade);
        }
      }
  }
  for (let i = 0; i < heights.length; i++) {
    heights[i] += 0.12 * Math.pow(rootInfluence[i], 2);
    terrainPixels[i * 4] = heights[i];
  }
}

// Copy only the addressed grid rows. Workers do all interpolation and habitat noise.
export function snapshotTerrain(x0, z0, x1, z1) {
  return copyTerrainRegion(
    terrainPixels,
    rootInfluence,
    N,
    TERRAIN_SIZE,
    x0,
    z0,
    x1,
    z1,
    canopyInfluence,
  );
}
