import { noise } from "./terrain-noise.js";

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// A heightfield approximation of accumulated scour and deposition. It can make
// steep cut banks and shelves, but cannot represent an undercut/overhang.
export function carveRiverHeight(original, x, z, h) {
  const shore = h.distance - h.width;
  const cut = h.cutBank || 0,
    bar = h.pointBar || 0;
  const depth = (0.55 + h.width * 0.14) * (1 + cut * 0.4 - bar * 0.24);
  const cross = h.distance / Math.max(1, h.width);
  if (shore <= 0) {
    const bed =
      h.level - depth + depth * Math.pow(cross, 2.4 + cut * 1.5 - bar * 0.9);
    // Preserve deeper scoured beds, but join the bank at the waterline. A
    // lower eroded floodplain needs deposited bank material here; taking only
    // min(original, profile) leaves the bank below the surface indefinitely.
    const bank = smooth(0.5, 1, cross);
    return Math.min(original, bed) * (1 - bank) + bed * bank;
  }
  const strength = cut * (0.72 + noise(x * 0.018 + 71, z * 0.018 - 39) * 0.28);
  const ledge = (1.2 + h.width * 0.16) * strength;
  const shelf = shore * (0.22 - bar * 0.13) + ledge * smooth(0, 2.6, shore);
  const channel = h.level + shelf;
  // Keep the bank profile connected to the floodplain with no cross-section step.
  const influence = 1 - smooth(3 + h.width * 0.25, 18 + h.width, shore);
  return original * (1 - influence) + channel * influence;
}
