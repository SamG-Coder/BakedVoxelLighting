import { GRASS_TYPES, GRASS_MIXES } from "./plant-catalog.js";
export const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (x, z, seed) => {
  let v = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};
export function patchNoise(x, z, seed = 19) {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = smooth(0, 1, x - ix),
    v = smooth(0, 1, z - iz);
  const a = hash(ix, iz, seed),
    b = hash(ix + 1, iz, seed),
    c = hash(ix, iz + 1, seed),
    d = hash(ix + 1, iz + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
export function seededRandom(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Static habitat potential, shared by stand placement and all preparation workers.
// Gaps belong to the landscape, so crossing a render tile never changes a patch.
export function woodlandHabitat(x, z, land) {
  const stand = smooth(0.28, 0.74, land.forest ?? 0);
  const gap = smooth(
    0.64,
    0.82,
    patchNoise(x * 0.016 + 71, z * 0.016 - 19, 823),
  );
  const core = stand * (1 - gap);
  return { stand, gap, core, edge: 4 * core * (1 - core) };
}
export function grassColour(habitat) {
  return (
    habitat.colour || [
      habitat.tint,
      habitat.tint * (1.01 - habitat.dry * 0.025),
      habitat.tint * (0.96 - habitat.dry * 0.05),
    ]
  );
}
export function grassHabitat(x, z, land) {
  const wood = woodlandHabitat(x, z, land);
  // Elongated, warped patches are modulated by water and canopy, rather than
  // random per-tile colour. Static growth direction is separate from wind time.
  const warp = (patchNoise(x * 0.009, z * 0.009, 503) - 0.5) * 28;
  const broad = patchNoise((x + warp) * 0.027, (z - warp * 0.6) * 0.011, 73);
  const fine = patchNoise(x * 0.19, z * 0.19, 127);
  const colony = patchNoise(x * 0.061 + warp * 0.02, z * 0.061, 439);
  const moisture = Math.max(0, Math.min(1, land.moisture ?? 0.5));
  const shade = Math.min(0.98, land.canopy ?? wood.core * 0.72);
  const woodland = smooth(0.18, 0.78, shade) * (0.65 + wood.stand * 0.35);
  const dry = smooth(0.34, 0.8, 1 - moisture) * (0.45 + broad * 0.55);
  const flower = smooth(0.46, 0.76, colony) * (1 - woodland) * (1 - dry * 0.65);
  const dryMix = smooth(0.18, 0.58, dry) * (1 - flower) * (1 - woodland);
  const mixes = [
    (1 - woodland) * (1 - flower) - dryMix,
    dryMix,
    flower * (1 - woodland),
    woodland,
  ];
  const sum = mixes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < mixes.length; i++) mixes[i] /= sum;
  const weights = GRASS_TYPES.map((_, type) =>
    GRASS_MIXES.reduce((total, mix, i) => total + mix[type] * mixes[i], 0),
  );
  const short = smooth(0.6, 0.83, patchNoise(x * 0.043, z * 0.043, 719));
  const vigour = 0.76 + broad * 0.28;
  const tint = 0.82 + fine * 0.14;
  return {
    weights,
    mixes,
    woodland,
    dry,
    shade,
    density:
      Math.min(1, 0.52 + fine * 0.35 + moisture * 0.16) * (1 - woodland * 0.91),
    height: (0.78 + broad * 0.63) * (1 - short * 0.34) * (1 - woodland * 0.46),
    tint,
    colour: [
      tint * (0.81 + dry * 0.48 + short * 0.11),
      tint * (1.03 - dry * 0.1) * vigour,
      tint * (0.67 - dry * 0.22 + moisture * 0.16),
    ],
    flow:
      0.8 +
      (patchNoise(x * 0.012, z * 0.012, 89) - 0.5) * 1.4 +
      (broad - 0.5) * 0.6,
    patch: mixes.indexOf(Math.max(...mixes)),
  };
}
export function chooseGrass(weights, random) {
  let u = random;
  for (let k = 0; k < weights.length; k++) {
    u -= weights[k];
    if (u <= 0) return k;
  }
  return weights.length - 1;
}
export function grassAllowed(land, rng) {
  return (
    land.traffic < 0.1 + rng() * 0.22 &&
    land.slope < 0.64 &&
    (land.riverDistance ?? 100) > 8 &&
    rng() > smooth(0.12, 0.78, land.root ?? 0) * 0.94
  );
}
// One source population drives both geometry LODs; thinning happens after sampling.
export function* grassPopulation(
  x,
  z,
  seed,
  count,
  span,
  sample,
  habitatOverride = null,
) {
  const rng = seededRandom(seed);
  for (let i = 0; i < count; i++) {
    const xx = x + (rng() - 0.5) * span,
      zz = z + (rng() - 0.5) * span,
      land = sample(xx, zz);
    if (!grassAllowed(land, rng)) continue;
    const habitat = habitatOverride || grassHabitat(xx, zz, land);
    if (rng() > habitat.density) continue;
    const type = chooseGrass(habitat.weights, rng()),
      form = GRASS_TYPES[type];
    const sy =
      (form.height[0] + rng() * (form.height[1] - form.height[0])) *
      habitat.height;
    const sx = form.width[0] + rng() * (form.width[1] - form.width[0]);
    const variation = 0.94 + rng() * 0.12;
    const colour = grassColour(habitat);
    yield {
      index: i,
      x: xx,
      z: zz,
      y: land.height - 0.035,
      type,
      sy,
      sx,
      angle: habitat.flow + (rng() - 0.5) * 2.5,
      colour: colour.map((v) => v * variation),
    };
  }
}
