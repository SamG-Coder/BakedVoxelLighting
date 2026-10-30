import * as T from "three/webgpu";
import { WorkerClient } from "./worker-client.js";
import { uploadTextures } from "./gpu-uploads.js";
export const COMPRESSION_REVISION = "basis-073eb6a-uastc2-bc7-v1";
export function supportsBC7(renderer) {
  return renderer.backend.isWebGPUBackend
    ? renderer.backend.device.features.has("texture-compression-bc")
    : !!renderer.backend.gl.getExtension("EXT_texture_compression_bptc");
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
  let client;
  try {
    for (const name of [
      "bark",
      "bark-birch",
      "bark-ash",
      "rock",
      "meadow-ground",
      "ground-meadow",
      "woodland-litter",
    ]) {
      const asset = assets[name],
        source = asset.map;
      const key = COMPRESSION_REVISION + ":" + asset.hash;
      progress?.(`Compressing ${name} surface`);
      let record = await cache.get(key);
      if (!record) {
        try {
          client ||= new WorkerClient(
            new Worker(
              `${import.meta.env.BASE_URL}workers/texture-compress.js`,
            ),
            "texture compression",
          );
          // The original stays usable until upload succeeds. Only a private copy
          // crosses the worker boundary; one texture is encoded at a time.
          const data = source.image.data.slice();
          record = await client.run(
            "compress",
            { data, width: source.image.width, height: source.image.height },
            [data.buffer],
          );
          await cache.put(key, record);
        } catch (error) {
          // Compression is optional. Do not persist a transient worker/network
          // failure as a rejected asset or prevent the world from loading.
          record = { rejected: "encoder unavailable", error: String(error) };
        }
      }
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
    client?.worker.terminate();
  }
  return stats;
}
