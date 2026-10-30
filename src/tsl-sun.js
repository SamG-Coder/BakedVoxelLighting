import { cloudAt, CLOUD_SHADOW_STRENGTH } from "./clouds.js";
import { DirectionalLight, DirectionalLightNode } from "three/webgpu";
import * as N from "three/tsl";
import {
  sampleVolume,
  sampleRadiance,
  distantSkyVisibility,
} from "./tsl-materials.js";
import { ref } from "./tsl-baking.js";
export class VoxelSun extends DirectionalLight {}
export class VoxelMoon extends DirectionalLight {}
export function installVoxelSun(renderer, uniforms) {
  class VoxelSunNode extends DirectionalLightNode {
    static get type() {
      return "VoxelSunNode";
    }
    setupDirect(builder) {
      const direct = super.setupDirect(builder);
      if (builder.material.userData.shading) {
        const visibility = sampleRadiance(
          uniforms,
          N.positionWorld.add(N.vec3(0, 1.2, 0)),
        ).a;
        const baked = N.mix(1, visibility, ref(uniforms, "bakedEnabled"));
        // Both representations contain the same trees. Multiplication squares
        // partial visibility and turns dappled shade into a dark blanket.
        // Keep the more occluded representation without counting it twice.
        const mapped =
          builder.object.receiveShadow &&
          builder.renderer.shadowMap.enabled &&
          this.shadowNode;
        direct.lightColor = mapped
          ? this.baseColorNode.mul(N.min(this.shadowNode, baked))
          : direct.lightColor.mul(baked);
      }
      direct.lightColor = direct.lightColor.mul(
        N.float(1).sub(
          cloudAt(
            uniforms,
            N.positionWorld,
            ref(uniforms, "liveSunDirection", "vec3"),
          ).mul(CLOUD_SHADOW_STRENGTH),
        ),
      );
      return direct;
    }
  }
  class VoxelMoonNode extends DirectionalLightNode {
    static get type() {
      return "VoxelMoonNode";
    }
    setupDirect(builder) {
      const direct = super.setupDirect(builder);
      const sky = sampleVolume(
        uniforms,
        "directionAtlas",
        N.positionWorld,
        N.vec4(0.5, 1, 0.5, distantSkyVisibility(uniforms, N.positionWorld)),
      ).a;
      const cloud = cloudAt(
        uniforms,
        N.positionWorld,
        ref(uniforms, "liveMoonDirection", "vec3"),
      );
      direct.lightColor = direct.lightColor
        .mul(N.mix(1, sky, ref(uniforms, "bakedEnabled")))
        .mul(N.float(1).sub(cloud.mul(CLOUD_SHADOW_STRENGTH)));
      return direct;
    }
  }
  VoxelSun.registerNode(VoxelSunNode);
  VoxelMoon.registerNode(VoxelMoonNode);
}
