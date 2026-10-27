// Three r186 deletes every attribute when a geometry is disposed, even when
// another geometry uses that buffer. Instance batches own their matrix/colour
// buffers, but lease the unchanged prototype vertices without copying them.
const leases = new WeakMap();
const installed = new WeakSet();
const prototypes = new WeakSet();
const base = (a) => (a?.isInterleavedBufferAttribute ? a.data : a);

export function leaseGeometry(source, target) {
  const attributes = new Set(
    [source.index, ...Object.values(source.attributes)]
      .filter(Boolean)
      .map(base),
  );
  if (!prototypes.has(source)) {
    prototypes.add(source);
    for (const a of attributes) leases.set(a, (leases.get(a) || 0) + 1);
    source.addEventListener("dispose", function releasePrototype() {
      source.removeEventListener("dispose", releasePrototype);
      prototypes.delete(source);
      for (const a of attributes) leases.set(a, leases.get(a) - 1);
    });
  }
  for (const a of attributes) leases.set(a, (leases.get(a) || 0) + 1);
  let released = false;
  const dispose = target.dispose;
  target.dispose = function () {
    if (released) return;
    released = true;
    for (const a of attributes) leases.set(a, leases.get(a) - 1);
    dispose.call(this);
  };
}

export function installGeometryLeases(renderer) {
  if (installed.has(renderer)) return;
  installed.add(renderer);
  const attributes = renderer._attributes;
  const remove = attributes.delete;
  attributes.delete = function (attribute) {
    if ((leases.get(base(attribute)) || 0) > 0) return null;
    return remove.call(this, attribute);
  };
}
