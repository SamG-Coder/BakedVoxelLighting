import { riverSegments } from "./watershed.js";

// All reaches share their junction coordinates, width and along-stream phase.
// Batch into spatial pages so tributaries do not become a draw per graph edge.
export function buildRiverData(heightAt, { step = 3, chunkLength = 125 } = {}) {
  const pages = new Map();
  const incoming = new Map();
  for (const s of riverSegments)
    if (!incoming.has(s.receiver) || incoming.get(s.receiver).area < s.area)
      incoming.set(s.receiver, s);
  const frames = new Map();
  for (const s of riverSegments) {
    const before = incoming.get(s.node) || s;
    const fx = before.fx + s.fx,
      fz = before.fz + s.fz,
      n = Math.hypot(fx, fz);
    frames.set(s.node, n > 0.1 ? [fx / n, fz / n] : [s.fx, s.fz]);
  }
  const across = 12,
    stride = across + 1;
  let length = 0;
  for (const s of riverSegments) {
    if (
      Math.max(Math.abs(s.ax), Math.abs(s.az), Math.abs(s.bx), Math.abs(s.bz)) >
      2000
    )
      continue;
    length += s.length;
    const key = `${Math.floor(((s.ax + s.bx) * 0.5) / chunkLength)},${Math.floor(((s.az + s.bz) * 0.5) / chunkLength)}`;
    let page = pages.get(key);
    if (!page)
      pages.set(
        key,
        (page = { position: [], normal: [], coord: [], flow: [], index: [] }),
      );
    const rows = Math.max(1, Math.ceil(s.length / step)),
      offset = page.position.length / 3;
    const startFrame = frames.get(s.node),
      endFrame = frames.get(s.receiver) || startFrame;
    for (let row = 0; row <= rows; row++) {
      const t = row / rows,
        cx = s.ax + (s.bx - s.ax) * t,
        cz = s.az + (s.bz - s.az) * t;
      const y = s.ay + (s.by - s.ay) * t,
        width = s.wa + (s.wb - s.wa) * t;
      let fx = startFrame[0] * (1 - t) + endFrame[0] * t,
        fz = startFrame[1] * (1 - t) + endFrame[1] * t;
      const norm = Math.hypot(fx, fz);
      fx /= norm;
      fz /= norm;
      for (let j = 0; j <= across; j++) {
        const lateral = ((j / across) * 2 - 1) * width * 1.12;
        const x = cx - fz * lateral,
          z = cz + fx * lateral,
          depth = y - heightAt(x, z);
        const speed =
          0.18 + 0.78 * Math.sqrt(Math.max(0, Math.min(1, depth / 1.6)));
        page.position.push(x, y, z);
        page.normal.push(0, 1, 0);
        page.coord.push(lateral, -s.station + s.length * t);
        page.flow.push(fx, fz, speed, depth);
        if (row < rows && j < across) {
          const i = offset + row * stride + j;
          page.index.push(
            i,
            i + 1,
            i + stride,
            i + 1,
            i + stride + 1,
            i + stride,
          );
        }
      }
    }
  }
  // At acute confluences an inner strip can cross its endpoint tangent.
  // Keep those connector triangles upward-facing as well as the ordinary reach.
  for (const p of pages.values()) {
    for (let j = 0; j < p.position.length; j++)
      p.position[j] = Math.fround(p.position[j]);
    let kept = 0;
    for (let k = 0; k < p.index.length; k += 3) {
      const a = p.index[k] * 3,
        b = p.index[k + 1] * 3,
        c = p.index[k + 2] * 3,
        v = p.position;
      const ny =
        (v[b + 2] - v[a + 2]) * (v[c] - v[a]) -
        (v[b] - v[a]) * (v[c + 2] - v[a + 2]);
      if (Math.abs(ny) < 1e-8) continue;
      const i0 = p.index[k],
        i1 = p.index[k + 1],
        i2 = p.index[k + 2];
      p.index[kept++] = i0;
      p.index[kept++] = ny < 0 ? i2 : i1;
      p.index[kept++] = ny < 0 ? i1 : i2;
    }
    p.index.length = kept;
  }
  return {
    length,
    chunks: Array.from(pages.values(), (p) => ({
      position: new Float32Array(p.position),
      normal: new Float32Array(p.normal),
      coord: new Float32Array(p.coord),
      flow: new Float32Array(p.flow),
      index: new Uint32Array(p.index),
    })),
  };
}
