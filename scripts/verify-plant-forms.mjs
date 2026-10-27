import assert from "node:assert/strict";
import { growStructure } from "../src/plant-growth.js";
import { leafColour } from "../src/plant-appearance.js";
import { TREE_VARIANTS, SHRUB_TYPES } from "../src/plant-catalog.js";

// Existing production budgets, before the species architecture revision.
const budgets = [
  [346, 373],
  [418, 453],
  [382, 413],
  [202, 247],
  [490, 533],
  [562, 613],
  [526, 573],
  [272, 338],
  [526, 573],
  [634, 693],
  [562, 613],
  [302, 377],
  [168, 240],
  [231, 330],
  [210, 300],
];
assert.equal(TREE_VARIANTS, 12);
assert.equal(SHRUB_TYPES.length, 3);
const plants = budgets.map((budget, i) => {
  const shrub = i >= 12,
    species = shrub ? i - 12 : i % 4;
  const p = growStructure(
    shrub ? 552 + species * 83 : 9801 + i * 137,
    species,
    shrub,
    shrub ? 1 : Math.floor(i / 4),
  );
  assert.deepEqual(
    [p.segments.length, p.leaves.length],
    budget,
    `prototype ${i} keeps its branch and foliage budget`,
  );
  for (const path of p.paths) {
    assert.ok(path.points.every((v) => v.toArray().every(Number.isFinite)));
    assert.ok(path.radii.every((v) => Number.isFinite(v) && v > 0));
    for (let j = 1; j < path.points.length; j++)
      assert.ok(path.points[j].distanceToSquared(path.points[j - 1]) > 1e-9);
    if (path.trunkFraction !== undefined)
      assert.ok(
        path.trunkFraction > 0 && path.trunkFraction < 0.96,
        "all scaffold attachments stay below the leader, including old pine whorls",
      );
  }
  for (const l of p.leaves) {
    assert.ok(l.colour.every((v) => Number.isFinite(v) && v > 0));
    // A leaf spray remains connected to the twig that supports it.
    const reach = Math.hypot(...l.p.map((v, j) => v - l.attachment[j]));
    assert.ok(Math.abs(reach - l.s[1] * 0.46) < 1e-6);
  }
  return p;
});
function width(p) {
  const x = p.leaves.map((l) => l.p[0]);
  const z = p.leaves.map((l) => l.p[2]);
  return Math.max(
    Math.max(...x) - Math.min(...x),
    Math.max(...z) - Math.min(...z),
  );
}
function tipLift(p) {
  const tips = p.paths.filter((path) => path.order === 0);
  return (
    tips.reduce(
      (sum, path) => sum + path.points.at(-1).y - path.points.at(-2).y,
      0,
    ) / tips.length
  );
}
for (let species = 0; species < 4; species++) {
  const youngRoot = plants[species].paths.find((p) => p.rootFlare);
  const oldRoot = plants[8 + species].paths.find((p) => p.rootFlare);
  assert.ok(
    youngRoot.rootFlare.reach < youngRoot.radii[0],
    "sapling flare is smaller than its trunk radius",
  );
  assert.ok(
    oldRoot.rootFlare.reach > youngRoot.rootFlare.reach * 5,
    "exposed buttresses develop with age",
  );
  assert.ok(
    width(plants[8 + species]) > width(plants[4 + species]) * 1.3,
    "open-grown crowns are broader than competition-grown crowns",
  );
  assert.ok(width(plants[4 + species]) > width(plants[species]) * 1.3);
}
for (const i of [1, 5, 9])
  assert.ok(tipLift(plants[i]) < 0, "birch twig tips hang");
for (const i of [0, 4, 8])
  assert.ok(tipLift(plants[i]) > 0, "oak twigs turn upward");
assert.ok(
  width(plants[13]) > width(plants[12]) * 1.4,
  "brambles spread below hazel crowns",
);
assert.ok(tipLift(plants[13]) < 0 && tipLift(plants[14]) > 0);
const ash = plants[6].paths.filter((p) => p.trunkFraction !== undefined);
for (let i = 0; i + 1 < ash.length; i += 2)
  assert.deepEqual(
    ash[i].attachment.p.toArray(),
    ash[i + 1].attachment.p.toArray(),
    "ash scaffold pairs share a node",
  );
assert.deepEqual(
  plants[8],
  growStructure(9801 + 8 * 137, 0, false, 2),
  "worker and HLOD inputs are deterministic",
);
assert.notDeepEqual(leafColour(1, 3, 2, 42, 0), leafColour(1, 3, 2, 42, 3));
console.log(
  "15 plant budgets, connected sprays, species architecture, age silhouettes and deterministic bake inputs pass.",
);
