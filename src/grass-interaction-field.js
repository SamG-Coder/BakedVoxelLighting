export const GRASS_FIELD_SIZE = 32;
export const GRASS_FIELD_STEP = 0.4;
const COUNT = GRASS_FIELD_SIZE * GRASS_FIELD_SIZE;
// A toroidal, world-anchored spring field, independent of vegetation streaming.
// Four floats per cell: displacement XYZ and contact weight. Storage is reused.
export class GrassInteractionField {
  constructor() {
    this.data = new Float32Array(COUNT * 4);
    this.previous = new Float32Array(COUNT * 4);
    this.velocity = new Float32Array(COUNT * 2);
    this.tagX = new Int32Array(COUNT).fill(2147483647);
    this.tagZ = new Int32Array(COUNT).fill(2147483647);
    this.active = false;
    this.updates = 0;
  }
  reset() {
    if (!this.active) return;
    this.data.fill(0);
    this.previous.fill(0);
    this.velocity.fill(0);
    this.tagX.fill(2147483647);
    this.tagZ.fill(2147483647);
    this.active = false;
  }
  update(x, z, vx, vz, dt) {
    this.previous.set(this.data);
    this.active = true;
    this.updates++;
    dt = Math.max(0, Math.min(0.05, dt));
    const cx = Math.floor(x / GRASS_FIELD_STEP),
      cz = Math.floor(z / GRASS_FIELD_STEP);
    const push = Math.min(1, Math.hypot(vx, vz) / 10);
    const speed = Math.max(0.001, Math.hypot(vx, vz));
    const contactDecay = Math.exp(-30 * dt),
      releaseDecay = Math.exp(-7 * dt);
    for (let iz = cz - 16; iz < cz + 16; iz++) {
      for (let ix = cx - 16; ix < cx + 16; ix++) {
        const i = (ix & 31) + (iz & 31) * 32,
          k = i * 4,
          v = i * 2;
        if (this.tagX[i] !== ix || this.tagZ[i] !== iz) {
          this.tagX[i] = ix;
          this.tagZ[i] = iz;
          this.data.fill(0, k, k + 4);
          this.previous.fill(0, k, k + 4);
          this.velocity[v] = this.velocity[v + 1] = 0;
        }
        const dx = ix * GRASS_FIELD_STEP - x,
          dz = iz * GRASS_FIELD_STEP - z;
        const r = Math.hypot(dx, dz),
          u = Math.max(0, Math.min(1, (1.15 - r) / 0.95));
        const weight = u * u * (3 - 2 * u);
        const tx =
          ((dx / Math.max(r, 0.16)) * 0.27 + (vx / speed) * push * 0.12) *
          weight;
        const tz =
          ((dz / Math.max(r, 0.16)) * 0.27 + (vz / speed) * push * 0.12) *
          weight;
        const omega = weight > 0.01 ? 30 : 7,
          decay = weight > 0.01 ? contactDecay : releaseDecay;
        // Exact critically damped integration, retaining velocity between frames.
        const ex = this.data[k] - tx,
          ez = this.data[k + 2] - tz;
        const jx = this.velocity[v] + omega * ex,
          jz = this.velocity[v + 1] + omega * ez;
        this.data[k] = tx + (ex + jx * dt) * decay;
        this.data[k + 2] = tz + (ez + jz * dt) * decay;
        this.velocity[v] = (this.velocity[v] - omega * jx * dt) * decay;
        this.velocity[v + 1] = (this.velocity[v + 1] - omega * jz * dt) * decay;
        this.data[k + 1] = -Math.hypot(this.data[k], this.data[k + 2]) * 0.3;
        this.data[k + 3] = weight;
      }
    }
  }
}
