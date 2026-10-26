import * as T from "three/webgpu";
import { WorkerClient } from "./worker-client.js";
// Two bounded workers overlap independent prototype bakes without a large
// memory spike from running all twelve implicit surfaces at once.
const workers = Array.from(
  { length: 2 },
  (_, i) =>
    new WorkerClient(
      new Worker(new URL("./growth-worker.js", import.meta.url), {
        type: "module",
        name: `tree surface baker ${i}`,
      }),
      "tree surface baker",
    ),
);
let nextWorker = 0;
const tails = workers.map(() => Promise.resolve());
function run(type, payload) {
  const i = nextWorker++ % workers.length;
  const job = tails[i].then(() => workers[i].run(type, payload));
  tails[i] = job.catch(() => {});
  return job;
}
export function clearTreeBakes() {
  return Promise.all(tails).then(() => workers[0].run("clear", {}));
}
export async function growTreeAsync(
  seed,
  species,
  age,
  identity,
  shrub = false,
) {
  const p = await run("grow", { seed, species, age, identity, shrub });
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
