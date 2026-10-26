import { landscape } from "./terrain-math.js";

export function copyTerrainRegion(
  pixels,
  roots,
  grid,
  extent,
  x0,
  z0,
  x1,
  z1,
  canopy = null,
) {
  const step = extent / (grid - 1);
  const start = (v) =>
    Math.max(0, Math.min(grid - 2, Math.floor((v + extent / 2) / step)));
  const end = (v) =>
    Math.max(1, Math.min(grid - 1, Math.floor((v + extent / 2) / step) + 1));
  const gx = start(x0),
    gz = start(z0),
    width = end(x1) - gx + 1,
    height = end(z1) - gz + 1;
  const result = {
    gx,
    gz,
    grid,
    extent,
    step,
    width,
    height,
    pixels: new Float32Array(width * height * 4),
    roots: new Float32Array(width * height),
    canopy: new Float32Array(width * height),
  };
  for (let row = 0; row < height; row++) {
    const offset = (gz + row) * grid + gx;
    result.pixels.set(
      pixels.subarray(offset * 4, (offset + width) * 4),
      row * width * 4,
    );
    result.roots.set(roots.subarray(offset, offset + width), row * width);
    if (canopy)
      result.canopy.set(canopy.subarray(offset, offset + width), row * width);
  }
  return result;
}

export function sampleTerrainRegion(s, x, z) {
  // Use world grid coordinates so worker interpolation is bit-identical.
  const gx = Math.max(0, Math.min(s.grid - 1.001, (x + s.extent / 2) / s.step));
  const gz = Math.max(0, Math.min(s.grid - 1.001, (z + s.extent / 2) / s.step));
  const ix = Math.floor(gx),
    iz = Math.floor(gz),
    u = gx - ix,
    v = gz - iz;
  const localX = ix - s.gx,
    localZ = iz - s.gz;
  if (
    localX < 0 ||
    localZ < 0 ||
    localX + 1 >= s.width ||
    localZ + 1 >= s.height
  )
    throw new RangeError("Worker terrain request is outside its snapshot");
  const i = localZ * s.width + localX;
  const channel = (data, stride, c) =>
    (data[i * stride + c] * (1 - u) + data[(i + 1) * stride + c] * u) *
      (1 - v) +
    (data[(i + s.width) * stride + c] * (1 - u) +
      data[(i + s.width + 1) * stride + c] * u) *
      v;
  return {
    height: channel(s.pixels, 4, 0),
    traffic: channel(s.pixels, 4, 1),
    moisture: channel(s.pixels, 4, 2),
    slope: channel(s.pixels, 4, 3),
    root: channel(s.roots, 1, 0),
    canopy: s.canopy ? channel(s.canopy, 1, 0) : undefined,
    ...landscape(x, z),
  };
}
