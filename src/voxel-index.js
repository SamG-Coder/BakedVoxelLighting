import * as T from "three/webgpu";
import { AreaIndex } from "./area-index.js";
export function indexVoxelWorld(world) {
  const trees = new AreaIndex(),
    grass = new AreaIndex(),
    objects = new AreaIndex();
  for (const t of world.trees)
    trees.insert(t, t.x - 15, t.z - 15, t.x + 15, t.z + 15);
  for (const p of world.grassBake.patches)
    grass.insert(p, p.x - 14, p.z - 14, p.x + 14, p.z + 14);
  const matrix = new T.Matrix4(),
    position = new T.Vector3(),
    scale = new T.Vector3(),
    rotation = new T.Quaternion();
  for (const mesh of world.voxelMeshes) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < (mesh.instanceCount ?? mesh.count); i++) {
      mesh.getMatrixAt(i, matrix);
      matrix.premultiply(mesh.matrixWorld);
      matrix.decompose(position, rotation, scale);
      const c = mesh.geometry.boundingSphere.center
          .clone()
          .applyMatrix4(matrix),
        r =
          mesh.geometry.boundingSphere.radius *
          Math.max(scale.x, scale.y, scale.z);
      const item = {
        p: c.toArray(),
        r,
        rock: mesh.userData.voxelKind === "rock",
      };
      objects.insert(item, c.x - r, c.z - r, c.x + r, c.z + r);
    }
  }
  for (const item of world.voxelObjects || []) {
    const { a, b, r } = item;
    objects.insert(
      item,
      Math.min(a[0], b[0]) - r,
      Math.min(a[2], b[2]) - r,
      Math.max(a[0], b[0]) + r,
      Math.max(a[2], b[2]) + r,
    );
  }
  world.areaIndexes = { trees, grass, objects };
  return { trees: trees.count, grass: grass.count, objects: objects.count };
}
