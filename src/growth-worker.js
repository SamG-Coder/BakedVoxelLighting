import { growPlant } from "./growth.js";
import { BakeCache } from "./cache.js";
const cache = new BakeCache("BakedTreeSurfaces-v1"),
  ready = cache.open();
self.onmessage = async ({
  data: { id, type, seed, species, age, identity, shrub = false },
}) => {
  try {
    await ready;
    if (type === "clear") {
      await cache.clear();
      self.postMessage({ id, result: true });
      return;
    }
    const key = `wood-union-v1:${identity}:${seed}:${species}:${age}:${shrub}`;
    let record = await cache.get(key);
    if (!record) {
      const plant = growPlant(seed, species, shrub, age);
      const pack = (g) => ({
        attributes: Object.fromEntries(
          Object.entries(g.attributes).map(([k, v]) => [
            k,
            { array: v.array, itemSize: v.itemSize },
          ]),
        ),
        index: g.index.array,
      });
      record = {
        ...plant,
        paths: plant.paths.map((p) => ({
          ...p,
          points: p.points.map((v) => v.toArray()),
        })),
        joints: plant.joints.map((v) => v.toArray()),
        segments: plant.segments.map((s) => ({
          ...s,
          a: s.a.toArray(),
          b: s.b.toArray(),
        })),
        high: pack(plant.high),
        low: pack(plant.low),
        farWood: pack(plant.farWood),
      };
      await cache.put(key, record);
    }
    const transfer = [];
    for (const k of ["high", "low", "farWood"]) {
      for (const v of Object.values(record[k].attributes))
        transfer.push(v.array.buffer);
      transfer.push(record[k].index.buffer);
    }
    self.postMessage({ id, result: record }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error.stack || String(error) });
  }
};
