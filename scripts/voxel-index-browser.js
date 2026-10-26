import * as T from "three/webgpu";
import * as N from "three/tsl";
import { nativeFunction, setShaderBackend } from "../src/native-kernels.js";
import glsl from "../src/shaders/volume.glsl?raw";
import wgsl from "../src/shaders/volume.wgsl?raw";
import { fullscreen, readPixels } from "../src/tsl-baking.js";
import { buildVoxelTreeGrid } from "../src/voxel-tree-grid.js";
const report = document.getElementById("report");
const errors = [];
const logError = console.error;
console.error = (...args) => {
  errors.push(args.map(String).join(" "));
  logError(...args);
};
try {
  const gpu = new URLSearchParams(location.search).get("backend") !== "webgl2";
  setShaderBackend(gpu);
  const renderer = new T.WebGPURenderer({ forceWebGL: !gpu });
  await renderer.init();
  const n = 64,
    min = { x: -64, y: -8, z: -64 },
    size = { x: 128, y: 64, z: 128 };
  let seed = 451;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const trees = Array.from({ length: 1000 }, () => ({
    x: -68 + random() * 136,
    y: -10 + random() * 20,
    z: -68 + random() * 136,
    scale: 0.3 + random() * 8,
  }));
  const grid = buildVoxelTreeGrid(trees, n, min, size);
  const oldData = new Float32Array(
    trees.flatMap((t) => [t.x, t.y, t.z, t.scale]),
  );
  const oldTex = new T.DataTexture(
    oldData,
    trees.length,
    1,
    T.RGBAFormat,
    T.FloatType,
  );
  const newTex = new T.DataTexture(
    grid.data,
    grid.width,
    grid.height,
    T.RGBAFormat,
    T.FloatType,
  );
  const terrain = new T.DataTexture(
    new Float32Array(16),
    2,
    2,
    T.RGBAFormat,
    T.FloatType,
  );
  const empty3D = new T.Data3DTexture(new Uint8Array(4), 1, 1, 1);
  empty3D.format = T.RGBAFormat;
  empty3D.minFilter = empty3D.magFilter = T.LinearFilter;
  const detailTex = new T.Data3DTexture(new Uint8Array(4), 1, 1, 1);
  detailTex.format = T.RGBAFormat;
  detailTex.minFilter = detailTex.magFilter = T.LinearFilter;
  const empty2D = new T.DataTexture(new Uint8Array(4), 1, 1);
  for (const tex of [oldTex, newTex, terrain, empty3D, detailTex, empty2D])
    tex.needsUpdate = true;
  const oldGL = glsl.replace(
    /        vec4 header=.*?vec3 q=p-tree.xyz;/s,
    `        for(int i=0;i<${trees.length};i++) {vec4 tree=texelFetch(trees,ivec2(i,0),0);vec3 q=p-tree.xyz;`,
  );
  const oldWG = wgsl.replace(
    /        let header=.*?let q=p-tree.xyz;/s,
    `        for(var i=0;i<${trees.length};i++) {let tree=textureLoad(trees,vec2i(i,0),0);let q=p-tree.xyz;`,
  );
  const target = new T.RenderTarget(n, (n * n) / 2, { depthBuffer: false });
  const scene = new T.Scene(),
    camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    mesh = new T.Mesh(new T.PlaneGeometry(2, 2));
  scene.add(mesh);
  const outputs = [],
    timings = [];
  for (const [label, gs, ws, tex] of [
    ["exhaustive", oldGL, oldWG, oldTex],
    ["indexed", glsl, wgsl, newTex],
  ]) {
    const field = N.texture3D(empty3D);
    mesh.material = fullscreen(
      nativeFunction(
        gs,
        ws,
      )({
        uv: N.uv(),
        dims: N.vec3(n, n / 2, n),
        origin: N.vec3(min.x, min.y, min.z),
        extent: N.vec3(size.x, size.y, size.z),
        terrain: N.texture(terrain),
        trees: N.texture(tex),
        details: N.texture3D(detailTex),
        field,
        transportMap: N.texture(empty2D),
        linearSampler: N.sampler(field),
        grid: N.float(2),
        mode: N.int(0),
        directionMode: N.float(0),
        sun: N.vec3(0, 1, 0),
        lamp: N.vec3(0),
        power: N.float(0),
      }),
    );
    renderer.setRenderTarget(target);
    await renderer.compileAsync(scene, camera);
    const times = [];
    let pixels;
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      renderer.render(scene, camera);
      pixels = new Uint8Array(((n * n * n) / 2) * 4);
      await readPixels(renderer, target, 0, 0, n, (n * n) / 2, pixels);
      if (i >= 2) times.push(performance.now() - start);
    }
    outputs.push(pixels);
    timings.push({ label, renderAndReadbackMs: times });
    mesh.material.dispose();
  }
  let differences = 0;
  for (let i = 0; i < outputs[0].length; i++)
    if (outputs[0][i] !== outputs[1][i]) differences++;
  report.textContent = JSON.stringify(
    {
      backend: gpu ? "webgpu" : "webgl2",
      errors,
      nonzeroBytes: outputs[1].filter((v) => v > 0).length,
      differences,
      voxelCount: (n * n * n) / 2,
      treeCount: trees.length,
      meanCandidates: grid.meanCandidates,
      timings,
    },
    null,
    2,
  );
  renderer.dispose();
} catch (error) {
  report.textContent = error.stack;
}
