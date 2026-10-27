import { GRASS_COUNT, GRASS_PATCH, GRASS_MIXES } from "./plant-catalog.js";
import {
  seededRandom,
  grassPopulation,
  grassHabitat,
  grassAllowed,
  grassColour,
  chooseGrass,
} from "./habitat.js";
export function grassLand(x, z, sample) {
  const land = new Float32Array(13 * 13 * 9);
  for (let j = 0; j < 13; j++)
    for (let i = 0; i < 13; i++) {
      const s = sample(x - 12 + i * 2, z - 12 + j * 2);
      land.set(
        [
          s.height,
          s.traffic,
          s.moisture,
          s.slope,
          s.root,
          s.riverDistance,
          s.forest,
          s.wetness,
          s.canopy ?? 0,
        ],
        (j * 13 + i) * 9,
      );
    }
  return land;
}
export function generateGrassBatches({ x, z, seed, level, land }) {
  const channel = (xx, zz, c) => {
    const gx = Math.max(0, Math.min(12, (xx - x + 12) / 2)),
      gz = Math.max(0, Math.min(12, (zz - z + 12) / 2)),
      ix = Math.min(11, Math.floor(gx)),
      iz = Math.min(11, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz;
    const at = (a, b) => land[((iz + b) * 13 + ix + a) * 9 + c];
    return (
      (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) +
      (at(0, 1) * (1 - u) + at(1, 1) * u) * v
    );
  };
  const sample = (xx, zz) => ({
    height: channel(xx, zz, 0),
    traffic: channel(xx, zz, 1),
    moisture: channel(xx, zz, 2),
    slope: channel(xx, zz, 3),
    root: channel(xx, zz, 4),
    riverDistance: channel(xx, zz, 5),
    forest: channel(xx, zz, 6),
    wetness: channel(xx, zz, 7),
    canopy: channel(xx, zz, 8),
  });
  const groups = Array.from(
    { length: level === 2 ? GRASS_MIXES.length : 1 },
    () => ({
      matrices: [],
      colours: [],
      types: [],
    }),
  );
  if (level === 2) {
    const rng = seededRandom(seed);
    for (let i = 0; i < GRASS_PATCH.count; i++) {
      const xx = x + (rng() - 0.5) * 24,
        zz = z + (rng() - 0.5) * 24,
        land = sample(xx, zz),
        h = grassHabitat(xx, zz, land);
      if (!grassAllowed(land, rng) || rng() > h.density) continue;
      const scale = (0.72 + rng() * 0.4) * h.height,
        width = (0.72 + rng() * 0.56) * h.width,
        a = h.flow + (rng() - 0.5) * 2,
        c = Math.cos(a) * width,
        s = Math.sin(a) * width,
        // Match the near population's habitat proportions instead of snapping
        // every distant colony to the single dominant mix at a field boundary.
        b = groups[chooseGrass(h.mixes, rng())];
      b.matrices.push(
        c,
        0,
        -s,
        0,
        0,
        scale,
        0,
        0,
        s,
        0,
        c,
        0,
        xx,
        land.height + GRASS_PATCH.centerY * scale - 0.035,
        zz,
        1,
      );
      b.colours.push(...grassColour(h));
    }
  } else {
    for (const p of grassPopulation(x, z, seed, GRASS_COUNT, 24, sample)) {
      if (level === 1 && p.index % 3 !== 0) continue;
      const width = p.sx * (level === 1 ? 1.42 : 1),
        b = groups[0];
      for (let k = 0; k < 2; k++) {
        const a = p.angle + k * Math.PI * 0.5,
          c = Math.cos(a),
          s = Math.sin(a);
        b.matrices.push(
          c * width,
          0,
          -s * width,
          0,
          0,
          p.sy,
          0,
          0,
          s * width,
          0,
          c * width,
          0,
          p.x,
          p.y,
          p.z,
          1,
        );
        b.colours.push(...p.colour);
        b.types.push(p.type);
      }
    }
  }
  return groups.map((b) => ({
    matrices: new Float32Array(b.matrices),
    colours: new Float32Array(b.colours),
    types: new Float32Array(b.types),
  }));
}
