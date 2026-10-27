import { normalKernel } from "./native-kernels.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";
import { fullscreen, readPixels } from "./tsl-baking.js";
export async function makeNormal(renderer, source, strength = 3) {
  const w = source.image.width,
    h = source.image.height;
  const target = new T.RenderTarget(w, h, { depthBuffer: false });
  const map = N.texture(source);
  const uv = N.uv();
  const normal = normalKernel({
    map,
    linearSampler: N.sampler(map),
    uv,
    texel: N.vec2(1 / w, 1 / h),
    strength: N.float(strength),
  });
  // A bounded material-authoring approximation, not a measured thickness map.
  // Broad alpha occupancy distinguishes overlapping/stem regions from fine tips.
  // Store transmission in the existing normal alpha, never in cutout coverage.
  const radius = N.vec2(5 / w, 5 / h);
  const centre = map.sample(uv);
  const density = map
    .sample(uv.add(radius))
    .a.add(map.sample(uv.sub(radius)).a)
    .add(map.sample(uv.add(N.vec2(radius.x, radius.y.negate()))).a)
    .add(map.sample(uv.add(N.vec2(radius.x.negate(), radius.y))).a)
    .mul(0.25);
  const pigment = N.dot(centre.rgb, N.vec3(0.2126, 0.7152, 0.0722));
  const response = N.clamp(
    N.float(0.28).add(N.float(1).sub(density).mul(0.44)).add(pigment.mul(0.24)),
    0.2,
    0.92,
  );
  const material = fullscreen(N.vec4(normal.rgb, response));
  const scene = new T.Scene(),
    mesh = new T.Mesh(new T.PlaneGeometry(2, 2), material),
    camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(mesh);
  const old = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const data = new Uint8Array(w * h * 4);
    await readPixels(renderer, target, 0, 0, w, h, data);
    return { data, w, h };
  } finally {
    renderer.setRenderTarget(old);
    mesh.geometry.dispose();
    material.dispose();
    target.dispose();
  }
}
