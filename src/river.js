import * as T from "three/webgpu";
import * as N from "three/tsl";
import { buildRiverData } from "./river-data.js";
import { riverTile, riverSurface, riverDisplacement } from "./river-kernels.js";
import riverSource from "./river-kernels.js?raw";
import { skyColour } from "./native-kernels.js";
import { cloudData } from "./clouds.js";
import { fullscreen, readPixels, ref } from "./tsl-baking.js";
import { uploadTextures } from "./gpu-uploads.js";
import { digest } from "./cache.js";

export const riverStats = {
  chunks: 0,
  triangles: 0,
  cacheHit: false,
  textureSize: 256,
  flow: "downstream",
  cpuUpdatesPerFrame: 0,
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
    roughness: 0.17,
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
      N.vec3(0.11, 0.17, 0.105),
      N.vec3(0.018, 0.055, 0.044),
      N.smoothstep(0.12, 1.5, depth),
    ),
    N.vec3(0.65, 0.72, 0.65),
    foam,
  );
  material.roughnessNode = N.mix(N.float(0.13), N.float(0.68), foam);
  const view = N.cameraPosition.sub(N.positionWorld).normalize();
  const fresnel = N.pow(N.float(1).sub(N.max(view.dot(normal), 0)), 5);
  material.opacityNode = N.smoothstep(0, 0.16, depth).mul(
    N.clamp(
      N.float(0.19).add(depth.mul(0.32)).add(fresnel.mul(0.75)).add(foam),
      0,
      0.98,
    ),
  );
  material.maskNode = depth.greaterThan(0.005);
  // Reuse the baked sky/cloud field, sampled in the actual reflection direction.
  // No second scene render, screen readback, or per-frame CPU flow simulation.
  material.envNode = N.Fn((builder) => {
    const ray = builder.context.getUV();
    return skyColour({
      ray,
      sun: ref(U, "liveSunDirection", "vec3"),
      cloud: cloudData(U, N.positionWorld, ray),
      daylight: ref(U, "daylight"),
    });
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
  });
  return group;
}
