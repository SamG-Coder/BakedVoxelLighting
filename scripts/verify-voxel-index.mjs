import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoxelTreeGrid } from "../src/voxel-tree-grid.js";
import { mergedClusterBounds, bakeMergedCluster } from "../src/merged-data.js";
const inside = (t, x, y, z) =>
  Math.hypot(x - t[0], z - t[2]) < t[3] * 0.42 &&
  y - t[1] > 0 &&
  y - t[1] < t[3] * 8;
test("indexed trunk occupancy matches exhaustive lookup across volume boundaries", () => {
  const n = 32,
    min = { x: -64, y: -8, z: 32 },
    size = { x: 128, y: 64, z: 128 };
  let seed = 451;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const trees = Array.from({ length: 1500 }, () => ({
    x: -68 + random() * 136,
    y: -10 + random() * 20,
    z: 28 + random() * 136,
    scale: 0.3 + random() * 8,
  }));
  const grid = buildVoxelTreeGrid(trees, n, min, size);
  const source = trees.map((t) => [t.x, t.y, t.z, t.scale].map(Math.fround));
  let candidates = 0;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const head = (x + z * n) * 4,
        offset = grid.data[head],
        count = grid.data[head + 1];
      candidates += count;
      for (let y = 0; y < n / 2; y++) {
        const p = [
          min.x + ((x + 0.5) * size.x) / n,
          min.y + ((y + 0.5) * size.y) / (n / 2),
          min.z + ((z + 0.5) * size.z) / n,
        ];
        let indexed = false;
        for (let i = 0; i < count; i++)
          if (
            inside(
              grid.data.subarray((offset + i) * 4, (offset + i + 1) * 4),
              ...p,
            )
          ) {
            indexed = true;
            break;
          }
        assert.equal(
          indexed,
          source.some((t) => inside(t, ...p)),
          `cell ${x},${y},${z}`,
        );
      }
    }
  assert.ok(candidates < (trees.length * n * n) / 100);
});
test("dense cells keep trunks beyond the old 1100-tree cap", () => {
  const trees = Array.from({ length: 1600 }, (_, i) => ({
    x: 0.5,
    y: i,
    z: 0.5,
    scale: 1,
  }));
  const g = buildVoxelTreeGrid(
    trees,
    4,
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 4, z: 4 },
  );
  assert.equal(g.data[1], 1600);
  assert.equal(g.data[(g.data[0] + 1599) * 4 + 1], 1599);
});
test("merged bounds enclose exact baked quads for arbitrary camera orientation", () => {
  const trees = [
    { x: 70, y: 5, z: -20, rotation: 0.7, scale: 2, variant: 0 },
    { x: -35, y: 12, z: 5, rotation: 2, scale: 0.4, variant: 0 },
  ];
  const prototypes = [{ center: [2, 6, -1], width: 14, height: 19 }];
  const bounds = mergedClusterBounds(trees, prototypes),
    record = bakeMergedCluster(trees, prototypes);
  for (let i = 0; i < record.position.length; i += 3) {
    const radius = Math.hypot(...record.position.subarray(i, i + 3));
    for (let a = 0; a < 3; a++) {
      assert.ok(record.plantCenter[i + a] - radius >= bounds.min[a] - 1e-5);
      assert.ok(record.plantCenter[i + a] + radius <= bounds.max[a] + 1e-5);
    }
  }
});
