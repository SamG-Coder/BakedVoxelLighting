import { cloudAt, CLOUD_SHADOW_STRENGTH } from "./clouds.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";
import { sampleVolume } from "./tsl-materials.js";
import { ref } from "./tsl-baking.js";
import { taau } from "three/addons/tsl/display/TAAUNode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { sss } from "three/addons/tsl/display/SSSNode.js";

// Half-resolution, depth-limited single scattering. Surface occlusion comes
// from the same streamed radiance atlas used by the vegetation materials.
export function createAtmosphere(
  renderer,
  scene,
  camera,
  U,
  sun,
  aaMode = "msaa",
) {
  const temporal = aaMode !== "msaa";
  const scenePass = N.pass(scene, camera);
  scenePass.renderTarget.samples = renderer.samples;
  scenePass.renderTarget.texture.type = renderer.getOutputBufferType();
  // Keep the auxiliary buffer to one RGBA attachment: motion, contact receiver,
  // reactive response. No additional full-scene geometry/depth prepass.
  const motion = N.Fn((builder) => {
    const s = builder.material.userData.shading || {};
    const thin = s.grass || s.wind || s.transmission;
    const contact = !thin && !s.water && builder.object.receiveShadow ? 1 : 0;
    const reactive = s.water
      ? 0.4
      : thin
        ? 0.12
        : builder.material.transparent
          ? 0.85
          : 0;
    return N.vec4(N.velocity, contact, reactive);
  })();
  if (temporal) {
    scenePass.setMRT(N.mrt({ output: N.output, velocity: motion }));
    scenePass.renderTarget.worldMRT = scenePass.getMRT();
  }
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
    // Native TAA resolves the scene before the final low-frequency composite.
    // Keep scattering deterministic there; unresolved temporal noise would shimmer.
    const jitter =
      aaMode === "taau"
        ? N.fract(
            N.sin(
              N.screenCoordinate.xy
                .dot(N.vec2(12.9898, 78.233))
                .add(N.floor(ref(U, "time").mul(60))),
            ).mul(43758.5453),
          )
        : N.float(0.5);
    N.Loop(8, ({ i }) => {
      const p = eye.add(ray.mul(length.mul(N.float(i).add(jitter).div(8))));
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
      const transmittance = N.exp(opticalDepth.negate());
      const cloud = N.float(1).sub(
        cloudAt(U, p, sun).mul(CLOUD_SHADOW_STRENGTH),
      );
      sum.addAssign(
        ref(U, "sunColour", "vec3")
          .mul(visibility)
          .mul(N.float(1).sub(N.exp(extinction.negate())))
          .mul(transmittance)
          .mul(phase)
          .mul(cloud),
      );
      opticalDepth.addAssign(extinction);
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
  const motionTexture = temporal ? scenePass.getTextureNode("velocity") : null;
  let resolve =
    aaMode === "taa" ? traa(colour, depth, motionTexture, camera) : null;
  if (resolve) resolve.reactiveNode = motionTexture.a;
  let shaded = resolve ? resolve.rgb : colour.rgb;
  let contact;
  if (temporal) {
    contact = sss(depth, camera, sun);
    contact.resolutionScale = 0.5;
    contact.maxDistance.value = 0.45;
    contact.thickness.value = 0.045;
    contact.quality.value = 0.25;
    contact.shadowIntensity.value = 1;
    // Conservative contact correction only on solid receivers, never the
    // grass/leaves' carrier faces. Existing voxel/raster shadows remain dominant.
    shaded = shaded.mul(
      N.mix(1, contact.r, motionTexture.z.mul(ref(U, "daylight")).mul(0.12)),
    );
  }
  // Coverage alpha belongs to the foliage raster pass, not canvas opacity.
  // The world includes an opaque sky; retaining cutout alpha here leaks the
  // page background through dense mipmapped grass after temporal filtering.
  const composed = N.vec4(
    shaded.mul(N.exp(light.a.negate())).add(light.rgb),
    1,
  );
  let output = composed;
  if (aaMode === "taau") {
    const input = N.rtt(composed, null, null, {
      type: T.HalfFloatType,
      depthBuffer: false,
    });
    resolve = taau(input, depth, motionTexture, camera);
    output = resolve;
  }
  if (resolve) {
    // Streaming compiles materials between frames. Keep the same unjittered
    // projection bound during those builds as during presentation; otherwise
    // VelocityNode bakes the jittered cameraProjectionMatrix into far HLODs.
    resolve._originalProjectionMatrix.copy(camera.projectionMatrix);
    N.velocity.setProjectionMatrix(resolve._originalProjectionMatrix);
    const clearViewOffset = resolve.clearViewOffset.bind(resolve);
    resolve.clearViewOffset = () => {
      clearViewOffset();
      N.velocity.setProjectionMatrix(resolve._originalProjectionMatrix);
    };
    // Native resolution, short history: retain fine blades and rapidly reject
    // changing foliage / flames / water instead of smearing long trails.
    resolve.currentFrameWeight = 0.15;
    resolve.maxVelocityLength = 48;
    // The raw input is jittered. Mixing it back after reconstruction makes
    // sub-pixel leaves, tree silhouettes and the horizon shake every frame.
    // Native resolve feeds the final atmosphere/contact composite directly:
    // no intermediate full-resolution RGBA16F texture or extra composite draw.
  }
  const pipeline = new T.RenderPipeline(renderer, output);
  const lastEye = camera.position.clone();
  const lastRotation = camera.quaternion.clone();
  const lastSun = U.liveSunDirection.value.clone();
  let lastFov = camera.fov;
  const render = () => {
    // Cuts and abrupt time-of-day changes cannot reuse screen history. These
    // scratch values are retained; ordinary movement does not clear the history.
    if (
      resolve?.resetHistory &&
      (lastEye.distanceToSquared(camera.position) > 64 ||
        Math.abs(lastRotation.dot(camera.quaternion)) < 0.85 ||
        lastSun.dot(U.liveSunDirection.value) < 0.98 ||
        lastFov !== camera.fov)
    )
      resolve.resetHistory();
    pipeline.render();
    lastEye.copy(camera.position);
    lastRotation.copy(camera.quaternion);
    lastSun.copy(U.liveSunDirection.value);
    lastFov = camera.fov;
  };
  return {
    sceneTarget: scenePass.renderTarget,
    render,
    setSize: () => {},
    pipeline,
    resolve,
    contact,
  };
}
