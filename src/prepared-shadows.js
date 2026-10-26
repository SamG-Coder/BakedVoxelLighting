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

// With inactive-light shadows skipped, a cube map can be sampled long before
// its first shadow draw. Allocate the render attachment before shader bindings
// capture it; otherwise the first draw replaces/destroys the sampled GPU image.
export class ResidentPointShadow extends PointShadowNode {
  setupRenderTarget(shadow, builder) {
    const result = super.setupRenderTarget(shadow, builder);
    builder.renderer.initRenderTarget(result.shadowMap);
    return result;
  }
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
      material.colorNode = N.vec4(0, 0, 0, 1);
      material.opacityNode =
        source.opacityNode ||
        (source.map ? N.texture(source.map).a : N.float(1));
      material.alphaTest = source.alphaTest;
      material.userData.fade = source.userData.fade;
      this.materials.set(source, material);
      source.addEventListener("dispose", () => material.dispose());
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
  async prepare(renderer, object, scene) {
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
        );
        this.prepared.set(mesh, material);
        this.stats.prepared++;
      } finally {
        this.stats.pending--;
      }
    }
  }
}
