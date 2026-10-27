import { fbm, noise } from "./terrain-noise.js";
import { sampleHydrology, regionalHeight, riverSegments } from "./watershed.js";
export { fbm, noise } from "./terrain-noise.js";
export { sampleHydrology, regionalHeight } from "./watershed.js";
export const TERRAIN_SIZE = 4000;
const water = {};
// Compatibility for named river viewpoints only. Physical consumers use the
// indexed network rather than assuming a river is a function of z.
export function riverCenter(z) {
  let best = Infinity,
    x = -280;
  for (const s of riverSegments) {
    if (s.area < 1500000) continue;
    const t = Math.max(0, Math.min(1, (z - s.az) / (s.bz - s.az || 1)));
    const d = Math.abs(z - (s.az + (s.bz - s.az) * t));
    if (d < best) {
      best = d;
      x = s.ax + (s.bx - s.ax) * t;
    }
  }
  return x;
}
export function riverLevel(z) {
  return sampleHydrology(riverCenter(z), z, water).level;
}
export function landscape(x, z) {
  sampleHydrology(x, z, water);
  const elevation = regionalHeight(x, z);
  const region = fbm(x * 0.00085 + 140, z * 0.00085 - 70);
  const shelter = 1 - Math.min(1, elevation / 570);
  const meadow =
    Math.max(0, 1 - Math.abs(x + 160) / 620) *
    Math.max(0, (noise(x * 0.0014 + 90, z * 0.0014 - 30) - 0.35) * 2);
  const forest = Math.max(
    0,
    Math.min(
      1,
      (region - 0.29) * 2.6 +
        shelter * 0.16 +
        water.wetness * 0.18 -
        meadow * 0.8,
    ),
  );
  return {
    // Worker terrain grids interpolate this channel: Infinity * 0 would become
    // NaN on cell edges and suppress all upland grass away from indexed rivers.
    riverDistance: Math.min(10000, water.distance) - water.width + 8,
    clump: 0.58 + 0.42 * noise(x * 0.013 + 3, z * 0.013 - 6),
    forest,
    upland: Math.min(1, elevation / 470),
    wetness: water.wetness,
  };
}
