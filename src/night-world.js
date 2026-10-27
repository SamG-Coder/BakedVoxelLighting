import { createRoadTorches } from "./road-torches.js";
import { createTorchVolumeMaterial } from "./torch-volume.js";
import { createTorchFire } from "./torch-fire.js";
import { VoxelMoon } from "./tsl-sun.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";
import { cloudData } from "./clouds.js";
import { seededRandom } from "./habitat.js";

// One sky draw, one moon draw and a camera-relative torch. Stable geometry is
// prepared with the scene; time changes uniforms instead of rebuilding assets.
export function createNightWorld(scene, camera, U, renderer, trees) {
  const fire = createTorchFire(renderer);
  const fireStrength = N.uniform(1);
  const night = N.uniform(0),
    torchOn = N.uniform(0),
    clock = N.uniform(0);
  const moonDirection = new T.Vector3(),
    position = new T.Vector3();
  const moonLight = new VoxelMoon(0xaac4ff, 0);
  scene.add(moonLight, moonLight.target);
  const starCount = 1800,
    random = seededRandom(91271);
  const points = new Float32Array(starCount * 3),
    colours = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const y = random() * 2 - 1,
      a = random() * Math.PI * 2,
      r = Math.sqrt(1 - y * y);
    points.set(
      [Math.cos(a) * r * 4400, y * 4400, Math.sin(a) * r * 4400],
      i * 3,
    );
    const brightness = 0.25 + random() ** 4 * 2,
      warmth = random();
    colours.set(
      [
        brightness * (0.75 + warmth * 0.25),
        brightness * 0.85,
        brightness * (1 - warmth * 0.25),
      ],
      i * 3,
    );
  }
  const starGeometry = new T.BufferGeometry();
  starGeometry.setAttribute("position", new T.BufferAttribute(points, 3));
  starGeometry.setAttribute("color", new T.BufferAttribute(colours, 3));
  const starsMaterial = new T.PointsNodeMaterial({
    size: 1.7,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  const starRay = N.positionWorld.sub(N.cameraPosition).normalize();
  starsMaterial.opacityNode = night
    .mul(N.float(1).sub(cloudData(U, N.cameraPosition, starRay).a))
    .mul(N.smoothstep(0, 0.12, starRay.y));
  const stars = new T.Points(starGeometry, starsMaterial);
  stars.frustumCulled = false;
  scene.add(stars);
  const moonMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  const q = N.uv().sub(0.5).mul(2),
    radius = q.length();
  const relief = N.sin(q.x.mul(31).add(N.sin(q.y.mul(17))))
    .mul(N.sin(q.y.mul(29)))
    .mul(0.08)
    .add(0.9);
  moonMaterial.colorNode = N.vec3(0.9, 1, 1.2).mul(relief).mul(1.5);
  moonMaterial.opacityNode = N.float(1)
    .sub(N.smoothstep(0.94, 1, radius))
    .mul(night)
    .mul(N.float(1).sub(cloudData(U, N.cameraPosition, starRay).a));
  const moon = new T.Mesh(new T.PlaneGeometry(42, 42), moonMaterial);
  moon.frustumCulled = false;
  scene.add(moon);

  const torch = new T.Group();
  torch.scale.setScalar(0.7);
  const wood = new T.MeshStandardNodeMaterial({
    color: 0x50301a,
    roughness: 1,
  });
  wood.maskNode = torchOn.greaterThan(0.5);
  const grain = N.sin(
    N.uv()
      .x.mul(160)
      .add(N.sin(N.uv().y.mul(18)).mul(2)),
  )
    .mul(0.12)
    .add(0.88);
  wood.colorNode = N.vec3(0.14, 0.065, 0.026).mul(grain);
  wood.emissiveNode = wood.colorNode.mul(0.06).mul(torchOn);
  const handle = new T.Mesh(
    new T.CylinderGeometry(0.028, 0.039, 0.66, 11),
    wood,
  );
  handle.position.y = -0.34;
  torch.add(handle);
  const wrapping = new T.MeshBasicNodeMaterial({
    color: 0x32241a,
  });
  wrapping.maskNode = torchOn.greaterThan(0.5);
  // Overlapping angled cloth bands give the head a wrapped silhouette.
  const weave = N.sin(N.uv().x.mul(190))
    .mul(N.sin(N.uv().y.mul(95)))
    .mul(0.08)
    .add(0.92);
  const char = N.mx_noise_float(N.vec3(N.uv().mul(24), 0))
    .mul(0.5)
    .add(0.5);
  wrapping.colorNode = N.vec3(0.018, 0.012, 0.008)
    .mul(weave)
    .mul(char.mul(0.7).add(0.5));
  // The flame sits inside this head: avoid singular point-light highlights at
  // millimetre distances; represent its char and embers directly.
  wrapping.colorNode = wrapping.colorNode.add(
    N.vec3(0.22, 0.022, 0.001)
      .mul(N.smoothstep(0.68, 0.85, char))
      .mul(torchOn),
  );
  const headGeometry = new T.CylinderGeometry(0.067, 0.052, 0.23, 24, 32);
  const headPoints = headGeometry.attributes.position;
  for (let i = 0; i < headPoints.count; i++) {
    const x = headPoints.getX(i),
      y = headPoints.getY(i),
      z = headPoints.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 0.01) {
      const angle = Math.atan2(z, x);
      const fold =
        1 +
        0.065 * Math.sin(y * 160 + angle * 2) +
        0.025 * Math.sin(angle * 7 + y * 35);
      headPoints.setXYZ(i, x * fold, y, z * fold);
    }
  }
  headGeometry.computeVertexNormals();
  torch.add(new T.Mesh(headGeometry, wrapping));
  const flameMaterial = createTorchVolumeMaterial(fire, torchOn);
  const flame = new T.Mesh(new T.BoxGeometry(1, 1, 1), flameMaterial);
  flame.scale.set(0.36, 0.7, 0.36);
  flame.position.y = 0.22;
  torch.add(flame);
  scene.add(torch);
  // Small recycled puffs: fixed geometry and uniforms, no per-frame allocation.
  const smokeMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  const smokeUV = N.uv().sub(0.5).mul(2);
  const puff = N.float(1).sub(N.smoothstep(0.25, 1, smokeUV.length()));
  const smokeAge = N.attribute("smokeAge", "float");
  smokeMaterial.colorNode = N.vec3(0.1, 0.105, 0.11);
  smokeMaterial.opacityNode = puff
    .mul(N.sin(smokeAge.mul(Math.PI)))
    .mul(0.16)
    .mul(fireStrength)
    .mul(torchOn);
  const smoke = [];
  for (let i = 0; i < 9; i++) {
    const geometry = new T.PlaneGeometry(1, 1);
    geometry.setAttribute(
      "smokeAge",
      new T.BufferAttribute(new Float32Array(4), 1),
    );
    const mesh = new T.Mesh(geometry, smokeMaterial);
    mesh.frustumCulled = false;
    scene.add(mesh);
    smoke.push(mesh);
  }
  const roadTorches = createRoadTorches(
    scene,
    fire,
    wood,
    wrapping,
    headGeometry,
    trees,
  );
  const smokeOrigin = new T.Vector3();
  let enabled = false,
    power = 120,
    warmth = 0.6,
    lastUpdate = null;
  return {
    prepare: () => fire.prepare(),
    fireStats: fire.stats,
    roadStats: roadTorches.stats,
    setTorch(value) {
      enabled = !!value;
    },
    get enabled() {
      return enabled;
    },
    update(seconds, daylight, sunDirection, carry, light) {
      const response =
        1 -
        Math.exp(
          -12 *
            (lastUpdate === null
              ? 1 / 60
              : Math.max(0, Math.min(0.1, seconds - lastUpdate))),
        );
      lastUpdate = seconds;
      clock.value = seconds;
      night.value = 1 - daylight;
      moonDirection.copy(sunDirection).negate();
      U.liveMoonDirection.value.copy(moonDirection);
      moon.position.copy(camera.position).addScaledVector(moonDirection, 4200);
      moon.quaternion.copy(camera.quaternion);
      moon.updateMatrixWorld();
      moonLight.target.position.copy(camera.position);
      moonLight.position
        .copy(camera.position)
        .addScaledVector(moonDirection, 300);
      moonLight.intensity = 0.7 * night.value * Math.max(0, moonDirection.y);
      moonLight.updateMatrixWorld();
      moonLight.target.updateMatrixWorld();
      stars.position.copy(camera.position);
      stars.updateMatrixWorld();
      const active = enabled && carry;
      torchOn.value = active ? 1 : 0;
      torch.visible = active;
      const roadsActive = roadTorches.update(
        camera,
        seconds,
        power * (1 - T.MathUtils.smoothstep(daylight, 0.15, 0.65)),
        warmth,
      );
      fire.advance(seconds, active || roadsActive);
      power +=
        (Math.min(320, Math.max(20, fire.stats.energy * 1800)) - power) *
        response;
      warmth += (fire.stats.temperature - warmth) * response;
      fireStrength.value = Math.min(1.5, power / 120);
      position.set(0.42, -0.17, -1.15).applyQuaternion(camera.quaternion);
      torch.position.copy(camera.position).add(position);
      torch.quaternion.copy(camera.quaternion);
      torch.rotateZ(-0.14);
      torch.updateMatrixWorld();
      smokeOrigin
        .set(0, 0.25, 0)
        .applyQuaternion(torch.quaternion)
        .add(torch.position);
      smoke.forEach((puff, i) => {
        puff.visible = active;
        if (!active) return;
        const age = (seconds * 0.35 + i / smoke.length) % 1;
        puff.position.copy(smokeOrigin);
        puff.position.x += Math.sin(age * 5 + i) * 0.045 + age * 0.16;
        puff.position.y += age * 0.8;
        puff.position.z += age * 0.08;
        puff.quaternion.copy(camera.quaternion);
        puff.scale.setScalar(0.055 + age * 0.22);
        const attr = puff.geometry.attributes.smokeAge;
        attr.array.fill(age);
        attr.needsUpdate = true;
        puff.updateMatrixWorld();
      });
      if (active) {
        position.set(0, 0.18, 0).applyQuaternion(torch.quaternion);
        light.position.copy(torch.position).add(position);
        light.intensity = power;
        light.color.setRGB(1, 0.28 + warmth * 0.32, 0.035 + warmth * 0.1);
        // GPU emission centroid moves the effective source with the rising fuel.
        position
          .set(
            (fire.stats.centroid[0] - 0.5) * 0.217,
            (fire.stats.centroid[1] - 0.3) * 0.336,
            0,
          )
          .applyQuaternion(torch.quaternion);
        light.position.add(position);
        light.updateMatrixWorld();
      }
      return active;
    },
  };
}
