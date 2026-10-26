import { volumeKernel } from "./native-kernels.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";

// All bake passes use canonical bottom-up UVs; no backend-specific fragment coordinates.
export function fullscreen(fragment, uniforms = {}) {
  const m = new T.MeshBasicNodeMaterial();
  m.vertexNode = N.vec4(N.positionGeometry.xy, 0, 1);
  m.fragmentNode = fragment;
  m.depthTest = m.depthWrite = false;
  m.toneMapped = false;
  m.uniforms = uniforms;
  return m;
}
export async function readPixels(renderer, target, x, y, w, h, destination) {
  const pixels = await renderer.readRenderTargetPixelsAsync(target, x, y, w, h);
  // WebGPU rows start at top; WebGL rows start at bottom. Cached atlases use bottom-up rows.
  if (renderer.backend.isWebGPUBackend) {
    const stride = w * 4;
    // Three r186 returns the raw WebGPU buffer, including 256-byte row padding.
    const sourceStride =
      pixels.length === w * h * 4 ? stride : Math.ceil(stride / 256) * 256;
    for (let row = 0; row < h; row++)
      destination.set(
        pixels.subarray(row * sourceStride, row * sourceStride + stride),
        (h - 1 - row) * stride,
      );
  } else destination.set(pixels);
  return destination;
}
export const ref = (u, name, type = "float") =>
  N.reference("value", type, u[name]);
export function texRef(u, name) {
  const t = N.texture(u[name].value).setUpdateMatrix(false);
  // TextureNode.sample() clones the node, and setup() can disable its update
  // callback. Keep the binding live through the base node's value accessor;
  // sampled clones already delegate their value to that base in Three.js.
  Object.defineProperty(t, "value", {
    get: () => u[name].value,
    set: (value) => {
      u[name].value = value;
    },
    configurable: true,
  });
  return t;
}
export function terrainNode(field, p, grid) {
  const c = N.clamp(
    p
      .add(2000)
      .div(4000)
      .mul(grid - 1),
    0,
    grid - 1,
  );
  const base = N.floor(c),
    f = N.fract(c);
  const at = (offset) =>
    N.textureLoad(field, N.ivec2(N.min(base.add(offset), grid - 1)));
  return N.mix(
    N.mix(at(N.vec2(0)), at(N.vec2(1, 0)), f.x),
    N.mix(at(N.vec2(0, 1)), at(N.vec2(1)), f.x),
    f.y,
  );
}
const empty2D = new T.DataTexture(new Uint8Array(4), 1, 1);
const empty3D = new T.Data3DTexture(new Uint8Array(4), 1, 1, 1);
empty3D.format = T.RGBAFormat;
empty3D.minFilter = empty3D.magFilter = T.LinearFilter;
empty2D.needsUpdate = empty3D.needsUpdate = true;
export function volumePass(kind, u, grid) {
  const texture = (name, volume = false) =>
    volume
      ? N.texture3D(u[name]?.value || empty3D)
      : N.texture(u[name]?.value || empty2D);
  const field = texture("field", true);
  return fullscreen(
    volumeKernel({
      uv: N.uv(),
      dims: ref(u, "dims", "vec3"),
      origin: ref(u, "vmin", "vec3"),
      extent: ref(u, "extent", "vec3"),
      terrain: texture("terrainField"),
      trees: texture("trees"),
      details: texture("details", true),
      field,
      transportMap: texture("transportMap"),
      linearSampler: N.sampler(field),
      grid: N.float(grid),
      mode: N.int({ occupancy: 0, transport: 1, lighting: 2 }[kind] ?? 2),
      directionMode: u.directionMode ? ref(u, "directionMode") : N.float(0),
      sun: u.sun ? ref(u, "sun", "vec3") : N.vec3(0, 1, 0),
      // Linear RGB is supplied as Vector3 for the vec3 uniform layout.
      sunColour: u.sunColour ? ref(u, "sunColour", "vec3") : N.vec3(1),
      lamp: u.lampPosition ? ref(u, "lampPosition", "vec3") : N.vec3(0),
      power: u.lampPower ? ref(u, "lampPower") : N.float(0),
    }),
    u,
  );
}
