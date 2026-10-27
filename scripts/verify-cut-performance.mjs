import assert from "node:assert/strict";
import * as T from "three";
import {
  createCutState,
  cutState,
  packGeometry,
  disposeCutState,
} from "../src/tree-cut-core.js";
const geometry = new T.CylinderGeometry(0.35, 0.35, 3, 32);
geometry.translate(0, 1.5, 0);
const state = createCutState(
  packGeometry(geometry),
  { x: 0, y: 1, z: 0, radius: 0.35, low: 0.2, high: 2 },
  1,
  { x: 0, y: 1.5, z: 0 },
);
const times = [];
let vertices = 0,
  released = 0;
for (let i = 0; i < 48; i++) {
  const start = performance.now();
  const result = cutState(state, {
    angle: Math.sin(i * 1.7) * 0.24,
    y: 1 + (i % 2 ? -0.09 : 0.09) + Math.sin(i * 0.7) * 0.035,
    depth: 0.08 + Math.floor(i / 8) * 0.035,
    halfWidth: 0.085,
    halfHeight: 0.045,
    slope: i % 2 ? 0.6 : -0.6,
  });
  const ms = performance.now() - start;
  times.push(ms);
  vertices = Math.max(
    vertices,
    result.band.attributes.position.array.length / 3,
  );
  released += result.released.length;
  assert(result.band.attributes.position.array.every(Number.isFinite));
  if ((i + 1) % 8 === 0)
    console.log(
      JSON.stringify({
        hits: i + 1,
        lastMs: +ms.toFixed(1),
        vertices,
        released,
      }),
    );
}
const sorted = [...times].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    p50Ms: sorted[24],
    p95Ms: sorted[45],
    maxMs: sorted[47],
    vertices,
    released,
  }),
);
assert(vertices < 100000, "bounded cutting band topology");
disposeCutState(state);
