// Nearshore swell transformation over the actual seabed (linear ray theory).
//
//  * Dispersion  w^2 = g k tanh(k h) gives the local wavenumber k(h).
//  * Refraction: the phase obeys the eikonal |grad phi| = k(h), solved by fast
//    sweeping from a deep-water plane wave. Crests bend towards the depth
//    contours and shorten in shallow water.
//  * Shoaling:   energy flux conservation, H = H0 sqrt(cg0 / cg).
//  * Breaking:   depth-limited, H <= gamma h with gamma = 0.78 (solitary-wave
//    breaker index; Bosboom & Stive, Coastal Dynamics 5.2.5).
//  * Run-up:     Stockdon et al. (2006) R2 = 1.1 (setup + swash / 2).
// Every value is fixed in world space; only the phase advances with time.

export const SHORE_SWELL = {
  period: 9,
  height: 1.1,
  gamma: 0.78,
  angle: 1.48,
};
export const SHORE_GRID = 1001;
const G = 9.81;

// Fenton & McKee explicit dispersion solution (better than 1.5%).
function wavenumber(h, omega) {
  const k0 = (omega * omega) / G,
    x = k0 * h;
  if (x <= 0) return Infinity;
  const coth = 1 / Math.tanh(Math.pow(x, 0.75));
  return k0 * Math.pow(coth, 2 / 3);
}

/**
 * @param heights  Float32Array stride `stride`, N x N samples over `size` m
 * @returns data: RGBA per cell (cos phase, sin phase, amplitude H/2, breaking)
 *          as a unit phasor that is zero where swell never arrives, so
 *          filtering never blends a real phase with "no wave"; runup: R2.
 */
export function computeShoreField(heights, N, size, stride = 4, sea = 0) {
  const M = SHORE_GRID,
    cell = size / (M - 1),
    step = (N - 1) / (M - 1),
    count = M * M;
  const { period, height: H0, gamma, angle } = SHORE_SWELL;
  const omega = (2 * Math.PI) / period,
    k0 = (omega * omega) / G,
    L0 = (2 * Math.PI) / k0,
    cg0 = G / (2 * omega);
  const dx = Math.cos(angle),
    dz = Math.sin(angle);
  const depth = new Float32Array(count),
    slowness = new Float32Array(count),
    phase = new Float64Array(count);
  for (let z = 0; z < M; z++)
    for (let x = 0; x < M; x++) {
      const gx = Math.min(N - 1, Math.round(x * step)),
        gz = Math.min(N - 1, Math.round(z * step));
      const i = z * M + x;
      depth[i] = sea - heights[(gz * N + gx) * stride];
    }
  const fixed = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const h = depth[i],
      px = (i % M) * cell - size / 2,
      pz = Math.floor(i / M) * cell - size / 2;
    // Pass 1 propagates through water only, so swell cannot leak over low
    // land into sheltered lagoons.
    slowness[i] = h > 0 ? wavenumber(Math.max(h, 0.25), omega) : Infinity;
    // The incoming swell is a plane wave where it enters the map.
    // Swell enters from deep water and from the open-sea edges of the map
    // (the shelf can be shallower than L0 / 2 everywhere inside it).
    const xi = i % M,
      zi = (i - xi) / M,
      edge = xi < 2 || zi < 2 || xi > M - 3 || zi > M - 3;
    phase[i] =
      h > Math.min(L0 * 0.45, 30) || (edge && h > 8)
        ? k0 * (px * dx + pz * dz)
        : Infinity;
    fixed[i] = Number.isFinite(phase[i]) ? 1 : 0;
  }
  // Fast sweeping (Zhao 2005): four Gauss-Seidel orderings, repeated.
  const update = (x, z) => {
    const i = z * M + x;
    if (fixed[i] || slowness[i] === Infinity) return;
    const a = Math.min(
        x > 0 ? phase[i - 1] : Infinity,
        x < M - 1 ? phase[i + 1] : Infinity,
      ),
      b = Math.min(
        z > 0 ? phase[i - M] : Infinity,
        z < M - 1 ? phase[i + M] : Infinity,
      );
    if (a === Infinity && b === Infinity) return;
    const f = slowness[i] * cell;
    let next;
    if (Math.abs(a - b) >= f) next = Math.min(a, b) + f;
    else next = (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b))) / 2;
    if (next < phase[i]) phase[i] = next;
  };
  const sweep = (iterations) => {
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) update(x, z);
      for (let z = 0; z < M; z++) for (let x = M - 1; x >= 0; x--) update(x, z);
      for (let z = M - 1; z >= 0; z--) for (let x = 0; x < M; x++) update(x, z);
      for (let z = M - 1; z >= 0; z--)
        for (let x = M - 1; x >= 0; x--) update(x, z);
    }
  };
  sweep(3);
  // Pass 2 carries the reached sea's phase up the beach (swash band, up to
  // 3 m above sea level) without re-entering any water. The swash zone rises
  // and falls as one water level (the shoreline moves along the height
  // contours), so the phase is nearly uniform there: a slow wavenumber gives a
  // small travel delay rather than several simultaneous run-up fronts.
  for (let i = 0; i < count; i++) {
    const h = depth[i];
    if (h > 0) {
      fixed[i] = 1;
      slowness[i] = Infinity;
    } else slowness[i] = h > -3 ? 0.02 : Infinity;
  }
  sweep(2);
  const out = new Float32Array(count * 4);
  const runup = new Float32Array(count),
    smoothRunup = new Float32Array(count);
  for (let z = 0; z < M; z++)
    for (let x = 0; x < M; x++) {
      const i = z * M + x,
        h = depth[i];
      // Beach slope for run-up, from the seabed/beach gradient.
      const hx =
          depth[z * M + Math.min(M - 1, x + 1)] -
          depth[z * M + Math.max(0, x - 1)],
        hz =
          depth[Math.min(M - 1, z + 1) * M + x] -
          depth[Math.max(0, z - 1) * M + x];
      const beta = Math.min(
        0.2,
        Math.max(0.01, Math.hypot(hx, hz) / (2 * cell)),
      );
      const setup = 0.35 * beta * Math.sqrt(H0 * L0),
        swash = Math.sqrt(H0 * L0 * (0.563 * beta * beta + 0.004));
      if (!Number.isFinite(phase[i])) continue;
      runup[i] = 1.1 * (setup + swash / 2);
      out[i * 4] = Math.cos(phase[i]);
      out[i * 4 + 1] = Math.sin(phase[i]);
      if (h <= 0) continue;
      const k = wavenumber(h, omega),
        kh = k * h,
        n = 0.5 * (1 + (2 * kh) / Math.sinh(Math.min(2 * kh, 60))),
        cg = (omega / k) * n,
        shoaled = H0 * Math.sqrt(cg0 / cg),
        // Depth-limited (gamma h) and steepness-limited (Miche) breaking.
        limit = Math.min(
          gamma * h,
          0.142 * ((2 * Math.PI) / k) * Math.tanh(kh),
        );
      out[i * 4 + 2] = Math.min(shoaled, limit) / 2;
      // 0 offshore, 1 inside the surf zone.
      const ratio = shoaled / limit;
      out[i * 4 + 3] = Math.max(0, Math.min(1, (ratio - 0.85) / 0.25));
    }
  // Wave height does not jump with every seabed pit: energy is carried along
  // rays and spread along the crest. Smooth height and breaking over ~20 m of
  // swell-reached water (two separable box passes ~ Gaussian).
  {
    const reached = new Float32Array(count);
    for (let i = 0; i < count; i++)
      reached[i] = Number.isFinite(phase[i]) && depth[i] > 0 ? 1 : 0;
    const blur = (channel, radius) => {
      const src = new Float32Array(count),
        tmp = new Float32Array(count);
      for (let i = 0; i < count; i++) src[i] = out[i * 4 + channel];
      for (let pass = 0; pass < 2; pass++)
        for (const horizontal of [true, false]) {
          const from = horizontal ? src : tmp,
            to = horizontal ? tmp : src;
          for (let z = 0; z < M; z++)
            for (let x = 0; x < M; x++) {
              const i = z * M + x;
              if (!reached[i]) {
                to[i] = from[i];
                continue;
              }
              let sum = 0,
                weight = 0;
              for (let d = -radius; d <= radius; d++) {
                const xx = horizontal ? x + d : x,
                  zz = horizontal ? z : z + d;
                if (xx < 0 || zz < 0 || xx >= M || zz >= M) continue;
                const j = zz * M + xx;
                if (!reached[j]) continue;
                sum += from[j];
                weight++;
              }
              to[i] = sum / weight;
            }
        }
      for (let i = 0; i < count; i++)
        if (reached[i]) out[i * 4 + channel] = src[i];
    };
    blur(2, 3);
    blur(3, 3);
    // Never exceed the local depth limit after smoothing.
    for (let i = 0; i < count; i++)
      if (reached[i])
        out[i * 4 + 2] = Math.min(out[i * 4 + 2], (gamma * depth[i]) / 2);
  }
  // Run-up is a beach property; smooth it along the shore.
  const r = 3;
  for (let z = 0; z < M; z++)
    for (let x = 0; x < M; x++) {
      // Only swell-reached cells carry run-up (sheltered lagoons stay calm).
      if (!Number.isFinite(phase[z * M + x])) continue;
      let sum = 0,
        n = 0;
      for (let j = -r; j <= r; j++)
        for (let k = -r; k <= r; k++) {
          const xx = x + k,
            zz = z + j;
          if (xx < 0 || zz < 0 || xx >= M || zz >= M) continue;
          if (!Number.isFinite(phase[zz * M + xx])) continue;
          sum += runup[zz * M + xx];
          n++;
        }
      smoothRunup[z * M + x] = n ? sum / n : 0;
    }
  // Connected run-up: flood from the reached sea through beach cells whose
  // elevation is below their local run-up, so isolated hollows stay dry.
  // Land cells store this mask in the (otherwise unused) breaking channel.
  {
    const queue = new Int32Array(count);
    const seen = new Uint8Array(count);
    let head = 0,
      tail = 0;
    for (let i = 0; i < count; i++)
      if (depth[i] > 0 && Number.isFinite(phase[i])) {
        seen[i] = 1;
        queue[tail++] = i;
      }
    while (head < tail) {
      const i = queue[head++],
        x = i % M,
        z = (i - x) / M;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx,
          zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= M || zz >= M) continue;
        const j = zz * M + xx;
        if (seen[j] || depth[j] > 0) continue;
        if (-depth[j] >= runup[j] || !Number.isFinite(phase[j])) continue;
        seen[j] = 1;
        out[j * 4 + 3] = 1;
        queue[tail++] = j;
      }
    }
  }
  // Dilate the run-up mask two cells so its 4 m cell edges lie beyond the
  // swash limit; the visible waterline then follows the height contours.
  for (let pass = 0; pass < 2; pass++) {
    const grow = [];
    for (let z = 1; z < M - 1; z++)
      for (let x = 1; x < M - 1; x++) {
        const i = z * M + x;
        if (depth[i] > 0 || out[i * 4 + 3] > 0) continue;
        if (
          out[(i - 1) * 4 + 3] > 0 ||
          out[(i + 1) * 4 + 3] > 0 ||
          out[(i - M) * 4 + 3] > 0 ||
          out[(i + M) * 4 + 3] > 0
        )
          grow.push(i);
      }
    for (const i of grow) out[i * 4 + 3] = 1;
  }
  return {
    data: out,
    runup: smoothRunup,
    grid: M,
    omega,
    deepWavelength: L0,
  };
}
