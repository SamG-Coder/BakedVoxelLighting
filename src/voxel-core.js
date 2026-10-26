import { GRASS_TYPES, TREE_TYPES } from "./plant-catalog.js";
import { Vector3 } from "three/src/math/Vector3.js";
import { riverCenter, riverLevel } from "./terrain-math.js";
import { treeTint } from "./plant-appearance.js";
function* voxelDetailChunks(world, n, min, size, grassRecords) {
  const ny = n / 2,
    cell = [size.x / n, size.y / ny, size.z / n],
    data = new Float32Array(n * ny * n * 4),
    kinds = new Uint8Array(n * ny * n),
    counts = {
      grass: 0,
      shrubs: 0,
      rocks: 0,
      branches: 0,
      deadwood: 0,
      leaves: 0,
      water: 0,
    };
  function stamp(p, r, colour, opacity, kind) {
    const lx = p[0] - r[0],
      ly = p[1] - r[1],
      lz = p[2] - r[2],
      hx = p[0] + r[0],
      hy = p[1] + r[1],
      hz = p[2] + r[2];
    const x0 = Math.max(0, Math.floor((lx - min.x) / cell[0])),
      x1 = Math.min(n - 1, Math.floor((hx - min.x) / cell[0]));
    const y0 = Math.max(0, Math.floor((ly - min.y) / cell[1])),
      y1 = Math.min(ny - 1, Math.floor((hy - min.y) / cell[1]));
    const z0 = Math.max(0, Math.floor((lz - min.z) / cell[2])),
      z1 = Math.min(n - 1, Math.floor((hz - min.z) / cell[2]));
    for (let z = z0; z <= z1; z++) {
      const wz = min.z + z * cell[2],
        az =
          Math.max(0, Math.min(wz + cell[2], hz) - Math.max(wz, lz)) / cell[2];
      for (let y = y0; y <= y1; y++) {
        const wy = min.y + y * cell[1],
          ay =
            Math.max(0, Math.min(wy + cell[1], hy) - Math.max(wy, ly)) /
            cell[1];
        for (let x = x0; x <= x1; x++) {
          const wx = min.x + x * cell[0],
            a =
              (opacity *
                az *
                ay *
                Math.max(0, Math.min(wx + cell[0], hx) - Math.max(wx, lx))) /
              cell[0];
          if (a <= 0) continue;
          const index = x + n * (y + ny * z),
            o = index * 4,
            old = data[o + 3] / 255,
            total = 1 - (1 - old) * (1 - a);
          for (let c = 0; c < 3; c++)
            data[o + c] =
              (((data[o + c] / 255) * old * (1 - a) + colour[c] * a) /
                Math.max(total, 0.0001)) *
              255;
          data[o + 3] = total * 255;
          kinds[index] |= kind;
        }
      }
    }
  }
  const query = (index) =>
    index.query(min.x, min.z, min.x + size.x, min.z + size.z);
  for (const patch of query(world.areaIndexes.grass)) {
    if (
      Math.abs(patch.x - (min.x + size.x / 2)) > size.x / 2 + 14 ||
      Math.abs(patch.z - (min.z + size.z / 2)) > size.z / 2 + 14
    )
      continue;
    yield;
    if (!grassRecords) {
      const points = world.grassPoints(patch.x, patch.z, patch.seed);
      for (let type = 0; type < points.length; type++)
        for (let i = 0; i < points[type].length; i += 2) {
          const t = points[type][i],
            s = t.s[1],
            profile = world.materialProfiles[GRASS_TYPES[type].name];
          stamp(
            [t.p[0], t.p[1] + s * 0.45, t.p[2]],
            [s * 0.4, s * 0.45, s * 0.4],
            profile.colour,
            Math.max(0.04, profile.coverage * 0.6),
            1,
          );
          counts.grass++;
        }
      continue;
    }
    const types = grassRecords.get(patch);
    for (let type = 0; type < types.length; type++) {
      const { matrices, colours, types: plantTypes } = types[type];
      for (let i = 0; i < matrices.length; i += 32) {
        const s = matrices[i + 5],
          c = (i / 16) * 3,
          profile =
            world.materialProfiles[
              GRASS_TYPES[plantTypes?.[i / 16] ?? type].name
            ];
        stamp(
          [matrices[i + 12], matrices[i + 13] + s * 0.45, matrices[i + 14]],
          [s * 0.4, s * 0.45, s * 0.4],
          profile.colour.map((v, k) => v * colours[c + k]),
          Math.max(0.04, profile.coverage * 0.6),
          1,
        );
        counts.grass++;
      }
    }
  }
  for (const object of query(world.areaIndexes.objects)) {
    yield;
    if (object.wood) {
      const { a, b, r } = object;
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(...a.map((v, i) => b[i] - v)) / Math.min(...cell)),
      );
      for (let i = 0; i <= steps; i++)
        stamp(
          a.map((v, k) => v + ((b[k] - v) * i) / steps),
          [r, r, r],
          [0.22, 0.15, 0.085],
          1,
          8,
        );
      counts.deadwood++;
      continue;
    }
    const { p, r, rock } = object;
    stamp(
      p,
      [r, r, r],
      rock ? [0.26, 0.25, 0.22] : [0.16, 0.25, 0.045],
      rock ? 0.85 : 0.2,
      rock ? 4 : 2,
    );
    counts[rock ? "rocks" : "shrubs"]++;
  }
  for (const t of query(world.areaIndexes.trees)) {
    if (
      t.x < min.x - 15 ||
      t.x > min.x + size.x + 15 ||
      t.z < min.z - 15 ||
      t.z > min.z + size.z + 15
    )
      continue;
    yield;
    const prototype = world.treePrototypes?.[t.variant],
      profile = world.materialProfiles[TREE_TYPES[prototype.species]];
    const tint = treeTint(t.seed);
    for (const leaf of prototype.leaves) {
      const p = new Vector3(...leaf.p)
        .multiplyScalar(t.scale)
        .applyAxisAngle(new Vector3(0, 1, 0), t.rotation)
        .add(new Vector3(t.x, t.y, t.z));
      const r = leaf.s[0] * t.scale * 0.48;
      stamp(
        p.toArray(),
        [r, r * 0.65, r],
        profile.colour.map((v, i) => v * tint[i] * (leaf.colour?.[i] ?? 1)),
        profile.coverage * 0.3,
        32,
      );
      counts.leaves++;
    }
    const paths = prototype?.paths || [];
    for (const path of paths)
      for (let j = 1; j < path.points.length; j++) {
        const a = path.points[j - 1]
          .clone()
          .multiplyScalar(t.scale)
          .applyAxisAngle(new Vector3(0, 1, 0), t.rotation)
          .add(new Vector3(t.x, t.y, t.z));
        const b = path.points[j]
          .clone()
          .multiplyScalar(t.scale)
          .applyAxisAngle(new Vector3(0, 1, 0), t.rotation)
          .add(new Vector3(t.x, t.y, t.z));
        const steps = Math.max(
            1,
            Math.ceil(a.distanceTo(b) / Math.min(...cell)),
          ),
          r = Math.max(0.04, path.radii[j - 1] * t.scale);
        for (let k = 0; k <= steps; k++)
          stamp(
            a
              .clone()
              .lerp(b, k / steps)
              .toArray(),
            [r, r, r],
            (
              path.reflectance ||
              [0.24, 0.17, 0.09].map((v, i) => v * (path.colour?.[i] ?? 1))
            ).map((v, i) => v * tint[i]),
            1,
            8,
          );
        counts.branches++;
      }
  }
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const wx = min.x + (x + 0.5) * cell[0],
        wz = min.z + (z + 0.5) * cell[2];
      if (Math.abs(wx - riverCenter(wz)) < 7) {
        stamp(
          [wx, riverLevel(wz), wz],
          [cell[0] / 2, 0.2, cell[2] / 2],
          [0.12, 0.24, 0.2],
          0.08,
          16,
        );
        counts.water++;
      }
    }
  const packed = new Uint8Array(data.length);
  for (let start = 0; start < data.length; start += 16384) {
    yield;
    for (let i = start; i < Math.min(start + 16384, data.length); i++)
      packed[i] = Math.round(data[i]);
  }
  return { data: packed, kinds, counts };
}

export function buildVoxelDetails(...args) {
  const it = voxelDetailChunks(...args);
  let r;
  do {
    r = it.next();
  } while (!r.done);
  return r.value;
}
