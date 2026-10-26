import * as T from "three/webgpu";
import { VegetationInstancePool } from "../src/vegetation-instance-pool.js";
import { readPixels } from "../src/tsl-baking.js";
const out = document.querySelector("#result");
try {
  const renderer = new T.WebGPURenderer({
    forceWebGL:
      new URLSearchParams(location.search).get("backend") === "webgl2",
  });
  await renderer.init();
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
  out.textContent = JSON.stringify({
    passed: true,
    changed,
    reused: pool.stats.reused,
    backend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2",
  });
} catch (error) {
  out.textContent = JSON.stringify({ passed: false, error: String(error) });
}
