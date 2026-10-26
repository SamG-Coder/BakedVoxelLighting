import * as T from "three/webgpu";
import * as N from "three/tsl";
import { setShaderBackend } from "../src/native-kernels.js";
import {
  sampleRadiance,
  distantSkyVisibility,
  sampleVolume,
} from "../src/tsl-materials.js";
import { fullscreen, readPixels } from "../src/tsl-baking.js";
const output = document.querySelector("#result"),
  errors = [];
window.addEventListener("error", (e) => errors.push(e.message));
const original = console.error;
console.error = (...a) => {
  errors.push(a.map(String).join(" "));
  original(...a);
};
try {
  const forceWebGL =
    new URLSearchParams(location.search).get("backend") === "webgl2";
  const renderer = new T.WebGPURenderer({ forceWebGL });
  await renderer.init();
  setShaderBackend(!forceWebGL);
  renderer.setSize(320, 32);
  document.body.append(renderer.domElement);
  const fieldData = new Uint16Array(2 * 4 * 4),
    skyData = new Uint16Array(2 * 4 * 4);
  const field = new T.DataTexture(
      fieldData,
      2,
      4,
      T.RGBAFormat,
      T.HalfFloatType,
    ),
    directions = new T.DataTexture(
      skyData,
      2,
      4,
      T.RGBAFormat,
      T.HalfFloatType,
    );
  field.minFilter =
    field.magFilter =
    directions.minFilter =
    directions.magFilter =
      T.LinearFilter;
  const env = new T.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1);
  env.needsUpdate = true;
  const U = {
    bakedAtlas: { value: field },
    directionAtlas: { value: directions },
    rootField: { value: env },
    volumeMin: { value: new T.Vector3(0, 0, 0) },
    volumeSize: { value: new T.Vector3(256, 64, 256) },
    bakeDims: { value: new T.Vector3(2, 2, 2) },
    sunColour: { value: new T.Vector3(1, 1, 1) },
    daylight: { value: 0 },
  };
  const p = N.vec3(N.uv().x.mul(768).sub(128), 32, 128);
  const scale = N.uniform(100);
  const material = fullscreen(N.vec4(sampleRadiance(U, p).rgb.mul(scale), 1));
  const moonMaterial = fullscreen(
    N.vec4(
      N.vec3(
        sampleVolume(
          U,
          "directionAtlas",
          p,
          N.vec4(0.5, 1, 0.5, distantSkyVisibility(U, p)),
        ).a,
      ),
      1,
    ),
  );
  const scene = new T.Scene(),
    camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    mesh = new T.Mesh(new T.PlaneGeometry(2, 2), material);
  scene.add(mesh);
  const target = new T.RenderTarget(32, 1, { depthBuffer: false });
  const checks = [];
  for (const canopyByte of [0, 230])
    for (const day of [0, 0.5, 1])
      for (const origin of [0, 128]) {
        const sky = Math.exp(-(canopyByte / 255) * 1.8);
        const rgb = [0.035, 0.055, 0.085].map(
          (v, i) =>
            (v * (0.15 + sky * 0.85) +
              [0.012, 0.018, 0.008][i] * (1 - sky) * 0.8) *
            (0.04 + 0.96 * day),
        );
        for (let i = 0; i < fieldData.length; i += 4) {
          fieldData.set([...rgb, sky].map(T.DataUtils.toHalfFloat), i);
          skyData.set([0.5, 1, 0.5, sky].map(T.DataUtils.toHalfFloat), i);
        }
        field.needsUpdate = directions.needsUpdate = true;
        env.image.data[1] = canopyByte;
        env.needsUpdate = true;
        U.daylight.value = day;
        U.volumeMin.value.x = origin;
        scale.value = day === 0 ? 100 : 8;
        for (const kind of ["radiance", "moon"]) {
          mesh.material = kind === "moon" ? moonMaterial : material;
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          const bytes = new Uint8Array(128);
          await readPixels(renderer, target, 0, 0, 32, 1, bytes);
          const expected = (
            kind === "moon" ? [sky, sky, sky] : rgb.map((v) => v * scale.value)
          ).map((v) => Math.round(v * 255));
          let maximumError = 0;
          for (let i = 0; i < 32; i++)
            for (let c = 0; c < 3; c++)
              maximumError = Math.max(
                maximumError,
                Math.abs(bytes[i * 4 + c] - expected[c]),
              );
          checks.push({
            kind,
            canopyByte,
            day,
            origin,
            maximumError,
            passed: maximumError <= 2,
          });
        }
      }
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  output.textContent = JSON.stringify(
    {
      backend: forceWebGL ? "webgl2" : "webgpu",
      passed: checks.every((c) => c.passed) && errors.length === 0,
      checks,
      errors,
    },
    null,
    2,
  );
} catch (e) {
  output.textContent = JSON.stringify(
    { error: String(e), stack: e.stack, errors },
    null,
    2,
  );
}
