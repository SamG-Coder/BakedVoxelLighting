import * as T from "three/webgpu";
import { decorate } from "./lighting.js";
import { terrainSample } from "./terrain-field.js";
import { instanced } from "./impostors.js";
import { deadwoodSegments } from "./deadwood-data.js";
export function buildDeadwood(world, assets) {
  const groups = new Map(),
    up = new T.Vector3(0, 1, 0),
    q = new T.Quaternion(),
    e = new T.Euler();
  world.voxelObjects = [];
  for (const log of world.deadwood) {
    const segments = deadwoodSegments(log, terrainSample);
    if (!segments.length) continue;
    let items = groups.get(log.cluster);
    if (!items) groups.set(log.cluster, (items = []));
    for (const segment of segments) {
      const a = new T.Vector3(...segment.a),
        b = new T.Vector3(...segment.b),
        d = b.clone().sub(a);
      q.setFromUnitVectors(up, d.clone().normalize());
      e.setFromQuaternion(q);
      const colour = new T.Color().setRGB(
        0.88 - segment.decay * 0.27,
        0.75 - segment.decay * 0.24,
        0.59 - segment.decay * 0.21,
      );
      items.push({
        p: a.clone().add(b).multiplyScalar(0.5).toArray(),
        r: [e.x, e.y, e.z],
        s: [segment.r, d.length(), segment.r],
        c: colour.getHex(),
        trunk: segment.trunk,
      });
      world.voxelObjects.push({ ...segment, wood: true });
    }
  }
  const geometries = [
    new T.CylinderGeometry(0.7, 1, 1, 9, 1),
    new T.CylinderGeometry(0.7, 1, 1, 5, 1),
  ];
  for (const geometry of geometries) {
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 3);
  }
  const entries = [];
  for (const [id, transforms] of groups) {
    const make = (level) => {
      const material = decorate(
        new T.MeshStandardMaterial({
          map: assets.bark.map,
          normalMap: assets.bark.normal,
          roughness: 1,
          normalScale: new T.Vector2(0.65, 0.65),
        }),
      );
      const mesh = instanced(
        geometries[level],
        material,
        level ? transforms.filter((t) => t.trunk) : transforms,
      );
      mesh.castShadow = mesh.receiveShadow = true;
      const group = new T.Group();
      group.add(mesh);
      group.visible = false;
      return group;
    };
    const c = world.clusters[id];
    entries.push({
      group: make(0),
      far: make(1),
      center: new T.Vector3(c.x, terrainSample(c.x, c.z).height, c.z),
    });
  }
  entries.identity = "deadwood-v1";
  entries.stats = {
    logs: world.voxelObjects.filter((o) => o.trunk).length / 2,
    segments: world.voxelObjects.length,
    clusters: entries.length,
  };
  return entries;
}
