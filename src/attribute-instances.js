import * as T from "three/webgpu";
import * as N from "three/tsl";
import { leaseGeometry } from "./shared-geometry.js";
const boundsMatrix = new T.Matrix4();
const transformedBounds = new T.Sphere();

// Named geometry attributes let Three share a node-builder state between tiles.
// InstancedMesh embeds each object's buffers in its graph and therefore keys that
// graph by object UUID. These attributes are resolved from each draw's geometry.
export const attributeInstanceMatrix = () =>
  N.mat4(...[0, 1, 2, 3].map((i) => N.attribute(`tileMatrix${i}`, "vec4")));
const setupInstances = N.Fn(() => {
  const matrix = attributeInstanceMatrix();
  N.positionLocal.assign(matrix.mul(N.positionLocal).xyz);
  N.normalLocal.assign(N.transformNormal(N.normalLocal, matrix));
  N.instanceColor.assign(N.attribute("tileColour", "vec3"));
}, "void");
function setupPosition(builder) {
  if (builder.geometry.hasAttribute("tileMatrix0")) setupInstances();
  return T.NodeMaterial.prototype.setupPosition.call(this, builder);
}

export class AttributeInstances extends T.Mesh {
  constructor(source, material, capacity, shared = false) {
    const geometry = new T.InstancedBufferGeometry();
    geometry.index = source.index;
    for (const [name, attribute] of Object.entries(source.attributes))
      geometry.setAttribute(name, attribute);
    super(geometry, material);
    this.sourceGeometry = source;
    this.sharedGeometry = shared;
    if (shared) leaseGeometry(source, geometry);
    this.isAttributeInstances = true;
    const buffer = new T.InstancedInterleavedBuffer(
      new Float32Array(capacity * 16),
      16,
    );
    this.instanceMatrix = buffer;
    for (let i = 0; i < 4; i++)
      geometry.setAttribute(
        `tileMatrix${i}`,
        new T.InterleavedBufferAttribute(buffer, 4, i * 4),
      );
    this.instanceColor = new T.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
    geometry.instanceCount = capacity;
    this.boundingSphere = null;
  }
  // Do not expose Object3D.count: Three treats count > 1 as a per-object shader
  // cache key. InstancedBufferGeometry already owns the draw instance count.
  setMatrixAt(i, matrix) {
    matrix.toArray(this.instanceMatrix.array, i * 16);
  }
  getMatrixAt(i, matrix) {
    return matrix.fromArray(this.instanceMatrix.array, i * 16);
  }
  setColorAt(i, colour) {
    colour.toArray(this.instanceColor.array, i * 3);
  }
  dispose() {
    this.dispatchEvent({ type: "dispose" });
    this.geometry.dispose();
  }
  clone(recursive = true) {
    const mesh = new AttributeInstances(
      this.sharedGeometry ? this.sourceGeometry : this.sourceGeometry.clone(),
      this.material,
      this.instanceMatrix.count,
      this.sharedGeometry,
    );
    T.Object3D.prototype.copy.call(mesh, this, recursive);
    mesh.instanceMatrix.array.set(this.instanceMatrix.array);
    mesh.instanceColor.array.set(this.instanceColor.array);
    // Per-instance species indices used by grass are private too.
    for (const [name, a] of Object.entries(this.geometry.attributes))
      if (a.isInstancedBufferAttribute && name !== "tileColour")
        mesh.geometry.setAttribute(name, a.clone());
    mesh.instanceCount = this.instanceCount;
    mesh.boundingSphere = this.boundingSphere?.clone() ?? null;
    return mesh;
  }
  set material(value) {
    // Also covers the temporary surface-capture material.
    if (value?.isNodeMaterial) value.setupPosition = setupPosition;
    this._tileMaterial = value;
  }
  get material() {
    return this._tileMaterial;
  }
  set instanceColor(value) {
    this._tileColour = value;
    this.geometry.setAttribute("tileColour", value);
  }
  get instanceColor() {
    return this._tileColour;
  }
  set instanceCount(value) {
    this.geometry.instanceCount = value;
  }
  get instanceCount() {
    return this.geometry.instanceCount;
  }
  computeBoundingSphere() {
    if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
    this.boundingSphere ||= new T.Sphere();
    this.boundingSphere.makeEmpty();
    for (let i = 0; i < this.instanceCount; i++) {
      boundsMatrix.fromArray(this.instanceMatrix.array, i * 16);
      this.boundingSphere.union(
        transformedBounds
          .copy(this.geometry.boundingSphere)
          .applyMatrix4(boundsMatrix),
      );
    }
  }
}
