import {
  DataTexture,
  RenderTarget,
  RGBAFormat,
  LinearFilter,
} from "three/webgpu";

// World materials (including pipelines being prepared asynchronously) retain
// bindings to these atlases. Keep their GPU identities for the renderer's life.
// Three UI resolutions bound the pool to ~4.8 MiB for both RGBA8 atlases.
const pools = new WeakMap();
export function publishedLighting(renderer, n) {
  if (![48, 64, 96].includes(n))
    throw new RangeError("Unsupported voxel resolution");
  let pool = pools.get(renderer);
  if (!pool) pools.set(renderer, (pool = new Map()));
  let pair = pool.get(n);
  if (!pair) {
    const target = new RenderTarget(n, (n * n) / 2, {
      depthBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    target.texture.name = `Published voxel radiance ${n}`;
    const directions = new DataTexture(
      new Uint8Array(n * n * n * 2),
      n,
      (n * n) / 2,
      RGBAFormat,
    );
    directions.name = `Published voxel directions ${n}`;
    directions.minFilter = directions.magFilter = LinearFilter;
    directions.needsUpdate = true;
    pair = { target, directions };
    pool.set(n, pair);
  }
  return pair;
}

// Private bake inputs are never exposed to world materials. Their preparation
// has completed before retirement; wait for already submitted GPU work too.
export function retireLightingInputs(renderer, resources) {
  const dispose = () => resources.forEach((resource) => resource?.dispose());
  const queue = renderer.backend?.device?.queue;
  if (queue) return queue.onSubmittedWorkDone().then(dispose, dispose);
  // WebGL defers deletion while submitted commands still reference resources.
  dispose();
  return Promise.resolve();
}
