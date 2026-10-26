import * as T from "three/webgpu";
import * as N from "three/tsl";
import {
  publishedLighting,
  retireLightingInputs,
} from "../src/lighting-resources.js";
import { fullscreen, readPixels, texRef } from "../src/tsl-baking.js";
import { uploadTextures } from "../src/gpu-uploads.js";
import { ResidentPointShadow } from "../src/prepared-shadows.js";
const errors = [];
const original = console.error;
console.error = (...a) => {
  errors.push(a.map(String).join(" "));
  original(...a);
};
addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
const output = document.querySelector("#result");
try {
  const backend = new URLSearchParams(location.search).get("backend");
  const renderer = new T.WebGPURenderer({ forceWebGL: backend === "webgl2" });
  await renderer.init();
  renderer.setSize(16, 16);
  document.body.append(renderer.domElement);
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    scene = new T.Scene(),
    target = new T.RenderTarget(2, 2, { depthBuffer: false });
  const U = { map: { value: publishedLighting(renderer, 96).directions } };
  const material = fullscreen(texRef(U, "map").sample(N.uv()));
  const mesh = new T.Mesh(new T.PlaneGeometry(2, 2), material);
  scene.add(mesh);
  const checks = [];
  for (let step = 0; step < 12; step++) {
    const n = [96, 48, 64, 96][step % 4],
      pair = publishedLighting(renderer, n);
    const data = new Uint8Array(n ** 3 * 2);
    for (let y = 0; y < (n * n) / 2; y++)
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4;
        data.set(
          [
            20 + step * 13,
            x < n / 2 ? 30 : 210,
            y < (n * n) / 4 ? 40 : 200,
            255,
          ],
          i,
        );
      }
    const staging = new T.DataTexture(data, n, (n * n) / 2);
    staging.needsUpdate = true;
    await uploadTextures(renderer, [staging, pair.directions]);
    renderer.copyTextureToTexture(staging, pair.directions);
    U.map.value = pair.directions;
    renderer.setRenderTarget(target);
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    await retireLightingInputs(renderer, [staging]);
    const pixels = await readPixels(
      renderer,
      target,
      0,
      0,
      2,
      2,
      new Uint8Array(16),
    );
    const expected = [
      20 + step * 13,
      30,
      40,
      255,
      20 + step * 13,
      210,
      40,
      255,
      20 + step * 13,
      30,
      200,
      255,
      20 + step * 13,
      210,
      200,
      255,
    ];
    if (pixels.some((v, i) => Math.abs(v - expected[i]) > 1))
      throw Error("Copy/orientation mismatch " + step + ": " + pixels);
    checks.push({ step, n, pixels: [...pixels] });
    output.textContent = JSON.stringify({ backend, checks, errors });
  }
  // Reproduce a shadow that is sampled while off, then first rendered later.
  // Before attachment initialization this destroyed a bound cube depth image.
  const shadowScene = new T.Scene();
  const light = new T.PointLight(0xffffff, 0, 20);
  light.position.set(1, 2, 3);
  light.castShadow = true;
  light.shadow.mapSize.set(32, 32);
  light.shadow.autoUpdate = false;
  light.shadow.shadowNode = new ResidentPointShadow(light);
  shadowScene.add(light);
  const sphere = new T.Mesh(
    new T.SphereGeometry(0.5, 8, 6),
    new T.MeshStandardNodeMaterial(),
  );
  sphere.castShadow = sphere.receiveShadow = true;
  shadowScene.add(sphere);
  const eye = new T.PerspectiveCamera(60, 1, 0.1, 20);
  eye.position.z = 3;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  await renderer.compileAsync(shadowScene, eye);
  for (let step = 0; step < 8; step++) {
    light.intensity = step % 2 ? 30 : 0;
    light.shadow.needsUpdate = light.intensity > 0;
    renderer.render(shadowScene, eye);
    if (renderer.backend.device)
      await renderer.backend.device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (errors.length) throw Error(errors.join("\n"));
  output.textContent = JSON.stringify({
    passed: true,
    backend,
    checks: checks.length,
    shadowToggles: 8,
    errors,
  });
} catch (e) {
  output.textContent = JSON.stringify({
    passed: false,
    error: String(e),
    errors,
  });
}
