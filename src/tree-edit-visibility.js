import { Matrix4 } from "three/webgpu";
const hidden = new Matrix4().makeScale(1e-8, 1e-8, 1e-8);
hidden.elements[13] = -100000;

// Apply AFTER asynchronous preparation too: a cut may occur while an old LOD
// is compiling. The original ordering stays stable for cached merged quads.
export function applyTreeEdits(cluster, group, prototypes) {
  if (!group || !cluster.editedTrees?.size) return;
  group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (mesh.userData.visibilityMerged) {
      const index = mesh.geometry.index;
      for (const tree of cluster.editedTrees) {
        const k = cluster.trees.indexOf(tree);
        if (k >= 0) index.array.fill(k * 4, k * 6, k * 6 + 6);
      }
      index.needsUpdate = true;
    } else if (mesh.instanceMatrix) {
      const a = mesh.instanceMatrix.array;
      for (const tree of cluster.editedTrees) {
        const p = prototypes[tree.variant].center,
          c = Math.cos(tree.rotation),
          s = Math.sin(tree.rotation);
        const bx = tree.x + (p.x * c + p.z * s) * tree.scale,
          bz = tree.z + (-p.x * s + p.z * c) * tree.scale;
        for (let i = 0; i < (mesh.instanceCount ?? mesh.count); i++) {
          const x = a[i * 16 + 12],
            z = a[i * 16 + 14];
          if (
            (Math.abs(x - tree.x) < 0.002 && Math.abs(z - tree.z) < 0.002) ||
            (Math.abs(x - bx) < 0.002 && Math.abs(z - bz) < 0.002)
          )
            mesh.setMatrixAt(i, hidden);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  });
}
