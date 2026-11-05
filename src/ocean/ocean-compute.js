import * as T from "three/webgpu";
import { buildOceanSpectrum, OCEAN_N } from "./ocean-spectrum.js";

// Direct WebGPU ocean simulation. The renderer's GPUDevice runs handwritten
// WGSL compute; Three.js only owns the sampled storage textures.
//
// Per frame, in one compute pass:
//   rows     : spectrum evaluation fused with a 128-point row IFFT in shared memory
//   columns  : 128-point column IFFT in shared memory, in place
//   resolve  : displacement + slopes/Jacobian terms, one dispatch per cascade
//   mips     : 2x2 reductions of every texture (no CPU, no render passes)
//   caustics : photon splat through the short cascade, tent filter, mips
// ClearWater 6.1 used a CUDA-to-WGSL compiler with separate spectrum, stage,
// resolve and coefficient kernels; this path fuses those and removes the
// global-memory round trips between FFT stages.

const N = OCEAN_N;
const CAUSTIC_N = 256;
const WORKGROUP_FFT = 64;

const PRELUDE = /* wgsl */ `
const N: u32 = ${N}u;
const TAU: f32 = 6.283185307179586;
struct Params {
  time: f32,
  choppy: f32,
  causticDepth: f32,
  pad0: f32,
  sun: vec4f,
  sizes: vec4f,
};
fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
`;

const FFT = /* wgsl */ `
var<workgroup> values: array<vec2f, ${N}>;
var<workgroup> twiddle: array<vec2f, ${N / 2}>;
fn bitrev(v: u32) -> u32 { return reverseBits(v) >> ${32 - Math.log2(N)}u; }
// Inverse (positive exponent), unnormalised. Input must be bit-reversed.
// Each of the 64 lanes owns one disjoint butterfly per stage.
fn transform(lane: u32) {
  var span = 2u;
  loop {
    if (span > N) { break; }
    let half = span / 2u;
    let j = lane & (half - 1u);
    let a = (lane / half) * span + j;
    let b = a + half;
    let left = values[a];
    let right = cmul(values[b], twiddle[j * (N / span)]);
    values[a] = left + right;
    values[b] = left - right;
    workgroupBarrier();
    span = span * 2u;
  }
}
fn loadTwiddle(lane: u32) {
  let angle = TAU * f32(lane) / f32(N);
  twiddle[lane] = vec2f(cos(angle), sin(angle));
}
`;

const ROWS = /* wgsl */ `${PRELUDE}${FFT}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> seeds: array<vec4f>;
@group(0) @binding(2) var<storage, read> omega: array<f32>;
@group(0) @binding(3) var<storage, read_write> work: array<vec2f>;

fn frequency(i: u32) -> f32 { return f32(select(i32(i), i32(i) - i32(N), i >= N / 2u)); }

// Field 0 packs h + i Dx; field 1 packs Dz. Both inverse transforms are real.
fn spectrum(c: u32, f: u32, x: u32, z: u32) -> vec2f {
  let i = c * N * N + z * N + x;
  let s = seeds[i];
  let phase = omega[i] * params.time;
  let e = vec2f(cos(phase), -sin(phase));
  // h0(k) e^{-iwt} + conj(h0(-k)) e^{+iwt}: crests travel along +k.
  let h = cmul(s.xy, e) + cmul(s.zw, vec2f(e.x, -e.y));
  let dk = TAU / params.sizes[c];
  let k = vec2f(frequency(x), frequency(z)) * dk;
  let len = length(k);
  let unit = select(vec2f(0.0), k / len, len > 1e-6) * params.choppy;
  // D = -i khat h, so -i (a + ib) = (b, -a).
  let minusIH = vec2f(h.y, -h.x);
  if (f == 0u) {
    let dx = minusIH * unit.x;
    return h + vec2f(-dx.y, dx.x);
  }
  return minusIH * unit.y;
}

@compute @workgroup_size(${WORKGROUP_FFT})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lane: u32) {
  let z = wg.x;
  let f = wg.y;
  let c = wg.z;
  loadTwiddle(lane);
  for (var k = 0u; k < 2u; k++) {
    let x = lane + k * ${WORKGROUP_FFT}u;
    values[bitrev(x)] = spectrum(c, f, x, z);
  }
  workgroupBarrier();
  transform(lane);
  let base = ((c * 2u + f) * N + z) * N;
  for (var k = 0u; k < 2u; k++) {
    let x = lane + k * ${WORKGROUP_FFT}u;
    work[base + x] = values[x];
  }
}
`;

const COLUMNS = /* wgsl */ `${PRELUDE}${FFT}
@group(0) @binding(0) var<storage, read_write> work: array<vec2f>;
@compute @workgroup_size(${WORKGROUP_FFT})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lane: u32) {
  let x = wg.x;
  let base = (wg.z * 2u + wg.y) * N * N + x;
  loadTwiddle(lane);
  for (var k = 0u; k < 2u; k++) {
    let z = lane + k * ${WORKGROUP_FFT}u;
    values[bitrev(z)] = work[base + z * N];
  }
  workgroupBarrier();
  transform(lane);
  for (var k = 0u; k < 2u; k++) {
    let z = lane + k * ${WORKGROUP_FFT}u;
    work[base + z * N] = values[z];
  }
}
`;

const RESOLVE = /* wgsl */ `${PRELUDE}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> work: array<vec2f>;
@group(0) @binding(2) var<uniform> cascade: vec4u;
@group(0) @binding(3) var displacement: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var derivatives: texture_storage_2d<rgba16float, write>;
fn at(f: u32, x: u32, z: u32) -> vec2f {
  return work[((cascade.x * 2u + f) * N + (z & (N - 1u))) * N + (x & (N - 1u))];
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x;
  let z = id.y;
  let a = at(0u, x, z);
  let scale = f32(N) / (2.0 * params.sizes[cascade.x]);
  let hx = (at(0u, x + 1u, z).x - at(0u, x - 1u, z).x) * scale;
  let hz = (at(0u, x, z + 1u).x - at(0u, x, z - 1u).x) * scale;
  let dxx = (at(0u, x + 1u, z).y - at(0u, x - 1u, z).y) * scale;
  let dzz = (at(1u, x, z + 1u).x - at(1u, x, z - 1u).x) * scale;
  textureStore(displacement, vec2i(id.xy), vec4f(a.y, a.x, at(1u, x, z).x, 0.0));
  textureStore(derivatives, vec2i(id.xy), vec4f(hx, hz, dxx, dzz));
}
`;

const DOWNSAMPLE = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dstTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let sum = textureLoad(srcTex, p, 0) + textureLoad(srcTex, p + vec2i(1, 0), 0)
    + textureLoad(srcTex, p + vec2i(0, 1), 0) + textureLoad(srcTex, p + vec2i(1, 1), 0);
  textureStore(dstTex, vec2i(id.xy), sum * 0.25);
}
`;

// Sunlight photons refracted through the short-wave cascade onto a plane at a
// fixed reference depth, as in ClearWater's caustic map, with RGB dispersion.
const CAUSTIC_SPLAT = /* wgsl */ `${PRELUDE}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var derivatives: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<storage, read_write> photons: array<atomic<u32>>;
const M: u32 = ${CAUSTIC_N}u;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + 0.5) / f32(M);
  let d = textureSampleLevel(derivatives, linearSampler, uv, 0.0);
  let n = normalize(vec3f(-d.x, 1.0, -d.y));
  let sun = normalize(vec3f(params.sun.x, max(params.sun.y, 0.08), params.sun.z));
  let size = params.sizes.z;
  for (var c = 0u; c < 3u; c++) {
    let eta = 1.0 / (1.331 + f32(c) * 0.004);
    let r = refract(-sun, n, eta);
    let travel = params.causticDepth / max(-r.y, 0.05);
    let hit = (uv * size + r.xz * travel) / size * f32(M) - 0.5;
    let cell = vec2i(floor(hit));
    let w = fract(hit);
    for (var j = 0; j < 2; j++) {
      for (var i = 0; i < 2; i++) {
        let p = vec2u((cell + vec2i(i, j)) & vec2i(i32(M) - 1));
        let weight = select(1.0 - w.x, w.x, i == 1) * select(1.0 - w.y, w.y, j == 1);
        atomicAdd(&photons[c * M * M + p.y * M + p.x], u32(weight * 4096.0 + 0.5));
      }
    }
  }
}
`;

const CAUSTIC_RESOLVE = /* wgsl */ `
const M: u32 = ${CAUSTIC_N}u;
@group(0) @binding(0) var<storage, read> photons: array<u32>;
@group(0) @binding(1) var light: texture_storage_2d<rgba16float, write>;
fn at(c: u32, x: i32, y: i32) -> f32 {
  let p = vec2u(vec2i(x, y) & vec2i(i32(M) - 1));
  return f32(photons[c * M * M + p.y * M + p.x]);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x);
  let y = i32(id.y);
  var result = vec3f(0.0);
  for (var c = 0u; c < 3u; c++) {
    var sum = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let weight = select(1.0, 2.0, i == 0) * select(1.0, 2.0, j == 0);
        sum += at(c, x + i, y + j) * weight;
      }
    }
    result[c] = sum / (16.0 * 4096.0);
  }
  textureStore(light, vec2i(id.xy), vec4f(result, 1.0));
}
`;

function storageTexture(renderer, size, name) {
  const texture = new T.StorageTexture(size, size);
  texture.name = name;
  texture.type = T.HalfFloatType;
  texture.format = T.RGBAFormat;
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.magFilter = T.LinearFilter;
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // Mip levels are written by the compute pass below, never by Three.js.
  texture.mipmapsAutoUpdate = false;
  texture.anisotropy = 8;
  renderer.initTexture(texture);
  const gpu = renderer.backend.get(texture).texture;
  if (!gpu) throw new Error(`WebGPU did not allocate ${name}.`);
  return { texture, gpu, levels: gpu.mipLevelCount, size };
}

export function createOceanSimulation(renderer, options = {}) {
  const backend = renderer.backend;
  if (!backend?.isWebGPUBackend || !backend.device)
    throw new Error("The ocean requires the WebGPU backend.");
  const device = backend.device;
  const spectrum = buildOceanSpectrum(options);
  const cascades = spectrum.sizes.length;

  const buffer = (data, usage, label) => {
    const b = device.createBuffer({
      label,
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const params = new Float32Array(12);
  const paramBuffer = buffer(params, GPUBufferUsage.UNIFORM, "ocean params");
  const seedBuffer = buffer(
    spectrum.seeds,
    GPUBufferUsage.STORAGE,
    "ocean spectrum seeds",
  );
  const omegaBuffer = buffer(
    spectrum.omega,
    GPUBufferUsage.STORAGE,
    "ocean dispersion",
  );
  const workBuffer = device.createBuffer({
    label: "ocean FFT work",
    size: cascades * 2 * N * N * 8,
    usage: GPUBufferUsage.STORAGE,
  });
  const photonBuffer = device.createBuffer({
    label: "ocean caustic photons",
    size: 3 * CAUSTIC_N * CAUSTIC_N * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const cascadeBuffers = spectrum.sizes.map((_, c) =>
    buffer(
      new Uint32Array([c, 0, 0, 0]),
      GPUBufferUsage.UNIFORM,
      `cascade ${c}`,
    ),
  );

  const displacement = [],
    derivatives = [];
  for (let c = 0; c < cascades; c++) {
    displacement.push(storageTexture(renderer, N, `Ocean displacement ${c}`));
    derivatives.push(storageTexture(renderer, N, `Ocean slopes ${c}`));
  }
  const caustics = storageTexture(renderer, CAUSTIC_N, "Ocean caustics");

  const pipeline = (code, label) =>
    device.createComputePipeline({
      label,
      layout: "auto",
      compute: {
        module: device.createShaderModule({ label, code }),
        entryPoint: "main",
      },
    });
  const rows = pipeline(ROWS, "ocean spectrum + row FFT");
  const columns = pipeline(COLUMNS, "ocean column FFT");
  const resolve = pipeline(RESOLVE, "ocean resolve");
  const downsample = pipeline(DOWNSAMPLE, "ocean mip reduction");
  const splat = pipeline(CAUSTIC_SPLAT, "ocean caustic photons");
  const gather = pipeline(CAUSTIC_RESOLVE, "ocean caustic resolve");

  const group = (p, entries) =>
    device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({
        binding,
        resource: resource.size !== undefined ? { buffer: resource } : resource,
      })),
    });
  const level = (t, mip) =>
    t.gpu.createView({ baseMipLevel: mip, mipLevelCount: 1 });

  const rowsGroup = group(rows, [
    paramBuffer,
    seedBuffer,
    omegaBuffer,
    workBuffer,
  ]);
  const columnsGroup = group(columns, [workBuffer]);
  const resolveGroups = spectrum.sizes.map((_, c) =>
    group(resolve, [
      paramBuffer,
      workBuffer,
      cascadeBuffers[c],
      level(displacement[c], 0),
      level(derivatives[c], 0),
    ]),
  );
  const mipChain = (t) => {
    const steps = [];
    for (let mip = 1; mip < t.levels; mip++)
      steps.push({
        size: Math.max(1, t.size >> mip),
        group: group(downsample, [level(t, mip - 1), level(t, mip)]),
      });
    return steps;
  };
  const surfaceMips = [...displacement, ...derivatives].flatMap(mipChain);
  const causticMips = mipChain(caustics);
  const linearSampler = device.createSampler({
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
  });
  const splatGroup = group(splat, [
    paramBuffer,
    level(derivatives[cascades - 1], 0),
    linearSampler,
    photonBuffer,
  ]);
  const gatherGroup = group(gather, [photonBuffer, level(caustics, 0)]);

  const stats = {
    cascades: spectrum.sizes,
    resolution: N,
    causticResolution: CAUSTIC_N,
    significantHeight: spectrum.significantHeight,
    windSpeed: spectrum.windSpeed,
    dispatches: 0,
    frames: 0,
  };
  const settings = {
    choppy: options.choppy ?? 0.9,
    causticDepth: options.causticDepth ?? 2.4,
  };

  function update(time, sunDirection) {
    params[0] = time;
    params[1] = settings.choppy;
    params[2] = settings.causticDepth;
    params[4] = sunDirection.x;
    params[5] = sunDirection.y;
    params[6] = sunDirection.z;
    params[8] = spectrum.sizes[0];
    params[9] = spectrum.sizes[1];
    params[10] = spectrum.sizes[2];
    device.queue.writeBuffer(paramBuffer, 0, params);
    const encoder = device.createCommandEncoder({ label: "ocean simulation" });
    encoder.clearBuffer(photonBuffer);
    const pass = encoder.beginComputePass({ label: "ocean FFT" });
    let dispatches = 0;
    pass.setPipeline(rows);
    pass.setBindGroup(0, rowsGroup);
    pass.dispatchWorkgroups(N, 2, cascades);
    pass.setPipeline(columns);
    pass.setBindGroup(0, columnsGroup);
    pass.dispatchWorkgroups(N, 2, cascades);
    pass.setPipeline(resolve);
    for (const g of resolveGroups) {
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(N / 8, N / 8);
    }
    dispatches += 2 + resolveGroups.length;
    pass.setPipeline(downsample);
    for (const step of surfaceMips) {
      pass.setBindGroup(0, step.group);
      const groups = Math.ceil(step.size / 8);
      pass.dispatchWorkgroups(groups, groups);
    }
    dispatches += surfaceMips.length;
    pass.setPipeline(splat);
    pass.setBindGroup(0, splatGroup);
    pass.dispatchWorkgroups(CAUSTIC_N / 8, CAUSTIC_N / 8);
    pass.setPipeline(gather);
    pass.setBindGroup(0, gatherGroup);
    pass.dispatchWorkgroups(CAUSTIC_N / 8, CAUSTIC_N / 8);
    pass.setPipeline(downsample);
    for (const step of causticMips) {
      pass.setBindGroup(0, step.group);
      const groups = Math.ceil(step.size / 8);
      pass.dispatchWorkgroups(groups, groups);
    }
    dispatches += 2 + causticMips.length;
    pass.end();
    device.queue.submit([encoder.finish()]);
    stats.dispatches = dispatches;
    stats.frames++;
  }

  return {
    update,
    settings,
    stats,
    sizes: spectrum.sizes,
    displacement: displacement.map((t) => t.texture),
    derivatives: derivatives.map((t) => t.texture),
    caustics: caustics.texture,
    causticSize: spectrum.sizes[cascades - 1],
    dispose() {
      for (const b of [
        paramBuffer,
        seedBuffer,
        omegaBuffer,
        workBuffer,
        photonBuffer,
        ...cascadeBuffers,
      ])
        b.destroy();
      for (const t of [...displacement, ...derivatives, caustics])
        t.texture.dispose();
    },
  };
}
