import assert from "node:assert/strict";
import { WalkCollision } from "../src/walk-collision.js";
const prototypes = [
  {
    paths: [
      {
        rootFlare: {},
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 8, z: 0 },
        ],
        radii: [0.4, 0.4],
      },
    ],
  },
];
const tree = (x, z) => ({ x, y: 0, z, scale: 1, rotation: 0, variant: 0 });
const trees = [tree(0, 0), tree(16, 0)];
for (let i = 0; i < 10000; i++)
  trees.push(tree(200 + (i % 100) * 8, 200 + Math.floor(i / 100) * 8));
const grid = new WalkCollision(trees, prototypes);
const result = grid.move(-4, 0, 4, 0, 0);
assert.ok(result.x <= -0.719, "sprinting cannot tunnel through trunk");
assert.ok(
  grid.checks < 500,
  "queries inspect nearby cells rather than the forest",
);
assert.ok(
  Math.abs(grid.move(-4, 2, 4, 2, 0).x - 4) < 1e-10,
  "clear paths remain unobstructed",
);
assert.ok(
  grid.move(12, 0, 20, 0, 0).x < 15.3,
  "collision across spatial cell boundary",
);
assert.ok(
  Math.abs(grid.move(-4, 0, 4, 0, 20).x - 4) < 1e-10,
  "height-separated movement is not blocked",
);
let x = -2,
  z = -0.1;
for (let i = 0; i < 50; i++) {
  const p = grid.move(x, z, x + 0.12, z + 0.04, 0);
  x = p.x;
  z = p.z;
  assert.ok(Math.hypot(x, z) >= 0.719);
}
assert.ok(x > 1 && z > 1, "oblique movement slides around the trunk");
assert.equal(grid.result, result, "movement reuses its result object");
console.log(
  JSON.stringify({
    passed: true,
    trees: trees.length,
    bytes: grid.data.byteLength + grid.next.byteLength + grid.head.byteLength,
    sweptSubsteps: true,
    sliding: true,
  }),
);
