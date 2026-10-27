import {
  TERRAIN_SIZE,
  terrainHeight,
  terrainSample,
  terrainSamplingGLSL,
  inRoadVerge,
} from "./terrain-field.js";
import { TREE_TYPES } from "./plant-catalog.js";
import { patchNoise, woodlandHabitat } from "./habitat.js";
export const WORLD_VERSION = "watershed-woodland-18";
export function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const height = terrainHeight;
export const terrainGLSL = terrainSamplingGLSL;
export function makeWorld() {
  const rng = random(851),
    clusters = [],
    trees = [],
    deadwood = [];
  const occupied = new Map();
  for (let cz = 0; cz < 32; cz++)
    for (let cx = 0; cx < 32; cx++) {
      const x = (cx - 15.5) * (TERRAIN_SIZE / 32),
        z = (cz - 15.5) * (TERRAIN_SIZE / 32),
        items = [];
      for (let j = 0; j < 768; j++) {
        const tx = x + (rng() - 0.5) * (TERRAIN_SIZE / 32),
          tz = z + (rng() - 0.5) * (TERRAIN_SIZE / 32),
          s = terrainSample(tx, tz);
        if (s.traffic > 0.13 || s.slope > 0.65 || s.riverDistance < 13)
          continue;
        // Coherent forest cores and edges, with sparse individual trees on open hills.
        const wood = woodlandHabitat(tx, tz, s);
        const suitability =
          wood.core * (0.7 + s.clump * 0.3) * (1 - Math.min(0.7, s.slope));
        // Mature stands, regeneration gaps and genuinely open hills share one field.
        if (rng() > 0.005 + 0.92 * suitability ** 1.45 + s.wetness * 0.1)
          continue;
        const gx = Math.floor(tx / 4),
          gz = Math.floor(tz / 4);
        const grove = patchNoise(tx * 0.006, tz * 0.006, 281);
        const species =
          s.wetness > 0.3
            ? rng() < 0.62
              ? 2
              : 1
            : (s.upland > 0.48 && grove < 0.47) || grove > 0.81
              ? 3
              : s.forest > 0.55
                ? rng() < 0.78
                  ? 0
                  : 2
                : grove > 0.56
                  ? 1
                  : grove < 0.27
                    ? 2
                    : 0;
        const age =
          wood.core > 0.62
            ? rng() < 0.14
              ? 0
              : rng() < 0.8
                ? 1
                : 2
            : rng() < 0.34
              ? 0
              : rng() < 0.48
                ? 1
                : 2;
        const t = {
          x: tx,
          z: tz,
          y: s.height,
          scale: 0.72 + rng() * 0.65,
          rotation: rng() * Math.PI * 2,
          variant: age * TREE_TYPES.length + species,
          seed: Math.floor(rng() * 1e6),
        };
        // Mature crowns compete for more space; young trees can occupy smaller
        // gaps. Store the radius in the index so the test is symmetric.
        const spacing = [1.7, 3.5, 4.8][age] * t.scale;
        let crowded = false;
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++) {
            for (const p of occupied.get(`${gx + dx},${gz + dz}`) || []) {
              if (Math.hypot(tx - p.x, tz - p.z) < (spacing + p.spacing) * 0.5)
                crowded = true;
            }
          }
        if (crowded) continue;
        t.spacing = spacing;
        t.ageClass = age;
        t.dbh = [0.08, 0.32, 0.65][age] * t.scale;
        if (age > 0 && wood.stand > 0.5 && s.slope < 0.25 && rng() < 0.026) {
          deadwood.push({
            ...t,
            cluster: cz * 32 + cx,
            decay: rng(),
            length: 5 + rng() * 6,
            radius: 0.18 + rng() * 0.22,
          });
          continue; // Mortality leaves a real opening; the log replaces this tree.
        }
        const key = `${gx},${gz}`;
        if (!occupied.has(key)) occupied.set(key, []);
        occupied.get(key).push(t);
        trees.push(t);
        items.push(t);
      }
      clusters.push({ id: cz * 32 + cx, x, z, trees: items });
    }
  // Preserve seeds and positions away from roads by filtering after generation.
  const allowed = (t) => !inRoadVerge(t.x, t.z);
  for (const cluster of clusters) cluster.trees = cluster.trees.filter(allowed);
  return {
    clusters,
    trees: trees.filter(allowed),
    deadwood: deadwood.filter(
      (t) =>
        allowed(t) &&
        !inRoadVerge(
          t.x + Math.cos(t.rotation) * t.length,
          t.z + Math.sin(t.rotation) * t.length,
        ) &&
        !inRoadVerge(
          t.x - Math.cos(t.rotation) * t.length,
          t.z - Math.sin(t.rotation) * t.length,
        ),
    ),
    seed: 851,
  };
}
