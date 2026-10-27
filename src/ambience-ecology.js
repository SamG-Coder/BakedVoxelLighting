// Deterministic resident territories; transient conversations use a bounded queue.
// Habitat data, not streamed meshes, owns sound placement.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const audioHash = (x, z, s = 0) => {
  let n =
    Math.imul(x, 374761393) ^
    Math.imul(z, 668265263) ^
    Math.imul(s + 1, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const SPECIES = [0, 1, 2, 5, 6],
  CELL = 64;
export class AmbienceEcology {
  constructor(sample) {
    this.sample = sample;
    this.serial = 0;
    this.nextCall = 0;
    this.pending = new Float64Array(8 * 7);
    this.pending.fill(-1);
    this.job = {
      x: 0,
      y: 0,
      z: 0,
      kind: 0,
      pitch: 1,
      duration: 0,
      seed: 0,
      territory: "",
      member: 0,
      response: false,
    };
  }
  member(gx, gz, member, kind, serial, response) {
    const anchorX = (gx + 0.2 + audioHash(gx, gz, 4) * 0.6) * CELL,
      anchorZ = (gz + 0.2 + audioHash(gx, gz, 6) * 0.6) * CELL;
    const angle = audioHash(gx, gz, member + 20) * Math.PI * 2,
      reach = member ? 8 + audioHash(gx, gz, member + 30) * 15 : 0;
    const x = anchorX + Math.cos(angle) * reach,
      z = anchorZ + Math.sin(angle) * reach;
    if (Math.abs(x) > 1990 || Math.abs(z) > 1990) return null;
    const h = this.sample(x, z),
      forest = clamp(Math.max(h.canopy, h.forest || 0), 0, 1);
    if (h.traffic > 0.4 || forest < (kind === 7 || kind === 8 ? 0.02 : 0.12))
      return null;
    const job = this.job;
    job.x = x;
    job.z = z;
    job.y =
      h.height +
      (kind === 7 ? 0.3 : kind === 8 ? 1 : kind === 5 ? 1.8 : 3 + forest * 7);
    job.kind = kind;
    job.pitch = 0.9 + audioHash(gx, gz, member + 45) * 0.2;
    job.duration =
      kind === 4
        ? 0.5
        : kind === 8
          ? 0.75
          : kind === 9
            ? 0.6 + audioHash(serial, 19) * 0.5
            : kind === 6
              ? 6.2
              : kind === 3
                ? 2.8
                : 2 + audioHash(serial, 19) * 2;
    job.seed = (audioHash(gx, gz, serial + member) * 2147483647) | 0;
    job.territory = `${gx},${gz}`;
    job.member = member;
    job.response = response;
    return job;
  }
  next(t, x, y, z, hour) {
    const day = hour >= 5 && hour < 20,
      q = this.pending;
    for (let i = 0; i < 8; i++) {
      const k = i * 7;
      if (q[k] < 0) continue;
      if (
        t - q[k] > 4 ||
        Boolean(q[k + 6]) !== day ||
        Math.hypot((q[k + 1] + 0.5) * CELL - x, (q[k + 2] + 0.5) * CELL - z) >
          145
      ) {
        q[k] = -1;
        continue;
      }
      if (q[k] > t) continue;
      q[k] = -1;
      const job = this.member(
        q[k + 1],
        q[k + 2],
        q[k + 3],
        q[k + 4],
        q[k + 5],
        true,
      );
      if (job) return job;
    }
    if (t < this.nextCall) return null;
    const n = ++this.serial,
      chorus = day && (hour < 8 || hour > 17);
    this.nextCall =
      t + (day ? (chorus ? 2 : 4) : 7) + audioHash(n, 3) * (day ? 5 : 10);
    for (let attempt = 0; attempt < 6; attempt++) {
      const serial = n * 7 + attempt,
        gx = Math.floor(x / CELL) + Math.floor(audioHash(serial, 7) * 3) - 1,
        gz = Math.floor(z / CELL) + Math.floor(audioHash(serial, 11) * 3) - 1;
      const species =
          SPECIES[Math.floor(audioHash(gx, gz, 13) * SPECIES.length)],
        member = Math.floor(audioHash(serial, 21) * 3),
        choice = audioHash(serial, 23);
      const kind = day
        ? choice < 0.08
          ? 8
          : choice < 0.14
            ? 4
            : choice < 0.4
              ? 9
              : species
        : choice < 0.22
          ? 3
          : choice < 0.85
            ? 7
            : 8;
      const job = this.member(gx, gz, member, kind, serial, false);
      if (!job || Math.abs(job.y - y) > 65) continue;
      // Contact calls often get an answer from another member. Territorial songs
      // occasionally receive a neighbour's phrase. Leave space, don't chorus in sync.
      if (
        day &&
        kind !== 8 &&
        kind !== 4 &&
        audioHash(serial, 25) < (kind === 9 ? 0.8 : 0.24)
      ) {
        for (let i = 0; i < 8; i++) {
          const k = i * 7;
          if (q[k] >= 0) continue;
          q[k] = t + job.duration + 0.45 + audioHash(serial, 29) * 1.5;
          q[k + 1] = gx;
          q[k + 2] = gz;
          q[k + 3] = (member + 1 + Math.floor(audioHash(serial, 31) * 2)) % 3;
          q[k + 4] = kind === 9 ? 9 : species;
          q[k + 5] = serial + 991;
          q[k + 6] = 1;
          break;
        }
      }
      return job;
    }
    return null;
  }
}
