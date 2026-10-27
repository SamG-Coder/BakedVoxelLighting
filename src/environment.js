import { sampleHydrology, regionalHeight } from "./watershed.js";
import * as T from "three/webgpu";
import { decorate, lightUniforms } from "./lighting.js";
import {
  terrainSample,
  TERRAIN_SIZE,
  TERRAIN_GRID,
  riverData,
} from "./terrain-field.js";
import { height, random } from "./world-data.js";
import { instanced } from "./impostors.js";
import { buildRiver } from "./river.js";
import { prioritizeArea } from "./streaming-view.js";
import {
  TERRAIN_TILE_COUNT,
  TERRAIN_FINE_SEGMENTS,
} from "./terrain-mesh-layout.js";
const terrainTiles = [];
function terrainSurface(x, z, segments) {
  const size = TERRAIN_SIZE / TERRAIN_TILE_COUNT,
    step = size / segments;
  const tx =
    Math.floor((x + TERRAIN_SIZE / 2) / size) * size - TERRAIN_SIZE / 2;
  const tz =
    Math.floor((z + TERRAIN_SIZE / 2) / size) * size - TERRAIN_SIZE / 2;
  const gx = (x - tx) / step,
    gz = (z - tz) / step,
    ix = Math.floor(gx),
    iz = Math.floor(gz),
    u = gx - ix,
    v = gz - iz;
  const xx = tx + ix * step,
    zz = tz + iz * step,
    a = height(xx, zz),
    b = height(xx, zz + step),
    c = height(xx + step, zz + step),
    d = height(xx + step, zz);
  const surface =
    u + v <= 1
      ? a + (d - a) * u + (b - a) * v
      : c + (b - c) * (1 - u) + (d - c) * (1 - v);
  return surface;
}
export function terrainCameraFloor(x, z) {
  const size = TERRAIN_SIZE / TERRAIN_TILE_COUNT;
  const ix = Math.floor((x + TERRAIN_SIZE / 2) / size),
    iz = Math.floor((z + TERRAIN_SIZE / 2) / size);
  const tile =
    ix >= 0 && ix < TERRAIN_TILE_COUNT && iz >= 0 && iz < TERRAIN_TILE_COUNT
      ? terrainTiles[ix + iz * TERRAIN_TILE_COUNT]
      : null;
  const current = tile?.levels.find((mesh) => mesh.visible);
  const segments =
    current?.geometry.parameters.widthSegments || TERRAIN_FINE_SEGMENTS;
  // A coarse surface can remain visible while the close mesh's pages load.
  // Keep the camera above both it and the eventual 48-subdivision replacement.
  let surface = Math.max(
    terrainSurface(x, z, TERRAIN_FINE_SEGMENTS),
    height(x, z),
  );
  if (segments !== TERRAIN_FINE_SEGMENTS)
    surface = Math.max(surface, terrainSurface(x, z, segments));
  return surface + 1.85;
}
let terrainEye = null;
let prepareTerrain = null;
export function setTerrainPreparation(prepare) {
  prepareTerrain = prepare;
  for (const tile of terrainTiles)
    for (const mesh of tile.levels)
      if (mesh.visible) mesh.userData.pipelineReady = true;
  terrainEye = null;
}
export function updateTerrain(camera) {
  const p = camera.position;
  if (
    terrainEye &&
    Math.abs(terrainEye.x - p.x) < 0.001 &&
    Math.abs(terrainEye.z - p.z) < 0.001
  )
    return;
  terrainEye ||= { x: p.x, z: p.z };
  terrainEye.x = p.x;
  terrainEye.z = p.z;
  for (const tile of terrainTiles) {
    const d = Math.hypot(
      camera.position.x - tile.x,
      camera.position.z - tile.z,
    );
    const level = tile.levels.length === 1 ? 0 : d < 260 ? 0 : d < 850 ? 1 : 2;
    tile.requestedLevel = level;
    tile.distance = d;
    // Keep the whole-world coarse surface. Release only hidden high-detail GPU
    // allocations well outside their ring; CPU vertices remain ready to upload.
    for (let i = 0; i < tile.levels.length - 1; i++) {
      const mesh = tile.levels[i];
      if (
        d > (i === 0 ? 390 : 1050) &&
        !mesh.visible &&
        mesh.userData.pipelineReady &&
        !mesh.userData.preparation
      ) {
        mesh.dispatchEvent({ type: "dispose" });
        mesh.geometry.dispose();
        mesh.userData.pipelineReady = false;
        mesh.userData.hasPreparedResources = false;
      }
    }
    const requested = tile.levels[level];
    if (prepareTerrain && !requested.userData.pipelineReady) {
      if (!requested.userData.residencyRequested) {
        requested.userData.residencyRequested = true;
        prepareTerrain(requested, () =>
          tile.requestedLevel === level
            ? prioritizeArea(tile.center, tile.distance, 100)
            : Infinity,
        )
          .then(() => {
            terrainEye = null; // completed pages invalidate the distance decision
          })
          .catch(() => {})
          .finally(() => {
            requested.userData.residencyRequested = false;
          });
      }
      continue; // keep the existing terrain surface until the new mesh is resident
    }
    for (let i = 0; i < tile.levels.length; i++)
      tile.levels[i].visible = i === level;
  }
}
export function buildEnvironment(scene, assets) {
  lightUniforms.groundMap.value = assets["ground-meadow"].map;
  lightUniforms.rockMap.value = assets.scree.map;
  lightUniforms.dryGroundMap.value = assets["meadow-ground"].map;
  const material = decorate(
    new T.MeshStandardMaterial({
      map: assets.dirt.map,
      normalMap: assets.dirt.normal,
      normalScale: new T.Vector2(0.65, 0.65),
      roughness: 1,
      side: T.FrontSide,
    }),
    { ground: true, fade: false },
  );
  const ground = new T.Group();
  const size = TERRAIN_SIZE / TERRAIN_TILE_COUNT;
  const waterQuery = {};
  for (let z = 0; z < TERRAIN_TILE_COUNT; z++)
    for (let x = 0; x < TERRAIN_TILE_COUNT; x++) {
      const cx = -TERRAIN_SIZE / 2 + (x + 0.5) * size,
        cz = -TERRAIN_SIZE / 2 + (z + 0.5) * size;
      const riverTile =
        sampleHydrology(cx, cz, waterQuery).distance < size * 0.75 + 20;
      // Channel beds retain full precision at every distance. One resident mesh
      // avoids constructing/uploading three identical copies of these pages.
      const levels = (
        riverTile ? [TERRAIN_FINE_SEGMENTS] : [TERRAIN_FINE_SEGMENTS, 12, 4]
      ).map((segments) => {
        const g = new T.PlaneGeometry(size, size, segments, segments);
        g.rotateX(-Math.PI / 2);
        const p = g.attributes.position,
          n = g.attributes.normal;
        for (let i = 0; i < p.count; i++) {
          const wx = p.getX(i) + cx,
            wz = p.getZ(i) + cz;
          p.setXYZ(i, wx, height(wx, wz), wz);
          const nx = height(wx - 1, wz) - height(wx + 1, wz),
            nz = height(wx, wz - 1) - height(wx, wz + 1),
            inverseLength = 1 / Math.hypot(nx, 2, nz);
          n.setXYZ(
            i,
            nx * inverseLength,
            2 * inverseLength,
            nz * inverseLength,
          );
        }
        // Add vertical skirts without depressing the sampled top surface.
        const positions = Array.from(p.array),
          normals = Array.from(n.array),
          uvs = Array.from(g.attributes.uv.array),
          indices = Array.from(g.index.array);
        const edge = [];
        for (let i = 0; i < segments; i++) edge.push(i);
        for (let i = 0; i < segments; i++)
          edge.push(i * (segments + 1) + segments);
        for (let i = segments; i > 0; i--)
          edge.push(segments * (segments + 1) + i);
        for (let i = segments; i > 0; i--) edge.push(i * (segments + 1));
        const base = p.count;
        edge.forEach((i) => {
          positions.push(p.getX(i), p.getY(i) - 32, p.getZ(i));
          normals.push(n.getX(i), n.getY(i), n.getZ(i));
          uvs.push(g.attributes.uv.getX(i), g.attributes.uv.getY(i));
        });
        edge.forEach((a, i) => {
          const j = (i + 1) % edge.length,
            b = edge[j];
          indices.push(a, b, base + i, b, base + j, base + i);
        });
        g.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
        g.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
        g.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
        g.setIndex(indices);
        const mesh = new T.Mesh(g, material);
        mesh.userData.terrainTile = true;
        mesh.receiveShadow = true;
        mesh.visible = false;
        ground.add(mesh);
        return mesh;
      });
      terrainTiles.push({
        x: cx,
        z: cz,
        center: new T.Vector3(cx, height(cx, cz), cz),
        levels,
      });
    }
  scene.add(ground);
  // Coarse surrounding terrain comes from the same regional watershed solve.
  // Its inner edge matches the playable heightfield exactly; no detached skyline.
  const horizon = new T.Group();
  horizon.name = "Regional horizon";
  // The playable ground-cover lookup clamps at 4km. Using it outside that
  // domain extrudes the last texel into stripes; use world-tiled surfaces here.
  const horizonMaterial = new T.MeshStandardNodeMaterial({
    map: assets["ground-meadow"].map,
    normalMap: assets["ground-meadow"].normal,
    roughness: 1,
    color: 0xbfb292,
  });
  for (const [cx, cz, width, depth] of [
    [0, -2280, 5120, 560],
    [0, 2280, 5120, 560],
    [-2280, 0, 560, 4000],
    [2280, 0, 560, 4000],
  ]) {
    const geometry = new T.PlaneGeometry(
      width,
      depth,
      Math.ceil(width / 40),
      Math.ceil(depth / 40),
    );
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i) + cx,
        z = positions.getZ(i) + cz;
      const edge = Math.max(Math.abs(x) - 2000, Math.abs(z) - 2000, 0);
      const blend = Math.min(1, edge / 60);
      geometry.attributes.uv.setXY(i, (x + 2000) / 4000, (z + 2000) / 4000);
      positions.setXYZ(
        i,
        x,
        height(
          Math.max(-2000, Math.min(2000, x)),
          Math.max(-2000, Math.min(2000, z)),
        ) *
          (1 - blend) +
          regionalHeight(x, z) * blend,
        z,
      );
    }
    geometry.computeVertexNormals();
    const mesh = new T.Mesh(geometry, horizonMaterial);
    mesh.receiveShadow = false; // Outside the playable voxel / terrain-shadow domain.
    horizon.add(mesh);
  }
  scene.add(horizon);
  const water = buildRiver(scene, height, lightUniforms, { data: riverData });
  const rng = random(607),
    sets = Array.from({ length: 6 }, () => []);
  let count = 0;
  for (let cluster = 0; cluster < 800; cluster++) {
    let x, z, land;
    for (let tries = 0; tries < 30; tries++) {
      x = (rng() - 0.5) * (TERRAIN_SIZE - 80);
      z = (rng() - 0.5) * (TERRAIN_SIZE - 80);
      land = terrainSample(x, z);
      if (land.slope > 0.09 && land.traffic < 0.04) break;
    }
    if (land.traffic > 0.05) continue;
    for (let j = 0; j < 5 + Math.floor(rng() * 9); j++) {
      const a = rng() * 6.28,
        r = j === 0 ? 0 : rng() * 9,
        xx = x + Math.cos(a) * r,
        zz = z + Math.sin(a) * r,
        s = terrainSample(xx, zz);
      if (s.traffic > 0.08) continue;
      const scale = j === 0 ? 1.2 + rng() * 2 : 0.18 + rng() * 0.9;
      sets[Math.floor(rng() * 6)].push({
        p: [xx, s.height - scale * 0.34, zz],
        r: [(rng() - 0.5) * 0.35, rng() * 6.28, (rng() - 0.5) * 0.3],
        s: [
          scale * (1 + rng() * 0.5),
          scale * (0.6 + rng() * 0.4),
          scale * (0.7 + rng() * 0.5),
        ],
      });
      count++;
    }
  }
  for (let k = 0; k < 6; k++) {
    const g = new T.IcosahedronGeometry(1, 2),
      p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        y = p.getY(i),
        z = p.getZ(i),
        n =
          1 +
          0.13 * Math.sin(x * 4 + k) * Math.cos(z * 5 - k) +
          0.08 * Math.sin(y * 7 + x * 3);
      p.setXYZ(i, x * n, y * n * (0.8 + 0.08 * k), z * n);
    }
    g.computeVertexNormals();
    const m = decorate(
      new T.MeshStandardMaterial({
        map: assets.rock.map,
        normalMap: assets.rock.normal,
        normalScale: new T.Vector2(0.75, 0.75),
        color: 0xb5b3a1,
        roughness: 1,
      }),
      { fade: false },
    );
    const rocks = instanced(g, m, sets[k]);
    rocks.userData.voxelKind = "rock";
    rocks.castShadow = rocks.receiveShadow = true;
    scene.add(rocks);
  }
  return { ground, water, rocks: count };
}
