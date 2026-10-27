import { mergedClusterBounds } from "./merged-data.js";
import { WorkerClient } from "./worker-client.js";
const worker = new WorkerClient(
  new Worker(new URL("./merged-worker.js", import.meta.url), {
    type: "module",
    name: "forest merge",
  }),
  "forest merge",
);
export const mergedWorkerStats = worker.stats;
import { billboardTSL } from "./tsl-materials.js";
import * as T from "three/webgpu";
import { BakeCache } from "./cache.js";
import { decorate, fadeMaterial } from "./lighting.js";
import { replaceLODLevel } from "./vegetation-lod.js";
import { disposeVegetationGroup } from "./vegetation-resources.js";
import { prioritizeArea } from "./streaming-view.js";

const cache = new BakeCache("BakedVoxelLightingMerged");
const ready = cache.open();
const frustum = new T.Frustum(),
  matrix = new T.Matrix4();
export const mergedStats = {
  baked: 0,
  hits: 0,
  visible: 0,
  pending: 0,
  sourceDraws: 0,
  mergedDraws: 0,
  errors: [],
  cancelled: 0,
};
let mergedTemplate = null;
let atlas = null,
  identity = "",
  generation = 0;
const bounds = new WeakMap();
const pending = new Set();

function makeAtlas(prototypes) {
  const first = prototypes[0].farAtlas.record,
    w = first.w,
    h = first.h * prototypes.length;
  const textures = [false, true].map((normalMap) => {
    const t = new T.DataTexture(null, w, h);
    t.magFilter = T.LinearFilter;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.generateMipmaps = false;
    t.mipmaps = first.mips.map((level, lod) => {
      const pixels = new Uint8Array(
        level.width * level.height * prototypes.length * 4,
      );
      prototypes.forEach((p, row) =>
        pixels.set(
          normalMap
            ? p.farAtlas.record.mips[lod].normals
            : p.farAtlas.record.mips[lod].data,
          row * level.width * level.height * 4,
        ),
      );
      return {
        data: pixels,
        width: level.width,
        height: level.height * prototypes.length,
      };
    });
    t.image.data = t.mipmaps[0].data;
    t.needsUpdate = true;
    return t;
  });
  textures[0].colorSpace = T.LinearSRGBColorSpace;
  return {
    textures,
    views: first.views,
    rows: prototypes.length,
    mossPayload: first.mossPayload,
  };
}
function material() {
  if (mergedTemplate) return fadeMaterial(mergedTemplate.clone());
  const m = decorate(
    new T.MeshStandardMaterial({
      map: atlas.textures[0],
      normalMap: atlas.textures[1],
      alphaTest: 0.32,
      alphaToCoverage: true,
      side: T.DoubleSide,
      roughness: 1,
      vertexColors: true,
    }),
    // Match individual HLODs: normal alpha is signed foliage/moss response,
    // not the source leaf texture's unsigned transmission channel.
    { transmission: 0.32, surfacePayload: true },
  );
  billboardTSL(m, atlas, true);
  mergedTemplate = m;
  return m;
}
async function install(c, record, clusters, version) {
  const g = new T.BufferGeometry();
  for (const [name, size] of [
    ["position", 3],
    ["plantCenter", 3],
    ["plantInfo", 2],
    ["uv", 2],
    ["normal", 3],
    ["color", 3],
  ])
    g.setAttribute(name, new T.BufferAttribute(record[name], size));
  g.setIndex(new T.BufferAttribute(record.indices, 1));
  // Shader rotates each quad about its own tree centre. Ordinary position bounds would be wrong.
  g.boundingSphere = bounds.get(c).clone();
  const mesh = new T.Mesh(g, material());
  mesh.userData.visibilityMerged = true;
  mesh.userData.ownedGeometry = true;
  const group = new T.Group();
  group.add(mesh);
  group.visible = false;
  // Do not publish an uncompiled replacement into the next frame.
  const wanted = () =>
    version === generation &&
    (clusters.startupMerge ||
      (c.levels[3]?.visible && frustum.intersectsSphere(bounds.get(c))));
  if (!clusters.startupMerge)
    await clusters.prepareGroup?.(group, () =>
      wanted() ? prioritizeArea(c.center, c.priority ?? 1000) : Infinity,
    );
  if (!wanted()) {
    mergedStats.cancelled++;
    g.dispose();
    mesh.material.dispose();
    return;
  }
  disposeVegetationGroup(replaceLODLevel(c, 3, group));
  c.farMerged = true;
  mergedStats.baked++;
  clusters.lodRevision = (clusters.lodRevision || 0) + 1;
}
export function updateMergedVisibility(
  clusters,
  camera,
  scene,
  prewarm = false,
) {
  if (!clusters.atlasIdentity) return;
  if (identity !== clusters.atlasIdentity) {
    generation++;
    identity = clusters.atlasIdentity;
    atlas?.textures.forEach((t) => t.dispose());
    mergedTemplate = null;
    atlas = makeAtlas(clusters.prototypes);
    mergedStats.baked = 0;
    mergedStats.hits = 0;
    for (const c of clusters) {
      c.farMerged = false;
      c.sourceFarDraws = new Set(c.trees.map((t) => t.variant)).size;
      const box = mergedClusterBounds(
        c.trees,
        clusters.prototypes.map((p) => ({
          center: p.center.toArray(),
          width: p.farAtlas.record.width,
          height: p.farAtlas.record.height,
        })),
      );
      bounds.set(
        c,
        new T.Box3(
          new T.Vector3(...box.min),
          new T.Vector3(...box.max),
        ).getBoundingSphere(new T.Sphere()),
      );
      bounds.get(c).radius += 16;
    }
  }
  camera.updateMatrixWorld();
  matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(matrix, camera.coordinateSystem);
  mergedStats.visible = 0;
  mergedStats.sourceDraws = 0;
  mergedStats.mergedDraws = 0;
  let candidate = null,
    best = Infinity;
  for (const c of clusters) {
    if (
      !c.levels[3]?.visible ||
      !c.trees.length ||
      (!prewarm && !frustum.intersectsSphere(bounds.get(c)))
    )
      continue;
    mergedStats.visible++;
    mergedStats.sourceDraws += c.sourceFarDraws;
    if (c.farMerged) {
      mergedStats.mergedDraws++;
      if (c.levels[3].parent !== scene) scene.add(c.levels[3]);
    } else if (!pending.has(c)) {
      const d = c.center.distanceToSquared(camera.position);
      if (d < best) {
        best = d;
        candidate = c;
      }
    }
  }
  if (pending.size >= (prewarm ? 8 : 3) || !candidate) return;
  pending.add(candidate);
  mergedStats.pending = pending.size;
  const c = candidate,
    version = generation,
    key = `merged-far-v1:${identity}:${c.id}`;
  return (async () => {
    const { record, hit } = await worker.run("merge", {
      key,
      trees: c.trees,
      prototypes: clusters.prototypes.map((p) => ({
        center: p.center.toArray(),
        width: p.farAtlas.record.width,
        height: p.farAtlas.record.height,
      })),
    });
    if (hit) mergedStats.hits++;
    if (version === generation) await install(c, record, clusters, version);
  })()
    .catch((e) => mergedStats.errors.push(e.message))
    .finally(() => {
      pending.delete(c);
      mergedStats.pending = pending.size;
    });
}
export async function clearMergedCache() {
  await ready;
  await cache.clear();
}
