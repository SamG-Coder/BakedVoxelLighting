import * as T from "three/webgpu";

// Metres. Shared by the rendered convex bit and continuous collision samples.
export const AXE_BIT_HEIGHT = 0.155;
export function axeEdge(v, out = new T.Vector3()) {
  return out.set(
    0.155 + 0.022 * Math.sin(Math.PI * v),
    0.59 + AXE_BIT_HEIGHT * v,
    0,
  );
}
export const AXE_EDGE_POINTS = Array.from({ length: 13 }, (_, i) =>
  axeEdge(i / 12),
);
export const AXE_EDGE_CENTER = axeEdge(0.5);

// Loft the two cheeks all the way to a 0.6 mm edge. The polished bevel is part
// of the solid surface, not a floating strip or a second overlapping extrusion.
export function axeHeadGeometry() {
  const stations = [0, 0.16, 0.32, 0.5, 0.7, 0.85, 1];
  const thickness = [0.019, 0.026, 0.027, 0.021, 0.013, 0.006, 0.0003];
  const rows = 24,
    positions = [],
    uvs = [],
    indices = [],
    groups = [];
  const edge = new T.Vector3();
  for (const side of [-1, 1]) {
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      axeEdge(v, edge);
      for (let i = 0; i < stations.length; i++) {
        const t = stations[i];
        const bottom =
          0.626 + (0.59 - 0.626) * t - 0.012 * Math.sin(Math.PI * t);
        const top = 0.704 + (0.745 - 0.704) * t;
        positions.push(
          T.MathUtils.lerp(-0.065, edge.x, t),
          T.MathUtils.lerp(bottom, top, v),
          side * thickness[i],
        );
        uvs.push(t, v);
      }
    }
  }
  const stride = stations.length,
    count = (rows + 1) * stride;
  function quad(a, b, c, d, mat) {
    const start = indices.length;
    indices.push(a, b, c, a, c, d);
    groups.push({ start, count: 6, materialIndex: mat });
  }
  for (let side = 0; side < 2; side++)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < stride - 1; i++) {
        const a = side * count + j * stride + i,
          b = a + 1,
          c = b + stride,
          d = a + stride;
        if (side === 1) quad(a, b, c, d, i === stride - 2 ? 1 : 0);
        else quad(a, d, c, b, i === stride - 2 ? 1 : 0);
      }
  for (let j = 0; j < rows; j++) {
    const a = j * stride,
      b = a + stride;
    quad(a, a + count, b + count, b, 0);
    const c = a + stride - 1,
      d = c + stride;
    quad(c, d, d + count, c + count, 1);
  }
  for (let i = 0; i < stride - 1; i++) {
    quad(i, i + 1, i + 1 + count, i + count, 0);
    const a = rows * stride + i;
    quad(a, a + count, a + count + 1, a + 1, 0);
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  // Group by material once, so hundreds of small loft quads are two draw calls.
  const sorted = [];
  for (let materialIndex = 0; materialIndex < 2; materialIndex++) {
    const start = sorted.length;
    for (const group of groups)
      if (group.materialIndex === materialIndex)
        sorted.push(...indices.slice(group.start, group.start + 6));
    g.addGroup(start, sorted.length - start, materialIndex);
  }
  g.setIndex(sorted);
  g.computeVertexNormals();
  // End/top faces need UV area across the thickness, otherwise the steel map
  // stretches into stripes along the poll and the top of the head.
  const result = g.toNonIndexed();
  const p = result.attributes.position, uv = result.attributes.uv;
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), n = new T.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p,i);b.fromBufferAttribute(p,i+1);c.fromBufferAttribute(p,i+2);
    n.crossVectors(b.sub(a),c.sub(a)).normalize();
    for(let j=i;j<i+3;j++) {
      if(Math.abs(n.y)>.75) uv.setXY(j,(p.getX(j)+.065)/.25,(p.getZ(j)+.027)/.054);
      else if(Math.abs(n.x)>.9) uv.setXY(j,(p.getZ(j)+.027)/.054,(p.getY(j)-.59)/.155);
    }
  }
  result.computeBoundingSphere();g.dispose();
  return result;
}
