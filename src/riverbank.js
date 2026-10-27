import { noise } from "./terrain-noise.js";

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// riverDistance uses 8 at the shoreline (the same convention as planting).
// World-space patches cross tile boundaries unchanged. Only preparation work
// evaluates noise; the material reads the baked UNORM mask at render time.
export function bankExposure(x, z, riverDistance) {
  const shore = riverDistance - 8;
  if (shore >= 13 || !Number.isFinite(shore)) return 0;
  if (shore <= 0) return 1;
  const bar = noise(x * 0.075 + 313, z * 0.075 - 171);
  const broken = noise(x * 0.31 - 63, z * 0.31 + 819);
  const width = 2.4 + bar * 7.6;
  const fringe = 1 - smooth(0.25, width, shore);
  return fringe * (1 - smooth(0, 1, shore) * (1 - broken) * 0.32);
}

export function bankGravel(x, z) {
  // Separate gravel bars and damp soil pockets, not alternating render tiles.
  return smooth(0.23, 0.77, noise(x * 0.12 + 621, z * 0.12 - 229));
}
