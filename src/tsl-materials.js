import { GRASS_MIXES } from "./plant-catalog.js";
import { cloudAt, CLOUD_SHADOW_STRENGTH } from "./clouds.js";
import * as K from "./native-kernels.js";
import * as T from "three/webgpu";
import * as N from "three/tsl";
import { ref, texRef, terrainNode } from "./tsl-baking.js";
const matrices = new WeakMap();
const instanceMatrix = N.Fn((builder) => {
  const source = builder.object.instanceMatrix;
  if (!source) return N.mat4(1);
  let node = matrices.get(source);
  if (!node) {
    const buffer = new T.InstancedInterleavedBuffer(source.array, 16, 1);
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
export const grassAtlasUV = (count) =>
  N.varying(
    N.vec2(
      N.uv()
        .x.mul(1 - 2 / 1024)
        .add(1 / 1024)
        .add(N.attribute("plantType", "float"))
        .div(count),
      N.uv().y,
    ),
  );
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
    fallback: N.vec4(...fallback),
    flipY,
  });
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
  if (!material.userData.surfaceMask)
    material.maskNode =
      material.map && material.alphaTest > 0
        ? fadeMask.and(
            (material.opacityNode || N.texture(material.map).a).greaterThan(
              N.float(material.alphaTest),
            ),
          )
        : fadeMask;
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
  const {
    wind = 0,
    ground = false,
    fade = true,
    transmission = 0,
    grass = false,
    grassAtlas = 0,
    moss = false,
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
  m.userData.shading = { wind, ground, transmission, grass };
  m.userData.grassAtlas = grassAtlas;
  if (wind)
    m.positionNode = N.Fn((builder) => {
      const id = builder.object.isInstancedMesh
        ? N.float(N.instanceIndex)
        : N.float(0);
      const anchor = builder.object.isInstancedMesh
        ? N.modelWorldMatrix.mul(instanceMatrix().element(3)).xyz
        : N.modelWorldMatrix.element(3).xyz;
      return K.windPosition({
        p: N.positionLocal,
        t: ref(U, "time"),
        id,
        anchor,
        y: N.positionGeometry.y,
        v: N.uv().y,
        strength: N.float(wind),
      });
    })();
  if (moss) {
    m.colorNode = K.mossSurface({
      bark: N.materialColor,
      uv: N.uv(),
      coverage: N.attribute("moss", "float"),
    });
    m.userData.moss = true;
  }
  let groundFade = N.float(0);
  let base = N.materialColor;
  if (ground) {
    const p = N.positionWorld,
      land = terrainNode(U.terrainField.value, p.xz, grid),
      guv = p.xz.mul(0.72);
    const soil = N.texture(m.map, guv).setUpdateMatrix(false).rgb,
      lush = N.mix(
        texRef(U, "groundMap").sample(guv).setUpdateMatrix(false).rgb,
        texRef(U, "groundMap")
          .sample(N.vec2(guv.y.negate(), guv.x).mul(0.73).add(17.31))
          .setUpdateMatrix(false).rgb,
        0.3,
      ),
      // The baked dry habitat carries its actual seed-grass textures. Reuse
      // the fine ground detail underneath it to stay within 16 GPU samplers.
      dry = lush.mul(N.vec3(1.12, 0.94, 0.78));

    const root = texRef(U, "rootField").sample(
      p.xz
        .add(2000)
        .div(4000)
        .mul(grid - 1)
        .add(0.5)
        .div(grid),
    ).r;
    const stone = texRef(U, "rockMap")
      .sample(guv.mul(0.5))
      .setUpdateMatrix(false).rgb;
    const cover = texRef(U, "grassGround").sample(p.xz.add(2000).div(4000));
    const habitat = texRef(U, "grassHabitat").sample(p.xz.add(2000).div(4000));
    const tiled = N.fract(N.vec2(p.x, p.z.negate()).div(4));
    // Half a texel of inset isolates habitats in every generated mip level.
    const patchUV = (k) =>
      N.vec2(
        tiled.x
          .mul(1 - 2 / 512)
          .add(1 / 512 + k)
          .div(GRASS_MIXES.length),
        tiled.y.mul(1 - 2 / 512).add(1 / 512),
      );
    let forestFloor = N.vec3(0);
    let surface = N.vec3(0),
      mean = N.vec3(0),
      normal = N.vec3(0);
    for (let k = 0; k < GRASS_MIXES.length; k++) {
      const weight = habitat.element(k),
        map = texRef(U, "grassSurface");
      if (k === 3)
        forestFloor = map.sample(patchUV(k)).setUpdateMatrix(false).rgb;
      surface = surface.add(
        map.sample(patchUV(k)).setUpdateMatrix(false).rgb.mul(weight),
      );
      mean = mean.add(
        map
          .sample(N.vec2((k + 0.5) / GRASS_MIXES.length, 0.5))
          .level(9)
          .rgb.mul(weight),
      );
      normal = normal.add(
        texRef(U, "grassSurfaceNormal")
          .sample(patchUV(k))
          .rgb.mul(2)
          .sub(1)
          .mul(weight),
      );
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
      root,
      cover,
      surface,
      mean,
      forestFloor,
      woodland: habitat.a,
    });
    m.normalNode = N.normalMap(
      N.texture(m.normalMap, guv).setUpdateMatrix(false),
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
  }
  if (grass) {
    const uv = grassAtlas ? grassAtlasUV(grassAtlas) : N.uv();
    if (grassAtlas) {
      const tex = N.texture(m.map, uv);
      m.colorNode = tex.rgb;
      m.opacityNode = tex.a;
      m.maskNode = tex.a.greaterThan(m.alphaTest);
    }
    const detail = N.texture(m.normalMap, uv).xyz.mul(2).sub(1);
    const wn = K.grassNormal({ detail, yaw: yawNode() });
    m.normalNode = N.normalize(N.cameraViewMatrix.mul(N.vec4(wn, 0)).xyz);
  }
  const bake = (p) => sampleVolume(U, "bakedAtlas", p, [0.12, 0.16, 0.2, 1]);
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
    thin: ground ? groundFade.mul(0.26) : N.float(thin),
    daylight: ref(U, "daylight"),
    sunColour: ref(U, "sunColour", "vec3"),
  });
  m.emissiveNode = N.diffuseColor.rgb.mul(extra);
  return fade ? fadeTSL(m) : m;
}
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
    if (merged) return data.xyz.add(rotate(N.vec3(p.x, p.y, 0), angle));
    const mat = instanceMatrix();
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
  // Standard materialColor samples map at its ordinary UV. Explicitly bind both
  // albedo and emissive sampling to the selected atlas frame.
  m.emissiveNode = m.emissiveNode.context({ getUV: () => atlasUV });
  m.userData.surfaceMask = true;
  m.userData.billboard = { views: count, rows, normalSpace: "source-world" };
  return m;
}
