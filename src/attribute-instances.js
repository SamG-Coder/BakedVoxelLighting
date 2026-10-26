import * as T from "three/webgpu";
import * as N from "three/tsl";

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
  constructor(source, material, capacity) {
    const geometry = new T.InstancedBufferGeometry();
    geometry.index = source.index;
    for (const [name, attribute] of Object.entries(source.attributes))
      geometry.setAttribute(name, attribute);
    super(geometry, material);
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
    const base = new T.Sphere(),
      matrix = new T.Matrix4(),
      sphere = new T.Sphere();
    if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
    base.copy(this.geometry.boundingSphere);
    this.boundingSphere = new T.Sphere().makeEmpty();
    for (let i = 0; i < this.instanceCount; i++) {
      matrix.fromArray(this.instanceMatrix.array, i * 16);
      this.boundingSphere.union(sphere.copy(base).applyMatrix4(matrix));
    }
  }
}
