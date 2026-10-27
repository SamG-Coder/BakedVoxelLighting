import {
  TREE_TYPES,
  TREE_VARIANTS,
  GRASS_TYPES,
  GRASS_COUNT,
  GRASS_PATCH,
  GRASS_MIXES,
} from "./plant-catalog.js";
import {
  grassHabitat,
  grassPopulation,
  grassColour,
  woodlandHabitat,
  patchNoise,
} from "./habitat.js";
export { grassHabitat } from "./habitat.js";
import { prepareAtlasMips } from "./atlas-mips.js";
import { shareAtlasBase } from "./atlas-storage.js";
import { grassPatchEdge } from "./grass-patch-shape.js";
import { buildGrassBatches } from "./grass-jobs.js";
import { GrassStreamQueue } from "./grass-stream-queue.js";
import { PreparationQueue } from "./preparation-queue.js";
import { VegetationInstancePool } from "./vegetation-instance-pool.js";
import { AttributeInstances } from "./attribute-instances.js";
import { instanceCapacity, takeCapacityGroup } from "./instance-capacity.js";
import { prioritizeArea } from "./streaming-view.js";
import { disposeVegetationGroup as removeLevel } from "./vegetation-resources.js";
import * as T from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { random, height } from "./world-data.js";
import { TERRAIN_SIZE, terrainSample } from "./terrain-field.js";
import { decorate, fadeMaterial, lightUniforms } from "./lighting.js";
import { growPlant } from "./growth.js";
import { growTreeAsync } from "./growth-jobs.js";
import { treeTint } from "./plant-appearance.js";
import {
  captureSurface,
  instanced,
  surfaceBillboards,
  atlasMaterial,
} from "./impostors.js";
const card = new T.PlaneGeometry(1, 1);
// Bound the entire build -> prepare -> publish lifetime, not just construction.
// Otherwise CPU completions accumulate full tree groups behind the GPU queue.
const treeBuildQueue = new PreparationQueue(2);
export const treeStreamingStats = {
  pending: 0,
  completed: 0,
  cancelled: 0,
  buildMs: 0,
  prepareMs: 0,
  maxBuildMs: 0,
  maxPrepareMs: 0,
};
function mergedLeaves(items) {
  const dummy = new T.Object3D(),
    parts = [];
  for (const t of items) {
    const g = card.clone();
    // Represent a small leaf cluster rather than the flat carrier polygon in lighting/captures.
    const normals = g.attributes.normal,
      positions = g.attributes.position;
    for (let i = 0; i < normals.count; i++) {
      const n = new T.Vector3(
        positions.getX(i) * 0.7,
        positions.getY(i) * 0.7,
        0.7,
      ).normalize();
      normals.setXYZ(i, n.x, n.y, n.z);
    }
    dummy.position.set(...t.p);
    dummy.rotation.set(...t.r);
    dummy.scale.set(...t.s);
    dummy.updateMatrix();
    g.applyMatrix4(dummy.matrix);
    if (t.n) {
      const canopy = new T.Vector3(...t.n),
        normal = g.attributes.normal;
      for (let i = 0; i < normal.count; i++) {
        const n = new T.Vector3()
          .fromBufferAttribute(normal, i)
          .multiplyScalar(0.45)
          .addScaledVector(canopy, 0.55)
          .normalize();
        normal.setXYZ(i, n.x, n.y, n.z);
      }
    }
    const c = new T.Color(t.c),
      colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
    g.setAttribute("color", new T.BufferAttribute(colors, 3));
    parts.push(g);
  }
  const result = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  return result;
}
const plantMaterialCache = new WeakMap();
function plantMaterials(assets, species, shrub = false) {
  let cache = plantMaterialCache.get(assets);
  if (!cache) plantMaterialCache.set(assets, (cache = new Map()));
  const key = `${species}:${shrub}`;
  if (cache.has(key)) return cache.get(key).map((m) => fadeMaterial(m.clone()));
  const name = shrub
    ? ["hazel", "bramble", "ash"][species]
    : TREE_TYPES[species];
  const bark =
    assets[
      shrub ? "bark-ash" : ["bark", "bark-birch", "bark-ash", "bark"][species]
    ];
  const wood = decorate(
    new T.MeshStandardMaterial({
      map: bark.map,
      normalMap: bark.normal,
      normalScale: new T.Vector2(0.6, 0.6),
      roughness: 1,
      vertexColors: true,
      color: shrub
        ? 0xb4aa93
        : species === 1
          ? 0xf2f0e7
          : species === 3
            ? 0xc6b09b
            : 0xe2d8c6,
    }),
    { moss: true, roots: !shrub },
  );
  const leaf = decorate(
    new T.MeshStandardMaterial({
      map: assets[name].map,
      normalMap: assets[name].normal,
      normalScale: new T.Vector2(0.25, 0.25),
      alphaTest: 0.4,
      alphaToCoverage: true,
      side: T.DoubleSide,
      roughness: 0.86,
      color: 0xf4f5ec,
      vertexColors: true,
    }),
    { wind: shrub ? 0.018 : 0.028, roots: !shrub },
  );
  cache.set(key, [wood, leaf]);
  return [wood, leaf].map((m) => fadeMaterial(m.clone()));
}
function makeModel(plant, assets, low = false) {
  const group = new T.Group(),
    materials = plantMaterials(assets, plant.species, plant.shrub);
  const wood = new T.Mesh(low ? plant.low : plant.high, materials[0]),
    leaf = new T.Mesh(plant.foliage, materials[1]);
  wood.castShadow = leaf.castShadow = true;
  wood.receiveShadow = leaf.receiveShadow = true;
  group.add(wood, leaf);
  return group;
}
export async function buildTrees(world, assets, identity, progress = () => {}) {
  const jobs = Array.from({ length: TREE_VARIANTS }, (_, i) =>
    growTreeAsync(
      9801 + i * 137,
      i % TREE_TYPES.length,
      Math.floor(i / TREE_TYPES.length),
      identity,
    ),
  );
  const prototypes = [];
  for (let i = 0; i < TREE_VARIANTS; i++) {
    progress(
      `Baking connected tree surfaces ${i + 1}/${TREE_VARIANTS}`,
      0.06 + (0.1 * i) / TREE_VARIANTS,
    );
    const p = await jobs[i];
    p.foliage = mergedLeaves(p.leaves);
    p.model = makeModel(p, assets);
    const box = new T.Box3().setFromObject(p.model),
      size = box.getSize(new T.Vector3());
    p.center = box.getCenter(new T.Vector3());
    p.width = Math.hypot(size.x, size.z) * 1.06;
    p.height = size.y * 1.06;
    prototypes.push(p);
  }
  const treePool = new VegetationInstancePool();
  treeStreamingStats.pool = treePool.stats;
  const clusters = world.clusters.map((c) => {
    const levels = [null, null];
    const makeLevel = async (level, wanted = () => true) => {
      const group = new T.Group();
      const byVariant = Array.from({ length: TREE_VARIANTS }, () => []);
      for (const t of c.trees)
        byVariant[t.variant].push({
          p: [t.x, t.y, t.z],
          r: [0, t.rotation, 0],
          s: [t.scale, t.scale, t.scale],
          colour: treeTint(t.seed),
        });
      for (let i = 0; i < TREE_VARIANTS; i++) {
        if (!wanted()) {
          treePool.releaseGroup(group);
          return null;
        }
        if (!byVariant[i].length) continue;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const transforms = byVariant[i];
        const p = prototypes[i];
        const material = (index) => {
          const materials = plantMaterials(assets, p.species);
          materials[1 - index].dispose();
          return materials[index];
        };
        const trunk = treePool.acquire(
            level ? p.low : p.high,
            () => material(0),
            transforms,
          ),
          leaves = treePool.acquire(p.foliage, () => material(1), transforms);
        trunk.castShadow = leaves.castShadow = true;
        trunk.receiveShadow = leaves.receiveShadow = true;
        group.add(trunk, leaves);
      }
      return group;
    };
    const entry = {
      ...c,
      levels,
      current: -1,
      center: new T.Vector3(c.x, height(c.x, c.z) + 8, c.z),
      kind: "tree",
    };
    const pending = new Map();
    const generations = [0, 0];
    entry.keepDetail = [true, true];
    entry.releaseMiddle = () => {
      const group = levels[2];
      if (
        !group?.userData.hasPreparedResources ||
        group.visible ||
        group.userData.preparation
      )
        return;
      // Reusing a disposed object's cached node attributes leaves stale backend
      // bindings. A fresh CPU clone retains the exact atlas/instances, not GPU state.
      const replacement = group.clone();
      replacement.traverse((mesh) => {
        if (!mesh.isMesh) return;
        mesh.material = fadeMaterial(mesh.material.clone());
        if (mesh.userData.ownedGeometry && !mesh.isAttributeInstances)
          mesh.geometry = mesh.geometry.clone();
      });
      replacement.userData.pipelineReady = false;
      replacement.userData.hasPreparedResources = false;
      replacement.userData.preparation = null;
      levels[2] = replacement;
      removeLevel(group);
    };
    entry.releaseDetail = (level) => {
      entry.keepDetail[level] = false;
      generations[level]++;
      treePool.releaseGroup(levels[level]);
      levels[level] = null;
    };
    entry.ensure = (level) => {
      entry.keepDetail[level] = true;
      if (level > 1 || levels[level] || pending.has(level)) return;
      const generation = generations[level];
      pending.set(level, generation);
      treeStreamingStats.pending++;
      const wanted = () =>
        generation === generations[level] && entry.keepDetail[level];
      const priority = () =>
        wanted()
          ? prioritizeArea(entry.center, (entry.priority ?? 1000) * 0.25)
          : Infinity;
      // Instantiate only nearby high-detail batches, between frames. Keep the
      // prepared far representation until both pipeline and pages are resident.
      treeBuildQueue
        .run(async () => {
          const start = performance.now();
          let group = await makeLevel(level, wanted);
          const ms = performance.now() - start;
          treeStreamingStats.buildMs += ms;
          treeStreamingStats.maxBuildMs = Math.max(
            treeStreamingStats.maxBuildMs,
            ms,
          );
          if (!group) {
            treeStreamingStats.cancelled++;
            return;
          }
          const prepareStarted = performance.now();
          try {
            if (!wanted()) {
              treeStreamingStats.cancelled++;
              return;
            }
            // One other cluster may build while this one waits for residency.
            await clusters.prepareGroup?.(group, priority);
            if (!wanted()) {
              treeStreamingStats.cancelled++;
              return;
            }
            levels[level] = group;
            group = null;
            treeStreamingStats.completed++;
          } finally {
            const ms = performance.now() - prepareStarted;
            treeStreamingStats.prepareMs += ms;
            treeStreamingStats.maxPrepareMs = Math.max(
              treeStreamingStats.maxPrepareMs,
              ms,
            );
            treePool.releaseGroup(group);
          }
        }, priority)
        .catch(console.error)
        .finally(() => {
          if (pending.get(level) === generation) pending.delete(level);
          treeStreamingStats.pending--;
          clusters.lodRevision = (clusters.lodRevision || 0) + 1;
        });
    };
    return entry;
  });
  clusters.prototypes = prototypes;
  return clusters;
}
export async function bakeTreeHLOD(
  renderer,
  clusters,
  lights,
  cache,
  identity,
  onProgress,
) {
  if (clusters.atlasIdentity === identity) return;
  const prototypes = clusters.prototypes;
  for (let i = 0; i < prototypes.length; i++) {
    const p = prototypes[i];
    for (const a of [p.atlas, p.farAtlas])
      if (a) {
        a.texture.dispose();
        a.normal.dispose();
      }
    // Capture the exact high-detail foliage; retain actual woody structure at L2.
    const canopy = new T.Group();
    canopy.add(p.model.children[1].clone());
    p.atlas = await captureSurface(
      renderer,
      canopy,
      p.center,
      p.width,
      p.height,
      256,
      16,
      cache,
      `tree-canopy:${identity}:${i}`,
    );
    p.farAtlas = await captureSurface(
      renderer,
      p.model,
      p.center,
      p.width,
      p.height,
      128,
      8,
      cache,
      `tree-far:${identity}:${i}`,
    );
    onProgress(
      `Capturing tree surfaces ${i + 1}/${prototypes.length}`,
      0.27 + (0.55 * (i + 1)) / prototypes.length,
    );
    await new Promise(requestAnimationFrame);
  }
  for (const c of clusters) {
    removeLevel(c.levels[2]);
    removeLevel(c.levels[3]);
    const middle = new T.Group(),
      far = new T.Group();
    for (let k = 0; k < TREE_VARIANTS; k++) {
      const p = prototypes[k],
        trees = c.trees.filter((t) => t.variant === k);
      if (!trees.length) continue;
      const transforms = trees.map((t) => ({
        p: [t.x, t.y, t.z],
        r: [0, t.rotation, 0],
        s: [t.scale, t.scale, t.scale],
        colour: treeTint(t.seed),
      }));
      const billboards = trees.map((t) => ({
        p: p.center
          .clone()
          .multiplyScalar(t.scale)
          .applyAxisAngle(new T.Vector3(0, 1, 0), t.rotation)
          .add(new T.Vector3(t.x, t.y, t.z))
          .toArray(),
        r: [0, t.rotation, 0],
        s: [t.scale, t.scale, t.scale],
        colour: treeTint(t.seed),
      }));
      const wood = instanced(
        p.farWood,
        p.model.children[0].material.clone(),
        transforms,
      );
      wood.material = fadeMaterial(wood.material);
      wood.castShadow = wood.receiveShadow = true;
      middle.add(wood);
      for (const [group, atlas] of [
        [middle, p.atlas],
        [far, p.farAtlas],
      ]) {
        const mesh = surfaceBillboards(atlas, billboards);
        mesh.userData.ownedGeometry = true;
        group.add(mesh);
      }
    }
    // Keep every tree anchored to its terrain position, including the farthest level.
    c.levels[2] = middle;
    c.levels[3] = far;
  }
  clusters.atlasIdentity = identity;
  clusters.lodRevision = (clusters.lodRevision || 0) + 1;
}
const grassCard = new T.PlaneGeometry(1, 1, 1, 3);
grassCard.translate(0, 0.5, 0);
// Bend the carrier cards so the represented blades have a real ground footprint.
for (let i = 0; i < grassCard.attributes.position.count; i++) {
  const p = grassCard.attributes.position,
    y = p.getY(i);
  p.setZ(i, y * y * 0.32);
}
grassCard.computeVertexNormals();
const grassMaterialCache = new WeakMap();
function grassMaterial(assets) {
  const template = grassMaterialCache.get(assets);
  if (template) return fadeMaterial(template.clone());
  const material = decorate(
    new T.MeshStandardMaterial({
      map: assets.grassAtlas.map,
      normalMap: assets.grassAtlas.normal,
      normalScale: new T.Vector2(0.25, 0.25),
      alphaTest: 0.34,
      alphaToCoverage: true,
      side: T.DoubleSide,
      roughness: 0.94,
      color: 0xffffff,
    }),
    { wind: 0.085, grass: true, grassAtlas: GRASS_TYPES.length },
  );
  grassMaterialCache.set(assets, material);
  return fadeMaterial(material.clone());
}
function grassMesh(assets, batch, capacity = batch.matrices.length / 16) {
  const geometry = grassCard.clone();
  geometry.setAttribute(
    "plantType",
    new T.InstancedBufferAttribute(new Float32Array(capacity), 1),
  );
  const mesh = new AttributeInstances(
    geometry,
    grassMaterial(assets),
    capacity,
  );
  mesh.instanceMatrix.array.set(batch.matrices);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.array.set(batch.colours);
  mesh.geometry.attributes.plantType.array.set(batch.types);
  mesh.instanceCount = batch.matrices.length / 16;
  mesh.userData.ownedGeometry = true;
  mesh.userData.grassCard = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
export function grassPoints(
  x,
  z,
  seed,
  count = GRASS_COUNT,
  span = 24,
  flat = false,
) {
  const groups = GRASS_TYPES.map(() => []);
  const sample = flat
    ? () => ({
        height: 0,
        traffic: 0,
        moisture: 0.5,
        slope: 0,
        root: 0,
        riverDistance: 100,
      })
    : terrainSample;
  for (const p of grassPopulation(x, z, seed, count, span, sample))
    for (let k = 0; k < 2; k++)
      groups[p.type].push({
        p: [p.x, p.y, p.z],
        r: [0, p.angle + k * Math.PI * 0.5, 0],
        s: [p.sx, p.sy, p.sx],
        c: new T.Color(...p.colour).getHex(),
      });
  return groups;
}
const yieldWork = () => new Promise((resolve) => setTimeout(resolve, 0));
const grassQueue = new GrassStreamQueue();
grassQueue.paused = true;
export function startGrassJobs() {
  grassQueue.paused = false;
  grassQueue.kick();
}
export const grassStreamingStats = grassQueue.stats;
export const finishGrassJobs = () => grassQueue.finish();
export function buildGrass(assets) {
  const patches = [];
  const spare = [[], [], []];
  const recycle = (group, level) => {
    if (!group) return;
    group.removeFromParent();
    group.visible = false;
    if (
      group.userData.poolIdentity === grass.identity &&
      spare[level].length < 48
    )
      spare[level].push(group);
    else removeLevel(group);
  };
  for (let z = -TERRAIN_SIZE / 2 + 12; z < TERRAIN_SIZE / 2 - 12; z += 24)
    for (let x = -TERRAIN_SIZE / 2 + 12; x < TERRAIN_SIZE / 2 - 12; x += 24) {
      const p = {
        x,
        z,
        seed: 18000 + (x + 492) * 100 + z + 492,
        center: new T.Vector3(x, height(x, z), z),
        levels: [null, null, null, new T.Group()],
        current: -1,
        kind: "grass",
      };
      p.pending = new Map();
      p.requestPriority = [Infinity, Infinity, Infinity];
      p.generation = 0;
      p.ensure = (level) => {
        if (p.levels[level] || level === 3 || p.pending.has(level)) return;
        const generation = p.generation;
        p.pending.set(level, generation);
        grassQueue.enqueue(p, level, generation);
      };
      p.build = async (level, generation) => {
        const wanted = () =>
          generation === p.generation &&
          Number.isFinite(p.requestPriority[level]);
        if (!wanted()) return;
        if (level === 2 && grass.templates.length === GRASS_MIXES.length) {
          const batches = await buildGrassBatches(
            x,
            z,
            p.seed,
            2,
            grass.identity,
          );
          if (!wanted()) return;
          const group = spare[2].pop() || new T.Group();
          group.userData.poolIdentity = grass.identity;
          for (let k = 0; k < GRASS_MIXES.length; k++) {
            const batch = batches[k],
              count = batch.matrices.length / 16;
            const atlas = grass.templates[k];
            let mesh = group.children.find((m) => m.userData.mix === k);
            if (mesh && mesh.instanceMatrix.count < count) {
              group.remove(mesh);
              removeLevel(mesh);
              mesh = null;
            }
            if (!count && !mesh) continue;
            if (!mesh) {
              const capacity = Math.max(
                16,
                2 ** Math.ceil(Math.log2(count || 1)),
              );
              mesh = new AttributeInstances(
                new T.PlaneGeometry(atlas.record.width, atlas.record.height),
                atlasMaterial(atlas, 0.26),
                capacity,
              );
              mesh.instanceColor = new T.InstancedBufferAttribute(
                new Float32Array(capacity * 3),
                3,
              );
              mesh.userData.mix = k;
              group.add(mesh);
              group.userData.pipelineReady = false;
            }
            mesh.instanceCount = count;
            mesh.instanceMatrix.array.set(batch.matrices);
            mesh.instanceMatrix.needsUpdate = true;
            mesh.instanceColor.array.set(batch.colours);
            mesh.instanceColor.needsUpdate = true;
            mesh.boundingSphere = new T.Sphere(
              p.center.clone().add(new T.Vector3(0, 0.6, 0)),
              32,
            );
            mesh.userData.ownedGeometry = true;
            mesh.userData.grassCard = true;
          }
          await grass.prepare?.(group, () =>
            wanted()
              ? prioritizeArea(p.center, p.requestPriority[level])
              : Infinity,
          );
          if (!wanted()) {
            recycle(group, level);
            return;
          }
          p.levels[2] = group;
          patches.lodRevision = (patches.lodRevision || 0) + 1;
          return;
        }
        const batches = await buildGrassBatches(
          x,
          z,
          p.seed,
          level,
          grass.identity,
        );
        if (!wanted()) return;
        const batch = batches[0];
        const capacity = instanceCapacity(batch.matrices.length / 16);
        const group =
          takeCapacityGroup(spare[level], capacity) || new T.Group();
        group.userData.poolIdentity = grass.identity;
        group.userData.instanceCapacity = capacity;
        let mesh = group.children[0];
        if (mesh && mesh.instanceMatrix.count < batch.matrices.length / 16) {
          group.remove(mesh);
          removeLevel(mesh);
          mesh = null;
        }
        if (batch.matrices.length) {
          if (!mesh) {
            // Reuse within a capacity class. The constructor allocates its own
            // instance buffers; do not allocate another full set just to copy zeros.
            mesh = grassMesh(assets, batch, capacity);
            group.add(mesh);
          }
          mesh.instanceCount = batch.matrices.length / 16;
          mesh.instanceMatrix.array.set(batch.matrices);
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.array.set(batch.colours);
          mesh.instanceColor.needsUpdate = true;
          mesh.geometry.attributes.plantType.array.set(batch.types);
          mesh.geometry.attributes.plantType.needsUpdate = true;
          mesh.boundingSphere = new T.Sphere(
            p.center.clone().add(new T.Vector3(0, 1, 0)),
            34,
          );
        } else if (mesh) {
          mesh.instanceCount = 0;
        }
        await grass.prepare?.(group, () =>
          wanted()
            ? prioritizeArea(p.center, p.requestPriority[level])
            : Infinity,
        );
        if (!wanted()) {
          recycle(group, level);
          return;
        }
        p.levels[level] = group;
        patches.lodRevision = (patches.lodRevision || 0) + 1;
      };
      p.release = () => {
        p.generation++;
        p.pending.clear();
        p.requestPriority.fill(Infinity);
        patches.lodRevision = (patches.lodRevision || 0) + 1;
        for (let i = 0; i < 3; i++) {
          recycle(p.levels[i], i);
          p.levels[i] = null;
        }
      };
      patches.push(p);
    }
  patches.grid = new Map(
    patches.map((p) => [
      `${Math.round((p.x + 1988) / 24)}:${Math.round((p.z + 1988) / 24)}`,
      p,
    ]),
  );
  patches.active = new Set();
  const grass = { patches, assets, templates: [] };
  grass.clearPool = () => {
    for (const pool of spare) {
      for (const group of pool) removeLevel(group);
      pool.length = 0;
    }
  };
  return grass;
}
export async function bakeGrassLOD(
  renderer,
  grass,
  lights,
  cache,
  identity,
  onProgress,
) {
  if (grass.identity === identity) return [];
  for (const t of grass.templates) {
    t.texture.dispose();
    t.normal.dispose();
  }
  grass.templates = [];
  for (let k = 0; k < GRASS_MIXES.length; k++) {
    const batch = { matrices: [], colours: [], types: [] },
      source = new T.Group();
    const habitat = {
      weights: GRASS_MIXES[k],
      density: 1,
      height: 1,
      tint: 0.96,
      dry: k === 1 ? 0.6 : 0.15,
      flow: k * 0.8,
    };
    const sample = () => ({
      height: 0,
      traffic: 0,
      moisture: 0.5,
      slope: 0,
      root: 0,
      riverDistance: 100,
    });
    for (const p of grassPopulation(0, 0, 981 + k, 64, 2.8, sample, habitat)) {
      const edge = grassPatchEdge(p.x, p.z, k);
      if (edge === 0) continue;
      p.sy *= 0.36 + edge * 0.64;
      p.sx *= 0.62 + edge * 0.38;
      for (let j = 0; j < 2; j++) {
        const a = p.angle + j * Math.PI * 0.5,
          c = Math.cos(a),
          s = Math.sin(a);
        batch.matrices.push(
          c * p.sx,
          0,
          -s * p.sx,
          0,
          0,
          p.sy,
          0,
          0,
          s * p.sx,
          0,
          c * p.sx,
          0,
          p.x,
          p.y,
          p.z,
          1,
        );
        batch.colours.push(...p.colour);
        batch.types.push(p.type);
      }
    }
    for (const key of Object.keys(batch))
      batch[key] = new Float32Array(batch[key]);
    source.add(grassMesh(grass.assets, batch));
    const atlas = await captureSurface(
      renderer,
      source,
      new T.Vector3(0, GRASS_PATCH.centerY, 0),
      GRASS_PATCH.width,
      GRASS_PATCH.height,
      256,
      8,
      cache,
      "grass-surface-tapered-v1:" + identity + ":" + k,
      { grassPatch: true },
    );
    grass.templates.push(atlas);
    removeLevel(source);
  }
  for (const p of grass.patches) p.release();
  grass.clearPool();
  grass.identity = identity;
  onProgress("Relightable grass patches cached", 0.96);
  return [];
}
export { updateLOD } from "./vegetation-lod.js";

export async function buildShrubs(world, assets, identity) {
  const prototypes = [];
  for (let k = 0; k < 3; k++) {
    const p = await growTreeAsync(552 + k * 83, k, 1, identity, true);
    p.foliage = mergedLeaves(p.leaves);
    p.model = makeModel(p, assets);
    const box = new T.Box3().setFromObject(p.model),
      size = box.getSize(new T.Vector3());
    p.center = box.getCenter(new T.Vector3());
    p.width = Math.hypot(size.x, size.z) * 1.04;
    p.height = size.y * 1.06;
    prototypes.push(p);
  }
  const groups = [];
  for (const c of world.clusters) {
    const rng = random(c.id + 4100),
      group = new T.Group(),
      all = [];
    for (let k = 0; k < 3; k++) {
      const transforms = [];
      for (let patch = 0; patch < 6; patch++) {
        const anchor = c.trees[Math.floor(rng() * c.trees.length)];
        if (!anchor) continue;
        const a = rng() * Math.PI * 2,
          r = 5 + rng() * 12,
          px = anchor.x + Math.cos(a) * r,
          pz = anchor.z + Math.sin(a) * r;
        for (let j = 0; j < 3; j++) {
          const x = px + (rng() - 0.5) * 6,
            z = pz + (rng() - 0.5) * 6,
            s = terrainSample(x, z);
          if (
            s.traffic > 0.12 ||
            s.slope > 0.58 ||
            s.riverDistance < 9 ||
            s.root > 0.6
          )
            continue;
          const h = grassHabitat(x, z, s),
            wood = woodlandHabitat(x, z, s);
          const suitable =
            k === 0
              ? 0.15 + wood.edge * 0.6 + s.canopy * 0.22
              : k === 1
                ? 0.08 + wood.edge * 0.75 + wood.gap * wood.stand * 0.4
                : 0.06 + s.moisture * 0.35 + wood.edge * 0.3;
          if (rng() > suitable * (1 - h.woodland * 0.65)) continue;
          const size = (k === 1 ? 0.48 : 0.7) + rng() * (k === 0 ? 0.85 : 0.6);
          transforms.push({
            p: [x, s.height - 0.03, z],
            r: [0, rng() * 6.28, 0],
            s: [size * (k === 1 ? 1.15 : 1), size, size],
          });
        }
      }
      all.push(transforms);
      if (transforms.length) {
        const m = plantMaterials(assets, k, true);
        for (const [geometry, material] of [
          [prototypes[k].low, m[0]],
          [prototypes[k].foliage, m[1]],
        ]) {
          const mesh = instanced(geometry, material, transforms);
          mesh.castShadow = mesh.receiveShadow = true;
          group.add(mesh);
        }
      }
    }
    groups.push({
      group,
      far: null,
      transforms: all,
      center: new T.Vector3(c.x, height(c.x, c.z), c.z),
    });
  }
  groups.prototypes = prototypes;
  return groups;
}
export async function bakeShrubLOD(renderer, shrubs, cache, identity) {
  if (shrubs.identity === identity) return;
  for (let k = 0; k < shrubs.prototypes.length; k++) {
    const p = shrubs.prototypes[k];
    p.atlas?.texture.dispose();
    p.atlas?.normal.dispose();
    p.atlas = await captureSurface(
      renderer,
      p.model,
      p.center,
      p.width,
      p.height,
      128,
      8,
      cache,
      "shrub-surface:" + identity + ":" + k,
    );
  }
  for (const entry of shrubs) {
    removeLevel(entry.far);
    const group = new T.Group();
    entry.transforms.forEach((ts, k) => {
      if (!ts.length) return;
      const p = shrubs.prototypes[k];
      const transforms = ts.map((t) => ({
        r: t.r,
        s: t.s,
        p: p.center
          .clone()
          .multiply(new T.Vector3(...t.s))
          .applyAxisAngle(new T.Vector3(0, 1, 0), t.r[1])
          .add(new T.Vector3(...t.p))
          .toArray(),
      }));
      group.add(surfaceBillboards(p.atlas, transforms));
    });
    entry.far = group;
  }
  shrubs.identity = identity;
}
export function updateShrubs(items, camera, scene) {
  const p = camera.position,
    last = items.lodState;
  if (
    last &&
    Math.abs(last.x - p.x) < 0.001 &&
    Math.abs(last.y - p.y) < 0.001 &&
    Math.abs(last.z - p.z) < 0.001 &&
    last.identity === items.identity
  )
    return;
  items.lodState = { x: p.x, y: p.y, z: p.z, identity: items.identity };
  for (const p of items) {
    const d = p.center.distanceTo(camera.position),
      transition = T.MathUtils.smoothstep(d, 100, 145),
      end = 1 - T.MathUtils.smoothstep(d, 320, 420);
    const groups = [p.group, p.far];
    p.distance = d;
    const weights = [1 - transition, Math.min(transition, end)];
    for (let i = 0; i < 2; i++) {
      const group = groups[i];
      if (
        d <= (i === 0 ? 220 : 520) ||
        !group?.userData.hasPreparedResources ||
        group.visible ||
        group.userData.preparation
      )
        continue;
      const replacement = group.clone();
      replacement.traverse((mesh) => {
        if (!mesh.isMesh) return;
        mesh.material = fadeMaterial(mesh.material.clone());
        if (mesh.userData.ownedGeometry && !mesh.isAttributeInstances)
          mesh.geometry = mesh.geometry.clone();
      });
      replacement.userData.pipelineReady =
        replacement.userData.hasPreparedResources = false;
      replacement.userData.preparation = null;
      replacement.userData.residencyRequested = false;
      p[i === 0 ? "group" : "far"] = groups[i] = replacement;
      removeLevel(group);
    }
    if (items.prepareGroup) {
      for (let i = 0; i < 2; i++) {
        const group = groups[i];
        if (!group || weights[i] <= 0 || group.userData.pipelineReady) continue;
        if (!group.userData.residencyRequested) {
          group.userData.residencyRequested = true;
          items
            .prepareGroup(group, () =>
              p.distance <= (i === 0 ? 220 : 520)
                ? prioritizeArea(p.center, p.distance)
                : Infinity,
            )
            .then(() => {
              items.lodState = null;
            })
            .catch(() => {})
            .finally(() => {
              group.userData.residencyRequested = false;
            });
        }
        if (groups[1 - i]?.userData.pipelineReady) weights[1 - i] += weights[i];
        weights[i] = 0;
      }
    }
    for (const [group, lo, hi] of [
      [p.group, weights[1], weights[1] + weights[0]],
      [p.far, 0, weights[1]],
    ]) {
      if (!group) continue;
      group.visible = hi > lo;
      if (group.visible && group.parent !== scene) scene.add(group);
      else if (!group.visible && group.parent) group.removeFromParent();
      if (group.visible)
        group.traverse((o) => {
          if (o.material?.userData.fade)
            o.material.userData.fade.value.set(lo, hi);
        });
    }
  }
}

// Orthographic canopy captures use the same bent cards, colours and represented
// normals as the nearby meadow. Wrapped copies make each four-metre tile seamless.
async function bakeGrassSurface(renderer, cache, identity, assets) {
  const key = "grass-ground-surface:" + identity;
  let record = await cache.get(key);
  if (!record) {
    const size = 512,
      span = 4,
      captures = [];
    for (let k = 0; k < GRASS_MIXES.length; k++) {
      const source = new T.Group(),
        batch = { matrices: [], colours: [], types: [] };
      const habitat = {
        weights: GRASS_MIXES[k],
        density: 1,
        height: 1,
        tint: 0.96,
        dry: k === 1 ? 0.6 : 0.15,
        flow: k * 0.8,
      };
      const sample = () => ({
        height: 0,
        traffic: 0,
        moisture: 0.5,
        slope: 0,
        root: 0,
        riverDistance: 100,
      });
      const matrix = new T.Matrix4(),
        q = new T.Quaternion(),
        axis = new T.Vector3(0, 1, 0);
      for (const p of grassPopulation(
        0,
        0,
        6151 + k,
        k === 3 ? 18 : 112,
        span,
        sample,
        habitat,
      )) {
        for (let oz = -1; oz <= 1; oz++)
          for (let ox = -1; ox <= 1; ox++)
            for (let j = 0; j < 2; j++) {
              if (
                Math.abs(p.x + ox * span) > span / 2 + 1.2 ||
                Math.abs(p.z + oz * span) > span / 2 + 1.2
              )
                continue;
              q.setFromAxisAngle(axis, p.angle + j * Math.PI * 0.5);
              matrix.compose(
                new T.Vector3(p.x + ox * span, p.y, p.z + oz * span),
                q,
                new T.Vector3(p.sx, p.sy, p.sx),
              );
              batch.matrices.push(...matrix.elements);
              batch.colours.push(...p.colour);
              batch.types.push(p.type);
            }
      }
      for (const c of Object.keys(batch)) batch[c] = new Float32Array(batch[c]);
      source.add(grassMesh(assets, batch));
      if (k === 3) {
        // Bake small, dry leaf sprays into the woodland surface. One instanced
        // draw, no per-leaf runtime objects, and the same mip chain at distance.
        const rng = random(17101),
          leaves = [];
        for (let leaf = 0; leaf < 260; leaf++) {
          const scale = 0.18 + rng() * 0.31;
          const transform = {
            p: [
              (rng() - 0.5) * span,
              -0.025 + rng() * 0.014,
              (rng() - 0.5) * span,
            ],
            r: [-Math.PI / 2, 0, rng() * Math.PI * 2],
            s: [scale, scale, scale],
            c: new T.Color(
              1.05 + rng() * 0.2,
              0.42 + rng() * 0.18,
              0.16 + rng() * 0.1,
            ).getHex(),
          };
          for (let oz = -1; oz <= 1; oz++)
            for (let ox = -1; ox <= 1; ox++) {
              const x = transform.p[0] + ox * span,
                z = transform.p[2] + oz * span;
              if (
                Math.abs(x) < span / 2 + scale &&
                Math.abs(z) < span / 2 + scale
              )
                leaves.push({ ...transform, p: [x, transform.p[1], z] });
            }
        }
        const litter = instanced(
          new T.PlaneGeometry(1, 1),
          new T.MeshStandardMaterial({
            map: assets.oak.map,
            alphaTest: 0.35,
            side: T.DoubleSide,
            roughness: 1,
          }),
          leaves,
        );
        litter.userData.ownedGeometry = true;
        source.add(litter);
      }
      const baseMap =
        assets[k === 3 ? "woodland-litter" : "ground-meadow"].map.clone();
      // An even number of mirrored repeats joins both capture borders exactly,
      // including source photographs whose opposite edges do not match.
      baseMap.wrapS = baseMap.wrapT = T.MirroredRepeatWrapping;
      baseMap.repeat.set(2, 2);
      const base = new T.Mesh(
        new T.PlaneGeometry(span, span),
        new T.MeshStandardMaterial({ map: baseMap, roughness: 1 }),
      );
      base.rotation.x = -Math.PI / 2;
      base.position.y = -0.045;
      source.add(base);
      const capture = await captureSurface(
        renderer,
        source,
        new T.Vector3(),
        span,
        span,
        size,
        1,
        cache,
        key + ":" + k,
        { topDown: true },
      );
      captures.push(capture.record);
      capture.texture.dispose();
      capture.normal.dispose();
      removeLevel(source);
      baseMap.dispose();
      base.geometry.dispose();
      await yieldWork();
    }
    const w = size * GRASS_MIXES.length,
      h = size,
      data = new Uint8Array(w * h * 4),
      normals = new Uint8Array(data.length);
    for (let k = 0; k < GRASS_MIXES.length; k++)
      for (let y = 0; y < h; y++) {
        const start = y * size * 4,
          end = start + size * 4,
          offset = (y * w + k * size) * 4;
        data.set(captures[k].data.subarray(start, end), offset);
        normals.set(captures[k].normals.subarray(start, end), offset);
      }
    const mips = await prepareAtlasMips({
      data,
      normals,
      w,
      h,
      views: GRASS_MIXES.length,
      cutoff: 0,
    });
    record = {
      data,
      normals,
      w,
      h,
      views: GRASS_MIXES.length,
      mips,
      topDown: true,
    };
    shareAtlasBase(record);
    await cache.put(key, record);
  }
  shareAtlasBase(record);
  for (const [channel, name] of [
    ["data", "grassSurface"],
    ["normals", "grassSurfaceNormal"],
  ]) {
    const t = new T.DataTexture(record[channel], record.w, record.h);
    t.mipmaps = record.mips.map((l) => ({
      data: l[channel],
      width: l.width,
      height: l.height,
    }));
    t.generateMipmaps = false;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.magFilter = T.LinearFilter;
    t.anisotropy = 8;
    if (channel === "data") t.colorSpace = T.LinearSRGBColorSpace;
    t.needsUpdate = true;
    lightUniforms[name].value = t;
  }
  return {
    key,
    tileMetres: 4,
    resolution: 512,
    habitats: GRASS_MIXES.length,
    mips: record.mips.length,
  };
}

export async function bakeGrassGround(renderer, cache, identity, assets) {
  const surface = await bakeGrassSurface(renderer, cache, identity, assets);
  const n = 1024,
    key = "grass-ground:" + identity;
  let record = await cache.get(key);
  if (!record) {
    const data = new Uint8Array(n * n * 4),
      habitat = new Uint8Array(n * n * 4);
    for (let z = 0; z < n; z++) {
      if (z % 16 === 0) await yieldWork();
      for (let x = 0; x < n; x++) {
        const wx = ((x + 0.5) / n - 0.5) * TERRAIN_SIZE,
          wz = ((z + 0.5) / n - 0.5) * TERRAIN_SIZE;
        const land = terrainSample(wx, wz),
          h = grassHabitat(wx, wz, land),
          i = (x + z * n) * 4;
        const cover =
          land.riverDistance < 8 || land.slope > 0.64
            ? 0
            : h.density *
              (1 - T.MathUtils.smoothstep(land.traffic, 0.08, 0.32)) *
              (1 - T.MathUtils.smoothstep(land.root, 0.12, 0.78) * 0.94);
        for (let c = 0; c < 3; c++) {
          let mean = 0;
          for (let k = 0; k < GRASS_TYPES.length; k++)
            mean +=
              assets[GRASS_TYPES[k].name].profile.colour[c] * h.weights[k];
          const tint = grassColour(h)[c];
          data[i + c] = Math.min(255, Math.round(255 * mean * tint));
        }
        data[i + 3] = Math.round(cover * 255);
        habitat.set(
          h.mixes.map((v) => Math.round(v * 255)),
          i,
        );
      }
    }
    record = { data, habitat, n };
    await cache.put(key, record);
  }
  const texture = new T.DataTexture(record.data, n, n, T.RGBAFormat);
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.magFilter = T.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = T.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  lightUniforms.grassGround.value = texture;
  const mix = new T.DataTexture(record.habitat, n, n);
  mix.minFilter = T.LinearMipmapLinearFilter;
  mix.magFilter = T.LinearFilter;
  mix.generateMipmaps = true;
  mix.needsUpdate = true;
  lightUniforms.grassHabitat.value = mix;
  return {
    key,
    resolution: n,
    surface,
    blockSize: 24,
    types: GRASS_TYPES.map((t) => t.name),
  };
}
