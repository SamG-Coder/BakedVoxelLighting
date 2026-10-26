import { seededRandom } from "./habitat.js";
// Shared source records drive visible LODs and voxel occlusion independently.
export function deadwoodSegments(log, sample) {
  const rng = seededRandom(log.seed),
    direction = log.rotation;
  const length = log.length * log.scale,
    radius = log.radius * log.scale;
  const a = [log.x, sample(log.x, log.z).height + radius * 0.7, log.z];
  const b = [
    log.x + Math.cos(direction) * length,
    0,
    log.z + Math.sin(direction) * length,
  ];
  b[1] = sample(b[0], b[2]).height + radius * 0.65;
  let lift = 0;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12,
      x = a[0] + (b[0] - a[0]) * t,
      z = a[2] + (b[2] - a[2]) * t,
      land = sample(x, z);
    if (land.traffic > 0.14 || land.riverDistance < 10) return [];
    lift = Math.max(
      lift,
      land.height + radius * 0.65 - (a[1] + (b[1] - a[1]) * t),
    );
  }
  if (lift > 1.25) return [];
  a[1] += lift;
  b[1] += lift;
  const segments = [{ a, b, r: radius, trunk: true, decay: log.decay }];
  const stump = [
    a[0] - 0.65 * Math.cos(direction),
    sample(a[0], a[2]).height - 0.05,
    a[2] - 0.65 * Math.sin(direction),
  ];
  segments.push({
    a: stump,
    b: [stump[0], stump[1] + radius * 2.2, stump[2]],
    r: radius * 1.05,
    trunk: true,
    decay: log.decay,
  });
  for (let i = 0; i < 4; i++) {
    const t = 0.18 + i * 0.19,
      origin = a.map((v, k) => v + (b[k] - v) * t);
    const angle = direction + (i % 2 ? 1 : -1) * (1 + rng() * 0.45),
      reach = 0.7 + rng() * 1.5;
    const x = origin[0] + Math.cos(angle) * reach,
      z = origin[2] + Math.sin(angle) * reach;
    const end = [
      x,
      Math.max(sample(x, z).height + radius * 0.15, origin[1] - 0.25),
      z,
    ];
    segments.push({
      a: origin,
      b: end,
      r: radius * (0.13 + rng() * 0.12),
      trunk: false,
      decay: log.decay,
    });
  }
  return segments;
}
