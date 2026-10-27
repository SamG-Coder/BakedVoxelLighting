// Static, packed trunk index. Render LOD/unloading never changes collisions.
const CELL = 16,
  HALF = 2048,
  N = 256;
const cell = (v) => Math.max(0, Math.min(N - 1, Math.floor((v + HALF) / CELL)));
export class WalkCollision {
  constructor(trees, prototypes) {
    this.head = new Int32Array(N * N).fill(-1);
    this.next = new Int32Array(trees.length);
    this.data = new Float32Array(trees.length * 5);
    this.result = { x: 0, z: 0 };
    this.checks = 0;
    this.logs = [];
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i],
        path = prototypes[t.variant].paths.find((p) => p.rootFlare);
      if (!path) {
        this.next[i] = -1;
        continue;
      }
      // Sample the real prototype trunk at body height, above the root flare.
      const y = 1 / t.scale;
      let j = 0;
      while (j < path.points.length - 2 && path.points[j + 1].y < y) j++;
      const a = path.points[j],
        b = path.points[j + 1];
      const u = Math.max(0, Math.min(1, (y - a.y) / (b.y - a.y)));
      const x = (a.x + (b.x - a.x) * u) * t.scale;
      const z = (a.z + (b.z - a.z) * u) * t.scale;
      const r =
        (path.radii[j] + (path.radii[j + 1] - path.radii[j]) * u) * t.scale;
      const c = Math.cos(t.rotation),
        s = Math.sin(t.rotation),
        k = i * 5;
      this.data[k] = t.x + c * x + s * z;
      this.data[k + 1] = t.z - s * x + c * z;
      this.data[k + 2] = t.y;
      this.data[k + 3] = r + 0.04;
      this.data[k + 4] = path.points.at(-1).y * t.scale;
      const bucket = cell(this.data[k]) + cell(this.data[k + 1]) * N;
      this.next[i] = this.head[bucket];
      this.head[bucket] = i;
    }
  }
  nearTrees(origin, reach, trees, result) {
    const gx = cell(origin.x),
      gz = cell(origin.z),
      n = Math.ceil(reach / CELL) + 1;
    for (let z = Math.max(0, gz - n); z <= Math.min(N - 1, gz + n); z++)
      for (let x = Math.max(0, gx - n); x <= Math.min(N - 1, gx + n); x++)
        for (let i = this.head[x + z * N]; i >= 0; i = this.next[i]) {
          const k = i * 5,
            r = reach + this.data[k + 3];
          if (
            !trees[i].felled &&
            (this.data[k] - origin.x) ** 2 +
              (this.data[k + 1] - origin.z) ** 2 <
              r * r
          )
            result.push(i);
        }
    return result;
  }
  pickTree(origin, direction, reach, trees) {
    const gx = cell(origin.x),
      gz = cell(origin.z);
    let nearest = reach,
      found = -1;
    const a = direction.x * direction.x + direction.z * direction.z;
    if (a < 0.01) return -1;
    for (let z = Math.max(0, gz - 1); z <= Math.min(N - 1, gz + 1); z++)
      for (let x = Math.max(0, gx - 1); x <= Math.min(N - 1, gx + 1); x++)
        for (let i = this.head[x + z * N]; i >= 0; i = this.next[i]) {
          if (trees[i].felled) continue;
          const k = i * 5,
            dx = origin.x - this.data[k],
            dz = origin.z - this.data[k + 1],
            r = this.data[k + 3];
          const b = dx * direction.x + dz * direction.z,
            disc = b * b - a * (dx * dx + dz * dz - r * r);
          if (disc < 0) continue;
          const t = (-b - Math.sqrt(disc)) / a,
            y = origin.y + direction.y * t - this.data[k + 2];
          if (
            t >= 0 &&
            t < nearest &&
            y > 0.35 &&
            y < Math.min(2.2, this.data[k + 4])
          ) {
            nearest = t;
            found = i;
          }
        }
    return found;
  }
  move(x, z, targetX, targetZ, feetY) {
    const dx = targetX - x,
      dz = targetZ - z;
    // Small steps prevent sprinting through narrow saplings; sliding remains free.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.18));
    this.checks = 0;
    for (let step = 0; step < steps; step++) {
      x += dx / steps;
      z += dz / steps;
      for (let pass = 0; pass < 3; pass++) {
        const gx = cell(x),
          gz = cell(z);
        for (let iz = Math.max(0, gz - 1); iz <= Math.min(N - 1, gz + 1); iz++)
          for (
            let ix = Math.max(0, gx - 1);
            ix <= Math.min(N - 1, gx + 1);
            ix++
          )
            for (let i = this.head[ix + iz * N]; i >= 0; i = this.next[i]) {
              this.checks++;
              const k = i * 5;
              if (
                feetY + 1.7 < this.data[k + 2] ||
                feetY > this.data[k + 2] + this.data[k + 4]
              )
                continue;
              let vx = x - this.data[k],
                vz = z - this.data[k + 1];
              const radius = this.data[k + 3] + 0.28;
              let d = Math.hypot(vx, vz);
              if (d >= radius) continue;
              if (d < 0.00001) {
                vx = -dx || 1;
                vz = -dz;
                d = Math.hypot(vx, vz);
              }
              x = this.data[k] + (vx / d) * radius;
              z = this.data[k + 1] + (vz / d) * radius;
            }
        for (const log of this.logs) {
          const lx = log.bx - log.ax,
            lz = log.bz - log.az,
            length = lx * lx + lz * lz;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((x - log.ax) * lx + (z - log.az) * lz) /
                Math.max(0.0001, length),
            ),
          );
          const y = log.ay + (log.by - log.ay) * t;
          if (feetY + 1.7 < y - log.r || feetY > y + log.r) continue;
          const px = log.ax + lx * t,
            pz = log.az + lz * t,
            vx = x - px,
            vz = z - pz,
            d = Math.hypot(vx, vz),
            r = log.r + 0.28;
          if (d < r && d > 0.00001) {
            x = px + (vx / d) * r;
            z = pz + (vz / d) * r;
          }
        }
      }
    }
    this.result.x = x;
    this.result.z = z;
    return this.result;
  }
}
