import * as T from "three/webgpu";
import { packPlantAtlas } from "./atlas-mips.js";
import { GRASS_TYPES, PLANT_REVISION } from "./plant-catalog.js";
export async function bakePlantAtlas(assets, cache, identity) {
  const key = "grass-palette-grid-v3:" + PLANT_REVISION + ":" + identity;
  // Colour + normals + all mips exceed Chromium's per-value IDB limit.
  // Publish a small manifest last; each channel stays below 64 MiB.
  const manifest = await cache.get(key);
  let levels = manifest ? [] : null;
  if (manifest) {
    for (let i = 0; i < manifest.length; i++) {
      const data = await cache.get(`${key}:${i}:colour`);
      const normals = await cache.get(`${key}:${i}:normal`);
      if (!data || !normals) {
        levels = null;
        break;
      }
      levels.push({ ...manifest[i], data, normals });
    }
  }
  if (!levels) {
    levels = await packPlantAtlas(
      GRASS_TYPES.map(({ name }) => ({
        w: assets[name].map.image.width,
        h: assets[name].map.image.height,
        data: assets[name].map.image.data,
        normals: assets[name].normal.image.data,
      })),
    );
    let stored = true;
    for (let i = 0; i < levels.length && stored; i++) {
      stored = await cache.put(`${key}:${i}:colour`, levels[i].data);
      if (stored)
        stored = await cache.put(`${key}:${i}:normal`, levels[i].normals);
    }
    if (stored)
      await cache.put(
        key,
        levels.map(({ width, height }) => ({ width, height })),
      );
  }
  const textures = ["data", "normals"].map((channel) => {
    const base = levels[0],
      t = new T.DataTexture(base[channel], base.width, base.height);
    t.mipmaps = levels.map((l) => ({
      data: l[channel],
      width: l.width,
      height: l.height,
    }));
    t.generateMipmaps = false;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.magFilter = T.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  });
  textures[0].colorSpace = T.SRGBColorSpace;
  assets.grassAtlas = {
    map: textures[0],
    normal: textures[1],
    types: GRASS_TYPES.length,
  };
  return {
    width: levels[0].width,
    height: levels[0].height,
    types: GRASS_TYPES.map((t) => t.name),
    mips: levels.length,
  };
}
