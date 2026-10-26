import { cloudAt, CLOUD_SHADOW_STRENGTH } from "./clouds.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";
import { sampleVolume } from "./tsl-materials.js";
import { ref } from "./tsl-baking.js";

// Half-resolution, depth-limited single scattering. Surface occlusion comes
// from the same streamed radiance atlas used by the vegetation materials.
export function createAtmosphere(renderer, scene, camera, U) {
  const scenePass = N.pass(scene, camera);
  scenePass.renderTarget.samples = renderer.samples;
  scenePass.renderTarget.texture.type = renderer.getOutputBufferType();
  const colour = scenePass.getTextureNode();
  const depth = scenePass.getTextureNode("depth");
  const inverseProjection = N.uniform(camera.projectionMatrixInverse);
  const worldMatrix = N.uniform(camera.matrixWorld);
  const eye = N.uniform(camera.position);
  const scatter = N.Fn(() => {
    const view = N.getViewPosition(N.screenUV, depth, inverseProjection);
    const end = worldMatrix.mul(N.vec4(view, 1)).xyz;
    const delta = end.sub(eye);
    const length = N.min(delta.length(), 160);
    const ray = delta.normalize();
    const sun = ref(U, "liveSunDirection", "vec3");
    const phase = N.pow(N.max(ray.dot(sun), 0), 24)
      .mul(1.2)
      .add(0.015);
    const sum = N.vec3(0).toVar();
    const opticalDepth = N.float(0).toVar();
    const cloud = N.float(1).sub(
      cloudAt(U, eye, sun).mul(CLOUD_SHADOW_STRENGTH),
    );
    N.Loop(8, ({ i }) => {
      const p = eye.add(ray.mul(length.mul(N.float(i).add(0.5).div(8))));
      const local = p
        .sub(ref(U, "volumeMin", "vec3"))
        .div(ref(U, "volumeSize", "vec3"));
      const edge = N.min(local, N.vec3(1).sub(local));
      const inside = N.smoothstep(0, 0.12, N.min(edge.x, edge.z)).mul(
        N.smoothstep(0, 0.1, edge.y),
      );
      const visibility = sampleVolume(U, "bakedAtlas", p, [0, 0, 0, 0]).a;
      const skyAccess = sampleVolume(
        U,
        "directionAtlas",
        p,
        [0.5, 1, 0.5, 1],
      ).a;
      const density = N.smoothstep(0.1, 0.7, N.float(1).sub(skyAccess)).mul(
        inside,
      );
      const extinction = density.mul(length.div(8)).mul(0.00035);
      opticalDepth.addAssign(extinction);
      sum.addAssign(
        ref(U, "sunColour", "vec3")
          .mul(visibility)
          .mul(extinction)
          .mul(phase)
          .mul(cloud),
      );
    });
    return N.vec4(
      sum.mul(ref(U, "bakedEnabled")).mul(ref(U, "daylight")),
      opticalDepth.mul(ref(U, "bakedEnabled")),
    );
  })();
  const light = N.rtt(scatter, null, null, {
    resolutionScale: 0.35,
    depthBuffer: false,
  });
  const pipeline = new T.RenderPipeline(
    renderer,
    N.vec4(colour.rgb.mul(N.exp(light.a.negate())).add(light.rgb), colour.a),
  );
  return {
    sceneTarget: scenePass.renderTarget,
    render: () => pipeline.render(),
    setSize: () => {},
    pipeline,
  };
}
