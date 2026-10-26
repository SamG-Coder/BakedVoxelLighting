import * as T from "three/webgpu";
import * as N from "three/tsl";
import { fullscreen, readPixels } from "../src/tsl-baking.js";
import { renderBakeSlices } from "../src/bake-slices.js";
const out = document.querySelector("#result");
try {
  const renderer = new T.WebGPURenderer({
    forceWebGL:
      new URLSearchParams(location.search).get("backend") === "webgl2",
  });
  await renderer.init();
  const scene = new T.Scene(),
    camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    target = new T.RenderTarget(96, 4608, { depthBuffer: false });
  const quad = new T.Mesh(
    new T.PlaneGeometry(2, 2),
    fullscreen(
      N.vec4(N.uv().x, N.uv().y, N.sin(N.uv().y.mul(49)).mul(0.5).add(0.5), 1),
    ),
  );
  scene.add(quad);
  const captures = [];
  const counts = [];
  for (const sliced of [false, true]) {
    counts.push(
      await renderBakeSlices(renderer, scene, camera, target, sliced),
    );
    captures.push(
      await readPixels(
        renderer,
        target,
        0,
        0,
        96,
        4608,
        new Uint8Array(96 * 4608 * 4),
      ),
    );
  }
  let changes = 0;
  for (let i = 0; i < captures[0].length; i++)
    if (captures[0][i] !== captures[1][i]) changes++;
  if (changes) throw Error(`${changes} pixel channels changed`);
  if (
    renderer.getRenderTarget() !== null ||
    !renderer.autoClear ||
    target.scissorTest
  )
    throw Error("Renderer state not restored");
  out.textContent = JSON.stringify({
    passed: true,
    counts,
    changes,
    backend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2",
  });
} catch (error) {
  out.textContent = JSON.stringify({ passed: false, error: String(error) });
}
