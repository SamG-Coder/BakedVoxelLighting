import {
  ShadowNode,
  PointShadowNode,
  NodeMaterial,
  FrontSide,
  BackSide,
  DoubleSide,
  NoBlending,
} from "three/webgpu";
import * as N from "three/tsl";
import { prepareForRender } from "./renderer-jobs.js";

// Material instances may differ only in their fade uniforms. Recreating these
// equivalent nodes per material prevents sharing of the depth shader graph.
const depthColour = N.vec4(0, 0, 0, 1);
const opaque = N.float(1);
const alphaNodes = new WeakMap();
function depthOpacity(source) {
  if (source.opacityNode) return source.opacityNode;
  if (!source.map) return opaque;
  let node = alphaNodes.get(source.map);
  if (!node) alphaNodes.set(source.map, (node = N.texture(source.map).a));
  return node;
}

// With inactive-light shadows skipped, a cube map can be sampled long before
// its first shadow draw. Allocate the render attachment before shader bindings
// capture it; otherwise the first draw replaces/destroys the sampled GPU image.
export class ResidentPointShadow extends PointShadowNode {
  constructor(light) {
    super(light);
    this.useCasterList = true;
    this.casterRoots = [];
  }
  setupRenderTarget(shadow, builder) {
    const result = super.setupRenderTarget(shadow, builder);
    builder.renderer.initRenderTarget(result.shadowMap);
    return result;
  }
  renderShadow(frame) {
    if (!this.useCasterList) return super.renderShadow(frame);
    const scene = frame.scene;
    const children = scene.children;
    collectShadowRoots(scene, this.casterRoots);
    // Six cube faces were traversing every non-casting grass/terrain/sky object.
    // Use the same objects, parents, world matrices, materials and scene identity;
    // only the roots submitted to the six shadow traversals are narrowed.
    scene.children = this.casterRoots;
    try {
      super.renderShadow(frame);
    } finally {
      scene.children = children;
      this.casterRoots.length = 0;
    }
  }
}

export function collectShadowRoots(scene, roots) {
  roots.length = 0;
  const visit = (object) => {
    if (!object.visible) return;
    // Preserve containers whose traversal carries rendering semantics. A caster
    // with children remains intact so its descendants cannot be submitted twice.
    if (
      object.castShadow ||
      object.isLOD ||
      object.isBundleGroup ||
      object.isClippingGroup ||
      (object.isGroup && object.renderOrder !== 0)
    ) {
      roots.push(object);
      return;
    }
    for (const child of object.children) visit(child);
  };
  if (scene.visible) for (const child of scene.children) visit(child);
  return roots;
}

// Stable, minimal depth materials avoid the shared override material being rebuilt
// synchronously for each newly encountered tree material in Three's shadow pass.
export class PreparedSunShadow extends ShadowNode {
  constructor(light) {
    super(light);
    this.materials = new WeakMap();
    this.prepared = new WeakMap();
    this.stats = { prepared: 0, pending: 0 };
  }
  materialFor(source) {
    let material = this.materials.get(source);
    if (Array.isArray(source)) {
      if (!material) {
        material = source.map((m) => this.materialFor(m));
        this.materials.set(source, material);
      }
      return material;
    }
    if (!material) {
      material = new NodeMaterial();
      material.name = "Prepared vegetation depth";
      material.isShadowPassMaterial = true;
      material.allowOverride = false;
      material.blending = NoBlending;
      material.fog = false;
      material.toneMapped = false;
      material.side =
        source.shadowSide ??
        (source.side === DoubleSide
          ? DoubleSide
          : source.side === FrontSide
            ? BackSide
            : FrontSide);
      material.positionNode =
        source.castShadowPositionNode || source.positionNode;
      material.maskNode = source.maskShadowNode || source.maskNode;
      material.colorNode = depthColour;
      material.opacityNode = depthOpacity(source);
      material.alphaTest = source.alphaTest;
      material.userData.fade = source.userData.fade;
      this.materials.set(source, material);
      const dispose = () => {
        material.dispose();
        this.materials.delete(source);
        source.removeEventListener("dispose", dispose);
      };
      source.addEventListener("dispose", dispose);
    }
    return material;
  }
  getShadowRenderObjectFunction(renderer) {
    return (
      object,
      scene,
      camera,
      geometry,
      source,
      group,
      lights,
      clipping,
      passId,
    ) => {
      if (!object.castShadow) return;
      const material = this.materialFor(source);
      object.onBeforeShadow(
        renderer,
        object,
        camera,
        this.shadow.camera,
        geometry,
        material,
        group,
      );
      renderer.renderObject(
        object,
        scene,
        camera,
        geometry,
        material,
        group,
        lights,
        clipping,
        passId,
      );
      object.onAfterShadow(
        renderer,
        object,
        camera,
        this.shadow.camera,
        geometry,
        material,
        group,
      );
    };
  }
  async prepare(renderer, object, scene, priority = () => 1000) {
    if (!this.shadowMap) return;
    this.shadow.updateMatrices(this.light);
    const meshes = [];
    object.traverseVisible((mesh) => {
      if (mesh.isMesh && mesh.castShadow) meshes.push(mesh);
    });
    // An unpublished LOD's root can be invisible; prepare its children explicitly.
    if (!object.visible)
      object.traverse((mesh) => {
        if (mesh.isMesh && mesh.castShadow && !meshes.includes(mesh))
          meshes.push(mesh);
      });
    for (const mesh of meshes) {
      if (!Number.isFinite(priority())) return;
      const material = this.materialFor(mesh.material);
      if (this.prepared.get(mesh) === material) continue;
      this.stats.pending++;
      try {
        await prepareForRender(
          renderer,
          mesh,
          this.shadow.camera,
          scene,
          this.shadowMap,
          material,
          2,
          priority,
        );
        if (!Number.isFinite(priority())) return;
        this.prepared.set(mesh, material);
        this.stats.prepared++;
      } finally {
        this.stats.pending--;
      }
    }
  }
}
