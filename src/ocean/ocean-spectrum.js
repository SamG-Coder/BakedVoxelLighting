// Initial ocean spectra for the WebGPU FFT cascades.
//
// The approach follows ClearWater 6.1 (SamG-Coder/ClearWater6.1): wind-aligned
// Phillips-style spectra, Hermitian time evolution and independent 128 x 128
// cascades. Differences: three band-limited cascades (no double-counted
// energy), a narrow onshore swell, choppy horizontal displacement, and a
// total-variance normalisation so the significant wave height is set directly.

export const OCEAN_N = 128;
// Patch sizes are deliberately non-commensurate so the three tiles never align.
export const CASCADE_SIZES = [389, 61.3, 9.7];
// Band edges in rad/m. Every wavenumber belongs to exactly one cascade.
const BAND_EDGES = [0, 0.62, 3.9, Infinity];
const G = 9.81;

function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussianPair(rng) {
  const r = Math.sqrt(-2 * Math.log(Math.max(1e-7, rng()))),
    a = 2 * Math.PI * rng();
  return [r * Math.cos(a), r * Math.sin(a)];
}

// Directional variance densities in m^2 per (rad/m)^2.
function windDensity(kx, kz, o) {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-10) return 0;
  const cos = (kx * o.windX + kz * o.windZ) / Math.sqrt(k2);
  // Waves running against the wind are strongly damped, not removed.
  const spread = cos > 0 ? cos * cos : cos * cos * 0.07;
  const L = (o.windSpeed * o.windSpeed) / G,
    smallest = 0.012;
  return (
    (Math.exp(-1 / (k2 * L * L)) / (k2 * k2)) *
    Math.exp(-k2 * smallest * smallest) *
    spread
  );
}
// A long, narrow swell arriving from offshore: Gaussian in |k|, cos^24 spread.
function swellDensity(kx, kz, o) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-5) return 0;
  const cos = Math.max(0, (kx * o.swellX + kz * o.swellZ) / k),
    kp = (2 * Math.PI) / o.swellLength;
  return Math.exp(-(((k - kp) / (kp * 0.16)) ** 2)) * cos ** 24;
}

/**
 * Returns seeds [cascade][z][x] as vec4 (h0(k), conj(h0(-k))) and the deep
 * water angular frequencies. Nyquist rows/columns are zeroed so the inverse
 * transform is exactly real.
 */
export function buildOceanSpectrum({
  windSpeed = 9,
  windAngle = 1.2,
  swellAngle = 1.48,
  swellLength = 110,
  swellShare = 0.55,
  significantHeight = 1.35,
  seed = 61061,
} = {}) {
  const N = OCEAN_N,
    count = N * N,
    cascades = CASCADE_SIZES.length;
  const o = {
    windSpeed,
    windX: Math.cos(windAngle),
    windZ: Math.sin(windAngle),
    swellX: Math.cos(swellAngle),
    swellZ: Math.sin(swellAngle),
    swellLength,
  };
  // Each cascade owns one wavenumber band; collect every mode once.
  const modes = [];
  for (let c = 0; c < cascades; c++) {
    const dk = (2 * Math.PI) / CASCADE_SIZES[c];
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        if (x === N / 2 || z === N / 2) continue;
        const kx = (x < N / 2 ? x : x - N) * dk,
          kz = (z < N / 2 ? z : z - N) * dk,
          k = Math.hypot(kx, kz);
        if (k < BAND_EDGES[c] || k >= BAND_EDGES[c + 1]) continue;
        modes.push([c * count + z * N + x, kx, kz, dk * dk]);
      }
  }
  // swellShare is a fraction of total variance, not a density multiplier.
  let windVariance = 0,
    swellVariance = 0;
  for (const [, kx, kz, area] of modes) {
    windVariance += windDensity(kx, kz, o) * area;
    swellVariance += swellDensity(kx, kz, o) * area;
  }
  const swellScale =
    swellVariance > 0
      ? (windVariance * swellShare) / (swellVariance * (1 - swellShare))
      : 0;
  const amplitude = new Float32Array(cascades * count);
  let variance = 0;
  for (const [i, kx, kz, area] of modes) {
    const a =
      (windDensity(kx, kz, o) + swellDensity(kx, kz, o) * swellScale) * area;
    amplitude[i] = a;
    variance += a;
  }
  // Var(h) = sum over k of E|h0(k)|^2 + E|h0(-k)|^2, which equals the sum of
  // the densities. Significant wave height Hs = 4 sigma.
  const scale = variance > 0 ? (significantHeight / 4) ** 2 / variance : 0;
  const rng = random(seed);
  const h0 = new Float32Array(cascades * count * 2);
  for (let i = 0; i < cascades * count; i++) {
    const [gr, gi] = gaussianPair(rng),
      s = Math.sqrt(amplitude[i] * scale * 0.5);
    h0[i * 2] = gr * s;
    h0[i * 2 + 1] = gi * s;
  }
  const seeds = new Float32Array(cascades * count * 4);
  const omega = new Float32Array(cascades * count);
  for (let c = 0; c < cascades; c++) {
    const dk = (2 * Math.PI) / CASCADE_SIZES[c];
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const i = c * count + z * N + x,
          j = c * count + ((N - z) % N) * N + ((N - x) % N);
        seeds[i * 4] = h0[i * 2];
        seeds[i * 4 + 1] = h0[i * 2 + 1];
        // conj(h0(-k))
        seeds[i * 4 + 2] = h0[j * 2];
        seeds[i * 4 + 3] = -h0[j * 2 + 1];
        const kx = (x < N / 2 ? x : x - N) * dk,
          kz = (z < N / 2 ? z : z - N) * dk;
        omega[i] = Math.sqrt(G * Math.hypot(kx, kz));
      }
  }
  return {
    seeds,
    omega,
    sizes: CASCADE_SIZES,
    significantHeight,
    windSpeed,
    windDirection: [o.windX, o.windZ],
    swellDirection: [o.swellX, o.swellZ],
  };
}
