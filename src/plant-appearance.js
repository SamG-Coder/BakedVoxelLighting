import { patchNoise, seededRandom, smooth } from "./habitat.js";

// Linear RGB multipliers shared by instanced trees and worker-merged impostors.
export function treeTint(seed = 0) {
  const rng = seededRandom(seed ^ 0x4317),
    hue = rng(),
    value = 0.82 + rng() * 0.25;
  return [value * (0.86 + hue * 0.23), value, value * (0.8 + (1 - hue) * 0.19)];
}

const barkPalettes = [
  [
    [0.68, 0.66, 0.61],
    [1.14, 0.91, 0.68],
  ],
  [
    [0.78, 0.84, 0.82],
    [1.06, 1.02, 0.88],
  ],
  [
    [0.72, 0.77, 0.72],
    [1.04, 0.94, 0.76],
  ],
  [
    [0.68, 0.6, 0.52],
    [1.24, 0.83, 0.56],
  ],
];

export function barkColour(x, y, z, seed, species, age = 1) {
  const rng = seededRandom(seed ^ 0x7131);
  const tone = rng();
  const weather = patchNoise(
    x * 1.8 + y * 0.09,
    z * 1.8 - y * 0.13,
    seed ^ 717,
  );
  const flecks = patchNoise(x * 7 + y * 0.9, z * 7 - y * 1.3, seed);
  const lichen =
    smooth(0.56, 0.79, flecks * 0.65 + weather * 0.35) * (0.12 + age * 0.12);
  // Species palettes and long vertical weathering patches live in vertex colour,
  // so normal maps, branch unions and captured HLODs retain the same variation.
  const [a, b] = barkPalettes[species % 4];
  const value = 0.82 + weather * 0.32;
  return a.map(
    (v, i) =>
      (v + (b[i] - v) * tone) * value * (1 - lichen) +
      [0.82, 0.86, 0.72][i] * lichen,
  );
}

const leafPalettes = [
  [0.94, 1, 0.89], // oak: muted, deeper green
  [1.08, 1.04, 0.9], // birch: lighter yellow-green sprays
  [0.91, 0.98, 1.02], // ash: cooler foliage
  [0.8, 0.88, 0.91], // pine: darker needles
];
const shrubPalettes = [
  [0.93, 0.98, 0.87],
  [0.87, 0.94, 0.9],
  [0.98, 1, 0.93],
];

export function leafColour(x, y, z, seed, species = 0, age = 1, shrub = false) {
  const colony = patchNoise(x * 0.43 + seed * 0.01, z * 0.43 + y * 0.16, 211);
  const tone = patchNoise(seed * 0.003, 1, 941);
  const value = 0.78 + 0.2 * colony;
  const palette = (shrub ? shrubPalettes : leafPalettes)[
    species % (shrub ? 3 : 4)
  ];
  // Slightly brighter new growth; the same vertex colour is captured in
  // the canopy and whole-tree atlases instead of tinting distant trees anew.
  const young = age === 0 ? 1.035 : 1;
  return [
    value * (0.72 + tone * 0.35 + colony * 0.09),
    value,
    value * (0.57 + (1 - tone) * 0.24),
  ].map((v, i) => v * palette[i] * young);
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
  const base = barkColour(x, y, z, seed, species, age);
  const coverage = mossCoverage(x, y, z, seed, age);
  return base.map(
    (v, i) =>
      [0.24, 0.17, 0.09][i] * v * (1 - coverage) +
      [0.065, 0.125, 0.017][i] * coverage,
  );
}
