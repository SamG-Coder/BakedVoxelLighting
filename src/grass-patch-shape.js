// A baked colony has a loose, lobed outline and shorter growth at its margins.
// This is applied to the source plants, so every captured view retains the same
// silhouette and represented normals rather than masking a square at runtime.
export function grassPatchEdge(x, z, variant = 0) {
  const angle = Math.atan2(z, x);
  const radius = Math.hypot(x / 1.28, z / 1.02);
  const boundary =
    1 +
    0.15 * Math.sin(angle * 3 + variant * 1.7) +
    0.09 * Math.sin(angle * 5 - variant * 0.9);
  if (radius >= boundary) return 0;
  const t = Math.max(0, Math.min(1, (radius / boundary - 0.22) / 0.78));
  return 1 - t * t * (3 - 2 * t);
}
