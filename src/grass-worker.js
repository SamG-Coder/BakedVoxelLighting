import { BakeCache } from "./cache.js";
import { grassLand, generateGrassBatches } from "./grass-data.js";
import { sampleTerrainRegion } from "./terrain-snapshot.js";
const cache = new BakeCache("BakedGrassBlocks-v2"),
  ready = cache.open();
const transfer = (batches) =>
  batches.flatMap((b) => [
    b.matrices.buffer,
    b.colours.buffer,
    ...(b.types ? [b.types.buffer] : []),
  ]);
self.onmessage = async ({
  data: { id, x, z, seed, terrain, level, identity },
}) => {
  const started = performance.now();
  try {
    await ready;
    const key = identity + ":" + x + ":" + z + ":" + seed + ":" + level;
    const cached = await cache.get(key);
    if (cached) {
      self.postMessage(
        {
          id,
          batches: cached,
          cacheHit: true,
          workerMs: performance.now() - started,
        },
        transfer(cached),
      );
      return;
    }
    const land = grassLand(x, z, (xx, zz) =>
      sampleTerrainRegion(terrain, xx, zz),
    );
    const batches = generateGrassBatches({ x, z, seed, level, land });
    // IndexedDB clones synchronously when put() is issued. Submit persistence
    // before transferring buffers, but don't make visibility wait for disk commit.
    const stored = cache.put(key, batches);
    self.postMessage(
      { id, batches, cacheHit: false, workerMs: performance.now() - started },
      transfer(batches),
    );
    await stored;
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
