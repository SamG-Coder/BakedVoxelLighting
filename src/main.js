import { buildDeadwood } from "./deadwood.js";
import deadwoodSource from "./deadwood-data.js?raw";
import { PreparedSunShadow } from "./prepared-shadows.js";
import { getGPUUploads } from "./gpu-uploads.js";
import {
  prepareForRender,
  rendererJobStats,
  setPreparationPresenting,
} from "./renderer-jobs.js";
import { bakePlantAtlas } from "./plant-atlas.js";
import {
  TREE_TYPES,
  SHRUB_TYPES,
  GRASS_TYPES,
  GRASS_LOD_DISTANCES,
} from "./plant-catalog.js";
import catalogSource from "./plant-catalog.js?raw";
import habitatSource from "./habitat.js?raw";
import plantGrowthSource from "./plant-growth.js?raw";
import plantAtlasSource from "./plant-atlas.js?raw";
import { grassBakeStats, clearGrassBakes } from "./grass-jobs.js";
import { clearTreeBakes } from "./growth-jobs.js";
import { prepareAtlasMips } from "./atlas-mips.js";
import { advanceHour, solarState } from "./day-cycle.js";
import { indexVoxelWorld } from "./voxel-index.js";
import {
  cloudAt,
  cloudData,
  updateClouds,
  getCloudTarget,
  prepareClouds,
  cloudStats,
  CLOUD_SHADOW_STRENGTH,
} from "./clouds.js";
import { createAtmosphere } from "./atmosphere.js";
import * as N from "three/tsl";
import cloudKernelSource from "./cloud-kernels.js?raw";
import cloudDensityGLSL from "./shaders/cloud-density.glsl?raw";
import cloudDensityWGSL from "./shaders/cloud-density.wgsl?raw";
import { skyColour } from "./native-kernels.js";
import { ref } from "./tsl-baking.js";
import grassWorkerSource from "./grass-worker.js?raw";
import { buildVoxelDetailsAsync, voxelWorkerStats } from "./voxel-details.js";
import {
  finishGrassJobs,
  startGrassJobs,
  grassStreamingStats,
} from "./vegetation.js";
import atlasWorkerSource from "./atlas-worker.js?raw";
import { setShaderBackend, nativeVolumeSource } from "./native-kernels.js";
import nativeSource from "./native-kernels.js?raw";
import { VoxelSun, installVoxelSun } from "./tsl-sun.js";
import tslBakeSource from "./tsl-baking.js?raw";
import tslMaterialSource from "./tsl-materials.js?raw";
import treeGridSource from "./voxel-tree-grid.js?raw";
import detailSource from "./voxel-core.js?raw";
import voxelWorkerSource from "./voxel-worker.js?raw";
import grassDataSource from "./grass-data.js?raw";
import terrainMathSource from "./terrain-math.js?raw";
import terrainSnapshotSource from "./terrain-snapshot.js?raw";
import mergedDataSource from "./merged-data.js?raw";
import { FrameClock, dampingAtDelta } from "./frame-clock.js";
import {
  updateMergedVisibility,
  mergedStats,
  mergedWorkerStats,
  clearMergedCache,
} from "./merged-visibility.js";
import mergedSource from "./merged-visibility.js?raw";
import * as T from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SkyMesh as Sky } from "three/addons/objects/SkyMesh.js";
import "./style.css";
import vegetationSource from "./vegetation.js?raw";
import lightingSource from "./lighting.js?raw";
import worldSource from "./world-data.js?raw";
import growthSource from "./growth.js?raw";
import appearanceSource from "./plant-appearance.js?raw";
import woodUnionSource from "./wood-union.js?raw";
import terrainSource from "./terrain-field.js?raw";
import impostorSource from "./impostors.js?raw";
import { BakeCache, digest } from "./cache.js";
import { makeWorld, height, WORLD_VERSION } from "./world-data.js";
import {
  TERRAIN_SIZE,
  applyTreeInfluence,
  riverCenter,
  riverLevel,
  terrainStats,
  terrainSample,
  routes,
} from "./terrain-field.js";
import {
  makeNormal,
  bakeVolume,
  refreshLighting,
  readLighting,
  voxelProbe,
  lightingState,
  lightUniforms,
  volumeMin,
} from "./lighting.js";
import {
  buildTrees,
  buildGrass,
  grassPoints,
  grassHabitat,
  bakeTreeHLOD,
  bakeGrassLOD,
  bakeGrassGround,
  updateLOD,
  buildShrubs,
  bakeShrubLOD,
  updateShrubs,
} from "./vegetation.js";
import {
  buildEnvironment,
  updateTerrain,
  terrainCameraFloor,
  setTerrainPreparation,
} from "./environment.js";
import { prepareRiver, riverStats } from "./river.js";
const $ = (id) => document.getElementById(id);
const diagnostics = (window.worldDiagnostics = {
  ready: false,
  baking: false,
  errors: [],
  treeLevels: [0, 0, 0, 0],
  grassLevels: [0, 0, 0, 0],
  assets: {},
  bakes: [],
  terrain: terrainStats,
  mapSize: TERRAIN_SIZE,
  mapAreaKm2: 16,
  terrainLOD: {
    tiles: 1024,
    segments: [48, 12, 4],
    distances: [260, 850],
    source: "shared eroded heightfield",
  },
  fog: false,
});
function fail(e) {
  console.error(e);
  diagnostics.errors.push(String(e.stack || e));
  $("error").hidden = false;
  $("error").textContent = "World initialization failed.\n" + e.message;
}
window.addEventListener("error", (e) => diagnostics.errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));
const backendChoice =
  new URLSearchParams(location.search).get("backend") ||
  localStorage.getItem("worldBackend") ||
  "webgpu";
const renderer = new T.WebGPURenderer({
  forceWebGL: backendChoice === "webgl2",
  samples: 4,
  canvas: $("world"),
  antialias: true,
  powerPreference: "high-performance",
});
await renderer.init();
const gpuUploads = getGPUUploads(renderer);
diagnostics.preparation = {
  uploads: gpuUploads.stats,
  renderer: rendererJobStats,
};
setShaderBackend(!!renderer.backend.isWebGPUBackend);
// This forest has thousands of differently sized instanced batches. Prefer
// instance attributes over count-sized uniform arrays so each batch count does
// not create a distinct shader program. This controls Three's optional buffer
// optimization, not the actual uniform allocation limit of the device.
renderer.backend.capabilities.getUniformBufferLimit = () => 0;
installVoxelSun(renderer, lightUniforms);
const actualBackend = renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2";
diagnostics.backend = actualBackend;
diagnostics.requestedBackend = backendChoice;
diagnostics.bakeBackend = actualBackend;
document.getElementById("backend").value = backendChoice;
document.getElementById("backendLabel").textContent =
  `THREE.JS / ${actualBackend.toUpperCase()} / ${actualBackend === "webgpu" ? "WGSL" : "GLSL"}`;
document.getElementById("backendNote").textContent =
  actualBackend !== backendChoice
    ? "WebGPU unavailable. Using WebGL2 for rendering and baking."
    : "Rendering and baking use the selected backend.";
document.getElementById("backend").onchange = (event) => {
  localStorage.setItem("worldBackend", event.target.value);
  const url = new URL(location.href);
  url.searchParams.set("backend", event.target.value);
  location.assign(url);
};
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFShadowMap;
const scene = new T.Scene();
// The world is static; wind runs in shaders. Updating its entire hierarchy for
// every colour and shadow pass was the dominant CPU regression.
scene.matrixWorldAutoUpdate = false;
scene.updateMatrixWorld(true);
scene.addEventListener("childadded", ({ child }) =>
  child.updateMatrixWorld(true),
);
scene.background = new T.Color(0xadc9df);
scene.fog = null;
const camera = new T.PerspectiveCamera(
  55,
  innerWidth / innerHeight,
  0.15,
  6500,
);
camera.coordinateSystem = renderer.coordinateSystem;
camera.updateProjectionMatrix();
camera.position.set(19, height(19, 43) + 4.2, 43);
// Hardware multisampling is shared by both backends; no legacy WebGL composer.
const composer = createAtmosphere(renderer, scene, camera, lightUniforms);
diagnostics.antialiasing = { smaa: false, samples: 4 };
renderer.info.autoReset = false;
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-8, height(-8, -23) + 5, -23);
if (new URLSearchParams(location.search).get("view") === "river") {
  camera.position.set(
    riverCenter(12) + 10,
    height(riverCenter(12) + 10, 12) + 2.2,
    12,
  );
  controls.target.set(riverCenter(-24), riverLevel(-24) + 0.3, -24);
}
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.maxPolarAngle = Math.PI - 0.02;
controls.minDistance = 2;
controls.maxDistance = 1000;
const sun = new VoxelSun(0xffe6be, 2.6),
  ambient = new T.HemisphereLight(0xc9dded, 0x666546, 0.85);
sun.castShadow = true;
const preparedSunShadow = new PreparedSunShadow(sun);
sun.shadow.shadowNode = preparedSunShadow;
sun.shadow.autoUpdate = false;
let lastSunShadowUpdate = -Infinity;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {
  left: -65,
  right: 65,
  top: 65,
  bottom: -65,
  near: 1,
  far: 320,
});
sun.shadow.bias = -0.00015;
sun.shadow.normalBias = 0.18;
scene.add(sun, sun.target, ambient);
const lamp = new T.PointLight(0xff8b32, 0, 55, 2);
lamp.position.set(6, height(6, 5) + 3, 5);
lamp.castShadow = true;
lamp.shadow.mapSize.set(512, 512);
lamp.shadow.bias = -0.001;
scene.add(lamp);
const lampOrb = new T.Mesh(
  new T.SphereGeometry(0.16, 12, 8),
  new T.MeshBasicMaterial({ color: 0xffcd73 }),
);
lampOrb.visible = false;
scene.add(lampOrb);
const sunDirection = new T.Vector3(),
  sky = new Sky();
sky.scale.setScalar(7000);
sky.frustumCulled = false;
sky.cloudCoverage.value = 0;
sky.showSunDisc.value = 0;
const skyDirection = N.positionWorld.sub(N.cameraPosition).normalize();
sky.material.colorNode = N.vec4(
  skyColour({
    ray: skyDirection,
    sun: ref(lightUniforms, "liveSunDirection", "vec3"),
    cloud: cloudData(lightUniforms, N.cameraPosition, skyDirection),
    daylight: ref(lightUniforms, "daylight"),
  }),
  1,
);
const discMaterial = new T.MeshBasicNodeMaterial({
  depthWrite: false,
  transparent: true,
});
discMaterial.colorNode = N.vec3(12, 9, 5);
discMaterial.opacityNode = N.float(1).sub(
  cloudData(
    lightUniforms,
    N.cameraPosition,
    ref(lightUniforms, "liveSunDirection", "vec3"),
  ).a,
);
const sunDisc = new T.Mesh(new T.SphereGeometry(14, 24, 12), discMaterial);
sunDisc.frustumCulled = false;
scene.add(sunDisc);
let worldHour = 8.133333,
  cycleRunning = true,
  lastCycleTime = null,
  lastCycleLight = -Infinity;
function applySolar() {
  const state = solarState(worldHour);
  sunDirection.fromArray(state.direction).normalize();
  lightUniforms.daylight.value = state.daylight;
  sun.intensity = 2.6 * state.daylight;
  ambient.intensity = 0.025 + 0.825 * state.daylight;
  sun.color.setRGB(
    1,
    0.73 + 0.23 * Math.max(0, sunDirection.y),
    0.46 + 0.43 * Math.max(0, sunDirection.y),
  );
  lightUniforms.sunColour.value.set(sun.color.r, sun.color.g, sun.color.b);
  sky.sunPosition.value.copy(sunDirection);
  lightUniforms.liveSunDirection.value.copy(sunDirection);
  sunDisc.visible = sunDirection.y > -0.015;
  diagnostics.sun = {
    direction: sunDirection.toArray(),
    hour: worldHour,
    daylight: state.daylight,
    angularDiameterDegrees: 0.535,
    cloudHeight: 650,
  };
  $("lookSun").disabled = sunDirection.y <= 0;
  $("sunValue").textContent = `${state.elevation.toFixed(0)}°`;
  $("clockValue").textContent =
    `${String(Math.floor(worldHour)).padStart(2, "0")}:${String(Math.floor((worldHour % 1) * 60)).padStart(2, "0")}`;
  $("timeOfDay").value = worldHour;
}
$("lookSun").onclick = () => {
  const p = camera.position.clone();
  controls.target.copy(p).addScaledVector(sunDirection, 100);
  controls.update();
};
$("dayCycle").onchange = (e) => {
  cycleRunning = e.target.checked;
};
$("timeOfDay").oninput = (e) => {
  worldHour = Number(e.target.value);
  applySolar();
  lightDirty = true;
  updateSunShadow(true);
};
sky.turbidity.value = 1.5;
sky.rayleigh.value = 2;
sky.mieCoefficient.value = 0.0003;
sky.mieDirectionalG.value = 0.8;
scene.add(sky);
function setSun(degrees) {
  const a = T.MathUtils.degToRad(degrees);
  sunDirection
    .set(Math.cos(a) * -0.78, Math.sin(a), Math.cos(a) * -0.625)
    .normalize();
  sun.color.setRGB(
    1,
    0.73 + 0.23 * Math.max(0, sunDirection.y),
    0.46 + 0.43 * Math.max(0, sunDirection.y),
  );
  lightUniforms.sunColour.value.set(sun.color.r, sun.color.g, sun.color.b);
  sky.sunPosition.value.copy(sunDirection);
  lightUniforms.liveSunDirection.value.copy(sunDirection);
  diagnostics.sun = {
    direction: sunDirection.toArray(),
    angularDiameterDegrees: 0.53,
    cloudHeight: 650,
    maximumCloudAttenuation: CLOUD_SHADOW_STRENGTH,
  };
  updateSunShadow(true);
}
function updateSunShadow(force = false) {
  const now = performance.now();
  if (!force && now - lastSunShadowUpdate < 50) return;
  lastSunShadowUpdate = now;
  sun.shadow.needsUpdate = true;
  sun.target.position.set(
    camera.position.x,
    height(camera.position.x, camera.position.z),
    camera.position.z,
  );
  sun.position.copy(sun.target.position).addScaledVector(sunDirection, 170);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}
applySolar();
updateSunShadow(true);
const cache = new BakeCache(),
  world = makeWorld();
applyTreeInfluence(world.trees);
let clusters = [],
  grass = null,
  shrubs = [],
  deadwood = [],
  assetHash = "",
  surfaceIdentity = "",
  baking = true,
  forcedTree = -1,
  forcedGrass = -1,
  debug = false,
  dynamic = false,
  lastLighting = 0,
  lightDirty = false;
function progress(message, p) {
  if (!loopStarted) {
    diagnostics.startup ||= [];
    diagnostics.startup.push({
      stage: message,
      ms: Math.round(performance.now()),
    });
  }
  $("status").textContent = message;
  $("progress").style.width = Math.round(p * 100) + "%";
}
function cacheLabel() {
  $("cache").textContent = cache.warning
    ? "Storage warning"
    : cache.available
      ? `${cache.hits} hits / ${cache.misses} new`
      : "Memory only";
}
const keys = new Set();
let walking = false,
  yaw = 0,
  pitch = 0;
function resumeOrbit(keepExploring = false) {
  walking = false;
  document.body.classList.toggle("exploring", keepExploring);
  controls.enabled = true;
  controls.target
    .copy(camera.position)
    .addScaledVector(camera.getWorldDirection(new T.Vector3()), 15);
}
$("explore").onclick = async () => {
  walking = true;
  document.body.classList.add("exploring");
  controls.enabled = false;
  const d = camera.getWorldDirection(new T.Vector3());
  yaw = Math.atan2(-d.x, -d.z);
  pitch = Math.asin(d.y);
  // Mouse capture can be denied in embedded previews or an inactive tab.
  // Keep the loaded world usable with drag/scroll controls in that case.
  if (!renderer.domElement.requestPointerLock) return resumeOrbit(true);
  try {
    await renderer.domElement.requestPointerLock();
  } catch {
    resumeOrbit(true);
  }
};
document.addEventListener("pointerlockerror", () => resumeOrbit(true));
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== renderer.domElement) {
    resumeOrbit();
  }
});
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    yaw -= e.movementX * 0.002;
    pitch = T.MathUtils.clamp(pitch - e.movementY * 0.002, -1.4, 1.4);
  }
});
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select,button")) return;
  keys.add(e.code);
  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code))
    e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());
let viewpoint = 0;
const views = [
  [
    [19, 4.2, 43],
    [-8, 5, -23],
  ],
  [
    [4, 2.1, 4],
    [-12, 6, -30],
  ],
  [
    [-44, 21, 56],
    [5, 5, -18],
  ],
  [
    [riverCenter(12) + 10, 2.2, 12],
    [
      riverCenter(-24),
      riverLevel(-24) - height(riverCenter(-24), -24) + 0.3,
      -24,
    ],
  ],
  [
    [1250, 650, 1350],
    [0, 3, 0],
  ],
];
$("view").onclick = () => {
  viewpoint = (viewpoint + 1) % views.length;
  const [p, t] = views[viewpoint];
  camera.position.set(p[0], height(p[0], p[2]) + p[1], p[2]);
  controls.target.set(t[0], height(t[0], t[2]) + t[1], t[2]);
  controls.update();
};
$("sun").oninput = () => {
  $("sunValue").textContent = $("sun").value + "°";
  cycleRunning = false;
  $("dayCycle").checked = false;
  worldHour = 6 + Number($("sun").value) / 15;
  applySolar();
  updateSunShadow(true);
  lightDirty = true;
  $("status").textContent = "Live sun · GPU radiance updating";
};
$("resolution").onchange = () => {
  $("status").textContent = "Resolution changed · bake to apply";
};
$("treeLod").onchange = (e) => (forcedTree = Number(e.target.value));
$("grassLod").onchange = (e) => (forcedGrass = Number(e.target.value));
$("gi").onchange = (e) =>
  (lightUniforms.bakedEnabled.value = e.target.checked ? 1 : 0);
$("dynamic").onchange = (e) => {
  dynamic = e.target.checked;
  lamp.intensity = dynamic ? 700 : 0;
  lampOrb.visible = dynamic;
  lightDirty = true;
};
$("lodColors").onchange = (e) => {
  debug = e.target.checked;
  for (const c of clusters)
    c.levels.forEach((group, i) =>
      group?.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.userData.originalColor)
          o.userData.originalColor = o.material.color.clone();
        o.material.color.copy(
          debug
            ? new T.Color([0xb9dd9f, 0xe5bf46, 0x63c1eb, 0xca8bde][i])
            : o.userData.originalColor,
        );
      }),
    );
};
$("clear").onclick = async () => {
  await finishGrassJobs();
  await clearGrassBakes();
  await clearTreeBakes();
  await cache.clear();
  await clearMergedCache();
  cacheLabel();
  $("status").textContent = "Project cache cleared";
};
async function bake() {
  if (diagnostics.baking) return;
  baking = !loopStarted;
  diagnostics.baking = true;
  $("bake").disabled = true;
  $("clear").disabled = true;
  const start = performance.now();
  try {
    const areaX = Math.round(camera.position.x / 64) * 64,
      areaZ = Math.round(camera.position.z / 64) * 64;
    volumeMin.set(
      areaX - 128,
      Math.floor(height(areaX, areaZ) / 8) * 8 - 16,
      areaZ - 128,
    );
    const n = Number($("resolution").value);
    const result = await bakeVolume(
      renderer,
      world,
      cache,
      n,
      sunDirection,
      assetHash,
      progress,
    );
    await bakeTreeHLOD(
      renderer,
      clusters,
      [],
      cache,
      surfaceIdentity,
      progress,
    );
    await bakeGrassLOD(renderer, grass, [], cache, surfaceIdentity, progress);
    await bakeShrubLOD(renderer, shrubs, cache, surfaceIdentity);
    diagnostics.bakes.push({
      ...result,
      totalMs: performance.now() - start,
      hits: cache.hits,
      misses: cache.misses,
    });
    diagnostics.volumeKey = result.key;
    diagnostics.ready = true;
    diagnostics.treeCount = world.trees.length;
    diagnostics.clusterCount = clusters.length;
    diagnostics.grassPatchCount = grass.patches.length;
    diagnostics.growth = clusters.prototypes.map((p) => ({
      species: p.speciesName,
      age: p.age,
      segments: p.segments.length,
      leafCards: p.leaves.length,
      highTriangles: p.high.index.count / 3,
      lowTriangles: p.low.index.count / 3,
    }));
    $("volume").textContent = `${n} × ${n / 2} × ${n}`;
    progress(
      `16 km² · ${world.trees.length} trees · ${((performance.now() - start) / 1000).toFixed(1)}s`,
      1,
    );
    cacheLabel();
    lightDirty = true;
  } catch (e) {
    fail(e);
  } finally {
    baking = false;
    diagnostics.baking = false;
    $("bake").disabled = false;
    $("clear").disabled = false;
  }
}
$("bake").onclick = bake;
const assetNames = [
  "bark",
  "oak",
  "birch",
  "ash",
  "grass",
  "meadow",
  "clover",
  "dirt",
  "rock",
  "meadow-ground",
  "bark-birch",
  "bark-ash",
  "lush-ground",
  "meadow-long",
  "meadow-seeds",
  "flowers-yellow",
  "flowers-purple",
  "hazel",
  "bramble",
  "pine",
  "ground-meadow",
];
async function loadAssets() {
  const assets = {},
    hashes = [],
    loader = new T.TextureLoader();
  // Fetch/decode concurrently; GPU normal and atlas passes remain serialized.
  const downloads = new Map(
    assetNames.map((name) => {
      const url = `${import.meta.env.BASE_URL}textures/${name}.png`;
      return [
        name,
        (async () => {
          const response = await fetch(url);
          if (!response.ok) throw Error(`Missing ${name}`);
          const blob = await response.blob();
          const hash = await digest(await blob.arrayBuffer());
          const objectURL = URL.createObjectURL(blob);
          try {
            return { hash, map: await loader.loadAsync(objectURL) };
          } finally {
            URL.revokeObjectURL(objectURL);
          }
        })(),
      ];
    }),
  );
  // Attach rejection handlers immediately while consuming in stable asset order.
  for (const job of downloads.values()) job.catch(() => {});
  for (const name of assetNames) {
    progress(`Loading ${name} surface`, 0.01);
    const downloaded = await downloads.get(name);
    const hash = downloaded.hash;
    hashes.push(hash);
    let map = downloaded.map;
    map.colorSpace = T.SRGBColorSpace;
    map.anisotropy = Math.min(16, renderer.getMaxAnisotropy());
    if (
      [
        "bark",
        "bark-birch",
        "bark-ash",
        "dirt",
        "rock",
        "meadow-ground",
        "lush-ground",
        "ground-meadow",
      ].includes(name)
    ) {
      map.wrapS = map.wrapT = T.RepeatWrapping;
      map.repeat.set(
        name.startsWith("bark") ? 1 : name === "rock" ? 1 : 220,
        name.startsWith("bark") ? 3 : name === "rock" ? 1 : 220,
      );
    }
    const key = "normal-native-v3:" + (await digest(hash + nativeSource));
    let record = await cache.get(key);
    if (!record) {
      const source = map.clone();
      source.repeat.set(1, 1);
      source.colorSpace = T.NoColorSpace;
      record = await makeNormal(
        renderer,
        source,
        name.startsWith("bark") ? 6 : 3,
      );
      source.dispose();
      await cache.put(key, record);
    }
    const normal = new T.DataTexture(
      record.data,
      record.w,
      record.h,
      T.RGBAFormat,
    );
    normal.wrapS = map.wrapS;
    normal.wrapT = map.wrapT;
    normal.repeat.copy(map.repeat);
    normal.minFilter = T.LinearMipmapLinearFilter;
    normal.magFilter = T.LinearFilter;
    normal.generateMipmaps = true;
    normal.needsUpdate = true;
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleCanvas.height = 64;
    const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(map.image, 0, 0, 64, 64);
    const pixels = ctx.getImageData(0, 0, 64, 64).data;
    let coverage = 0,
      r = 0,
      g = 0,
      b = 0;
    const linear = new T.Color();
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3] / 255;
      coverage += a;
      linear.setRGB(
        pixels[i] / 255,
        pixels[i + 1] / 255,
        pixels[i + 2] / 255,
        T.SRGBColorSpace,
      );
      r += linear.r * a;
      g += linear.g * a;
      b += linear.b * a;
    }
    const colour = new T.Color(
      r / Math.max(coverage, 1),
      g / Math.max(coverage, 1),
      b / Math.max(coverage, 1),
    );
    const mipKey = "source-mips-v2:" + (await digest(hash + atlasWorkerSource));
    let mipRecord = await cache.get(mipKey);
    if (!mipRecord) {
      sampleCanvas.width = map.image.width;
      sampleCanvas.height = map.image.height;
      ctx.drawImage(map.image, 0, 0);
      const raw = ctx.getImageData(
        0,
        0,
        sampleCanvas.width,
        sampleCanvas.height,
      ).data;
      const data = new Uint8Array(raw.length),
        stride = sampleCanvas.width * 4;
      for (let y = 0; y < sampleCanvas.height; y++)
        data.set(
          raw.subarray(y * stride, (y + 1) * stride),
          (sampleCanvas.height - 1 - y) * stride,
        );
      mipRecord = await prepareAtlasMips({
        w: sampleCanvas.width,
        h: sampleCanvas.height,
        views: 1,
        data,
        normals: record.data,
        srgb: true,
        cutoff: ["oak", "birch", "ash", "pine", "hazel", "bramble"].includes(
          name,
        )
          ? 103
          : 87,
      });
      await cache.put(mipKey, mipRecord);
    }
    const bakedMap = new T.DataTexture(
      mipRecord[0].data,
      map.image.width,
      map.image.height,
      T.RGBAFormat,
    );
    bakedMap.colorSpace = T.SRGBColorSpace;
    bakedMap.wrapS = map.wrapS;
    bakedMap.wrapT = map.wrapT;
    bakedMap.repeat.copy(map.repeat);
    bakedMap.anisotropy = map.anisotropy;
    bakedMap.mipmaps = mipRecord.map((l) => ({
      data: l.data,
      width: l.width,
      height: l.height,
    }));
    bakedMap.generateMipmaps = false;
    bakedMap.minFilter = T.LinearMipmapLinearFilter;
    bakedMap.magFilter = T.LinearFilter;
    bakedMap.needsUpdate = true;
    normal.mipmaps = mipRecord.map((l) => ({
      data: l.normals,
      width: l.width,
      height: l.height,
    }));
    normal.generateMipmaps = false;
    normal.needsUpdate = true;
    map.dispose();
    map = bakedMap;
    const tail = mipRecord.at(-1).data;
    colour.setRGB(
      tail[0] / 255,
      tail[1] / 255,
      tail[2] / 255,
      T.SRGBColorSpace,
    );
    assets[name] = {
      map,
      normal,
      profile: { coverage: coverage / 4096, colour: colour.toArray() },
    };
    diagnostics.assets[name] = {
      width: map.image.width,
      height: map.image.height,
      normalWidth: record.w,
      normalHeight: record.h,
      hash,
    };
  }
  assetHash = await digest(
    woodUnionSource +
      appearanceSource +
      catalogSource +
      habitatSource +
      plantGrowthSource +
      plantAtlasSource +
      nativeSource +
      nativeVolumeSource +
      tslBakeSource +
      tslMaterialSource +
      hashes.join("") +
      lightingSource +
      worldSource +
      terrainSource +
      terrainMathSource +
      terrainSnapshotSource +
      vegetationSource +
      deadwoodSource +
      detailSource +
      treeGridSource +
      voxelWorkerSource,
  );
  surfaceIdentity = await digest(
    woodUnionSource +
      appearanceSource +
      "layered-surfaces-v5:" +
      catalogSource +
      habitatSource +
      plantGrowthSource +
      plantAtlasSource +
      grassWorkerSource +
      grassDataSource +
      atlasWorkerSource +
      nativeSource +
      nativeVolumeSource +
      tslBakeSource +
      tslMaterialSource +
      hashes.join("") +
      vegetationSource +
      growthSource +
      worldSource +
      terrainSource +
      terrainMathSource +
      terrainSnapshotSource +
      impostorSource +
      mergedSource +
      mergedDataSource,
  );
  return assets;
}
const frameClock = new FrameClock();
let frameTime = 0,
  animationId = null,
  loopStarted = false,
  capturePaused = false;
function scheduleFrame() {
  if (animationId === null && !document.hidden && loopStarted && !capturePaused)
    animationId = requestAnimationFrame(animate);
}
document.addEventListener("visibilitychange", () => {
  frameClock.reset();
  frameTime = 0;
  if (document.hidden) {
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
  } else scheduleFrame();
});
function animate(now) {
  animationId = null;
  scheduleFrame();
  const dt = frameClock.begin(now, baking);
  if (baking) {
    frameTime = 0;
    return;
  }
  const cpuStart = performance.now();
  lightUniforms.time.value = now / 1000;
  if (lastCycleTime !== null && cycleRunning)
    worldHour = advanceHour(worldHour, (now - lastCycleTime) / 1000);
  lastCycleTime = now;
  applySolar();
  if (cycleRunning && now - lastCycleLight > 2000) {
    lightDirty = true;
    lastCycleLight = now;
  }
  sunDisc.position.copy(camera.position).addScaledVector(sunDirection, 3000);
  sunDisc.updateMatrixWorld();
  if (walking) {
    camera.rotation.order = "YXZ";
    camera.rotation.set(pitch, yaw, 0);
    const speed = (keys.has("ShiftLeft") ? 22 : 6) * dt,
      forward = new T.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)),
      right = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (keys.has("KeyW")) camera.position.addScaledVector(forward, speed);
    if (keys.has("KeyS")) camera.position.addScaledVector(forward, -speed);
    if (keys.has("KeyA")) camera.position.addScaledVector(right, -speed);
    if (keys.has("KeyD")) camera.position.addScaledVector(right, speed);
    camera.position.x = T.MathUtils.clamp(
      camera.position.x,
      -TERRAIN_SIZE / 2 + 20,
      TERRAIN_SIZE / 2 - 20,
    );
    camera.position.z = T.MathUtils.clamp(
      camera.position.z,
      -TERRAIN_SIZE / 2 + 20,
      TERRAIN_SIZE / 2 - 20,
    );
    camera.position.y = height(camera.position.x, camera.position.z) + 1.85;
  } else {
    controls.dampingFactor = dampingAtDelta(0.045, dt);
    controls.update(dt);
  }
  // Orbit and scroll must obey the same ground clearance as walking.
  camera.position.x = T.MathUtils.clamp(
    camera.position.x,
    -TERRAIN_SIZE / 2 + 20,
    TERRAIN_SIZE / 2 - 20,
  );
  camera.position.z = T.MathUtils.clamp(
    camera.position.z,
    -TERRAIN_SIZE / 2 + 20,
    TERRAIN_SIZE / 2 - 20,
  );
  const floor = terrainCameraFloor(camera.position.x, camera.position.z);
  if (camera.position.y < floor) {
    const lift = floor - camera.position.y;
    camera.position.y = floor;
    if (!walking) controls.target.y += lift;
  }
  sky.position.copy(camera.position);
  sky.updateMatrixWorld();
  updateSunShadow();
  if (dynamic) {
    const t = now * 0.0004;
    lamp.position.set(
      camera.position.x + Math.sin(t) * 9,
      height(camera.position.x, camera.position.z) + 3.5,
      camera.position.z - 12 + Math.cos(t) * 8,
    );
    lampOrb.position.copy(lamp.position);
    lamp.updateMatrixWorld();
    lampOrb.updateMatrixWorld();
  }
  if (
    !diagnostics.baking &&
    (dynamic || lightDirty) &&
    now - lastLighting > 180
  ) {
    refreshLighting(renderer, sunDirection, lamp.position, dynamic ? 700 : 0);
    lastLighting = now;
    lightDirty = false;
  }
  diagnostics.treeLevels = updateLOD(
    clusters,
    camera,
    forcedTree,
    [85, 190, 420],
    scene,
  );
  diagnostics.grassLevels = updateLOD(
    grass.patches,
    camera,
    forcedGrass,
    GRASS_LOD_DISTANCES,
    scene,
  );
  updateShrubs(shrubs, camera, scene);
  updateShrubs(deadwood, camera, scene);
  updateTerrain(camera);
  updateMergedVisibility(clusters, camera, scene);
  diagnostics.mergedVisibility = mergedStats;
  diagnostics.grassBake = grassBakeStats;
  diagnostics.grassStreaming = grassStreamingStats;
  diagnostics.preparation = {
    voxel: voxelWorkerStats,
    merged: mergedWorkerStats,
    renderer: rendererJobStats,
    shadows: preparedSunShadow.stats,
    uploads: gpuUploads.stats,
  };
  renderer.info.reset();
  updateClouds(renderer, now, lightUniforms, camera);
  composer.render();
  frameClock.end(performance.now() - cpuStart);
  if (now - frameTime > 250) {
    diagnostics.frameTiming = frameClock.read();
    diagnostics.fps = Math.round(diagnostics.frameTiming.fps);
    diagnostics.drawCalls = renderer.info.render.drawCalls;
    diagnostics.triangles = renderer.info.render.triangles;
    diagnostics.cache = {
      hits: cache.hits,
      misses: cache.misses,
      available: cache.available,
      warning: cache.warning,
    };
    diagnostics.lighting = { ...lightingState, dynamic };
    diagnostics.camera = camera.position.toArray();
    $("fps").textContent = diagnostics.fps || "—";
    $("fps").title =
      `Delivered animation rate; ${diagnostics.frameTiming.frameMs.toFixed(2)} ms between callbacks, ${diagnostics.frameTiming.cpuMs.toFixed(2)} ms average CPU submission. This is not measured panel Hz or GPU time.`;
    $("draws").textContent = `${diagnostics.drawCalls} draws`;
    $("lodStats").textContent =
      `Trees ${diagnostics.treeLevels.join(" / ")} · ${lightingState.updates} light updates — ${mergedStats.mergedDraws}/${mergedStats.visible} far clusters merged`;
    frameTime = now;
  }
  const cx = volumeMin.x + 128,
    cz = volumeMin.z + 128;
  if (
    Math.abs(camera.position.x - cx) > 64 ||
    Math.abs(camera.position.z - cz) > 64
  )
    bake();
}
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
window.worldTest = {
  terrainCameraFloor,
  getCloudTarget,
  camera,
  controls,
  lamp,
  lampOrb,
  sun,
  cache,
  rebake: bake,
  renderer,
  scene,
  lightUniforms,
  lightingState,
  readLighting: () => readLighting(renderer),
  refreshLighting: (position, power) =>
    refreshLighting(renderer, sunDirection, new T.Vector3(...position), power),
  terrainSample,
  voxelProbe,
  routes,
  world,
};
// Local capture harnesses can render every output frame at a fixed time without
// making dropped live frames part of an exported movie. Removed in production.
if (import.meta.env.DEV)
  window.worldTest.capture = {
    pause() {
      capturePaused = true;
      if (animationId !== null) cancelAnimationFrame(animationId);
      animationId = null;
      setPreparationPresenting(false);
    },
    render(seconds) {
      animate(seconds * 1000);
    },
    setHour(hour) {
      cycleRunning = false;
      worldHour = hour;
      applySolar();
      updateSunShadow(true);
      lightDirty = true;
    },
    resume() {
      capturePaused = false;
      lastCycleTime = null;
      frameClock.reset();
      setPreparationPresenting(true);
      scheduleFrame();
    },
  };
async function start() {
  await cache.open();
  const assets = await loadAssets();
  progress("Baking cloud density and sunlight", 0.015);
  await prepareClouds(
    renderer,
    cache,
    await digest(cloudKernelSource + cloudDensityGLSL + cloudDensityWGSL),
    lightUniforms,
    camera,
  );
  diagnostics.clouds = cloudStats;
  progress("Baking shared meadow atlas", 0.02);
  diagnostics.plants = {
    trees: TREE_TYPES,
    shrubs: SHRUB_TYPES,
    grass: GRASS_TYPES.map((t) => t.name),
  };
  diagnostics.grassPalette = await bakePlantAtlas(
    assets,
    cache,
    surfaceIdentity,
  );
  progress("Baking flowing river surface", 0.025);
  await prepareRiver(renderer, cache);
  diagnostics.environment = buildEnvironment(scene, assets);
  window.worldTest.river = diagnostics.environment.water;
  diagnostics.environment = {
    rocks: diagnostics.environment.rocks,
    river: riverStats,
  };
  deadwood = buildDeadwood(world, assets);
  diagnostics.deadwood = deadwood.stats;
  window.worldTest.deadwood = deadwood;
  const geometryIdentity = await digest(
    growthSource +
      plantGrowthSource +
      woodUnionSource +
      appearanceSource +
      catalogSource,
  );
  clusters = await buildTrees(world, assets, geometryIdentity, progress);
  grass = buildGrass(assets);
  clusters.prepareGroup = (group) => {
    if (group.userData.pipelineReady) return Promise.resolve();
    if (group.userData.preparation) return group.userData.preparation;
    group.userData.preparation = (async () => {
      await prepareForRender(
        renderer,
        group,
        camera,
        scene,
        composer.sceneTarget,
        null,
        1,
      );
      await preparedSunShadow.prepare(renderer, group, scene);
      group.userData.pipelineReady = true;
      clusters.lodRevision = (clusters.lodRevision || 0) + 1;
    })().catch((error) => {
      group.userData.preparation = null;
      fail(error);
      throw error;
    });
    return group.userData.preparation;
  };
  // Worker completions arrive in a small burst. Compile/upload that page together
  // rather than paying compileAsync's scheduling overhead once per grass tile.
  let grassPreparation = [],
    grassPreparationTimer = null;
  grass.prepare = (group, priority) => {
    if (!group.children.length) return Promise.resolve();
    const result = new Promise((resolve, reject) => {
      grassPreparation.push({ group, priority, resolve, reject });
    });
    if (grassPreparationTimer === null)
      grassPreparationTimer = setTimeout(async () => {
        grassPreparationTimer = null;
        const requests = grassPreparation;
        grassPreparation = [];
        const page = new T.Group();
        for (const request of requests) page.add(request.group);
        try {
          await prepareForRender(
            renderer,
            page,
            camera,
            scene,
            composer.sceneTarget,
            null,
            1,
            () => Math.min(...requests.map((request) => request.priority())),
          );
          for (const request of requests) request.resolve();
        } catch (error) {
          for (const request of requests) request.reject(error);
        } finally {
          // Publication remains the owner's responsibility, after the whole page
          // is resident. No visible representation is removed during preparation.
          page.clear();
        }
      }, 8);
    return result;
  };
  diagnostics.grassGround = await bakeGrassGround(
    renderer,
    cache,
    surfaceIdentity,
    assets,
  );
  shrubs = await buildShrubs(world, assets, geometryIdentity);
  world.materialProfiles = Object.fromEntries(
    Object.entries(assets)
      .filter(([, v]) => v.profile)
      .map(([k, v]) => [k, v.profile]),
  );
  world.grassBake = grass;
  world.surfaceIdentity = surfaceIdentity;
  world.grassPoints = grassPoints;
  world.treePrototypes = clusters.prototypes;
  world.buildVoxelDetails = buildVoxelDetailsAsync;
  world.voxelMeshes = [];
  scene.traverse((o) => {
    if (o.userData.voxelKind) world.voxelMeshes.push(o);
  });
  for (const entry of shrubs)
    entry.group.traverse((o) => {
      if (o.isInstancedMesh) {
        o.userData.voxelKind = "shrub";
        world.voxelMeshes.push(o);
      }
    });

  window.worldTest.clusters = clusters;
  window.worldTest.grass = grass;
  window.worldTest.shrubs = shrubs;
  clusters.forEach((c) => {
    if (c.levels[0] && c.center.distanceTo(camera.position) < 180)
      scene.add(c.levels[0]);
  });
  diagnostics.areaIndexes = indexVoxelWorld(world);
  world.bakeIdentity = await digest(
    assetHash + surfaceIdentity + JSON.stringify([world.trees, world.deadwood]),
  );
  await bake();
  if (!diagnostics.ready) return;
  baking = true;
  diagnostics.baking = true;
  progress("Preparing scene shaders", 0.98);
  controls.update();
  const prepareGroup = clusters.prepareGroup;
  clusters.prepareGroup = null;
  updateLOD(clusters, camera, forcedTree, [85, 190, 420], scene);
  clusters.prepareGroup = prepareGroup;
  updateLOD(grass.patches, camera, forcedGrass, GRASS_LOD_DISTANCES, scene);
  updateShrubs(shrubs, camera, scene);
  updateShrubs(deadwood, camera, scene);
  updateTerrain(camera);
  // Ground cover is already resident. Stream geometry after the first frame
  // instead of holding presentation until hundreds of grass tiles finish.
  // Initial merged geometry is prepared in the single scene warmup below.
  // Avoid a separate compile/upload round-trip for each of the 1024 clusters.
  clusters.startupMerge = true;
  try {
    for (let i = 0; i < clusters.length; i += 8) {
      const jobs = [];
      for (let j = 0; j < 8; j++) {
        const job = updateMergedVisibility(clusters, camera, scene, true);
        if (!job) break;
        jobs.push(job);
      }
      if (!jobs.length) break;
      await Promise.all(jobs);
      progress(`Preparing forest pages ${mergedStats.baked}`, 0.97);
    }
  } finally {
    clusters.startupMerge = false;
  }
  updateMergedVisibility(clusters, camera, scene);
  // Warm the active distance rings in every direction. Frustum-limited compilation
  // made a camera turn synchronously build hundreds of first-use materials.
  const culled = [];
  scene.traverse((o) => {
    if (o.isMesh) {
      culled.push([o, o.frustumCulled]);
      o.frustumCulled = false;
    }
  });
  try {
    await prepareForRender(
      renderer,
      scene,
      camera,
      scene,
      composer.sceneTarget,
      null,
      1,
    );
  } finally {
    for (const [object, value] of culled) object.frustumCulled = value;
  }
  await preparedSunShadow.prepare(renderer, scene, scene);
  // Newly selected terrain and shrub meshes use the same page/pipeline gate as
  // trees. Previously these LOD switches could bypass the preparation queue.
  scene.traverseVisible((object) => {
    object.userData.pipelineReady = true;
  });
  setTerrainPreparation(clusters.prepareGroup);
  shrubs.prepareGroup = clusters.prepareGroup;
  deadwood.prepareGroup = clusters.prepareGroup;
  clusters.forEach((c) =>
    c.levels.forEach((g) => {
      if (g?.visible) g.userData.pipelineReady = true;
    }),
  );
  baking = false;
  diagnostics.baking = false;
  progress(`16 km² · ${world.trees.length} trees · ready`, 1);
  setPreparationPresenting(true);
  loopStarted = true;
  startGrassJobs();
  scheduleFrame();
}
start().catch(fail);
