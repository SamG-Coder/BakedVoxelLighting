// Source identities are shared by placement, material baking and voxelization.
export const TREE_TYPES = ["oak", "birch", "ash", "pine"];
export const TREE_VARIANTS = TREE_TYPES.length * 3;
export const SHRUB_TYPES = ["hazel", "bramble", "elder"];
export const GRASS_TYPES = [
  { name: "meadow", height: [0.28, 0.56], width: [0.65, 1.05] },
  { name: "meadow-long", height: [0.65, 1.25], width: [0.82, 1.35] },
  { name: "meadow-seeds", height: [0.85, 1.5], width: [0.75, 1.2] },
  { name: "grass", height: [0.46, 0.95], width: [0.62, 1.05] },
  { name: "clover", height: [0.18, 0.38], width: [0.55, 0.9] },
  { name: "flowers-yellow", height: [0.45, 0.85], width: [0.65, 1.05] },
  { name: "flowers-purple", height: [0.65, 1.15], width: [0.65, 1.05] },
  { name: "fern", height: [0.4, 0.95], width: [0.75, 1.3] },
  { name: "bracken", height: [0.65, 1.35], width: [0.9, 1.55] },
  { name: "wild-strawberry", height: [0.12, 0.3], width: [0.35, 0.7] },
  { name: "grass-upright", height: [0.85, 1.45], width: [0.7, 1.1] },
  { name: "grass-fine", height: [0.45, 0.85], width: [1.05, 1.65] },
];
export const GRASS_COUNT = 3900;
export const GRASS_PATCH = {
  width: 4.2,
  height: 2.4,
  centerY: 1.15,
  count: 190,
};
export const GRASS_LOD_DISTANCES = [45, 110, 280];
export const PLANT_REVISION = "watershed-grass-coverage-v10";
export const GRASS_BASE_SHARE = 0.8;
// Preserve the full original ground-cover population. Sparse new silhouettes
// are an additional 25% of plants, not substitutes for dense meadow cover.
// Normalized proportions also feed distant colour and the four habitat bakes.
export const GRASS_MIXES = [
  [0.25, 0.43, 0.04, 0.025, 0.21, 0.03, 0.015, 0, 0, 0],
  [0.15, 0.2, 0.38, 0.22, 0.03, 0.015, 0.005, 0, 0, 0],
  [0.16, 0.3, 0.06, 0.03, 0.13, 0.2, 0.12, 0, 0, 0],
  [0.06, 0.02, 0, 0.15, 0.07, 0, 0, 0.3, 0.18, 0.22],
].map((base, habitat) => [
  ...base.map((weight) => weight * GRASS_BASE_SHARE),
  ...[
    [0.09, 0.11],
    [0.14, 0.06],
    [0.08, 0.12],
    [0.04, 0.16],
  ][habitat],
]);
