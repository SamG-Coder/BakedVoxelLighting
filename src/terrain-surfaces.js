import * as T from "three/webgpu";
import { WorkerClient } from "./worker-client.js";
import { uploadTextures } from "./gpu-uploads.js";
export async function prepareTerrainSurfaces(assets, renderer) {
  const client = new WorkerClient(
    new Worker(new URL("./terrain-surfaces-worker.js", import.meta.url), {
      type: "module",
    }),
    "terrain surfaces",
  );
  let levels;
  try {
    levels = await client.run("pack", {
      layers: [assets.dirt, assets.scree].map((a) =>
        a.map.mipmaps.map((m, i) => ({
          ...m,
          normals: a.normal.mipmaps[i].data,
        })),
      ),
    });
  } finally {
    client.worker.terminate();
  }
  const textures = ["data", "normals"].map((channel) => {
    const base = levels[0];
    const texture = new T.DataArrayTexture(
      base[channel],
      base.width,
      base.height,
      base.depth,
    );
    texture.name = "terrain surfaces " + channel;
    texture.colorSpace = channel === "data" ? T.SRGBColorSpace : T.NoColorSpace;
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    texture.minFilter = T.LinearMipmapLinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.anisotropy = Math.min(16, renderer.getMaxAnisotropy());
    texture.mipmaps = levels.map((l) => ({
      width: l.width,
      height: l.height,
      depth: l.depth,
      data: l[channel],
    }));
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  });
  await uploadTextures(renderer, textures);
  return { color: textures[0], normal: textures[1] };
}
