import * as N from "three/tsl";

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
      const world = N.modelWorldMatrix.mul(N.vec4(p, 1)).xyz;
      const anchor = N.modelWorldMatrix.mul(instanceMatrix().element(3)).xyz;
      const scale = N.length(
        N.modelWorldMatrix.mul(N.vec4(instanceMatrix().element(1).xyz, 0)).xyz,
      );
      const c = N.clamp(
        world.xz.add(2000).mul((grid - 1) / 4000),
        0,
        grid - 1.001,
      );
      const cell = N.floor(c),
        f = N.fract(c);
      const at = (x, z) =>
        N.textureLoad(field, N.ivec2(cell.add(N.vec2(x, z)))).r;
      const a = at(0, 0).toVar(),
        b = at(1, 0).toVar();
      const d = at(0, 1).toVar(),
        e = at(1, 1).toVar();
      const ground = N.mix(N.mix(a, b, f.x), N.mix(d, e, f.x), f.y);
      // Uphill roots already enter the ground. Only bend exposed downhill roots;
      // lifting uphill wood would stretch the collar and can fold its surface.
      const drop = ground.sub(anchor.y).min(0).toVar();
      const t = N.clamp(N.positionGeometry.y.div(2), 0, 1).toVar();
      const weight = N.float(1).sub(t.mul(t).mul(N.float(3).sub(t.mul(2))));
      const offset = drop.mul(weight);
      p.addAssign(N.modelWorldMatrixInverse.mul(N.vec4(0, offset, 0, 0)).xyz);

      // Inverse-transpose of the vertical warp's Jacobian. Bark normal maps keep
      // their existing shading; the geometric normal follows the bent root.
      const slope = N.vec2(
        N.mix(b.sub(a), e.sub(d), f.y),
        N.mix(d.sub(a), e.sub(b), f.x),
      )
        .mul((grid - 1) / 4000)
        .mul(weight)
        .mul(N.float(drop.lessThan(0)));
      const dy = drop.mul(t.mul(N.float(1).sub(t)).mul(-3)).div(scale);
      const normal = N.transformNormal(
        N.normalLocal,
        N.modelWorldMatrix,
      ).toVar();
      normal.y.divAssign(N.float(1).add(dy));
      normal.xz.subAssign(slope.mul(normal.y));
      N.normalLocal.assign(
        N.normalize(N.transformNormal(normal, N.modelWorldMatrixInverse)),
      );
    });
    return p;
  })();
}
