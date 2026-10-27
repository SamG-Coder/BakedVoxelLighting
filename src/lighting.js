import { reorderVoxels } from "./voxel-details.js";
import { renderBakeSlices } from "./bake-slices.js";
import { prepareForRender } from "./renderer-jobs.js";
import { uploadTextures } from "./gpu-uploads.js";
import {
  publishedLighting,
  retireLightingInputs,
} from "./lighting-resources.js";
import { nativeVolumeSource } from "./native-kernels.js";
import tslBakeSource from "./tsl-baking.js?raw";
import { volumePass, readPixels } from "./tsl-baking.js";
import { decorateTSL, fadeTSL } from "./tsl-materials.js";
import * as T from "three/webgpu";
import { digest } from "./cache.js";
import {
  TERRAIN_SIZE,
  rootInfluence,
  canopyInfluence,
  groundInfluence,
  terrainPixels,
  terrainSample,
  TERRAIN_GRID,
} from "./terrain-field.js";
export { makeNormal } from "./normal-map.js";
export const terrainTexture = new T.DataTexture(
  terrainPixels,
  TERRAIN_GRID,
  TERRAIN_GRID,
  T.RGBAFormat,
  T.FloatType,
);
terrainTexture.needsUpdate = true;
// R: root wear, G: canopy shelter, B: bank exposure, A: gravel fraction.
// Reuse the worker's transferred buffer, with no staging copy or new binding.
const rootCanopyPixels = groundInfluence;
const rootTexture = new T.DataTexture(
  rootCanopyPixels,
  TERRAIN_GRID,
  TERRAIN_GRID,
  T.RGBAFormat,
  T.UnsignedByteType,
);
rootTexture.minFilter = rootTexture.magFilter = T.LinearFilter;
rootTexture.needsUpdate = true;
export const volumeMin = new T.Vector3(-128, -12, -128),
  volumeSize = new T.Vector3(256, 64, 256);
// Cache identities include the actual TSL source, not an obsolete GLSL copy.
const fallback = new T.DataTexture(
  new Uint8Array([38, 45, 52, 255]),
  1,
  1,
  T.RGBAFormat,
);
fallback.minFilter = fallback.magFilter = T.LinearFilter;
fallback.needsUpdate = true;
export const lightUniforms = {
  bakedAtlas: { value: fallback },
  bakeDims: { value: new T.Vector3(1, 1, 1) },
  volumeMin: { value: volumeMin.clone() },
  volumeSize: { value: volumeSize },
  bakedEnabled: { value: 0 },
  time: { value: 0 },
  previousTime: { value: 0 },
  previousCameraPosition: { value: new T.Vector3() },
  daylight: { value: 1 },
  mossEnvironment: { value: fallback.clone() },
  sunColour: { value: new T.Vector3(1, 1, 1) },
  terrainField: { value: terrainTexture },
  rootField: { value: rootTexture },
  liveMoonDirection: { value: new T.Vector3(0, -1, 0) },
  liveSunDirection: { value: new T.Vector3(-0.6, 0.6, -0.5) },
  liveLampPosition: { value: new T.Vector3() },
  liveLampPower: { value: 0 },
  liveLampColour: { value: new T.Vector3(1, 0.43, 0.12) },
  groundMap: { value: null },
  grassGround: { value: fallback.clone() },
  grassHabitat: { value: fallback.clone() },
  grassSurface: { value: fallback.clone() },
  grassSurfaceNormal: { value: fallback.clone() },
  directionAtlas: { value: fallback.clone() },
  dryGroundMap: { value: null },
  rockMap: { value: null },
};
export function fadeMaterial(material) {
  return fadeTSL(material);
}
export function decorate(material, options = {}) {
  return decorateTSL(material, options, lightUniforms, TERRAIN_GRID);
}
let active = null;
export const lightingState = {
  updates: 0,
  lastSubmitMs: 0,
  geometryKey: "",
  n: 0,
};
function data3D(data, n) {
  const t = new T.Data3DTexture(data, n, n / 2, n);
  t.format = T.RGBAFormat;
  t.minFilter = t.magFilter = T.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
export function refreshLighting(
  renderer,
  sun,
  position = new T.Vector3(),
  power = 0,
) {
  if (!active) return;
  lightUniforms.liveSunDirection.value.copy(sun);
  lightUniforms.liveLampPosition.value.copy(position);
  lightUniforms.liveLampPower.value = power;
  const start = performance.now(),
    old = renderer.getRenderTarget();
  active.material.uniforms.sun.value.copy(sun);
  active.material.uniforms.lampPosition.value.copy(position);
  active.material.uniforms.lampPower.value = power;
  renderer.setRenderTarget(active.target);
  renderer.render(active.scene, active.camera);
  renderer.setRenderTarget(old);
  lightUniforms.bakedAtlas.value = active.target.texture;
  lightingState.updates++;
  lightingState.lastSubmitMs = performance.now() - start;
}
export async function bakeVolume(
  renderer,
  world,
  cache,
  n,
  sun,
  assetHash,
  onProgress,
  interactive = false,
  signal,
) {
  const owned = new Set();
  const own = (value) => {
    owned.add(value);
    return value;
  };
  let publishedResult = false;
  const priority = () => (signal?.aborted ? Infinity : 180);
  try {
    const start = performance.now();
    const stages = {},
      operations = {};
    const timed = async (name, work) => {
      const t = performance.now();
      try {
        return await work();
      } finally {
        operations[name] = performance.now() - t;
      }
    };
    let stageStart = start;
    const mark = (name) => {
      stages[name] = performance.now() - stageStart;
      stageStart = performance.now();
    };
    const origin = volumeMin.clone();
    const geometryKey =
      "occupancy:" +
      (await digest(
        JSON.stringify({
          world: world.bakeIdentity,
          treeEdits: world.treeEditRevision || 0,
          n,
          origin: origin.toArray(),
          assetHash,
          shader: nativeVolumeSource + tslBakeSource,
        }),
      ));
    let geometry = await cache.get(geometryKey);
    signal?.throwIfAborted();
    const target = own(
      new T.RenderTarget(n, (n * n) / 2, {
        depthBuffer: false,
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
      }),
    );
    const dims = new T.Vector3(n, n / 2, n),
      uniforms = {
        dims: { value: dims },
        vmin: { value: origin },
        extent: { value: volumeSize },
        terrainField: { value: terrainTexture },
        rootField: { value: rootTexture },
        liveMoonDirection: { value: new T.Vector3(0, -1, 0) },
        liveSunDirection: { value: new T.Vector3(-0.6, 0.6, -0.5) },
        liveLampPosition: { value: new T.Vector3() },
        liveLampPower: { value: 0 },
      };
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      quad = new T.Mesh(new T.PlaneGeometry(2, 2));
    scene.add(quad);
    own(quad.geometry);
    own(quad.material);
    const old = renderer.getRenderTarget();
    if (!geometry) {
      onProgress("Voxelizing eroded terrain & woodland", 0.08);
      const detailRecord = await world.buildVoxelDetails(
        world,
        n,
        origin,
        volumeSize,
        signal,
      );
      signal?.throwIfAborted();
      mark("voxelDetailsMs");
      onProgress("Baking indexed terrain & woodland occupancy", 0.12);
      const detailTexture = data3D(detailRecord.data, n);
      own(detailTexture);
      const grid = detailRecord.treeGrid;
      const trees = new T.DataTexture(
        grid.data,
        grid.width,
        grid.height,
        T.RGBAFormat,
        T.FloatType,
      );
      lightingState.treeLookup = {
        trees: grid.trees,
        records: grid.records,
        meanCandidates: grid.meanCandidates,
      };
      trees.needsUpdate = true;
      own(trees);
      quad.material = volumePass(
        "occupancy",
        {
          ...uniforms,
          trees: { value: trees },
          details: { value: detailTexture },
        },
        TERRAIN_GRID,
      );
      own(quad.material);
      await timed("occupancyPrepareMs", () =>
        prepareForRender(
          renderer,
          scene,
          camera,
          scene,
          target,
          null,
          0,
          priority,
        ),
      );
      try {
        await timed("occupancySubmitMs", () =>
          renderBakeSlices(
            renderer,
            scene,
            camera,
            target,
            interactive,
            signal,
          ),
        );
        const packed = new Uint8Array(((n * n * n) / 2) * 4);
        await timed("occupancyReadbackMs", () =>
          readPixels(renderer, target, 0, 0, n, (n * n) / 2, packed),
        );
        geometry = {
          data: await reorderVoxels(packed, n),
          n,
          kinds: detailRecord.kinds,
          contributors: detailRecord.counts,
          treeLookup: lightingState.treeLookup,
        };
        await timed("occupancyCacheMs", () => cache.put(geometryKey, geometry));
      } finally {
        renderer.setRenderTarget(old);
        quad.material.dispose();
        trees.dispose();
        detailTexture.dispose();
      }
    }
    mark("occupancyMs");
    lightingState.contributors = geometry.contributors;
    lightingState.treeLookup = geometry.treeLookup || null;
    const field = data3D(geometry.data, n);
    own(field);
    const transportKey =
      "transport:" +
      (await digest(
        geometryKey + nativeVolumeSource + tslBakeSource + "transport",
      ));
    let transport = await cache.get(transportKey);
    signal?.throwIfAborted();
    lightingState.transportCacheHit = !!transport;
    if (!transport) {
      onProgress("Baking sky visibility & woodland bounce", 0.18);
      const buffers = [];
      quad.material = volumePass(
        "transport",
        {
          ...uniforms,
          field: { value: field },
          directionMode: { value: 0 },
        },
        TERRAIN_GRID,
      );
      own(quad.material);
      await timed("transportPrepareMs", () =>
        prepareForRender(
          renderer,
          scene,
          camera,
          scene,
          target,
          null,
          0,
          priority,
        ),
      );
      try {
        for (let mode = 0; mode < 2; mode++) {
          quad.material.uniforms.directionMode.value = mode;
          await timed(`transportSubmit${mode}Ms`, () =>
            renderBakeSlices(
              renderer,
              scene,
              camera,
              target,
              interactive,
              signal,
            ),
          );
          const pixels = new Uint8Array(((n * n * n) / 2) * 4);
          await readPixels(renderer, target, 0, 0, n, (n * n) / 2, pixels);
          buffers.push(pixels);
        }
      } finally {
        renderer.setRenderTarget(old);
        quad.material.dispose();
      }
      transport = { data: buffers[0], directions: buffers[1], n };
      await cache.put(transportKey, transport);
    }
    mark("transportMs");
    const transportMap = new T.DataTexture(
      transport.data,
      n,
      (n * n) / 2,
      T.RGBAFormat,
    );
    transportMap.needsUpdate = true;
    own(transportMap);
    transportMap.minFilter = transportMap.magFilter = T.LinearFilter;
    const directionMap = new T.DataTexture(
      transport.directions,
      n,
      (n * n) / 2,
      T.RGBAFormat,
    );
    directionMap.needsUpdate = true;
    own(directionMap);
    directionMap.minFilter = directionMap.magFilter = T.LinearFilter;

    lightingState.transportKey = transportKey;
    lightingState.transportBakes = (lightingState.transportBakes || 0) + 1;
    quad.material = volumePass(
      "lighting",
      {
        ...uniforms,
        field: { value: field },
        transportMap: { value: transportMap },
        sun: { value: sun.clone() },
        daylight: lightUniforms.daylight,
        sunColour: lightUniforms.sunColour,
        lampColour: lightUniforms.liveLampColour,
        lampPosition: { value: new T.Vector3() },
        lampPower: { value: 0 },
      },
      TERRAIN_GRID,
    );
    const published = publishedLighting(renderer, n);
    own(quad.material);
    await timed("lightingPrepareMs", () =>
      prepareForRender(
        renderer,
        scene,
        camera,
        scene,
        published.target,
        null,
        0,
        priority,
      ),
    );
    // This binding is consumed by the world, not by the lighting bake pass.
    // Make it resident before publishing the matching volume origin/dimensions.
    await uploadTextures(renderer, [directionMap, published.directions]);
    signal?.throwIfAborted();
    // Copy into a stable DataTexture to preserve canonical row orientation on
    // both backends. No await between publication and the matching radiance pass.
    renderer.copyTextureToTexture(directionMap, published.directions);
    if (active) {
      void retireLightingInputs(renderer, [
        active.field,
        active.transportMap,
        active.material,
        active.quad.geometry,
      ]);
    }
    void retireLightingInputs(renderer, [target, directionMap]);
    active = {
      target: published.target,
      field,
      geometry,
      directionMap: published.directions,
      transport,
      transportMap,
      origin,
      scene,
      camera,
      quad,
      material: quad.material,
      cachedTexture: null,
    };
    publishedResult = true;
    lightUniforms.directionAtlas.value = published.directions;
    lightUniforms.volumeMin.value.copy(origin);
    lightUniforms.bakeDims.value.copy(dims);
    refreshLighting(
      renderer,
      lightUniforms.liveSunDirection.value,
      lightUniforms.liveLampPosition.value,
      lightUniforms.liveLampPower.value,
    );
    lightUniforms.bakedEnabled.value = 1;
    lightingState.geometryKey = geometryKey;
    lightingState.n = n;
    // Streaming always uses current radiance. A historical sun/torch snapshot is
    // never read for display, so don't read it back and write it to IDB on the walk.
    if (interactive)
      return {
        key: geometryKey,
        ms: performance.now() - start,
        stages: { ...stages, lightingMs: performance.now() - stageStart },
        operations,
        bytes: n * n * n * 2,
        cached: lightingState.transportCacheHit,
      };
    const key =
      "lighting:" +
      (await digest(
        geometryKey +
          sun.toArray().join(",") +
          nativeVolumeSource +
          tslBakeSource +
          "lighting",
      ));
    let record = await cache.get(key);
    const cached = !!record;
    onProgress(
      cached ? "Restoring cached lighting" : "Baking sky, sun & diffuse bounce",
      0.24,
    );
    if (!record) {
      refreshLighting(
        renderer,
        lightUniforms.liveSunDirection.value,
        lightUniforms.liveLampPosition.value,
        lightUniforms.liveLampPower.value,
      );
      const data = new Uint8Array(((n * n * n) / 2) * 4);
      await readPixels(renderer, active.target, 0, 0, n, (n * n) / 2, data);
      record = { data, n, key };
      await cache.put(key, record);
    }
    // Cache occupancy and transport, but never present a radiance snapshot from
    // another time/light state. Regenerate this cheap pass after any cache await.
    refreshLighting(
      renderer,
      lightUniforms.liveSunDirection.value,
      lightUniforms.liveLampPosition.value,
      lightUniforms.liveLampPower.value,
    );
    return {
      key,
      ms: performance.now() - start,
      stages: { ...stages, lightingMs: performance.now() - stageStart },
      operations,
      bytes: record.data.byteLength,
      cached,
    };
  } finally {
    if (!publishedResult) await retireLightingInputs(renderer, [...owned]);
  }
}
export async function readLighting(renderer) {
  if (!active) return null;
  refreshLighting(
    renderer,
    active.material.uniforms.sun.value,
    active.material.uniforms.lampPosition.value,
    active.material.uniforms.lampPower.value,
  );
  const n = lightingState.n,
    data = new Uint8Array(((n * n * n) / 2) * 4);
  await readPixels(renderer, active.target, 0, 0, n, (n * n) / 2, data);
  return data;
}

// Read-only probes for tools/visibility planning; partial vegetation is never treated as a solid occluder.
export function voxelProbe(position) {
  if (!active) return null;
  const n = lightingState.n,
    p = new T.Vector3(...position).sub(active.origin).divide(volumeSize);
  if (p.x < 0 || p.y < 0 || p.z < 0 || p.x >= 1 || p.y >= 1 || p.z >= 1)
    return null;
  const x = Math.floor(p.x * n),
    y = Math.floor((p.y * n) / 2),
    z = Math.floor(p.z * n),
    i = (x + n * (y + (n / 2) * z)) * 4,
    a = (x + n * (z + n * y)) * 4;
  return {
    opacity: active.geometry.data[i + 3] / 255,
    materialKinds: active.geometry.kinds?.[i / 4] || 0,
    skyVisibility: active.transport.directions[a + 3] / 255,
    incomingDirection: Array.from(
      active.transport.directions.slice(a, a + 3),
      (v) => (v / 255) * 2 - 1,
    ),
    indirect: Array.from(active.transport.data.slice(a, a + 3), (v) => v / 255),
  };
}

// Persistent habitat data, independent of the current sun or streamed light volume.
export function bakeMossEnvironment() {
  for (let i = 0; i < rootInfluence.length; i++) {
    rootCanopyPixels[i * 4] = Math.round(
      Math.max(0, Math.min(1, rootInfluence[i])) * 255,
    );
    rootCanopyPixels[i * 4 + 1] = Math.round(
      Math.max(0, Math.min(1, canopyInfluence[i])) * 255,
    );
  }
  rootTexture.needsUpdate = true;
  const size = 256,
    data = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const s = terrainSample(
        ((x + 0.5) / size) * 4000 - 2000,
        ((z + 0.5) / size) * 4000 - 2000,
      );
      const i = (z * size + x) * 4;
      data[i] = Math.round(Math.min(1, s.moisture) * 255);
      data[i + 1] = Math.round(Math.min(1, s.canopy) * 255);
      data[i + 3] = 255;
    }
  const texture = new T.DataTexture(data, size, size);
  texture.minFilter = texture.magFilter = T.LinearFilter;
  texture.needsUpdate = true;
  lightUniforms.mossEnvironment.value.dispose();
  lightUniforms.mossEnvironment.value = texture;
}
