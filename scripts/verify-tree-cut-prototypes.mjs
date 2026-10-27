import { growPlant } from "../src/growth.js";
import {
  createCutState,
  cutState,
  packGeometry,
  disposeCutState,
} from "../src/tree-cut-core.js";
import assert from "node:assert/strict";
for (let species = 0; species < 4; species++) {
  const p = growPlant(9801 + (4 + species) * 137, species, false, 1);
  const path = p.paths.find((p) => p.rootFlare);
  let j = 0;
  while (path.points[j + 1].y < 1) j++;
  const a = path.points[j],
    b = path.points[j + 1],
    u = (1 - a.y) / (b.y - a.y);
  const section = {
    x: a.x + (b.x - a.x) * u,
    z: a.z + (b.z - a.z) * u,
    y: 1,
    radius: path.radii[j] + (path.radii[j + 1] - path.radii[j]) * u,
  };
  const begin = performance.now(),
    state = createCutState(packGeometry(p.high), section, 650, {
      x: 0.04,
      y: p.height / 2 || 5,
      z: 0.02,
    });
  let failed = false,
    maxVertices = 0,
    ms = [];
  for (let n = 1; n <= 20; n++) {
    const start = performance.now();
    const r = cutState(state, { angle: 0, depth: n * 0.06 });
    ms.push(Math.round(performance.now() - start));
    maxVertices = Math.max(
      maxVertices,
      r.band.attributes.position.array.length / 3,
    );
    for (const key of ["band", "chunk", "stump", "fallen"])
      if (r[key])
        assert(r[key].attributes.position.array.every(Number.isFinite));
    if (r.strength.failed) {
      failed = true;
      break;
    }
  }
  assert(failed);
  console.log(
    JSON.stringify({
      species,
      maxVertices,
      hits: ms.length,
      cutMs: ms,
      totalMs: Math.round(performance.now() - begin),
    }),
  );
  disposeCutState(state);
}
