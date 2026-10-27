import { prepareAtlasMips } from "./atlas-mips.js";
import { shareAtlasBase } from "./atlas-storage.js";
import * as N from "three/tsl";
import { readPixels } from "./tsl-baking.js";
import { billboardTSL, grassAtlasUV } from "./tsl-materials.js";
import * as T from "three/webgpu";
import { AttributeInstances } from "./attribute-instances.js";
import { decorate, fadeMaterial } from "./lighting.js";
export async function captureSurface(
  renderer,
  object,
  center,
  width,
  height,
  size,
  views,
  cache,
  key,
  options = {},
) {
  let record = await cache.get(key);
  if (!record) {
    const originalParent = object.parent,
      wasVisible = object.visible,
      scene = new T.Scene();
    object.visible = true;
    scene.add(object);
    const saved = [];
    object.traverse((o) => {
      if (o.isMesh) saved.push([o, o.material]);
    });
    const mossPayload = saved.some(([, material]) => material.userData.moss);
    const camera = new T.OrthographicCamera(
        -width / 2,
        width / 2,
        height / 2,
        -height / 2,
        0.1,
        2000,
      ),
      target = new T.RenderTarget(size * views, size, {
        depthBuffer: true,
      });
    const old = renderer.getRenderTarget(),
      clear = renderer.getClearColor(new T.Color()),
      alpha = renderer.getClearAlpha(),
      tone = renderer.toneMapping,
      autoClear = renderer.autoClear;
    renderer.setClearColor(0, 0);
    renderer.toneMapping = T.NoToneMapping;
    const output = [];
    try {
      for (let pass = 0; pass < 2; pass++) {
        const materials = new Map();
        for (const [mesh, original] of saved) {
          let m = materials.get(original);
          if (!m) {
            m = new T.MeshBasicNodeMaterial();
            m.map = original.map;
            m.color.copy(original.color);
            m.alphaTest = original.alphaTest;
            m.side = original.side;
            m.toneMapped = false;
            const sourceUV = original.userData.grassAtlas
              ? grassAtlasUV(original.userData.grassAtlas)
              : N.uv();
            const alpha = original.map
              ? N.texture(original.map, sourceUV).a
              : N.float(1);
            const colour = original.map
              ? N.texture(original.map, sourceUV).rgb.mul(
                  N.vec3(original.color.r, original.color.g, original.color.b),
                )
              : N.vec3(original.color.r, original.color.g, original.color.b);
            // Reuse represented grass normals and curved leaf normals during capture.
            const viewNormal =
              original.normalNode ||
              (original.normalMap
                ? N.normalMap(
                    N.texture(original.normalMap),
                    N.vec2(original.normalScale.x, original.normalScale.y),
                  )
                : N.normalViewGeometry);
            const worldNormal = N.cameraWorldMatrix
              .mul(N.vec4(viewNormal, 0))
              .xyz.normalize();
            if (pass === 0) {
              m.fragmentNode = N.Fn(() => {
                N.If(alpha.lessThanEqual(original.alphaTest || 0), () =>
                  N.Discard(),
                );
                let rgb = colour; // Moss potential is stored independently for habitat-aware relighting.
                if (
                  original.vertexColors &&
                  mesh.geometry.hasAttribute("color")
                )
                  rgb = rgb.mul(N.attribute("color", "vec3"));
                if (mesh.instanceColor) rgb = rgb.mul(N.instanceColor.rgb);
                return N.vec4(rgb, options.topDown ? 1 : alpha);
              })();
            } else {
              // Normals are data: instance/vertex tint must never multiply them.
              m.fragmentNode = N.Fn(() => {
                N.If(alpha.lessThanEqual(original.alphaTest || 0), () => {
                  N.Discard();
                });
                return N.vec4(
                  worldNormal.mul(0.5).add(0.5),
                  mossPayload
                    ? original.userData.moss
                      ? N.attribute("moss", "float")
                      : N.float(0)
                    : options.topDown
                      ? 1
                      : alpha,
                );
              })();
            }
            materials.set(original, m);
          }
          mesh.material = m;
        }
        renderer.setRenderTarget(target);
        target.scissorTest = false;
        target.viewport.set(0, 0, size * views, size);
        target.scissor.set(0, 0, size * views, size);
        renderer.clear();
        renderer.autoClear = false;
        target.scissorTest = true;
        for (let i = 0; i < views; i++) {
          const a = (i / views) * Math.PI * 2;
          if (options.topDown) {
            camera.up.set(0, 0, -1);
            camera.position.copy(center).add(new T.Vector3(0, 800, 0));
          } else
            camera.position.set(
              center.x + Math.sin(a) * 800,
              center.y,
              center.z + Math.cos(a) * 800,
            );
          camera.lookAt(center);
          target.viewport.set(i * size, 0, size, size);
          target.scissor.set(i * size, 0, size, size);
          renderer.render(scene, camera);
        }
        const data = new Uint8Array(size * size * views * 4);
        await readPixels(renderer, target, 0, 0, size * views, size, data);
        output.push(data);
        materials.forEach((m) => m.dispose());
      }
      record = {
        mossPayload,
        data: output[0],
        normals: output[1],
        w: size * views,
        h: size,
        views,
        width,
        height,
        topDown: !!options.topDown,
        grassPatch: !!options.grassPatch,
        centerY: center.y,
        cutoff: options.topDown ? 0 : 82,
      };
      record.mips = await prepareAtlasMips(record);
      shareAtlasBase(record);
      await cache.put(key, record);
    } finally {
      for (const [mesh, m] of saved) mesh.material = m;
      scene.remove(object);
      if (originalParent) originalParent.add(object);
      object.visible = wasVisible;
      renderer.setScissorTest(false);
      renderer.setRenderTarget(old);
      renderer.setViewport(
        0,
        0,
        renderer.domElement.width,
        renderer.domElement.height,
      );
      renderer.setClearColor(clear, alpha);
      renderer.toneMapping = tone;
      renderer.autoClear = autoClear;
      target.dispose();
    }
  }
  shareAtlasBase(record);
  const texture = new T.DataTexture(
      record.data,
      record.w,
      record.h,
      T.RGBAFormat,
    ),
    normal = new T.DataTexture(
      record.normals,
      record.w,
      record.h,
      T.RGBAFormat,
    );
  for (const t of [texture, normal]) {
    t.magFilter = T.LinearFilter;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.generateMipmaps = false;
    t.mipmaps = record.mips.map((level) => ({
      data: t === texture ? level.data : level.normals,
      width: level.width,
      height: level.height,
    }));
    t.needsUpdate = true;
  }
  texture.colorSpace = T.LinearSRGBColorSpace;
  return { texture, normal, record };
}
const atlasTemplates = new WeakMap();
export function atlasMaterial(atlas, transmission = 0.32) {
  const existing = atlasTemplates.get(atlas);
  if (existing) return fadeMaterial(existing.clone());
  const material = decorate(
    new T.MeshStandardMaterial({
      map: atlas.texture,
      normalMap: atlas.normal,
      normalScale: new T.Vector2(1, 1),
      alphaTest: 0.32,
      alphaToCoverage: true,
      side: T.DoubleSide,
      roughness: 1,
    }),
    { transmission, grass: transmission > 0.4 },
  );
  billboardTSL(material, atlas.record);
  atlasTemplates.set(atlas, material);

  return material;
}
export function instanced(geometry, material, transforms, shared = true) {
  const mesh = new AttributeInstances(
      geometry,
      material,
      transforms.length,
      shared,
    ),
    dummy = new T.Object3D();
  transforms.forEach((t, i) => {
    dummy.position.set(...t.p);
    dummy.rotation.set(...(t.r || [0, 0, 0]));
    dummy.scale.set(...(t.s || [1, 1, 1]));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (t.c) mesh.setColorAt(i, new T.Color(t.c));
    if (t.colour) mesh.setColorAt(i, new T.Color().setRGB(...t.colour));
  });
  mesh.computeBoundingSphere();
  return mesh;
}
export function surfaceBillboards(atlas, transforms, transmission = 0.32) {
  const mesh = instanced(
    new T.PlaneGeometry(atlas.record.width, atlas.record.height),
    atlasMaterial(atlas, transmission),
    transforms,
    false,
  );
  mesh.userData.ownedGeometry = true;
  return mesh;
}
