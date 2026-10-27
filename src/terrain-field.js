import { landscape, TERRAIN_SIZE } from "./terrain-math.js";
import { copyTerrainRegion } from "./terrain-snapshot.js";
export {
  riverCenter,
  riverLevel,
  landscape,
  TERRAIN_SIZE,
} from "./terrain-math.js";
export const TERRAIN_GRID = 2001;
const N = TERRAIN_GRID,
  CELL = TERRAIN_SIZE / (N - 1);
async function loadTerrain() {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return (await import("./terrain-generation.js")).generateTerrain();
  }
  const status = document.getElementById("status");
  if (status)
    status.textContent = "Forming watersheds, terrain and paths in background";
  const worker = new Worker(
    new URL("./terrain-generation-worker.js", import.meta.url),
    { type: "module" },
  );
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) =>
        data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = (event) =>
        reject(new Error(event.message || "Terrain generation failed"));
      worker.postMessage({ type: "generate" });
    });
  } catch (error) {
    if (status)
      status.textContent = `Terrain preparation failed: ${error.message}`;
    throw error;
  } finally {
    worker.terminate();
  }
}
const {
  heights,
  traffic,
  moisture,
  slopes,
  roadVerge,
  groundInfluence,
  routes: generatedRoutes,
  terrainStats: generatedStats,
  riverData,
} = await loadTerrain();
export { groundInfluence, riverData };
export const routes = generatedRoutes;
export const terrainStats = generatedStats;
export const canopyInfluence = new Float32Array(N * N);
export const rootInfluence = new Float32Array(N * N);
function sampleGrid(field, x, z) {
  x = Math.max(0, Math.min(N - 1.001, x));
  z = Math.max(0, Math.min(N - 1.001, z));
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = x - ix,
    v = z - iz,
    i = iz * N + ix;
  return (
    (field[i] * (1 - u) + field[i + 1] * u) * (1 - v) +
    (field[i + N] * (1 - u) + field[i + N + 1] * u) * v
  );
}
export function inRoadVerge(x, z) {
  return (
    sampleGrid(
      roadVerge,
      (x + TERRAIN_SIZE / 2) / CELL,
      (z + TERRAIN_SIZE / 2) / CELL,
    ) > 0.01
  );
}
export function terrainSample(x, z) {
  const gx = (x + TERRAIN_SIZE / 2) / CELL,
    gz = (z + TERRAIN_SIZE / 2) / CELL;
  return {
    height: sampleGrid(heights, gx, gz),
    traffic: sampleGrid(traffic, gx, gz),
    moisture: sampleGrid(moisture, gx, gz),
    slope: sampleGrid(slopes, gx, gz),
    root: sampleGrid(rootInfluence, gx, gz),
    canopy: sampleGrid(canopyInfluence, gx, gz),
    ...landscape(x, z),
  };
}
export function terrainHeight(x, z) {
  return sampleGrid(
    heights,
    (x + TERRAIN_SIZE / 2) / CELL,
    (z + TERRAIN_SIZE / 2) / CELL,
  );
}
export const terrainPixels = new Float32Array(N * N * 4);
for (let i = 0; i < heights.length; i++) {
  terrainPixels[i * 4] = heights[i];
  terrainPixels[i * 4 + 1] = traffic[i];
  terrainPixels[i * 4 + 2] = moisture[i];
  terrainPixels[i * 4 + 3] = slopes[i];
}

export const terrainSamplingGLSL = `uniform sampler2D terrainField;
vec4 terrainData(vec2 p){vec2 uv=clamp((p+${(TERRAIN_SIZE / 2).toFixed(1)})/${TERRAIN_SIZE.toFixed(1)},0.,1.);vec2 g=uv*${N - 1}.;ivec2 a=ivec2(min(floor(g),vec2(${N - 2}.)));vec2 f=fract(g);return mix(mix(texelFetch(terrainField,a,0),texelFetch(terrainField,a+ivec2(1,0),0),f.x),mix(texelFetch(terrainField,a+ivec2(0,1),0),texelFetch(terrainField,a+ivec2(1,1),0),f.x),f.y);}
float terrain(vec2 p){return terrainData(p).r;}`;

export function applyTreeInfluence(trees) {
  for (const tree of trees) {
    const crownRadius =
        [5.8, 4.3, 5.3, 4.6][tree.variant % 4] *
        tree.scale *
        [0.6, 1, 1.24][Math.floor(tree.variant / 4)],
      radius = 3.6 * tree.scale,
      gx = (tree.x + TERRAIN_SIZE / 2) / CELL,
      gz = (tree.z + TERRAIN_SIZE / 2) / CELL,
      steps = Math.ceil(Math.max(radius * 2, crownRadius) / CELL);
    for (
      let z = Math.max(0, Math.floor(gz) - steps);
      z <= Math.min(N - 1, Math.ceil(gz) + steps);
      z++
    )
      for (
        let x = Math.max(0, Math.floor(gx) - steps);
        x <= Math.min(N - 1, Math.ceil(gx) + steps);
        x++
      ) {
        const dx = x * CELL - TERRAIN_SIZE / 2 - tree.x,
          dz = z * CELL - TERRAIN_SIZE / 2 - tree.z,
          a = Math.atan2(dz, dx),
          r = Math.hypot(dx, dz),
          irregular = 1 + 0.17 * Math.sin(a * 5 + tree.seed);
        const value = Math.exp(-Math.pow(r / (radius * irregular), 2) * 1.8);
        const index = z * N + x;
        rootInfluence[index] = Math.max(rootInfluence[index], value);
        if (r < crownRadius) {
          const shade =
            [0.86, 0.65, 0.74, 0.86][tree.variant % 4] *
            Math.pow(1 - (r / crownRadius) ** 2, 0.55);
          canopyInfluence[index] =
            1 - (1 - canopyInfluence[index]) * (1 - shade);
        }
      }
  }
  for (let i = 0; i < heights.length; i++) {
    heights[i] += 0.12 * Math.pow(rootInfluence[i], 2);
    terrainPixels[i * 4] = heights[i];
  }
}

// Copy only the addressed grid rows. Workers do all interpolation and habitat noise.
export function snapshotTerrain(x0, z0, x1, z1) {
  return copyTerrainRegion(
    terrainPixels,
    rootInfluence,
    N,
    TERRAIN_SIZE,
    x0,
    z0,
    x1,
    z1,
    canopyInfluence,
  );
}
