import { buildVoxelTreeGrid } from "./voxel-tree-grid.js";
import { Vector3 } from "three/src/math/Vector3.js";
import { BakeCache } from "./cache.js";
import { buildVoxelDetailsStreamed } from "./voxel-core.js";
import { generateGrassBatches, grassLand } from "./grass-data.js";
import { sampleTerrainRegion } from "./terrain-snapshot.js";

const cache = new BakeCache("BakedGrassBlocks-v2"),
  ready = cache.open();
let treePrototypes, materialProfiles;
const cancelled = new Set(),
  running = new Set();
self.onmessage = async ({ data: job }) => {
  if (job.type === "cancel") {
    if (running.has(job.id)) cancelled.add(job.id);
    return;
  }
  running.add(job.id);
  const started = performance.now();
  try {
    let result,
      transfer = [];
    if (job.type === "init") {
      treePrototypes = job.prototypes.map((p) => ({
        ...p,
        paths: p.paths.map((path) => ({
          ...path,
          points: path.points.map((point) => new Vector3(...point)),
        })),
      }));
      materialProfiles = job.profiles;
      result = true;
    } else if (job.type === "reorder") {
      const { n, packed } = job,
        data = new Uint8Array(packed.length);
      for (let y = 0; y < n / 2; y++)
        for (let z = 0; z < n; z++)
          for (let x = 0; x < n; x++) {
            const a = (x + n * (z + n * y)) * 4,
              b = (x + n * (y + (n / 2) * z)) * 4;
            data[b] = packed[a];
            data[b + 1] = packed[a + 1];
            data[b + 2] = packed[a + 2];
            data[b + 3] = packed[a + 3];
          }
      result = data;
      transfer = [data.buffer];
    } else if (job.type === "details") {
      if (!treePrototypes)
        throw new Error("Voxel worker must be initialized before baking");
      await ready;
      const world = {
        treePrototypes,
        materialProfiles,
        areaIndexes: {
          trees: { query: () => job.trees },
          grass: { query: () => job.grass },
          objects: { query: () => job.objects },
        },
      };
      result = await buildVoxelDetailsStreamed(
        world,
        job.n,
        job.min,
        job.size,
        async (p) => {
          if (cancelled.has(job.id))
            throw new DOMException("Stale voxel area", "AbortError");
          const key = `${job.identity}:${p.x}:${p.z}:${p.seed}:0`;
          let batches = await cache.get(key);
          if (cancelled.has(job.id))
            throw new DOMException("Stale voxel area", "AbortError");
          if (!batches) {
            const land = grassLand(p.x, p.z, (x, z) =>
              sampleTerrainRegion(job.terrain, x, z),
            );
            batches = generateGrassBatches({ ...p, level: 0, land });
            await cache.put(key, batches);
          }
          return batches;
        },
      );
      result.treeGrid = buildVoxelTreeGrid(job.trees, job.n, job.min, job.size);
      transfer = [
        result.data.buffer,
        result.kinds.buffer,
        result.treeGrid.data.buffer,
      ];
    } else throw new Error(`Unknown voxel worker request: ${job.type}`);
    self.postMessage(
      { id: job.id, result, workerMs: performance.now() - started },
      transfer,
    );
  } catch (error) {
    self.postMessage({ id: job.id, error: error.stack || error.message });
  } finally {
    running.delete(job.id);
    cancelled.delete(job.id);
  }
};
