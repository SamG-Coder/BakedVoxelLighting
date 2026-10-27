// Lamps belong to route features, not a continuous row through wild woodland.
export function routeLandmarks(routes) {
  const landmarks = [];
  for (let r = 1; r < routes.length; r++) {
    const branch = routes[r];
    if (!branch?.length) continue;
    for (let other = 0; other < r; other++) {
      const route = routes[other];
      let travelled = 0;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1],
          b = route[i];
        const dx = b[0] - a[0],
          dz = b[1] - a[1],
          length = Math.hypot(dx, dz);
        if (!length) continue;
        const add = (t) => {
          const x = a[0] + dx * t,
            z = a[1] + dz * t;
          // Shared vertices and closely spaced crossings describe one junction.
          if (!landmarks.some((p) => Math.hypot(p.x - x, p.z - z) < 24))
            landmarks.push({
              route: other,
              distance: travelled + length * t,
              kind: "junction",
              x,
              z,
            });
        };
        for (let j = 1; j < branch.length; j++) {
          const c = branch[j - 1],
            d = branch[j];
          const ex = d[0] - c[0],
            ez = d[1] - c[1];
          const determinant = dx * ez - dz * ex;
          if (Math.abs(determinant) < 1e-9) continue;
          const qx = c[0] - a[0],
            qz = c[1] - a[1];
          const t = (qx * ez - qz * ex) / determinant;
          const u = (qx * dz - qz * dx) / determinant;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) add(t);
        }
        // A path may end at the verge instead of exactly on the centreline.
        for (const endpoint of [branch[0], branch.at(-1)]) {
          const t = Math.max(
            0,
            Math.min(
              1,
              ((endpoint[0] - a[0]) * dx + (endpoint[1] - a[1]) * dz) /
                (length * length),
            ),
          );
          if (
            Math.hypot(
              endpoint[0] - a[0] - dx * t,
              endpoint[1] - a[1] - dz * t,
            ) < 4
          )
            add(t);
        }
        travelled += length;
      }
    }
  }
  return landmarks;
}
export function roadTorchLayout(
  routes,
  height,
  random,
  { traffic, clear = () => true, landmarks = routeLandmarks(routes) } = {},
) {
  const result = [];
  for (const landmark of landmarks) {
    const route = routes[landmark.route];
    if (!route) continue;
    // One landmark lamp; bridge approaches may supply their own two markers.
    const target = Math.max(0, landmark.distance - 7);
    let travelled = 0;
    for (let i = 1; i < route.length; i++) {
      const [ax, az] = route[i - 1],
        [bx, bz] = route[i];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.001) continue;
      if (target > travelled + length) {
        travelled += length;
        continue;
      }
      const t = (target - travelled) / length;
      const cx = ax + (bx - ax) * t,
        cz = az + (bz - az) * t;
      for (const side of [1, -1]) {
        const nx = (-(bz - az) / length) * side,
          nz = ((bx - ax) / length) * side;
        let verge = [3.8, 2.4, 2][landmark.route] ?? 2.4;
        if (traffic) {
          verge = 0;
          while (verge < 12 && traffic(cx + nx * verge, cz + nz * verge) > 0.24)
            verge += 0.15;
          verge += 0.35;
        }
        const x = cx + nx * verge,
          z = cz + nz * verge;
        if (
          verge < 12 &&
          clear(x, z) &&
          !result.some((p) => Math.hypot(p.x - x, p.z - z) < 24)
        ) {
          result.push({
            x,
            y: height(x, z),
            z,
            head: 3.8 + random() * 0.4,
            yaw: random() * Math.PI * 2,
            route: landmark.route,
            distance: target,
            centre: [cx, cz],
            verge,
            kind: landmark.kind,
          });
          break;
        }
      }
      break;
    }
  }
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
