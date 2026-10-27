import * as T from "three/webgpu";
import * as N from "three/tsl";
import { buildRiverData } from "./river-data.js";
import {
  riverTile,
  riverSurface,
  riverDisplacement,
  riverReflection,
} from "./river-kernels.js";
import riverSource from "./river-kernels.js?raw";
import { skyColour } from "./native-kernels.js";
import { cloudData } from "./clouds.js";
import { fullscreen, readPixels, ref, texRef } from "./tsl-baking.js";
import { uploadTextures } from "./gpu-uploads.js";
import { digest } from "./cache.js";
import { sampleHydrology } from "./watershed.js";

export const riverStats = {
  chunks: 0,
  triangles: 0,
  cacheHit: false,
  textureSize: 256,
  flow: "downstream",
  flowCPUUpdatesPerFrame: 0,
};
let rippleMap;
export async function prepareRiver(renderer, cache) {
  if (rippleMap) return;
  const key = "river-ripples:" + (await digest(riverSource));
  let record = await cache.get(key);
  riverStats.cacheHit = !!record;
  if (!record) {
    const target = new T.RenderTarget(256, 256, { depthBuffer: false });
    const quad = new T.QuadMesh(fullscreen(riverTile({ uv: N.uv().flipY() })));
    const previous = renderer.getRenderTarget();
    try {
      await renderer.compileAsync(quad, quad.camera);
      renderer.setRenderTarget(target);
      quad.render(renderer);
      const data = new Uint8Array(256 * 256 * 4);
      await readPixels(renderer, target, 0, 0, 256, 256, data);
      record = { data };
      await cache.put(key, record);
    } finally {
      renderer.setRenderTarget(previous);
      target.dispose();
      quad.material.dispose();
    }
  }
  rippleMap = new T.DataTexture(record.data, 256, 256, T.RGBAFormat);
  rippleMap.wrapS = rippleMap.wrapT = T.RepeatWrapping;
  rippleMap.magFilter = T.LinearFilter;
  rippleMap.minFilter = T.LinearMipmapLinearFilter;
  rippleMap.generateMipmaps = true;
  rippleMap.anisotropy = 4;
  rippleMap.needsUpdate = true;
  await uploadTextures(renderer, [rippleMap]);
}

export function createRiverMaterial(U) {
  if (!rippleMap)
    throw new Error("Prepare river ripples before building the water.");
  const material = new T.MeshPhysicalNodeMaterial({
    color: 0xffffff,
    roughness: 0.09,
    metalness: 0,
    ior: 1.333,
    transparent: true,
    depthWrite: false,
    side: T.FrontSide,
  });
  material.name = "Flowing river";
  material.userData.shading = { water: true };
  const coord = N.attribute("riverCoord", "vec2");
  const flow = N.attribute("riverFlow", "vec4");
  const time = ref(U, "time");
  const map = N.texture(rippleMap);
  const surface = riverSurface({
    map,
    linearSampler: N.sampler(map),
    coord,
    flow,
    time,
    distanceToEye: N.cameraPosition.sub(N.positionWorld).length(),
  });
  const normal = surface.xyz;
  const depth = N.max(flow.w, 0);
  const foam = surface.w;
  material.positionNode = riverDisplacement({
    p: N.positionLocal,
    coord,
    depth,
    speed: flow.z,
    time,
  });
  material.normalNode = N.cameraViewMatrix
    .mul(N.vec4(normal, 0))
    .xyz.normalize();
  material.colorNode = N.mix(
    N.mix(
      N.vec3(0.075, 0.105, 0.065),
      N.vec3(0.008, 0.034, 0.028),
      N.float(1).sub(N.exp(depth.mul(-0.85))),
    ),
    N.vec3(0.65, 0.72, 0.65),
    foam,
  );
  material.roughnessNode = N.mix(N.float(0.09), N.float(0.6), foam);
  const view = N.cameraPosition.sub(N.positionWorld).normalize();
  const fresnel = N.pow(N.float(1).sub(N.max(view.dot(normal), 0)), 5);
  material.opacityNode = N.smoothstep(0, 0.16, depth).mul(
    N.clamp(
      N.float(1)
        .sub(N.exp(depth.mul(-0.65)))
        .add(fresnel.mul(0.88))
        .add(foam),
      0,
      0.98,
    ),
  );
  material.maskNode = depth.greaterThan(0.005);
  const planar = N.reflector({
    resolutionScale: 0.5,
    bounces: false,
    samples: 1,
  });
  planar.target.rotation.x = -Math.PI / 2;
  const planeLevel = N.uniform(0),
    planeWeight = N.uniform(0);
  const water = {};
  const hiddenGrass = [],
    shadowUpdates = [],
    shadowLights = [];
  const centre = new T.Vector3();
  let reflectionCamera;
  function selectReflectionObjects(object) {
    if (!object.visible) return;
    if (object.isLight && object.shadow) {
      shadowLights.push(object.shadow);
      shadowUpdates.push(object.shadow.needsUpdate);
      object.shadow.needsUpdate = false;
    }
    if (object.userData.grassCard && object.boundingSphere) {
      centre
        .copy(object.boundingSphere.center)
        .applyMatrix4(object.matrixWorld);
      // Subpixel distant grass is already represented by the ground-cover bake.
      if (
        Math.hypot(
          centre.x - reflectionCamera.position.x,
          centre.z - reflectionCamera.position.z,
        ) >
        64 + object.boundingSphere.radius
      ) {
        hiddenGrass.push(object);
        object.visible = false;
        return;
      }
    }
    for (const child of object.children) selectReflectionObjects(child);
  }
  const base = planar.reflector;
  const updateReflection = base.updateBefore.bind(base);
  base.updateBefore = (frame) => {
    sampleHydrology(frame.camera.position.x, frame.camera.position.z, water);
    const nearby =
      water.segment >= 0 &&
      water.distance - water.width < 160 &&
      frame.camera.position.y > water.level;
    planeWeight.value = nearby ? 1 : 0;
    if (!nearby && base.hasOutput) return false;
    planeLevel.value = water.level;
    planar.target.position.y = water.level;
    planar.target.updateMatrixWorld(true);
    reflectionCamera = frame.camera;
    const far = reflectionCamera.far;
    selectReflectionObjects(frame.scene);
    reflectionCamera.far = Math.min(far, 320);
    reflectionCamera.updateProjectionMatrix();
    try {
      return updateReflection(frame);
    } finally {
      reflectionCamera.far = far;
      reflectionCamera.updateProjectionMatrix();
      for (const mesh of hiddenGrass) mesh.visible = true;
      for (let i = 0; i < shadowLights.length; i++)
        shadowLights[i].needsUpdate = shadowUpdates[i];
      hiddenGrass.length = shadowLights.length = shadowUpdates.length = 0;
    }
  };
  planar.uvNode = N.screenUV.flipX().add(normal.xz.mul(0.035));
  material.addEventListener("dispose", () => planar.dispose());
  // Sky reflection plus a bounded trace through resident landscape fields.
  // Reflections remain available outside the screen and streamed voxel volume.
  material.envNode = N.Fn((builder) => {
    const ray = builder.context.getUV();
    const sky = skyColour({
      ray,
      sun: ref(U, "liveSunDirection", "vec3"),
      cloud: cloudData(U, N.positionWorld, ray),
      daylight: ref(U, "daylight"),
    });
    const canopy = texRef(U, "rootField");
    const landscape = riverReflection({
      terrain: texRef(U, "terrainField"),
      canopy,
      linearSampler: N.sampler(canopy),
      p: N.positionWorld.add(N.vec3(0, 0.03, 0)),
      ray,
      daylight: ref(U, "daylight"),
      sun: ref(U, "liveSunDirection", "vec3"),
    });
    const estimate = N.mix(sky, landscape.rgb, landscape.a);
    // A river is not globally planar. Only nearby water at this reach's elevation
    // uses the scene capture; other heights blend to the resident-field estimate.
    const local = N.float(1)
      .sub(N.smoothstep(0.2, 1.5, N.abs(N.positionWorld.y.sub(planeLevel))))
      .mul(
        N.float(1).sub(
          N.smoothstep(80, 160, N.cameraPosition.sub(N.positionWorld).length()),
        ),
      )
      .mul(planeWeight);
    return N.mix(estimate, planar.rgb, local);
  })();
  return material;
}

export function buildRiver(scene, heightAt, U, options) {
  const data = options?.data ?? buildRiverData(heightAt, options);
  const material = createRiverMaterial(U),
    group = new T.Group();
  group.name = "River";
  for (const chunk of data.chunks) {
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(chunk.position, 3));
    geometry.setAttribute("normal", new T.BufferAttribute(chunk.normal, 3));
    geometry.setAttribute("riverCoord", new T.BufferAttribute(chunk.coord, 2));
    geometry.setAttribute("riverFlow", new T.BufferAttribute(chunk.flow, 4));
    geometry.setIndex(new T.BufferAttribute(chunk.index, 1));
    geometry.computeBoundingBox();
    geometry.boundingBox.min.y -= 0.02;
    geometry.boundingBox.max.y += 0.02;
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += 0.02;
    const mesh = new T.Mesh(geometry, material);
    mesh.name = `River section ${group.children.length}`;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  scene.add(group);
  Object.assign(riverStats, {
    chunks: data.chunks.length,
    triangles: data.chunks.reduce((n, c) => n + c.index.length / 3, 0),
    lengthMetres: Math.round(data.length),
    speedMetresPerSecond: [0.18, 0.96],
    reflection: "half-resolution local planar + distant terrain/canopy + sky",
  });
  return group;
}
