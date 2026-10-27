import * as T from "three";

// Connectivity is evaluated in the worker after solid subtraction. Material/UV
// seams are welded for this graph only; the rendered vertices remain untouched.
export function splitLooseWood(source, low, high) {
  const g = source.index ? source.toNonIndexed() : source;
  const p = g.attributes.position,
    triangles = p.count / 3;
  const parent = new Int32Array(triangles);
  for (let i = 0; i < triangles; i++) parent[i] = i;
  const find = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  const vertices = new Map(),
    epsilon = 1e-5;
  for (let t = 0; t < triangles; t++)
    for (let j = 0; j < 3; j++) {
      const i = t * 3 + j,
        key = `${Math.round(p.getX(i) / epsilon)},${Math.round(p.getY(i) / epsilon)},${Math.round(p.getZ(i) / epsilon)}`;
      const previous = vertices.get(key);
      if (previous === undefined) vertices.set(key, t);
      else {
        const a = find(t),
          b = find(previous);
        if (a !== b) parent[a] = b;
      }
    }
  const groups = new Map();
  for (let t = 0; t < triangles; t++) {
    const root = find(t);
    let group = groups.get(root);
    if (!group) {
      group = { faces: [], anchored: false };
      groups.set(root, group);
    }
    group.faces.push(t);
    for (let j = 0; j < 3; j++) {
      const y = p.getY(t * 3 + j);
      if (y <= low + epsilon * 4 || y >= high - epsilon * 4)
        group.anchored = true;
    }
  }
  const loose = [...groups.values()].filter(
    (c) => !c.anchored && c.faces.length >= 4,
  );
  if (!loose.length) {
    if (g !== source) g.dispose();
    return null;
  }
  const looseIds = new Set(loose);
  const kept = [];
  for (const c of groups.values()) if (!looseIds.has(c)) kept.push(...c.faces);
  // Never remove the whole band because an input mesh was already disconnected.
  if (!kept.length) {
    if (g !== source) g.dispose();
    return null;
  }
  const material = new Int32Array(triangles);
  for (const group of g.groups)
    for (let i = group.start / 3; i < (group.start + group.count) / 3; i++)
      material[i] = group.materialIndex;
  function extract(faces) {
    const out = new T.BufferGeometry();
    for (const [name, a] of Object.entries(g.attributes)) {
      const array = new Float32Array(faces.length * 3 * a.itemSize);
      let at = 0;
      for (const t of faces)
        for (let j = 0; j < 3 * a.itemSize; j++)
          array[at++] = a.array[t * 3 * a.itemSize + j];
      out.setAttribute(name, new T.BufferAttribute(array, a.itemSize));
    }
    let start = 0,
      last = -1;
    for (let i = 0; i <= faces.length; i++) {
      const next = i < faces.length ? material[faces[i]] : -2;
      if (next !== last) {
        if (i > start) out.addGroup(start * 3, (i - start) * 3, last);
        start = i;
        last = next;
      }
    }
    out.computeBoundingBox();
    return out;
  }
  const result = {
    body: extract(kept),
    pieces: loose.map((c) => extract(c.faces)),
  };
  if (g !== source) g.dispose();
  return result;
}
