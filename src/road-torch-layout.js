// Arc-length placement is independent of route tessellation and camera motion.
// Follow one verge continuously: no alternating/random scatter across the road.
export function roadTorchLayout(
  routes,
  height,
  random,
  { traffic, clear = () => true } = {},
) {
  const result = [];
  routes.forEach((route, routeIndex) => {
    let remaining = 8,
      travelled = 0;
    for (let i = 1; i < route.length; i++) {
      const [ax, az] = route[i - 1],
        [bx, bz] = route[i];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.001) continue;
      let offset = 0;
      while (remaining <= length - offset) {
        offset += remaining;
        travelled += remaining;
        const cx = ax + ((bx - ax) * offset) / length;
        const cz = az + ((bz - az) * offset) / length;
        const nx = -(bz - az) / length,
          nz = (bx - ax) / length;
        let verge = [3.8, 2.4, 2][routeIndex] ?? 2.4;
        if (traffic) {
          // Same traffic field as the terrain shader: find the worn dirt's edge.
          verge = 0;
          while (verge < 12 && traffic(cx + nx * verge, cz + nz * verge) > 0.24)
            verge += 0.15;
          verge += 0.35;
        }
        const x = cx + nx * verge,
          z = cz + nz * verge;
        // Keep the row aligned. Skip obstructed sites rather than scatter poles.
        if (
          verge < 12 &&
          clear(x, z) &&
          !result.some((p) => Math.hypot(p.x - x, p.z - z) < 12)
        ) {
          result.push({
            x,
            y: height(x, z),
            z,
            head: 3.8 + random() * 0.4,
            yaw: random() * Math.PI * 2,
            route: routeIndex,
            distance: travelled,
            centre: [cx, cz],
            verge,
          });
        }
        remaining = 18;
      }
      remaining -= length - offset;
      travelled += length - offset;
    }
  });
  return result;
}

export function treeClearance(trees) {
  const cells = new Map();
  for (const t of trees) {
    const key = `${Math.floor(t.x / 8)},${Math.floor(t.z / 8)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(t);
  }
  return (x, z) => {
    const gx = Math.floor(x / 8),
      gz = Math.floor(z / 8);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const t of cells.get(`${gx + dx},${gz + dz}`) ?? [])
          if (Math.hypot(t.x - x, t.z - z) < 2.1) return false;
    return true;
  };
}
