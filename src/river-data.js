import { riverSegments } from "./watershed.js";

// A single lattice owns every wet point, including confluences. Spatial pages
// share field values at their edges. Built once in the terrain worker.
export function buildRiverData(
  heightAt,
  { step = 2, chunkLength = 125, segments = riverSegments, extent = 4000 } = {},
) {
  if (!(step > 0 && chunkLength >= step && extent > 0))
    throw new Error("Invalid river mesh dimensions");
  const cells = Math.ceil(chunkLength / step),
    pageSize = cells * step;
  const half = extent / 2,
    pages = new Map();
  let length = 0;
  for (const s of segments) {
    const radius = Math.max(s.wa, s.wb) * 1.12 + step * 2;
    if (
      Math.min(s.ax, s.bx) > half ||
      Math.max(s.ax, s.bx) < -half ||
      Math.min(s.az, s.bz) > half ||
      Math.max(s.az, s.bz) < -half
    )
      continue;
    length += s.length;
    for (
      let z = Math.floor((Math.min(s.az, s.bz) - radius) / pageSize);
      z <= Math.floor((Math.max(s.az, s.bz) + radius) / pageSize);
      z++
    )
      for (
        let x = Math.floor((Math.min(s.ax, s.bx) - radius) / pageSize);
        x <= Math.floor((Math.max(s.ax, s.bx) + radius) / pageSize);
        x++
      ) {
        const key = `${x},${z}`;
        if (!pages.has(key)) pages.set(key, { x, z, segments: [] });
        pages.get(key).segments.push(s);
      }
  }
  const chunks = [],
    stride = cells + 1;
  // x,y,z, flowX,flowZ,speed,depth, signed wet boundary.
  const field = new Float64Array(stride * stride * 8);
  for (const page of pages.values()) {
    const position = [],
      normal = [],
      coord = [],
      flow = [],
      index = [];
    const vertices = new Map();
    for (let iz = 0; iz <= cells; iz++)
      for (let ix = 0; ix <= cells; ix++) {
        const x = (page.x * cells + ix) * step,
          z = (page.z * cells + iz) * step;
        let cover = -Infinity,
          sum = 0,
          level = 0,
          fx = 0,
          fz = 0;
        let nearest = Infinity,
          fallback = null,
          along = 0;
        for (const s of page.segments) {
          const t = Math.max(
            0,
            Math.min(1, ((x - s.ax) * s.fx + (z - s.az) * s.fz) / s.length),
          );
          const distance = Math.hypot(
            x - s.ax - s.fx * s.length * t,
            z - s.az - s.fz * s.length * t,
          );
          const width = s.wa + (s.wb - s.wa) * t;
          cover = Math.max(cover, width * 1.12 - distance);
          if (distance < nearest) {
            nearest = distance;
            fallback = s;
            along = t;
          }
          // Compact support makes shared page-edge values independent of distant candidates.
          const w = Math.max(0, 1 - distance / (width * 1.12 + step * 2)) ** 3;
          sum += w;
          level += (s.ay + (s.by - s.ay) * t) * w;
          fx += s.fx * w;
          fz += s.fz * w;
        }
        if (sum > 0) {
          level /= sum;
        } else {
          level = fallback.ay + (fallback.by - fallback.ay) * along;
          fx = fallback.fx;
          fz = fallback.fz;
        }
        const norm = Math.hypot(fx, fz);
        if (norm > 1e-9) {
          fx /= norm;
          fz /= norm;
        } else {
          fx = fallback.fx;
          fz = fallback.fz;
        }
        const depth = level - heightAt(x, z),
          i = (iz * stride + ix) * 8;
        field[i] = x;
        field[i + 1] = level;
        field[i + 2] = z;
        field[i + 3] = fx;
        field[i + 4] = fz;
        field[i + 5] =
          0.18 + 0.78 * Math.sqrt(Math.max(0, Math.min(1, depth / 1.6)));
        field[i + 6] = depth;
        field[i + 7] = Math.min(
          cover,
          depth - 0.005,
          half - Math.abs(x),
          half - Math.abs(z),
        );
      }
    function vertex(a, b = a) {
      // Canonical edge ordering gives identical interpolation on both sides.
      if (b < a) [a, b] = [b, a];
      const key = a === b ? a : `${a}:${b}`;
      if (vertices.has(key)) return vertices.get(key);
      const ai = a * 8,
        bi = b * 8;
      const t = a === b ? 0 : field[ai + 7] / (field[ai + 7] - field[bi + 7]);
      const v = [];
      for (let k = 0; k < 7; k++)
        v[k] = field[ai + k] + (field[bi + k] - field[ai + k]) * t;
      const n = Math.hypot(v[3], v[4]);
      const id = position.length / 3;
      position.push(Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2]));
      normal.push(0, 1, 0);
      coord.push(v[0], v[2]);
      flow.push(
        n > 1e-9 ? v[3] / n : field[ai + 3],
        n > 1e-9 ? v[4] / n : field[ai + 4],
        v[5],
        v[6],
      );
      vertices.set(key, id);
      return id;
    }
    function triangle(a, b, c) {
      const polygon = [],
        ids = [a, b, c];
      for (let j = 0; j < 3; j++) {
        const p = ids[j],
          q = ids[(j + 1) % 3],
          inside = field[p * 8 + 7] >= 0;
        if (inside) polygon.push(vertex(p));
        if (inside !== field[q * 8 + 7] >= 0) polygon.push(vertex(p, q));
      }
      for (let j = 1; j + 1 < polygon.length; j++) {
        const a = polygon[0],
          b = polygon[j],
          c = polygon[j + 1];
        const area =
          (position[b * 3 + 2] - position[a * 3 + 2]) *
            (position[c * 3] - position[a * 3]) -
          (position[b * 3] - position[a * 3]) *
            (position[c * 3 + 2] - position[a * 3 + 2]);
        if (area > 1e-8) index.push(a, b, c);
      }
    }
    for (let z = 0; z < cells; z++)
      for (let x = 0; x < cells; x++) {
        const a = z * stride + x,
          b = a + 1,
          c = a + stride,
          d = c + 1;
        if (
          Math.max(
            field[a * 8 + 7],
            field[b * 8 + 7],
            field[c * 8 + 7],
            field[d * 8 + 7],
          ) < 0
        )
          continue;
        triangle(a, c, b);
        triangle(b, c, d);
      }
    if (index.length)
      chunks.push({
        position: new Float32Array(position),
        normal: new Float32Array(normal),
        coord: new Float32Array(coord),
        flow: new Float32Array(flow),
        index: new Uint32Array(index),
      });
  }
  return { length, chunks };
}
