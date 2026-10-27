import * as T from "three/webgpu";
import * as N from "three/tsl";
import { routes, terrainHeight, terrainSample } from "./terrain-field.js";
import { seededRandom } from "./habitat.js";
import { roadTorchLayout, treeClearance } from "./road-torch-layout.js";
import { createTorchVolumeMaterial } from "./torch-volume.js";

// Immutable spatial pages for posts; bounded reusable pools for fire and lights.
// All flames share the carried torch's GPU simulation, not one solver per post.
export function createRoadTorches(
  scene,
  fire,
  carriedWood,
  carriedCloth,
  headGeometry,
  trees,
) {
  const clear = treeClearance(trees);
  const records = roadTorchLayout(routes, terrainHeight, seededRandom(731903), {
    traffic: (x, z) => terrainSample(x, z).traffic,
    clear: (x, z) => terrainSample(x, z).riverDistance > 9 && clear(x, z),
  });
  if (!records.length)
    return {
      stats: {
        total: 0,
        pages: 0,
        flames: 0,
        lights: 0,
        placement: "route landmarks",
        lightCapacity: 0,
        flameCapacity: 0,
        height: [4.6, 5],
        sharedSimulation: true,
        glowDistance: 900,
      },
      update: () => false,
    };
  const cells = new Map(),
    cellSize = 128;
  for (const p of records) {
    const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.z / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  const wood = carriedWood.clone(),
    cloth = carriedCloth.clone();
  wood.maskNode = null;
  wood.emissiveNode = null;
  cloth.maskNode = null;
  // Road heads remain lit independently of the carried-torch checkbox.
  cloth.colorNode = N.vec3(0.024, 0.014, 0.008).add(
    N.vec3(0.3, 0.025, 0.001).mul(
      N.smoothstep(
        0.5,
        0.8,
        N.mx_noise_float(N.positionGeometry.mul(75)).mul(0.5).add(0.5),
      ),
    ),
  );
  const postGeometry = new T.CylinderGeometry(0.07, 0.12, 1, 9);
  const ironGeometry = new T.CylinderGeometry(0.104, 0.104, 0.065, 12);
  const iron = new T.MeshStandardNodeMaterial({
    color: 0x24201b,
    roughness: 0.8,
    metalness: 0.65,
  });
  const dummy = new T.Object3D();
  for (const page of cells.values()) {
    const posts = new T.InstancedMesh(postGeometry, wood, page.length);
    const heads = new T.InstancedMesh(headGeometry, cloth, page.length);
    const collars = new T.InstancedMesh(ironGeometry, iron, page.length * 2);
    for (let i = 0; i < page.length; i++) {
      const p = page[i];
      dummy.rotation.set(0, p.yaw, 0);
      dummy.position.set(p.x, p.y + p.head / 2 - 0.08, p.z);
      dummy.scale.set(1, p.head + 0.16, 1);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
      dummy.position.y = p.y + p.head;
      dummy.scale.setScalar(1.4);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);
      for (let j = 0; j < 2; j++) {
        dummy.position.y = p.y + p.head - 0.22 - j * 0.16;
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        collars.setMatrixAt(i * 2 + j, dummy.matrix);
      }
    }
    for (const mesh of [posts, heads, collars]) {
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.updateMatrixWorld();
      scene.add(mesh);
    }
  }
  const fireRange = N.uniform(400);
  const visible = N.float(1).sub(
    N.smoothstep(
      fireRange.sub(100),
      fireRange,
      N.distance(N.positionWorld, N.cameraPosition),
    ),
  );
  const material = createTorchVolumeMaterial(fire, visible);
  const geometry = new T.BoxGeometry(1, 1, 1);
  const flames = Array.from({ length: Math.min(48, records.length) }, () => {
    const mesh = new T.Mesh(geometry, material);
    mesh.scale.set(0.36 * 1.4, 0.7 * 1.4, 0.36 * 1.4);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });
  // Fixed light count avoids shader recompilation when walking between pages.
  const lights = Array.from({ length: Math.min(12, records.length) }, () => {
    const light = new T.PointLight(0xff9c42, 0, 24, 2);
    light.castShadow = false;
    scene.add(light);
    return light;
  });
  // Distant glows retain visibility when the real 3D flames become sub-pixel.
  // One depth-tested instanced sprite draw, occluded by terrain and trees.
  const glowEnergy = N.uniform(1);
  const glowPositions = new T.InstancedBufferAttribute(
    new Float32Array(records.flatMap((p) => [p.x, p.y + p.head + 0.25, p.z])),
    3,
  );
  const glowPosition = N.instancedBufferAttribute(glowPositions);
  const glowDistance = N.varying(N.distance(glowPosition, N.cameraPosition));
  const glowMaterial = new T.PointsNodeMaterial({
    size: 7,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  glowMaterial.positionNode = glowPosition;
  glowMaterial.colorNode = N.vec3(2.4, 0.65, 0.06).mul(glowEnergy);
  glowMaterial.opacityNode = N.exp(N.uv().sub(0.5).length().pow(2).mul(-28))
    .mul(N.smoothstep(35, 90, glowDistance))
    .mul(N.float(1).sub(N.smoothstep(650, 900, glowDistance)));
  const glow = new T.Sprite(glowMaterial);
  glow.count = records.length;
  glow.frustumCulled = false;
  scene.add(glow);
  // Records are fixed at startup: reuse selection objects for the entire walk.
  const selected = records.map((p) => ({ p, distance: Infinity }));
  const byDistance = (a, b) => a.distance - b.distance;
  let lastQuery = -Infinity;
  const stats = {
    total: records.length,
    pages: cells.size,
    flames: 0,
    lights: 0,
    placement: "route landmarks",
    height: [4.6, 5],
    sharedSimulation: true,
    glowDistance: 900,
    lightCapacity: lights.length,
    flameCapacity: flames.length,
  };
  return {
    stats,
    update(camera, seconds, power, warmth) {
      const burning = power > 0.5 && records.length > 0;
      glow.visible = burning;
      if (!burning) {
        stats.flames = stats.lights = 0;
        for (const mesh of flames) mesh.visible = false;
        for (const light of lights) light.intensity = 0;
        return false;
      }
      if (seconds - lastQuery > 0.15) {
        for (const candidate of selected)
          candidate.distance = Math.hypot(
            candidate.p.x - camera.position.x,
            candidate.p.z - camera.position.z,
          );
        selected.sort(byDistance);
        lastQuery = seconds;
      }
      stats.flames = 0;
      // At junctions the pool can fill before the normal range. Fade to zero
      // before its last slot, so selecting the next source never pops a flame.
      fireRange.value = Math.min(400, selected[flames.length]?.distance ?? 400);
      glowEnergy.value = Math.max(0, Math.min(1.5, power / 120));
      stats.lights = 0;
      for (let i = 0; i < flames.length; i++) {
        const candidate = selected[i],
          mesh = flames[i];
        mesh.visible = !!candidate && candidate.distance < 400;
        if (mesh.visible) stats.flames++;
        if (!candidate) continue;
        const p = candidate.p;
        mesh.position.set(p.x, p.y + p.head + 0.22 * 1.4, p.z);
        mesh.rotation.y = p.yaw;
        mesh.updateMatrixWorld();
      }
      for (let i = 0; i < lights.length; i++) {
        const candidate = selected[i],
          light = lights[i];
        light.intensity = 0;
        if (!candidate) continue;
        const { p } = candidate;
        const distance = Math.hypot(
          p.x - camera.position.x,
          p.z - camera.position.z,
        );
        const outer = Math.min(160, selected[lights.length]?.distance ?? 160);
        const fade =
          1 -
          T.MathUtils.smoothstep(distance, Math.min(100, outer - 20), outer);
        light.position.set(p.x, p.y + p.head + 0.25, p.z);
        light.color.setRGB(1, 0.28 + warmth * 0.32, 0.035 + warmth * 0.1);
        light.intensity = power * 2.2 * fade;
        light.updateMatrixWorld();
        if (fade > 0 && burning) stats.lights++;
      }
      return stats.flames > 0;
    },
  };
}
