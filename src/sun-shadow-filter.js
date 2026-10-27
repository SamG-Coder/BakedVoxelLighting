import * as N from "three/tsl";

// Small, fixed-cost PCSS approximation for an orthographic sun shadow map.
// Grass close to the ground stays crisp; elevated crowns get a wider penumbra.
// All probes reuse the shadow texture binding, with no extra texture allocation.
const disk = [
  [-0.64, -0.37],
  [0.47, -0.61],
  [0.66, 0.41],
  [-0.38, 0.68],
];
export const sunShadowFilter = N.Fn(
  ({ depthTexture, shadowCoord, shadow }, builder) => {
    const size = N.reference("mapSize", "vec2", shadow);
    const texel = N.vec2(1).div(size);
    // Reuse the centre comparison for visibility and the blocker estimate.
    const centre = N.texture(depthTexture, shadowCoord.xy)
      .compare(shadowCoord.z)
      .toVar();
    // Comparison-only depth search works on both backends. A depth texture
    // cannot share a raw sampler and a comparison sampler in Three's GL path.
    // Five bounded probes estimate the blocker distance without readback.
    const camera = shadow.camera;
    const low = N.float(0).toVar(),
      high = N.float(64).toVar();
    for (let i = 0; i < 5; i++) {
      const middle = low.add(high).mul(0.5).toVar();
      const offset = middle.div(camera.far - camera.near);
      const probe = builder.renderer.reversedDepthBuffer
        ? shadowCoord.z.add(offset)
        : shadowCoord.z.sub(offset);
      const visible = N.texture(depthTexture, shadowCoord.xy).compare(probe);
      low.assign(N.mix(middle, low, visible));
      high.assign(N.mix(high, middle, visible));
    }
    const depthMetres = low.mul(N.float(1).sub(centre));
    // Sun angular radius ~0.27 degrees. A sub-texel minimum handles raster edges.
    const radius = N.clamp(
      depthMetres.mul(0.00465 / (camera.right - camera.left)).mul(size.x),
      0.65,
      5,
    );
    let result = centre;
    for (const [x, y] of disk) {
      result = result.add(
        N.texture(
          depthTexture,
          shadowCoord.xy.add(N.vec2(x, y).mul(texel).mul(radius)),
        ).compare(shadowCoord.z),
      );
    }
    return result.mul(0.2);
  },
);
