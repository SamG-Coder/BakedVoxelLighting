import { patchNoise, seededRandom, smooth } from "./habitat.js";

// Linear RGB multipliers shared by instanced trees and worker-merged impostors.
export function treeTint(seed = 0) {
  const rng = seededRandom(seed ^ 0x4317),
    hue = rng(),
    value = 0.82 + rng() * 0.25;
  return [value * (0.86 + hue * 0.23), value, value * (0.8 + (1 - hue) * 0.19)];
}

export function barkColour(x, y, z, seed, species) {
  const rng = seededRandom(seed ^ 0x7131);
  const tone = rng(),
    mossAmount = 0.35 + rng() * 0.65,
    aspect = rng() * Math.PI * 2;
  const side = 0.5 + 0.5 * Math.cos(Math.atan2(z, x) - aspect);
  const broad = patchNoise(x * 1.9 + seed * 0.013, z * 1.9 + y * 0.7, 609);
  const flecks = patchNoise(x * 7 + y * 0.9, z * 7 - y * 1.3, seed);
  const moss =
    (1 - smooth(0.1, 3.3, y)) *
    smooth(0.25, 0.7, broad * 0.6 + side * 0.4) *
    mossAmount;
  const lichen = smooth(0.63, 0.85, flecks) * 0.22;
  const base =
    species === 1
      ? [0.94, 0.96, 0.91]
      : [0.84 + tone * 0.25, 0.82 + tone * 0.13, 0.76 + tone * 0.11];
  const green = [0.28, 0.54, 0.17];
  return base.map(
    (v, i) =>
      (v * (1 - moss) + green[i] * moss) * (1 - lichen) +
      [0.78, 0.82, 0.69][i] * lichen,
  );
}

export function leafColour(x, y, z, seed) {
  const colony = patchNoise(x * 0.43 + seed * 0.01, z * 0.43 + y * 0.16, 211);
  const tone = patchNoise(seed * 0.003, 1, 941);
  const value = 0.78 + 0.2 * colony;
  return [
    value * (0.72 + tone * 0.35 + colony * 0.09),
    value,
    value * (0.57 + (1 - tone) * 0.24),
  ];
}
