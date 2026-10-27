import {
  createCutState,
  cutState,
  surfaceRecord,
  disposeCutState,
} from "./tree-cut-core.js";
import { unpackGeometry } from "./tree-cut-geometry.js";
import { MeshBVH } from "three-mesh-bvh";
function accelerator(record) {
  const g = unpackGeometry(record);
  g.clearGroups();
  const bvh = MeshBVH.serialize(
    new MeshBVH(g, { indirect: true, targetLeafSize: 8 }),
  );
  g.dispose();
  return bvh;
}
function transfers(value, buffers = new Set()) {
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) transfers(item, buffers);
  return buffers;
}
let state = null,
  key = null;
// A single serial worker and one resident cutting band bound memory regardless
// of how many world trees exist. A different target replays its small cut log.
self.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    if (data.type === "cancel") return;
    if (data.type === "colliders") {
      const result = data.geometry.map((record) => ({
        geometry: record,
        bvh: accelerator(record),
      }));
      self.postMessage(
        {
          id: data.id,
          result,
          workerMs: performance.now() - started,
        },
        [...transfers(result)],
      );
      return;
    }
    let initial = null;
    if (key !== data.key) {
      if (state) disposeCutState(state);
      state = createCutState(data.geometry, data.section, data.mass, data.com);
      key = data.key;
      for (const cut of data.history) cutState(state, cut);
    }
    if (data.needsInitial)
      initial = {
        bottom: surfaceRecord(state.bottom, state.section),
        top: surfaceRecord(state.top, state.section),
      };
    const result = { ...cutState(state, data.cut), initial };
    result.bvh = accelerator(result.band);
    const transfer = [...transfers(result)];
    self.postMessage(
      { id: data.id, result, workerMs: performance.now() - started },
      transfer,
    );
  } catch (error) {
    key = null;
    self.postMessage({ id: data.id, error: error.stack || String(error) });
  }
};
