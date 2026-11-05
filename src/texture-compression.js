import * as T from "three/webgpu";
import { WorkerClient } from "./worker-client.js";
import { uploadTextures } from "./gpu-uploads.js";
export const COMPRESSION_REVISION = "basis-073eb6a-uastc2-bc7-v1";
export function supportsBC7(renderer) {
  return renderer.backend.device.features.has("texture-compression-bc");
}
export async function compressOpaqueTextures(
  assets,
  renderer,
  cache,
  progress,
) {
  const stats = {
    supported: supportsBC7(renderer),
    sourceBytes: 0,
    residentBytes: 0,
    textures: [],
  };
  if (!stats.supported) return stats;
  const names = [
    "bark",
    "bark-birch",
    "bark-ash",
    "rock",
    "meadow-ground",
    "ground-meadow",
    "woodland-litter",
  ];
  // Cold caches previously encoded one texture at a time (~7 s each). Run a
  // small worker pool; results still upload and publish in a fixed order.
  const workers = [];
  const poolSize = Math.max(
    1,
    Math.min(names.length, (navigator.hardwareConcurrency || 4) - 2, 4),
  );
  let free = [];
  const waiting = [];
  const acquire = async () => {
    if (free.length) return free.pop();
    if (workers.length < poolSize) {
      const client = new WorkerClient(
        new Worker(`${import.meta.env.BASE_URL}workers/texture-compress.js`),
        "texture compression",
      );
      workers.push(client);
      return client;
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (client) => {
    const next = waiting.shift();
    if (next) next(client);
    else free.push(client);
  };
  const encode = async (name) => {
    const asset = assets[name],
      source = asset.map;
    const key = COMPRESSION_REVISION + ":" + asset.hash;
    let record = await cache.get(key);
    if (record) return record;
    const client = await acquire();
    try {
      // The original stays usable until upload succeeds. Only a private copy
      // crosses the worker boundary.
      const data = source.image.data.slice();
      record = await client.run(
        "compress",
        { data, width: source.image.width, height: source.image.height },
        [data.buffer],
      );
      await cache.put(key, record);
      return record;
    } catch (error) {
      // Compression is optional. Do not persist a transient worker/network
      // failure as a rejected asset or prevent the world from loading.
      return { rejected: "encoder unavailable", error: String(error) };
    } finally {
      release(client);
    }
  };
  try {
    const records = names.map((name) => encode(name));
    for (let i = 0; i < names.length; i++) {
      const name = names[i],
        asset = assets[name],
        source = asset.map;
      progress?.(`Compressing ${name} surface`);
      const record = await records[i];
      const sourceBytes = source.mipmaps.reduce(
        (n, l) => n + l.data.byteLength,
        0,
      );
      stats.sourceBytes += sourceBytes;
      if (record.rejected) {
        stats.residentBytes += sourceBytes;
        stats.textures.push({ name, ...record });
        continue;
      }
      const texture = new T.CompressedTexture(
        record.levels,
        record.levels[0].width,
        record.levels[0].height,
        T.RGBA_BPTC_Format,
      );
      for (const key of [
        "colorSpace",
        "wrapS",
        "wrapT",
        "anisotropy",
        "minFilter",
        "magFilter",
      ])
        texture[key] = source[key];
      texture.repeat.copy(source.repeat);
      texture.name = name + " BC7";
      texture.needsUpdate = true;
      try {
        await uploadTextures(renderer, [texture]);
      } catch (error) {
        texture.dispose();
        stats.residentBytes += sourceBytes;
        stats.textures.push({
          name,
          rejected: "upload failed",
          error: String(error),
        });
        continue;
      }
      asset.map = texture;
      source.dispose();
      const bytes = record.levels.reduce((n, l) => n + l.data.byteLength, 0);
      stats.residentBytes += bytes;
      stats.textures.push({ name, rmse: record.rmse, bytes });
    }
  } finally {
    for (const client of workers) client.worker.terminate();
  }
  return stats;
}
