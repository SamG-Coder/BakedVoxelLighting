import { GRASS_MIXES } from "./plant-catalog.js";
import { worldHabitat, worldSunVisibility } from "./world-light.js";
import { cloudAt, CLOUD_SHADOW_STRENGTH } from "./clouds.js";
import * as K from "./native-kernels.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";
import { ref, texRef, terrainNode } from "./tsl-baking.js";
import { attributeInstanceMatrix } from "./attribute-instances.js";
import { rootConformPosition } from "./root-conform.js";
import {
  surfaceCoordinates,
  variedSurface,
  atlasSurfaceCoordinates,
} from "./surface-variation.js";
const matrices = new WeakMap();
const instanceMatrix = N.Fn((builder) => {
  if (builder.object.isAttributeInstances) return attributeInstanceMatrix();
  const source = builder.object.instanceMatrix;
  if (!source) return N.mat4(1);
  let node = matrices.get(source);
  if (!node) {
    const buffer = new T.InstancedInterleavedBuffer(source.array, 16, 1);
    // Pooled tiles keep the same arrays but replace their contents.
    N.OnBeforeFrameUpdate(() => {
      buffer.version = source.version;
    });
    node = N.mat4(
      ...[0, 4, 8, 12].map((offset) =>
        N.instancedBufferAttribute(buffer, "vec4", 16, offset),
      ),
    );
    matrices.set(source, node);
  }
  return node;
});
const yawNode = () =>
  N.varying(
    N.Fn(() => {
      const m = instanceMatrix();
      return N.atan(m.element(0).z.negate(), m.element(0).x);
    })(),
  );
const rotate = (v, a) => K.rotatePlant({ v, a });
const grassMirror = () =>
  N.varying(
    N.Fn(() => {
      // Height is stable through thinning and periodic copies used by the bake.
      const seed = N.length(instanceMatrix().element(1).xyz);
      return N.step(0.5, N.fract(N.sin(seed.mul(127.1)).mul(43758.5453)))
        .mul(2)
        .sub(1);
    })(),
  );
export const grassAtlasUV = (count, mirror = grassMirror()) => {
  const columns = Math.min(4, count),
    rows = Math.ceil(count / columns);
  const type = N.attribute("plantType", "float");
  return N.varying(
    N.vec2(
      N.uv()
        .x.sub(0.5)
        .mul(mirror)
        .add(0.5)
        .mul(1 - 2 / 1024)
        .add(1 / 1024)
        .add(type.mod(columns))
        .div(columns),
      N.uv()
        .y.mul(1 - 2 / 1024)
        .add(1 / 1024)
        .add(type.div(columns).floor())
        .div(rows),
    ),
  );
};
export function sampleVolume(U, name, p, fallback) {
  const map = texRef(U, name);
  const flipY = N.uniform(0).onRenderUpdate(() =>
    U[name].value?.isRenderTargetTexture ? 1 : 0,
  );
  return K.sampleAtlas({
    map,
    linearSampler: N.sampler(map),
    p,
    origin: ref(U, "volumeMin", "vec3"),
    extent: ref(U, "volumeSize", "vec3"),
    dims: ref(U, "bakeDims", "vec3"),
    fallback: Array.isArray(fallback) ? N.vec4(...fallback) : fallback,
    flipY,
  });
}
// Whole-world canopy data remains available beyond the streamed voxel box.
// Match the radiance bake's sky/day response instead of returning daytime RGB.
export function distantSkyVisibility(U, p) {
  return worldHabitat(U, p).a;
}
export function distantRadiance(U, p) {
  const sky = distantSkyVisibility(U, p);
  const ambient = N.vec3(0.085, 0.115, 0.16).mul(sky.mul(0.85).add(0.15));
  const bounce = N.mix(
    N.vec3(0.02, 0.014, 0.008),
    N.vec3(0.012, 0.023, 0.008),
    worldHabitat(U, p).r,
  )
    .mul(N.float(1).sub(sky))
    .mul(ref(U, "sunColour", "vec3"))
    .mul(0.8);
  return N.vec4(
    // Daylight fill comes from sky visibility; retain the previous night floor.
    ambient
      .add(bounce)
      .mul(ref(U, "daylight"))
      .add(
        N.vec3(0.035, 0.055, 0.085)
          .mul(sky.mul(0.85).add(0.15))
          .add(bounce)
          .mul(N.float(1).sub(ref(U, "daylight")).mul(0.04)),
      ),
    worldSunVisibility(U, p),
  );
}
export function sampleRadiance(U, p) {
  return sampleVolume(U, "bakedAtlas", p, distantRadiance(U, p));
}
// Source normal alpha carries a baked thin-material response. Surface atlases
// use signed response: positive = foliage, negative = moss, zero = bare wood.
export function foliageResponse(material, uv = null) {
  const s = material.userData.shading || {};
  if (!material.normalMap || !(s.grass || s.wind || s.transmission))
    return N.float(0);
  const a = N.texture(material.normalMap, uv).a;
  if (s.surfacePayload) return N.max(a.mul(2).sub(1), 0);
  return s.grass
    ? a.mul(N.mix(0.45, 1, N.smoothstep(0.02, 0.65, N.uv().y)))
    : a;
}
const fullFade = new T.Vector2(0, 1);
const fadeRange = N.uniform(fullFade).onObjectUpdate(
  ({ object }) => object.material.userData.fade?.value || fullFade,
);
const fadeMask = K.fadeMask({ p: N.screenCoordinate.xy, range: fadeRange });
export function fadeTSL(material) {
  // Three r186 NodeMaterial.copy skips inherited alphaTest's private backing field.
  // Preserve the cutoff explicitly when cloning shared material templates.
  material.alphaTest = material.userData.alphaCutoff ?? material.alphaTest;
  material.userData.fade = { value: new T.Vector2(0, 1) };
  if (!material.userData.surfaceMask && !material.userData.fadeMaskReady) {
    material.maskNode =
      material.map && material.alphaTest > 0
        ? fadeMask.and(
            (material.opacityNode || N.texture(material.map).a).greaterThan(
              N.float(material.alphaTest),
            ),
          )
        : fadeMask;
    material.userData.fadeMaskReady = true;
  }
  if (material.alphaTest > 0) material.alphaToCoverage = true;
  return material;
}
const templates = new Map();
export function decorateTSL(original, options, U, grid) {
  const key = JSON.stringify([
    original.map?.uuid,
    original.normalMap?.uuid,
    original.normalScale?.toArray(),
    original.side,
    original.alphaTest,
    original.vertexColors,
    options,
  ]);
  let template = templates.get(key);
  if (!template) {
    template = createDecorated(original, { ...options, fade: false }, U, grid);
    templates.set(key, template);
  }
  const m = template.clone();
  m.alphaTest = template.alphaTest;
  m.color.copy(original.color);
  return options.fade === false ? m : fadeTSL(m);
}
function createDecorated(original, options, U, grid) {
  mossEnvironmentUniforms = U;
  const {
    wind = 0,
    ground = false,
    fade = true,
    transmission = 0,
    grass = false,
    grassAtlas = 0,
    moss = false,
    roots = false,
    surfacePayload = false,
  } = options;
  const m = new T.MeshStandardNodeMaterial();
  // Copy standard properties without copying GLSL hooks or changing NodeMaterial's type.
  for (const key of [
    "color",
    "map",
    "normalMap",
    "normalScale",
    "roughness",
    "metalness",
    "side",
    "alphaTest",
    "alphaToCoverage",
    "transparent",
    "opacity",
    "depthWrite",
    "vertexColors",
  ]) {
    if (original[key] !== undefined)
      m[key] =
        original[key]?.clone && !original[key].isTexture
          ? original[key].clone()
          : original[key];
  }
  m.userData.alphaCutoff = m.alphaTest;
  if (m.map && m.alphaTest > 0) {
    m.maskNode = N.texture(m.map).a.greaterThan(N.float(m.alphaTest));
    m.alphaToCoverage = true;
  }
  m.userData.shading = { wind, ground, transmission, grass, surfacePayload };
  m.userData.grassAtlas = grassAtlas;
  const fittedPosition = roots
    ? rootConformPosition(U.terrainField.value, grid, instanceMatrix)
    : N.positionLocal;
  if (wind)
    m.positionNode = N.Fn((builder) => {
      const id =
        builder.object.isInstancedMesh || builder.object.isAttributeInstances
          ? N.float(N.instanceIndex)
          : N.float(0);
      const anchor =
        builder.object.isInstancedMesh || builder.object.isAttributeInstances
          ? N.modelWorldMatrix.mul(instanceMatrix().element(3)).xyz
          : N.modelWorldMatrix.element(3).xyz;
      const inputs = {
        p: fittedPosition,
        t: ref(U, "time"),
        id,
        anchor,
        y: N.positionGeometry.y,
        v: N.uv().y,
        strength: N.float(wind),
      };
      N.positionPrevious.assign(
        K.windPosition({ ...inputs, t: ref(U, "previousTime") }),
      );
      return K.windPosition(inputs);
    })();
  if (roots && !wind)
    m.positionNode = N.Fn(() => {
      N.positionPrevious.assign(fittedPosition);
      return fittedPosition;
    })();
  if (moss) {
    m.colorNode = K.mossSurface({
      bark: N.materialColor,
      coverage: N.attribute("moss", "float"),
      n: N.normalWorld,
      habitat: worldHabitat(U, N.positionWorld).rg,
    });
    m.userData.moss = true;
  }
  let groundFade = N.float(0);
  let groundResponse = N.float(0);
  let base = N.materialColor;
  if (ground) {
    const p = N.positionWorld,
      land = terrainNode(U.terrainField.value, p.xz, grid),
      guv = p.xz.mul(0.72);
    const coordinates = surfaceCoordinates(guv, p.xz);
    const soil = variedSurface(N.texture(m.map), coordinates).rgb,
      lush = variedSurface(
        texRef(U, "grassSurface"),
        atlasSurfaceCoordinates(coordinates, 0, GRASS_MIXES.length, 512),
      ).rgb,
      // The baked dry habitat carries its actual seed-grass textures. Reuse
      // the fine ground detail underneath it to stay within 16 GPU samplers.
      dry = lush.mul(N.vec3(1.12, 0.94, 0.78));

    const groundInfluence = texRef(U, "rootField").sample(
      p.xz
        .add(2000)
        .div(4000)
        .mul(grid - 1)
        .add(0.5)
        .div(grid),
    );
    const stone = variedSurface(
      texRef(U, "rockMap"),
      surfaceCoordinates(guv.mul(0.5), p.xz),
    ).rgb;
    const cover = texRef(U, "grassGround").sample(p.xz.add(2000).div(4000));
    const habitat = texRef(U, "grassHabitat").sample(p.xz.add(2000).div(4000));
    const patchCoordinates = surfaceCoordinates(
      N.vec2(p.x, p.z.negate()).div(4),
      p.xz,
    );
    let forestFloor = N.vec3(0);
    let surface = N.vec3(0),
      mean = N.vec3(0),
      normal = N.vec3(0);
    for (let k = 0; k < GRASS_MIXES.length; k++) {
      const weight = habitat.element(k),
        map = texRef(U, "grassSurface");
      const patch = atlasSurfaceCoordinates(
        patchCoordinates,
        k,
        GRASS_MIXES.length,
        512,
      );
      const patchColour = variedSurface(map, patch).rgb;
      const patchNormal = variedSurface(texRef(U, "grassSurfaceNormal"), patch);
      groundResponse = groundResponse.add(
        N.max(patchNormal.a.mul(2).sub(1), 0).mul(weight),
      );
      if (k === 3) forestFloor = patchColour;
      surface = surface.add(patchColour.mul(weight));
      mean = mean.add(
        map
          .sample(N.vec2((k + 0.5) / GRASS_MIXES.length, 0.5))
          .level(9)
          .rgb.mul(weight),
      );
      normal = normal.add(patchNormal.rgb.mul(2).sub(1).mul(weight));
    }
    groundFade = N.smoothstep(90, 300, N.distance(N.cameraPosition, p));
    m.colorNode = K.groundBlend({
      p,
      camera: N.cameraPosition,
      land,
      soil,
      lush,
      dry,
      stone,
      root: groundInfluence.r,
      bank: groundInfluence.ba,
      cover,
      surface,
      mean,
      forestFloor,
      woodland: habitat.a,
    });
    m.normalNode = N.normalMap(
      variedSurface(N.texture(m.normalMap), coordinates),
      N.vec2(m.normalScale.x, m.normalScale.y),
    );
    const canopy = normal.normalize();
    const canopyView = N.cameraViewMatrix
      .mul(N.vec4(canopy, 0))
      .xyz.normalize();
    m.normalNode = N.normalize(
      N.mix(m.normalNode, canopyView, groundFade.mul(cover.a).mul(0.85)),
    );
    base = m.colorNode;
    // Damp river sediment and compacted paths reflect differently from litter.
    m.roughnessNode = N.mix(
      0.96,
      0.67,
      groundInfluence.b.mul(N.float(1).sub(groundInfluence.a)),
    );
  }
  if (grass) {
    const mirror = grassAtlas ? grassMirror() : N.float(1);
    const uv = grassAtlas ? grassAtlasUV(grassAtlas, mirror) : N.uv();
    if (grassAtlas) {
      const tex = N.texture(m.map, uv);
      m.colorNode = tex.rgb;
      m.opacityNode = tex.a;
      m.maskNode = tex.a.greaterThan(m.alphaTest);
    }
    const detail = N.texture(m.normalMap, uv)
      .xyz.mul(2)
      .sub(1)
      .mul(N.vec3(mirror, 1, 1));
    const wn = K.grassNormal({ detail, yaw: yawNode() });
    m.normalNode = N.normalize(N.cameraViewMatrix.mul(N.vec4(wn, 0)).xyz);
    // The crossed cards carry a volume of blades; they are not two solid
    // vertical walls. Receive external shadows at the tuft's upper envelope
    // instead of letting one carrier slice a black stripe across the other.
    // Casting is unchanged, so the grass still shades the soil underneath.
    const tuftHeight = N.varying(
      N.length(N.modelWorldMatrix.mul(instanceMatrix().element(1)).xyz),
    );
    const lift = tuftHeight.mul(N.float(1).sub(N.uv().y).mul(0.95)).add(0.06);
    m.receivedShadowPositionNode = N.positionWorld.add(N.vec3(0, lift, 0));
    // Retain gentle root occlusion without a directional card-shaped seam.
    m.aoNode = N.mix(0.8, 1, N.smoothstep(0.02, 0.7, N.uv().y));
  }
  const bake = (p) => sampleRadiance(U, p);
  const bent = sampleVolume(
    U,
    "directionAtlas",
    N.positionWorld,
    [0.5, 1, 0.5, 1],
  )
    .rgb.mul(2)
    .sub(1)
    .normalize();
  const indirect = bake(
    N.positionWorld.add(N.normalWorld.mul(grass ? 0.15 : 1.1)),
  ).rgb;
  const thin = transmission || (grass ? 0.26 : wind > 0 ? 0.32 : 0);
  const responseUV = grassAtlas
    ? grassAtlasUV(grassAtlas, grassMirror())
    : null;
  const response = foliageResponse(m, responseUV);
  if (thin) {
    m.roughnessNode = N.mix(0.94, grass ? 0.8 : 0.68, response);
    if (!grass) m.aoNode = N.mix(0.86, 1, response);
  }
  const extra = K.foliageRadiance({
    n: N.normalWorld,
    indirect,
    bent,
    enabled: ref(U, "bakedEnabled"),
    sun: ref(U, "liveSunDirection", "vec3"),
    visibility: bake(N.positionWorld).a.mul(
      N.float(1).sub(
        cloudAt(U, N.positionWorld, ref(U, "liveSunDirection", "vec3")).mul(
          CLOUD_SHADOW_STRENGTH,
        ),
      ),
    ),
    lamp: ref(U, "liveLampPosition", "vec3").sub(N.positionWorld),
    power: ref(U, "liveLampPower"),
    lampColour: ref(U, "liveLampColour", "vec3"),
    thin: ground
      ? groundFade.mul(0.48).mul(groundResponse)
      : N.float(thin * 1.65).mul(response),
    daylight: ref(U, "daylight"),
    sunColour: ref(U, "sunColour", "vec3"),
  });
  m.emissiveNode = N.diffuseColor.rgb.mul(extra);
  return fade ? fadeTSL(m) : m;
}
let mossEnvironmentUniforms;
export function billboardTSL(m, atlas, merged = false) {
  const count = atlas.views,
    rows = atlas.rows || 1;
  const data = N.Fn(() => {
    if (merged)
      return N.vec4(
        N.attribute("plantCenter", "vec3"),
        N.attribute("plantInfo", "vec2").x,
      );
    const matrix = instanceMatrix(),
      center = N.modelWorldMatrix.mul(matrix.element(3)).xyz;
    return N.vec4(
      center,
      N.atan(matrix.element(0).z.negate(), matrix.element(0).x),
    );
  })();
  const angle = N.atan(
    N.cameraPosition.x.sub(data.x),
    N.cameraPosition.z.sub(data.z),
  );
  const atlasUV = N.varying(
    K.atlasUV({
      uv: N.uv(),
      angle,
      yaw: data.w,
      views: N.float(count),
      row: merged ? N.attribute("plantInfo", "vec2").y : N.float(0),
      rows: N.float(rows),
    }),
  );
  m.positionNode = N.Fn(() => {
    const p = N.positionGeometry;
    // Keep roots fixed while the last geometric meadow layer settles into its
    // matching canopy surface. This avoids a ring of tall, repeated patch cards.
    const compression = atlas.grassPatch
      ? N.float(1).sub(
          N.smoothstep(110, 300, N.distance(N.cameraPosition, data.xyz)).mul(
            0.78,
          ),
        )
      : N.float(1);
    const y = p.y
      .add(atlas.grassPatch ? atlas.centerY : 0)
      .mul(compression)
      .sub(atlas.grassPatch ? atlas.centerY : 0);
    const previousCamera = ref(
      mossEnvironmentUniforms,
      "previousCameraPosition",
      "vec3",
    );
    const oldAngle = N.atan(
      previousCamera.x.sub(data.x),
      previousCamera.z.sub(data.z),
    );
    const oldCompression = atlas.grassPatch
      ? N.float(1).sub(
          N.smoothstep(110, 300, N.distance(previousCamera, data.xyz)).mul(
            0.78,
          ),
        )
      : N.float(1);
    const oldY = p.y
      .add(atlas.grassPatch ? atlas.centerY : 0)
      .mul(oldCompression)
      .sub(atlas.grassPatch ? atlas.centerY : 0);
    if (merged) {
      N.positionPrevious.assign(
        data.xyz.add(rotate(N.vec3(p.x, p.y, 0), oldAngle)),
      );
      return data.xyz.add(rotate(N.vec3(p.x, p.y, 0), angle));
    }
    const mat = instanceMatrix();
    N.positionPrevious.assign(
      mat.mul(N.vec4(rotate(N.vec3(p.x, oldY, 0), oldAngle.sub(data.w)), 1))
        .xyz,
    );
    return mat.mul(N.vec4(rotate(N.vec3(p.x, y, 0), angle.sub(data.w)), 1)).xyz;
  })();
  const map = N.texture(m.map, atlasUV);
  m.colorNode = map.rgb;
  m.opacityNode = map.a;
  m.maskNode = fadeMask.and(map.a.greaterThan(N.float(m.alphaTest)));
  if (atlas.grassPatch) {
    // A continuous world-space ring, independent of the tile centre. Fade the
    // carrier's lateral edges too so an atlas cannot show a rectangular rim.
    const distanceFade = N.float(1).sub(
      N.smoothstep(210, 300, N.distance(N.cameraPosition, N.positionWorld)),
    );
    const edge = N.smoothstep(
      0,
      0.13,
      N.min(N.uv().x, N.float(1).sub(N.uv().x)),
    );
    m.maskNode = m.maskNode.and(
      K.fadeMask({
        p: N.screenCoordinate.xy.add(N.vec2(37, 91)),
        range: N.vec2(0, distanceFade.mul(edge)),
      }),
    );
  }
  m.alphaToCoverage = true;
  // Atlas normals were captured in source/world space. Rotate only with the plant,
  // never with the card or current view frame.
  const source = N.texture(m.normalMap, atlasUV).xyz.mul(2).sub(1);
  const wn = rotate(source.normalize(), N.varying(data.w));
  m.normalNode = N.normalize(N.cameraViewMatrix.mul(N.vec4(wn, 0)).xyz);
  if (atlas.mossPayload)
    m.colorNode = K.mossSurface({
      bark: map.rgb,
      coverage: N.max(
        N.float(1).sub(N.texture(m.normalMap, atlasUV).a.mul(2)),
        0,
      ),
      n: wn,
      habitat: worldHabitat(mossEnvironmentUniforms, N.positionWorld).rg,
    });
  // Standard materialColor samples map at its ordinary UV. Explicitly bind both
  // albedo and emissive sampling to the selected atlas frame.
  m.emissiveNode = m.emissiveNode.context({ getUV: () => atlasUV });
  m.roughnessNode = m.roughnessNode?.context({ getUV: () => atlasUV });
  m.aoNode = m.aoNode?.context({ getUV: () => atlasUV });
  m.userData.surfaceMask = true;
  m.userData.billboard = { views: count, rows, normalSpace: "source-world" };
  return m;
}
