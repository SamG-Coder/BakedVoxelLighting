import * as T from "three/webgpu";
import { WorkerClient } from "./worker-client.js";
const worker = new WorkerClient(
  new Worker(new URL("./growth-worker.js", import.meta.url), {
    type: "module",
    name: "tree surface baker",
  }),
  "tree surface baker",
);
export function clearTreeBakes() {
  return worker.run("clear", {});
}
export async function growTreeAsync(seed, species, age, identity) {
  const p = await worker.run("grow", { seed, species, age, identity });
  const hydrate = (r) => {
    const g = new T.BufferGeometry();
    for (const [k, v] of Object.entries(r.attributes))
      g.setAttribute(k, new T.BufferAttribute(v.array, v.itemSize));
    g.setIndex(new T.BufferAttribute(r.index, 1));
    return g;
  };
  return {
    ...p,
    paths: p.paths.map((path) => ({
      ...path,
      attachment: path.attachment
        ? {
            ...path.attachment,
            p: new T.Vector3().copy(path.attachment.p),
            d: new T.Vector3().copy(path.attachment.d),
          }
        : undefined,
      points: path.points.map((v) => new T.Vector3(...v)),
    })),
    joints: p.joints.map((v) => new T.Vector3(...v)),
    high: hydrate(p.high),
    low: hydrate(p.low),
    farWood: hydrate(p.farWood),
  };
}
