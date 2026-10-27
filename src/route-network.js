// Preparation-only projection: branch origins must belong to an existing road,
// rather than to a fixed world coordinate that becomes stranded after erosion.
export function nearestRoutePoint(route, point) {
  if (!route.length)
    throw new Error("Cannot attach a branch to an empty route");
  let best = Infinity;
  let result = route[0].slice();
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1],
      b = route[i];
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const length2 = dx * dx + dz * dz;
    const t = length2
      ? Math.max(
          0,
          Math.min(
            1,
            ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length2,
          ),
        )
      : 0;
    const x = a[0] + dx * t,
      z = a[1] + dz * t;
    const distance2 = (point[0] - x) ** 2 + (point[1] - z) ** 2;
    if (distance2 < best) {
      best = distance2;
      result = [x, z];
    }
  }
  return result;
}
