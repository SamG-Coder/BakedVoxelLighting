import { Object3D, Color } from "three/webgpu";
import { disposeVegetationGroup } from "./vegetation-resources.js";
import { AttributeInstances } from "./attribute-instances.js";
const noRotation = [0, 0, 0];
const unitScale = [1, 1, 1];

// Geometry identifies a species/LOD. Keep mesh, material and attribute identities
// when moving that representation between clusters, so its prepared shaders and
// shadow pipelines remain reusable. This pool owns only private instance data.
export class VegetationInstancePool {
  constructor(limit = 4) {
    this.limit = limit;
    this.free = new WeakMap();
    this.transform = new Object3D();
    this.colour = new Color();
    this.stats = { created: 0, reused: 0, retained: 0, disposed: 0 };
  }
  acquire(geometry, makeMaterial, transforms) {
    const list = this.free.get(geometry);
    const index =
      list?.findIndex(
        (mesh) => mesh.instanceMatrix.count >= transforms.length,
      ) ?? -1;
    let mesh;
    if (index >= 0) {
      mesh = list.splice(index, 1)[0];
      this.stats.retained--;
      this.stats.reused++;
    } else {
      const capacity = Math.max(
        4,
        2 ** Math.ceil(Math.log2(transforms.length || 1)),
      );
      mesh = new AttributeInstances(geometry, makeMaterial(), capacity, true);
      this.stats.created++;
    }
    mesh.instanceCount = transforms.length;
    mesh.visible = true;
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i],
        dummy = this.transform;
      dummy.position.set(...t.p);
      dummy.rotation.set(...(t.r || noRotation));
      dummy.scale.set(...(t.s || unitScale));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(
        i,
        t.colour
          ? this.colour.setRGB(...t.colour)
          : this.colour.set(t.c ?? 0xffffff),
      );
    }
    mesh.instanceMatrix.needsUpdate = mesh.instanceColor.needsUpdate = true;
    mesh.boundingBox = null;
    mesh.computeBoundingSphere();
    return mesh;
  }
  releaseGroup(group) {
    if (!group) return;
    group.removeFromParent();
    while (group.children.length) {
      const mesh = group.children[group.children.length - 1];
      group.remove(mesh);
      if (!mesh.isInstancedMesh && !mesh.isAttributeInstances) {
        disposeVegetationGroup(mesh);
        continue;
      }
      const source = mesh.sourceGeometry || mesh.geometry;
      let list = this.free.get(source);
      if (!list) this.free.set(source, (list = []));
      mesh.visible = false;
      if (list.length < this.limit) {
        list.push(mesh);
        this.stats.retained++;
      } else {
        disposeVegetationGroup(mesh);
        this.stats.disposed++;
      }
    }
  }
}
