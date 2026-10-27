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
      }
    }
    this.result.x = x;
    this.result.z = z;
    return this.result;
  }
}
