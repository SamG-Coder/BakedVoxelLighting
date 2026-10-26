// Instance buffers/materials belong to a streamed group. Prototype geometry and
// atlas textures are shared and must outlive any individual streamed instance.
export function disposeVegetationGroup(group) {
  if (!group) return;
  group.removeFromParent();
  group.traverse((object) => {
    if (!object.isMesh) return;
    if (object.isInstancedMesh) object.dispose();
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      material.dispose();
    if (object.userData.ownedGeometry) object.geometry.dispose();
  });
}
