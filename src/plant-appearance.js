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
  const tone = rng();
  const flecks = patchNoise(x * 7 + y * 0.9, z * 7 - y * 1.3, seed);
  const lichen = smooth(0.63, 0.85, flecks) * 0.22;
  const base =
    species === 1
      ? [0.94, 0.96, 0.91]
      : [0.84 + tone * 0.25, 0.82 + tone * 0.13, 0.76 + tone * 0.11];
  return base.map((v, i) => v * (1 - lichen) + [0.78, 0.82, 0.69][i] * lichen);
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

// Age classes: sapling 0, mature 1, old 2. Older rough bark supports broader
// colonies. Patch noise breaks the mask up; age alone is not ecology.
export function mossCoverage(x, y, z, seed, age = 1) {
  const rng = seededRandom(seed ^ 0x7131);
  rng();
  const variation = 0.7 + rng() * 0.3;
  // Irregular colonies in object space, baked with the geometry. Actual habitat
  // and long-term sun exposure are applied consistently to meshes and HLODs.
  const warp = patchNoise(x * 0.8 + y * 0.37, z * 0.8 - y * 0.23, seed);
  const patch = patchNoise(x * 2.2 + warp * 2.7, z * 2.2 + y * 0.55, 609);
  return (
    [0.07, 0.62, 0.95][Math.max(0, Math.min(2, age))] *
    variation *
    (1 - smooth(0.3, 1.2 + age * 1.15, y)) *
    smooth(0.23, 0.67, patch * 0.7 + warp * 0.3)
  );
}

export function barkReflectance(x, y, z, seed, species, age) {
  const base = barkColour(x, y, z, seed, species);
  const coverage = mossCoverage(x, y, z, seed, age);
  return base.map(
    (v, i) =>
      [0.24, 0.17, 0.09][i] * v * (1 - coverage) +
      [0.065, 0.125, 0.017][i] * coverage,
  );
}
