import {
  noise,
  fbm,
  TERRAIN_SIZE,
  regionalHeight,
  sampleHydrology,
  SEA_LEVEL,
} from "./terrain-math.js";
import { riverSegments, coastLine } from "./watershed.js";
import { bankExposure, bankGravel } from "./riverbank.js";
import { carveRiverHeight } from "./river-profile.js";
import { buildRiverData } from "./river-data.js";
import { nearestRoutePoint } from "./route-network.js";
export function generateTerrain() {
  const N = 2001,
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
  const heights = new Float32Array(N * N),
    original = new Float32Array(N * N),
    drainage = new Float32Array(N * N),
    traffic = new Float32Array(N * N),
    moisture = new Float32Array(N * N),
    slopes = new Float32Array(N * N),
    // R/G are populated with root wear/canopy after tree placement. B/A hold
    // bank exposure/gravel; transfer this buffer directly to the GPU texture.
    groundInfluence = new Uint8Array(N * N * 4);
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      const wx = x * CELL - TERRAIN_SIZE / 2,
        wz = z * CELL - TERRAIN_SIZE / 2;
      const regional = regionalHeight(wx, wz);
      // Keep small-scale relief out of the shore zone; the nearshore follows
      // the smooth equilibrium profile instead of forming bars and hollows.
      const away = Math.min(
        1,
        Math.max(0, (Math.abs(regional - SEA_LEVEL) - 1.5) / 5),
      );
      heights[z * N + x] =
        regional +
        (fbm(wx * 0.028 + 10, wz * 0.028 - 13) - 0.5) *
          2.4 *
          Math.max(0.08, away * away * (3 - 2 * away));
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
        const put =
          drop < 0 ? Math.min(sediment, -drop) : (sediment - cap) * 0.2;
        add(heights, x, z, put);
        sediment -= put;
        deposited += put;
      } else {
        const take = Math.min(
          (cap - sediment) * 0.18,
          Math.max(0, drop) * 0.35,
        );
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
  // Waves plane the intertidal zone: droplet erosion carves rills across
  // beaches that real swash smooths away within a tide. Blend heights near
  // sea level towards a broad (~12 m) blur, keeping the beach profile.
  {
    let z0 = N,
      z1 = -1;
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x += 4) {
        const h = heights[z * N + x];
        if (h > SEA_LEVEL - 7 && h < SEA_LEVEL + 6) {
          z0 = Math.min(z0, z);
          z1 = Math.max(z1, z);
        }
      }
    if (z1 >= 0) {
      const r = 6,
        rows = Math.min(N - 1, z1 + r * 3) - Math.max(0, z0 - r * 3) + 1,
        base = Math.max(0, z0 - r * 3) * N,
        a = heights.slice(base, base + rows * N),
        b = new Float32Array(a.length);
      for (let pass = 0; pass < 3; pass++) {
        for (let z = 0; z < rows; z++) {
          let sum = 0;
          for (let x = -r; x <= r; x++)
            sum += a[z * N + Math.max(0, Math.min(N - 1, x))];
          for (let x = 0; x < N; x++) {
            b[z * N + x] = sum / (2 * r + 1);
            sum +=
              a[z * N + Math.min(N - 1, x + r + 1)] -
              a[z * N + Math.max(0, x - r)];
          }
        }
        for (let x = 0; x < N; x++) {
          let sum = 0;
          for (let z = -r; z <= r; z++)
            sum += b[Math.max(0, Math.min(rows - 1, z)) * N + x];
          for (let z = 0; z < rows; z++) {
            a[z * N + x] = sum / (2 * r + 1);
            sum +=
              b[Math.min(rows - 1, z + r + 1) * N + x] -
              b[Math.max(0, z - r) * N + x];
          }
        }
      }
      for (let i = 0; i < a.length; i++) {
        const h = heights[base + i],
          t = Math.min(
            Math.max(0, Math.min(1, (h - (SEA_LEVEL - 7)) / 3)),
            Math.max(0, Math.min(1, (SEA_LEVEL + 6 - h) / 3)),
          ),
          w = t * t * (3 - 2 * t);
        heights[base + i] = h + (a[i] - h) * w;
      }
    }
  }
  // Carve all connected reaches, preserving the graph's downhill water surface.
  const hydrology = {};
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      const wx = x * CELL - TERRAIN_SIZE / 2,
        wz = z * CELL - TERRAIN_SIZE / 2;
      const h = sampleHydrology(wx, wz, hydrology),
        i = z * N + x;
      if (h.distance > h.width + 30) continue;
      const bank = bankExposure(wx, wz, h.distance - h.width + 8);
      if (bank > 0) {
        groundInfluence[i * 4 + 2] = Math.round(bank * 255);
        groundInfluence[i * 4 + 3] = Math.round(bankGravel(wx, wz) * 255);
      }
      const carved = carveRiverHeight(heights[i], wx, wz, h);
      // Near and below sea level river shaping may only deepen: raising banks
      // to river level there pushed the seabed up into blobby islands.
      const coastal = Math.max(
        0,
        Math.min(1, (SEA_LEVEL + 2.5 - heights[i]) / 2),
      );
      heights[i] =
        carved * (1 - coastal) + Math.min(heights[i], carved) * coastal;
    }
  // River mouths: the coastal beach builds a berm across every outlet, which
  // left rivers dead-ending in lagoons. Carve each terminal reach out to the
  // sea as an estuary that flares and deepens into the nearshore profile.
  {
    const outgoing = new Set(riverSegments.map((s) => s.node));
    for (const s of riverSegments) {
      if (outgoing.has(s.receiver) || s.area < 300000) continue;
      if (
        Math.abs(s.bx) > TERRAIN_SIZE / 2 ||
        Math.abs(s.bz) > TERRAIN_SIZE / 2
      )
        continue;
      if (s.by > SEA_LEVEL + 3) continue;
      // Head seawards: the coast runs east-west, open water lies to -z.
      const ax = s.bx,
        az = s.bz,
        bx = s.bx + s.fx * 20,
        bz = coastLine(s.bx) - 90;
      const length = Math.hypot(bx - ax, bz - az),
        ux = (bx - ax) / length,
        uz = (bz - az) / length;
      const maxHalf = s.wb * 3.5 + 10;
      const x0 = Math.max(
          0,
          Math.floor((Math.min(ax, bx) - maxHalf + TERRAIN_SIZE / 2) / CELL),
        ),
        x1 = Math.min(
          N - 1,
          Math.ceil((Math.max(ax, bx) + maxHalf + TERRAIN_SIZE / 2) / CELL),
        ),
        z0 = Math.max(
          0,
          Math.floor((Math.min(az, bz) - maxHalf + TERRAIN_SIZE / 2) / CELL),
        ),
        z1 = Math.min(
          N - 1,
          Math.ceil((Math.max(az, bz) + maxHalf + TERRAIN_SIZE / 2) / CELL),
        );
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const wx = x * CELL - TERRAIN_SIZE / 2,
            wz = z * CELL - TERRAIN_SIZE / 2;
          const along = (wx - ax) * ux + (wz - az) * uz,
            t = Math.max(0, Math.min(1, along / length));
          const d = Math.hypot(
            wx - ax - ux * length * t,
            wz - az - uz * length * t,
          );
          const flare = t * t * (3 - 2 * t);
          const half = s.wb * (1.3 + flare * 2.2) + 4;
          if (d > half * 1.25) continue;
          const bed =
            Math.min(s.by, SEA_LEVEL - 0.3) - (0.9 + s.wb * 0.08) - flare * 1.2;
          const cross = d / half,
            k = Math.max(0, Math.min(1, (cross - 0.55) / 0.7)),
            bank = k * k * (3 - 2 * k);
          const i = z * N + x;
          heights[i] = Math.min(heights[i], bed + (heights[i] - bed) * bank);
        }
    }
  }
  // River-bank exposure is a land feature; under the sea it showed through
  // the water as sand-coloured blobs. Fade it out across the waterline.
  for (let i = 0; i < N * N; i++) {
    const keep = Math.max(0, Math.min(1, (heights[i] - SEA_LEVEL - 0.2) / 0.8));
    groundInfluence[i * 4 + 2] = Math.round(groundInfluence[i * 4 + 2] * keep);
    groundInfluence[i * 4 + 3] = Math.round(groundInfluence[i * 4 + 3] * keep);
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
      sampleHydrology(
        x * CELL - TERRAIN_SIZE / 2,
        z * CELL - TERRAIN_SIZE / 2,
        hydrology,
      );
      moisture[i] = Math.min(
        1,
        0.22 +
          hydrology.wetness * 0.57 +
          Math.log1p(drainage[i]) * 0.07 +
          Math.max(0, original[i] - heights[i]) * 0.025 +
          Math.max(0, -gx) * 0.12,
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
  function route(from, to, width, wear, attach = false) {
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
    // Dijkstra uses a 2 m lattice. Preserve the exact segment attachment before
    // smoothing, so the road and its traffic/verge bake share the same junction.
    if (attach) path[0] = from.slice();
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
  const mainRoute = route(
    [6, TERRAIN_SIZE / 2 - 30],
    [-7, -TERRAIN_SIZE / 2 + 30],
    4.2,
    1,
  );
  const routes = [mainRoute];
  for (const [hint, destination, width, wear] of [
    [[-4, 12], [290, -180], 2.3, 0.7],
    [[-6, -30], [-310, -260], 1.7, 0.45],
  ]) {
    routes.push(
      route(nearestRoutePoint(mainRoute, hint), destination, width, wear, true),
    );
  }
  // Cleared verge, built once from the road curves for indexed tree lookups.
  const roadVerge = new Uint8Array(N * N);
  routes.forEach((path, routeIndex) => {
    const radius = [4.2, 2.3, 1.7][routeIndex] + 5;
    const steps = Math.ceil(radius / CELL);
    for (const [px, pz] of path) {
      const [gx, gz] = gridPoint([px, pz]);
      for (
        let z = Math.max(0, gz - steps);
        z <= Math.min(N - 1, gz + steps);
        z++
      )
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
  // Compact heavily used soil slightly; the terrain and material mask share this result.
  for (let i = 0; i < heights.length; i++) heights[i] -= 0.12 * traffic[i];
  const terrainStats = {
    droplets: 42000,
    steps: 45,
    eroded,
    deposited,
    grid: N,
    extent: TERRAIN_SIZE,
    generation: "regional-watersheds-connected-roads-v2",
    routes: routes.map((p) => p.length),
    maxChange: heights.reduce(
      (m, h, i) => Math.max(m, Math.abs(h - original[i])),
      0,
    ),
  };
  const riverData = buildRiverData((x, z) =>
    sampleGrid(
      heights,
      (x + TERRAIN_SIZE / 2) / CELL,
      (z + TERRAIN_SIZE / 2) / CELL,
    ),
  );
  return {
    heights,
    traffic,
    moisture,
    slopes,
    roadVerge,
    groundInfluence,
    routes,
    terrainStats,
    riverData,
  };
}
