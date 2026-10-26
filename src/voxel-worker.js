import { buildVoxelTreeGrid } from "./voxel-tree-grid.js";
import { Vector3 } from "three/src/math/Vector3.js";
import { BakeCache } from "./cache.js";
import { buildVoxelDetails } from "./voxel-core.js";
import { generateGrassBatches, grassLand } from "./grass-data.js";
import { sampleTerrainRegion } from "./terrain-snapshot.js";

const cache = new BakeCache("BakedGrassBlocks-v2"),
  ready = cache.open();
let treePrototypes, materialProfiles;
self.onmessage = async ({ data: job }) => {
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
      const records = new Map();
      let next = 0;
      // Overlap reads, but bound decoded tile memory and IndexedDB requests.
      await Promise.all(
        Array.from({ length: Math.min(8, job.grass.length) }, async () => {
          while (next < job.grass.length) {
            const p = job.grass[next++];
            const key = `${job.identity}:${p.x}:${p.z}:${p.seed}:0`;
            let batches = await cache.get(key);
            if (!batches) {
              const land = grassLand(p.x, p.z, (x, z) =>
                sampleTerrainRegion(job.terrain, x, z),
              );
              batches = generateGrassBatches({ ...p, level: 0, land });
              await cache.put(key, batches);
            }
            records.set(p, batches);
          }
        }),
      );
      const world = {
        treePrototypes,
        materialProfiles,
        areaIndexes: {
          trees: { query: () => job.trees },
          grass: { query: () => job.grass },
          objects: { query: () => job.objects },
        },
      };
      result = buildVoxelDetails(world, job.n, job.min, job.size, records);
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
  }
};
