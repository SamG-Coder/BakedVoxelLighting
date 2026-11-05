import * as N from "three/tsl";

// Two offset samples, continuous across every phase boundary. Unlike random UVs
// per square tile this has no grid seams. Keep derivatives from the unwrapped UV
// so minification never mistakes an offset/atlas seam for a huge footprint.
export function surfaceCoordinates(uv, world) {
  // Variant index from aperiodic gradient noise at two scales (Quilez's
  // "texture repetition" technique). The previous sum of sines was itself
  // periodic, so the same offset arrangement recurred every few tens of
  // metres and the ground visibly tiled.
  const phase = N.mx_noise_float(N.vec3(world.mul(0.052), 3.7))
    .mul(5.5)
    .add(N.mx_noise_float(N.vec3(world.mul(0.0131), 11.3)).mul(9))
    .add(32)
    .toVar();
  const index = N.floor(phase);
  const offset = (i) =>
    N.fract(N.sin(N.vec2(i.mul(127.1), i.mul(311.7))).mul(43758.5453));
  return {
    a: uv.add(offset(index).mul(7.13)),
    b: uv.add(offset(index.add(1)).mul(7.13)),
    blend: N.smoothstep(0.18, 0.82, N.fract(phase)),
    dx: N.dFdx(uv),
    dy: N.dFdy(uv),
  };
}

export function variedSurface(map, coordinates) {
  const { a, b, blend, dx, dy } = coordinates;
  return N.mix(
    map.sample(a).grad(dx, dy).setUpdateMatrix(false),
    map.sample(b).grad(dx, dy).setUpdateMatrix(false),
    blend,
  );
}

export function atlasSurfaceCoordinates(coordinates, slot, columns, size) {
  const scale = N.vec2((1 - 2 / size) / columns, 1 - 2 / size);
  const inset = N.vec2((slot + 1 / size) / columns, 1 / size);
  return {
    a: N.fract(coordinates.a).mul(scale).add(inset),
    b: N.fract(coordinates.b).mul(scale).add(inset),
    blend: coordinates.blend,
    dx: coordinates.dx.mul(scale),
    dy: coordinates.dy.mul(scale),
  };
}
