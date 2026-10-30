import { MeshStandardNodeMaterial, PhysicalLightingModel } from "three/webgpu";
import * as N from "three/tsl";

// A thin leaf transmits part of incident light to the opposite hemisphere.
// Preserve Three's BRDF/specular path; add a bounded, shadowed back response.
// This uses the represented blade/leaf normal, never the billboard plane normal.
class FoliageLightingModel extends PhysicalLightingModel {
  constructor(transmission) {
    super();
    this.transmission = transmission;
  }
  direct(input, builder) {
    super.direct(input, builder);
    if (!this.transmission) return;
    const amount = this.transmission.clamp(0, 0.45);
    const wrap = 0.25;
    const back = N.normalView
      .dot(input.lightDirection)
      .negate()
      .add(wrap)
      .clamp()
      .div((1 + wrap) ** 2);
    const energy = N.float(1)
      .sub(N.specularColor.max(N.vec3(0)).dot(N.vec3(1 / 3)))
      .clamp();
    input.reflectedLight.directDiffuse.addAssign(
      N.diffuseColor.rgb
        .mul(amount)
        .mul(back)
        .mul(energy)
        .mul(input.lightColor)
        .mul(1 / Math.PI),
    );
  }
}
export class FoliageMaterial extends MeshStandardNodeMaterial {
  constructor(parameters) {
    super(parameters);
    this.foliageTransmissionNode = null;
  }
  setupLightingModel() {
    return new FoliageLightingModel(this.foliageTransmissionNode);
  }
  copy(source) {
    super.copy(source);
    this.foliageTransmissionNode = source.foliageTransmissionNode;
    return this;
  }
}
