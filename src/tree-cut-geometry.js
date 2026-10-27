import * as T from "three/webgpu";
export function packGeometry(g) {
  const out = {
    attributes: {},
    index: g.index?.array.slice(),
    groups: g.groups.map((x) => ({ ...x })),
  };
  for (const name of ["position", "normal", "uv", "color", "moss"]) {
    const a = g.getAttribute(name);
    if (a)
      out.attributes[name] = { array: a.array.slice(), itemSize: a.itemSize };
  }
  return out;
}
export function unpackGeometry(record) {
  const g = new T.BufferGeometry();
  for (const [name, a] of Object.entries(record.attributes))
    g.setAttribute(name, new T.BufferAttribute(a.array, a.itemSize));
  if (record.index) g.setIndex(new T.BufferAttribute(record.index, 1));
  for (const group of record.groups || [])
    g.addGroup(group.start, group.count, group.materialIndex);
  if (!g.attributes.color)
    g.setAttribute(
      "color",
      new T.Float32BufferAttribute(
        new Float32Array(g.attributes.position.count * 3).fill(1),
        3,
      ),
    );
  if (!g.attributes.moss)
    g.setAttribute(
      "moss",
      new T.Float32BufferAttribute(
        new Float32Array(g.attributes.position.count),
        1,
      ),
    );
  return g;
}
