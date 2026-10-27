import * as T from "three/webgpu";
import * as N from "three/tsl";
import { ref, fullscreen, readPixels } from "../src/tsl-baking.js";

const report = document.querySelector("#report");
const backend = new URLSearchParams(location.search).get("backend") || "webgpu";
const renderer = new T.WebGPURenderer({ forceWebGL: backend === "webgl2" });
const errors = [];
const oldError = console.error;
console.error = (...args) => {
  errors.push(args.join(" "));
  oldError(...args);
};
try {
  await renderer.init();
  const state = {
    power: { value: 0.5 },
    colour: { value: new T.Vector3(0.2, 0.4, 0.8) },
  };
  const other = {
    power: { value: 0.7 },
    colour: { value: new T.Vector3(0.8, 0.1, 0.3) },
  };
  const fragment = (s, get) =>
    N.vec4(get(s, "colour", "vec3").mul(get(s, "power")), 1);
  const oldRef = (s, name, type = "float") =>
    N.reference("value", type, s[name]);
  const quad = new T.QuadMesh(fullscreen(fragment(state, ref)));
  const reference = new T.QuadMesh(fullscreen(fragment(state, oldRef)));
  const independent = new T.QuadMesh(fullscreen(fragment(other, ref)));
  const target = new T.RenderTarget(8, 8, { depthBuffer: false });
  const output = new Uint8Array(8 * 8 * 4);
  async function pixel(mesh) {
    renderer.setRenderTarget(target);
    mesh.render(renderer);
    await readPixels(renderer, target, 0, 0, 8, 8, output);
    return Array.from(output.subarray(0, 4));
  }
  const cases = [];
  // All renders occur without requesting a new animation frame. Baking changes
  // directionMode between render calls and must not inherit the previous pass.
  for (const [name, change] of [
    ["initial", () => {}],
    [
      "scalar change",
      () => {
        state.power.value = 0.9;
      },
    ],
    [
      "vector mutation",
      () => {
        state.colour.value.set(0.9, 0.2, 0.1);
      },
    ],
    [
      "vector replacement",
      () => {
        state.colour.value = new T.Vector3(0.1, 0.7, 0.2);
      },
    ],
    [
      "zero power",
      () => {
        state.power.value = 0;
      },
    ],
    [
      "restore",
      () => {
        state.power.value = 1;
      },
    ],
  ]) {
    change();
    const actual = await pixel(quad),
      expected = await pixel(reference);
    const isolated = await pixel(independent);
    const analytic = state.colour.value
      .toArray()
      .map((c) => Math.round(c * state.power.value * 255))
      .concat(255);
    const otherExpected = [143, 18, 54, 255];
    const pass =
      actual.every(
        (v, i) =>
          Math.abs(v - expected[i]) <= 1 && Math.abs(v - analytic[i]) <= 1,
      ) && isolated.every((v, i) => Math.abs(v - otherExpected[i]) <= 1);
    cases.push({ name, pass, actual, expected, isolated });
    if (!pass) throw new Error(JSON.stringify(cases));
  }
  report.textContent = JSON.stringify(
    { backend, passed: true, cases, errors },
    null,
    2,
  );
  for (const mesh of [quad, reference, independent]) mesh.material.dispose();
  target.dispose();
  renderer.dispose();
} catch (error) {
  report.textContent = JSON.stringify(
    { backend, passed: false, message: error.message, errors },
    null,
    2,
  );
  throw error;
}
