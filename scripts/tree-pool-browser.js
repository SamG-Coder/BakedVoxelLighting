import * as T from "three/webgpu";
import { VegetationInstancePool } from "../src/vegetation-instance-pool.js";
import { readPixels } from "../src/tsl-baking.js";
import { installGeometryLeases } from "../src/shared-geometry.js";
import { disposeVegetationGroup } from "../src/vegetation-resources.js";
const out = document.querySelector("#result");
try {
  const renderer = new T.WebGPURenderer({
    forceWebGL:
      new URLSearchParams(location.search).get("backend") === "webgl2",
  });
  await renderer.init();
  installGeometryLeases(renderer);
  renderer.backend.capabilities.getUniformBufferLimit = () => 0;
  const scene = new T.Scene(),
    camera = new T.PerspectiveCamera(50, 1, 0.1, 100),
    target = new T.RenderTarget(128, 128);
  camera.position.set(0, 2, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.add(new T.HemisphereLight(0xffffff, 0x334422, 2));
  const sun = new T.DirectionalLight(0xffffff, 3);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const geometry = new T.CylinderGeometry(0.2, 0.5, 3, 7),
    material = () => new T.MeshStandardNodeMaterial({ roughness: 0.8 });
  const pool = new VegetationInstancePool(1),
    group = new T.Group();
  scene.add(group);
  const original = pool.acquire(geometry, material, [
    { p: [-2, 0, 0], colour: [0.2, 0.7, 0.1] },
  ]);
  group.add(original);
  renderer.setRenderTarget(target);
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  pool.releaseGroup(group);
  scene.add(group);
  const transforms = [
    { p: [1, 0, 0], r: [0, 0.7, 0.2], s: [1, 0.9, 1], colour: [0.6, 0.2, 0.1] },
    {
      p: [-1, 0, -1],
      r: [0, -0.5, 0],
      s: [0.8, 1.2, 0.8],
      colour: [0.1, 0.4, 0.6],
    },
  ];
  group.add(pool.acquire(geometry, material, transforms));
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  const reused = await readPixels(
    renderer,
    target,
    0,
    0,
    128,
    128,
    new Uint8Array(128 * 128 * 4),
  );
  scene.remove(group);
  const fresh = new VegetationInstancePool().acquire(
    geometry,
    material,
    transforms,
  );
  scene.add(fresh);
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  const reference = await readPixels(
    renderer,
    target,
    0,
    0,
    128,
    128,
    new Uint8Array(reused.length),
  );
  let changed = 0;
  for (let i = 0; i < reused.length; i++)
    if (reused[i] !== reference[i]) changed++;
  if (changed) throw Error(`${changed} changed channels`);
  // Retiring another batch must neither delete the shared prototype buffers nor
  // retain private render objects / shader states across repeated section visits.
  disposeVegetationGroup(group);
  const states = renderer._nodes.nodeBuilderCache.size;
  const objects = renderer._objects._renderObjects.size;
  const geometries = renderer.info.memory.geometries;
  const memory = { ...renderer.info.memory };
  for (let i = 0; i < 24; i++) {
    const transient = new VegetationInstancePool(0).acquire(
      geometry,
      material,
      transforms,
    );
    scene.add(transient);
    await renderer.compileAsync(scene, camera);
    if (renderer._nodes.nodeBuilderCache.size !== states)
      throw Error("Identical batches compiled separate shader graphs");
    renderer.render(scene, camera);
    disposeVegetationGroup(transient);
    renderer.render(scene, camera);
  }
  const surviving = await readPixels(
    renderer,
    target,
    0,
    0,
    128,
    128,
    new Uint8Array(reference.length),
  );
  if (surviving.some((v, i) => v !== reference[i]))
    throw Error("Disposing a sibling damaged shared geometry");
  if (
    renderer._nodes.nodeBuilderCache.size !== states ||
    renderer._objects._renderObjects.size !== objects ||
    renderer.info.memory.geometries !== geometries
  )
    throw Error("Retired batches retained renderer state");
  for (const key of [
    "attributes",
    "attributesSize",
    "indexAttributes",
    "uniformBuffers",
    "uniformBuffersSize",
  ])
    if (renderer.info.memory[key] !== memory[key])
      throw Error(
        `Retired batch leaked ${key}: ${memory[key]} -> ${renderer.info.memory[key]}`,
      );
  out.textContent = JSON.stringify({
    passed: true,
    changed,
    reused: pool.stats.reused,
    retirementCycles: 24,
    states,
    objects,
    geometries,
    backend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2",
  });
} catch (error) {
  out.textContent = JSON.stringify({ passed: false, error: String(error) });
}
