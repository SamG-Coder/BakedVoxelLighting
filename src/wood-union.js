import * as T from "three/webgpu";
import { triTable } from "three/addons/objects/MarchingCubes.js";
import { barkColour } from "./plant-appearance.js";

// Sparse narrow-band implicit union, baked once per prototype. The marching
// cubes share their interpolated edge vertices: a fork is one surface.
export function unionWood(paths, plant, coarse = false) {
  const step = coarse ? 0.105 : 0.065,
    blend = 0.105,
    segments = [];
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let id = 0; id < paths.length; id++) {
    const path = paths[id];
    let distance = 0;
    for (let j = 1; j < path.points.length; j++) {
      const a = path.points[j - 1].toArray(),
        b = path.points[j].toArray(),
        d = b.map((v, k) => v - a[k]);
      const length = Math.hypot(...d),
        r0 = path.radii[j - 1],
        r1 = path.radii[j];
      const reach =
        path.rootFlare && a[1] < 1.5
          ? path.rootFlare.reach *
            Math.exp(-Math.pow(Math.max(0, a[1] + 0.22) / 0.4, 1.4))
          : 0;
      const pad = Math.max(r0, r1) + reach + blend + step * 2;
      const min = a.map((v, k) => Math.min(v, b[k]) - pad),
        max = a.map((v, k) => Math.max(v, b[k]) + pad);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], min[k]);
        hi[k] = Math.max(hi[k], max[k]);
      }
      const dir = d.map((v) => v / length);
      let right = [1 - dir[0] * dir[0], -dir[0] * dir[1], -dir[0] * dir[2]];
      if (Math.hypot(...right) < 0.01)
        right = [-dir[2] * dir[0], -dir[2] * dir[1], 1 - dir[2] * dir[2]];
      const rn = Math.hypot(...right);
      right = right.map((v) => v / rn);
      const forward = [
        dir[1] * right[2] - dir[2] * right[1],
        dir[2] * right[0] - dir[0] * right[2],
        dir[0] * right[1] - dir[1] * right[0],
      ];
      segments.push({
        a,
        b,
        d,
        length,
        dir,
        right,
        forward,
        r0,
        r1,
        id,
        min,
        max,
        distance,
        path,
      });
      distance += length;
    }
  }
  const dims = lo.map((v, k) => Math.ceil((hi[k] - v) / step) + 2),
    [nx, ny, nz] = dims;
  const values = new Float32Array(nx * ny * nz);
  values.fill(NaN);
  const key = (x, y, z) => x + nx * (y + ny * z),
    cells = new Set(),
    bins = new Map();
  const binKey = (x, y, z) => `${x},${y},${z}`;
  for (const seg of segments) {
    const mn = seg.min.map((v) => Math.floor(v)),
      mx = seg.max.map((v) => Math.floor(v));
    for (let z = mn[2]; z <= mx[2]; z++)
      for (let y = mn[1]; y <= mx[1]; y++)
        for (let x = mn[0]; x <= mx[0]; x++) {
          const k = binKey(x, y, z);
          if (!bins.has(k)) bins.set(k, []);
          bins.get(k).push(seg);
        }
    const a = seg.min.map((v, k) =>
        Math.max(0, Math.floor((v - lo[k]) / step)),
      ),
      b = seg.max.map((v, k) =>
        Math.min(dims[k] - 2, Math.ceil((v - lo[k]) / step)),
      );
    for (let z = a[2]; z <= b[2]; z++)
      for (let y = a[1]; y <= b[1]; y++)
        for (let x = a[0]; x <= b[0]; x++) cells.add(key(x, y, z));
  }
  function field(x, y, z, detail = false) {
    const candidates = bins.get(
      binKey(Math.floor(x), Math.floor(y), Math.floor(z)),
    );
    if (!candidates) return detail ? null : 1;
    const byPath = new Map();
    for (const s of candidates) {
      const delta = [x - s.a[0], y - s.a[1], z - s.a[2]];
      const t = Math.max(
        0,
        Math.min(
          1,
          (delta[0] * s.d[0] + delta[1] * s.d[1] + delta[2] * s.d[2]) /
            (s.length * s.length),
        ),
      );
      const radial = delta.map((v, k) => v - s.d[k] * t);
      let r = s.r0 + (s.r1 - s.r0) * t;
      if (s.path.rootFlare) {
        const theta = Math.atan2(
          radial[0] * s.forward[0] +
            radial[1] * s.forward[1] +
            radial[2] * s.forward[2],
          radial[0] * s.right[0] +
            radial[1] * s.right[1] +
            radial[2] * s.right[2],
        );
        r +=
          s.path.rootFlare.reach *
          (0.16 +
            0.84 *
              Math.pow(
                0.5 + 0.5 * Math.cos(theta * 5 + s.path.rootFlare.phase),
                4,
              )) *
          Math.exp(-Math.pow(Math.max(0, y + 0.22) / 0.4, 1.4));
      }
      const distance = Math.hypot(...radial) - r,
        old = byPath.get(s.id);
      if (!old || distance < old.distance)
        byPath.set(s.id, { distance, s, t, radial });
    }
    let result = Infinity,
      closest = null;
    for (const item of byPath.values()) {
      if (!closest || item.distance < closest.distance) closest = item;
      const h = Math.max(blend - Math.abs(result - item.distance), 0) / blend;
      result = Math.min(result, item.distance) - h * h * blend * 0.25;
    }
    return detail
      ? {
          ...closest,
          near: [...byPath.values()].filter(
            (v) => v.distance < closest.distance + blend,
          ),
        }
      : result;
  }
  function sample(x, y, z) {
    const k = key(x, y, z);
    if (Number.isNaN(values[k]))
      values[k] = field(lo[0] + x * step, lo[1] + y * step, lo[2] + z * step);
    return values[k];
  }
  const positions = [],
    normal = [],
    uv = [],
    colour = [],
    indices = [],
    edges = new Map();
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const cubeEdges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  function vertex(a, b, pa, pb, va, vb) {
    const id = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edges.has(id)) return edges.get(id);
    const t = va / (va - vb),
      p = pa.map((v, k) => v + (pb[k] - v) * t),
      i = positions.length / 3;
    positions.push(...p);
    edges.set(id, i);
    const e = step * 0.3,
      grad = [
        field(p[0] + e, p[1], p[2]) - field(p[0] - e, p[1], p[2]),
        field(p[0], p[1] + e, p[2]) - field(p[0], p[1] - e, p[2]),
        field(p[0], p[1], p[2] + e) - field(p[0], p[1], p[2] - e),
      ];
    const length = Math.hypot(...grad) || 1;
    normal.push(...grad.map((v) => v / length));
    const hit = field(...p, true);
    let u = 0,
      v = 0,
      total = 0;
    for (const h of hit.near) {
      const s = h.s;
      let theta = Math.atan2(
        h.radial.reduce((n, v, k) => n + v * s.forward[k], 0),
        h.radial.reduce((n, v, k) => n + v * s.right[k], 0),
      );
      if (theta < 0) theta += Math.PI * 2;
      const weight = Math.exp(-(h.distance - hit.distance) * 35);
      u +=
        ((theta / (2 * Math.PI)) *
          Math.max(0.18, (s.path.radii[0] * Math.PI * 2) / 0.85) +
          s.path.points[0].x * 0.19) *
        weight;
      v +=
        ((s.distance + s.length * h.t) * 0.28 +
          s.path.points[0].y * 0.17 +
          s.path.points[0].z * 0.13) *
        weight;
      total += weight;
    }
    uv.push(
      u / total + (plant.seed % 71) * 0.173,
      v / total + (plant.seed % 53) * 0.137,
    );
    colour.push(...barkColour(...p, plant.seed, plant.species));
    return i;
  }
  function triangle(a, b, c) {
    const p = [a, b, c].map((i) => positions.slice(i * 3, i * 3 + 3)),
      u = p[1].map((v, k) => v - p[0][k]),
      v = p[2].map((v, k) => v - p[0][k]);
    const cross = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    if (cross.reduce((s, v, k) => s + v * normal[a * 3 + k], 0) < 0)
      indices.push(a, c, b);
    else indices.push(a, b, c);
  }
  for (const k of cells) {
    const x = k % nx,
      y = Math.floor(k / nx) % ny,
      z = Math.floor(k / (nx * ny));
    const ids = corners.map((c) => key(x + c[0], y + c[1], z + c[2]));
    const vs = corners.map((c) => sample(x + c[0], y + c[1], z + c[2]));
    if (vs.every((v) => v >= 0) || vs.every((v) => v < 0)) continue;
    const ps = corners.map((c) => [
      lo[0] + (x + c[0]) * step,
      lo[1] + (y + c[1]) * step,
      lo[2] + (z + c[2]) * step,
    ]);
    const edge = (a, b) => vertex(ids[a], ids[b], ps[a], ps[b], vs[a], vs[b]);
    let mask = 0;
    vs.forEach((v, i) => {
      if (v < 0) mask |= 1 << i;
    });
    const intersections = new Map();
    const at = (i) => {
      if (!intersections.has(i)) intersections.set(i, edge(...cubeEdges[i]));
      return intersections.get(i);
    };
    for (let i = mask * 16; triTable[i] !== -1; i += 3)
      triangle(at(triTable[i]), at(triTable[i + 1]), at(triTable[i + 2]));
  }

  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new T.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("color", new T.Float32BufferAttribute(colour, 3));
  geometry.setIndex(indices);
  return geometry;
}
