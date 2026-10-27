import * as N from "three/tsl";

// Height and its exact bilinear gradient, shared by the bend and its normal.
function groundSample(field, grid, xz) {
  const c = N.clamp(xz.add(2000).mul((grid - 1) / 4000), 0, grid - 1.001);
  const cell = N.floor(c),
    f = N.fract(c);
  const at = (x, z) => N.textureLoad(field, N.ivec2(cell.add(N.vec2(x, z)))).r;
  const a = at(0, 0).toVar(),
    b = at(1, 0).toVar();
  const d = at(0, 1).toVar(),
    e = at(1, 1).toVar();
  return {
    height: N.mix(N.mix(a, b, f.x), N.mix(d, e, f.x), f.y),
    slope: N.vec2(
      N.mix(b.sub(a), e.sub(d), f.y),
      N.mix(d.sub(a), e.sub(b), f.x),
    ).mul((grid - 1) / 4000),
  };
}

// Instancing runs before positionNode. positionLocal/normalLocal are already
// instance-transformed, while positionGeometry still identifies the root collar.
export function rootConformPosition(field, grid, instanceMatrix) {
  return N.Fn((builder) => {
    // Prototype captures must stay in prototype space. Terrain fitting belongs
    // to placed plants, including the real wood retained at HLOD level 2.
    if (!builder.object.isInstancedMesh && !builder.object.isAttributeInstances)
      return N.positionLocal;
    const p = N.positionLocal.toVar();
    N.If(N.positionGeometry.y.lessThan(2), () => {
      const world = N.modelWorldMatrix.mul(N.vec4(p, 1)).xyz.toVar();
      const anchor = N.modelWorldMatrix.mul(instanceMatrix().element(3)).xyz;
      const scale = N.length(
        N.modelWorldMatrix.mul(N.vec4(instanceMatrix().element(1).xyz, 0)).xyz,
      );
      const ground = groundSample(field, grid, world.xz);
      const drop = ground.height.sub(anchor.y).min(0).toVar();
      const t = N.clamp(N.positionGeometry.y.div(2), 0, 1).toVar();
      const weight = N.float(1)
        .sub(t.mul(t).mul(N.float(3).sub(t.mul(2))))
        .toVar();
      const dw = t.mul(N.float(1).sub(t)).mul(-3).div(scale);

      // Bend the root's existing reach onto the slope instead of extending it
      // vertically. On a planar slope, the tip keeps its original radial length.
      // Uphill roots stay embedded and the upper trunk remains unchanged.
      const radial = world.xz.sub(anchor.xz).toVar();
      const radius = N.length(radial).max(0.001).toVar();
      const grade = drop.div(radius).toVar();
      const compression = N.inversesqrt(
        N.float(1).add(grade.mul(grade)),
      ).toVar();
      const reach = N.float(1).add(compression.sub(1).mul(weight)).toVar();
      const bentXZ = anchor.xz.add(radial.mul(reach));
      const fitted = groundSample(field, grid, bentXZ);
      const fittedDrop = fitted.height.sub(anchor.y).min(0).toVar();
      const offset = N.vec3(
        radial.x.mul(reach.sub(1)),
        fittedDrop.mul(weight),
        radial.y.mul(reach.sub(1)),
      );
      p.addAssign(N.modelWorldMatrixInverse.mul(N.vec4(offset, 0)).xyz);

      // Full bend Jacobian, including horizontal contraction. Transforming only
      // the vertical slope would leave bark lighting stretched across the bend.
      const dg = ground.slope
        .mul(N.float(drop.lessThan(0)))
        .sub(radial.div(radius).mul(grade))
        .div(radius);
      const dk = dg.mul(grade.negate().mul(compression.pow(3)));
      const ax = N.vec2(reach, 0).add(radial.mul(dk.x).mul(weight));
      const az = N.vec2(0, reach).add(radial.mul(dk.y).mul(weight));
      const ay = radial.mul(compression.sub(1)).mul(dw);
      const slope = fitted.slope.mul(N.float(fittedDrop.lessThan(0)));
      const jx = N.vec3(ax.x, N.dot(slope, ax).mul(weight), ax.y);
      const jz = N.vec3(az.x, N.dot(slope, az).mul(weight), az.y);
      const jy = N.vec3(
        ay.x,
        N.float(1).add(fittedDrop.mul(dw)).add(N.dot(slope, ay).mul(weight)),
        ay.y,
      );
      const normal = N.transformNormal(
        N.normalLocal,
        N.modelWorldMatrix,
      ).toVar();
      const bentNormal = N.cross(jy, jz)
        .mul(normal.x)
        .add(N.cross(jz, jx).mul(normal.y))
        .add(N.cross(jx, jy).mul(normal.z));
      N.normalLocal.assign(
        N.normalize(N.transformNormal(bentNormal, N.modelWorldMatrixInverse)),
      );
    });
    return p;
  })();
}
