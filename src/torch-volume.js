import * as T from "three/webgpu";
import * as N from "three/tsl";

export function createTorchVolumeMaterial(fire, enabled) {
  const flameMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: T.DoubleSide,
    blending: T.AdditiveBlending,
  });
  // Ray march a real 3D field inside the torch's volume. No flame cards.
  const volume = N.Fn(() => {
    N.If(enabled.lessThan(0.001), () => N.Discard());
    const eye = N.modelWorldMatrixInverse.mul(N.vec4(N.cameraPosition, 1)).xyz;
    const entry = N.positionGeometry;
    const ray = entry.sub(eye).normalize();
    const colour = N.vec3(0).toVar(),
      opacity = N.float(0).toVar();
    N.Loop(48, ({ i }) => {
      const p = entry.add(ray.mul(N.float(i).add(0.5).mul(0.037))).add(0.5);
      N.If(
        p
          .lessThan(N.vec3(0))
          .any()
          .or(p.greaterThan(N.vec3(1)).any()),
        () => N.Break(),
      );
      const cloth = p
        .sub(0.5)
        .mul(N.vec3(0.36, 0.7, 0.36))
        .add(N.vec3(0, 0.22, 0));
      N.If(
        cloth.y
          .greaterThan(-0.115)
          .and(cloth.y.lessThan(0.115))
          .and(cloth.xz.length().lessThan(0.064)),
        () => N.Break(),
      );
      const cell = fire.sample(p),
        heat = cell.r;
      const density = cell.b;
      const a = N.float(1).sub(N.exp(density.mul(-0.045)));
      const hot = N.smoothstep(0.25, 0.95, heat);
      const emission = N.mix(
        N.vec3(1.8, 0.16, 0.004),
        N.vec3(3.4, 1.4, 0.12),
        hot,
      );
      colour.addAssign(emission.mul(a).mul(N.float(1).sub(opacity)));
      opacity.addAssign(a.mul(N.float(1).sub(opacity)));
    });
    return N.vec4(colour.div(N.max(opacity, 0.0001)), opacity.mul(enabled));
  })();
  flameMaterial.side = T.FrontSide;
  flameMaterial.blending = T.NormalBlending;
  flameMaterial.colorNode = volume.rgb;
  flameMaterial.opacityNode = volume.a;
  return flameMaterial;
}
