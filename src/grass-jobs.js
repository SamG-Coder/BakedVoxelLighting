import { BakeCache } from "./cache.js";
import { snapshotTerrain } from "./terrain-field.js";
const workers = Array.from(
  { length: 2 },
  () =>
    new Worker(new URL("./grass-worker.js", import.meta.url), {
      type: "module",
    }),
);
let nextWorker = 0;
export const grassBakeStats = {
  hits: 0,
  bakes: 0,
  maxWorkerMs: 0,
  lastWorkerMs: 0,
};
let id = 0;
const pending = new Map(),
  resident = new Map();
for (const worker of workers)
  worker.onmessage = ({ data }) => {
    if (data.error) {
      pending.get(data.id)?.reject(new Error(data.error));
      pending.delete(data.id);
      return;
    }
    grassBakeStats.lastWorkerMs = data.workerMs || 0;
    grassBakeStats.maxWorkerMs = Math.max(
      grassBakeStats.maxWorkerMs,
      data.workerMs || 0,
    );
    grassBakeStats[data.cacheHit ? "hits" : "bakes"]++;
    pending.get(data.id)?.resolve(data.batches);
    pending.delete(data.id);
  };
for (const worker of workers)
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message));
    pending.clear();
  };
export function buildGrassBatches(x, z, seed, level, identity) {
  const address = `${identity}:${x}:${z}:${seed}:${level}`;
  if (resident.has(address)) {
    grassBakeStats.hits++;
    return resident.get(address);
  }
  const terrain = snapshotTerrain(x - 12, z - 12, x + 12, z + 12);
  const job = new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, { resolve, reject });
    workers[nextWorker++ % workers.length].postMessage(
      { id: key, x, z, seed, level, terrain, identity },
      [terrain.pixels.buffer, terrain.roots.buffer, terrain.canopy.buffer],
    );
  });
  resident.set(address, job);
  if (resident.size > 96) resident.delete(resident.keys().next().value);
  job.catch(() => resident.delete(address));
  return job;
}

export async function clearGrassBakes() {
  resident.clear();
  const cache = new BakeCache("BakedGrassBlocks-v2");
  await cache.open();
  await cache.clear();
  cache.db?.close();
  grassBakeStats.hits = grassBakeStats.bakes = 0;
}
