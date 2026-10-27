import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  grassBakeHabitat,
  grassColour,
  grassHabitat,
  grassPopulation,
} from "../src/habitat.js";
import { generateGrassBatches, grassLand } from "../src/grass-data.js";

const workerCode = await readFile(
  new URL("../src/atlas-worker.js", import.meta.url),
  "utf8",
);
function bake(input) {
  let result;
  const self = {
    postMessage: (value) => {
      result = value.levels;
    },
  };
  vm.runInNewContext(workerCode, { self, Uint8Array, Float32Array, Math });
  self.onmessage({ data: { id: 1, ...input } });
  return result;
}
function pixels(w, h, colour, response = 180) {
  const data = new Uint8Array(w * h * 4),
    normals = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    data.set(colour, i);
    normals.set([128, 255, 128, response], i);
  }
  return { w, h, data, normals };
}

// Fully covered mip texels must remain opaque for MSAA alpha-to-coverage.
// Previously the search reduced every level to just above the alpha cutoff.
for (const cutoff of [82, 87, 102]) {
  const levels = bake({
    record: {
      ...pixels(16, 16, [48, 120, 32, 255]),
      views: 1,
      cutoff,
      materialPayload: true,
    },
  });
  for (const level of levels)
    for (let i = 0; i < level.data.length; i += 4) {
      assert.equal(
        level.data[i + 3],
        255,
        "opaque coverage survives every mip",
      );
      assert.equal(
        level.normals[i + 3],
        180,
        "material response is independent of coverage correction",
      );
    }
}
// Packing downsamples source PNGs too; this must use linear light just like mips.
const checker = pixels(2, 2, [255, 255, 255, 255]);
checker.data.set([0, 0, 0, 255], 0);
checker.data.set([0, 0, 0, 255], 12);
const packed = bake({ sources: [checker], tileSize: 1 })[0];
assert.ok(
  packed.data[0] >= 187 && packed.data[0] <= 188,
  "linear 50% white packs to sRGB 188, not 128",
);
for (const value of [18, 48, 120, 180, 254, 255]) {
  const constant = pixels(32, 32, [value, value, value, 255]);
  const levels = bake({ record: { ...constant, views: 1, srgb: true } });
  for (const level of levels)
    assert.equal(
      level.data[0],
      value,
      "constant sRGB must not darken through repeated quantization",
    );
}
const cutout = pixels(2, 2, [60, 180, 30, 255]);
cutout.data.set([255, 0, 255, 0], 0);
const edge = bake({ sources: [cutout], tileSize: 1 })[0];
assert.ok(Math.abs(edge.data[0] - 60) <= 1);
assert.ok(Math.abs(edge.data[1] - 180) <= 1);
assert.ok(
  Math.abs(edge.data[2] - 30) <= 1,
  "hidden RGB cannot tint a visible blade",
);

const land = {
  height: 0,
  traffic: 0,
  slope: 0,
  root: 0,
  riverDistance: 100,
  moisture: 0.55,
  forest: 0,
  wetness: 0,
  canopy: 0,
};
for (let k = 0; k < 4; k++) {
  const habitat = grassBakeHabitat(k);
  assert.deepEqual(grassColour(habitat), [1, 1, 1]);
  const population = [
    ...grassPopulation(0, 0, 981 + k, 64, 2.8, () => land, habitat),
  ];
  assert.ok(population.length > 40);
  for (const plant of population) {
    assert.equal(plant.colour[0], plant.colour[1]);
    assert.equal(plant.colour[1], plant.colour[2]);
  }
}
let checked = 0;
for (const x of [-120, 0, 420]) {
  const groups = generateGrassBatches({
    x,
    z: 80,
    seed: 42,
    level: 2,
    land: grassLand(x, 80, () => land),
  });
  for (const group of groups)
    for (let i = 0; i < group.colours.length / 3; i++) {
      const expected = grassColour(
        grassHabitat(
          group.matrices[i * 16 + 12],
          group.matrices[i * 16 + 14],
          land,
        ),
      );
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(group.colours[i * 3 + c] - expected[c]) < 0.00001,
          "patch receives the same habitat RGB as near plants",
        );
      checked++;
    }
}
assert.ok(checked > 300);
console.log(
  `LOD colour checks pass: opaque mips, linear packing, transparent edges, four neutral captures, ${checked} habitat tints.`,
);
