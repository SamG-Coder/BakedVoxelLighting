import * as T from "three/webgpu";
import { seededRandom } from "./habitat.js";
import { TREE_TYPES, SHRUB_TYPES } from "./plant-catalog.js";
const up = new T.Vector3(0, 1, 0);
const profiles = [
  {
    height: 11.4,
    radius: 0.43,
    spread: 4.3,
    crown: 0.25,
    lift: 0.1,
    tip: 0.14,
    spray: 1.2,
    limbs: 13,
  },
  {
    height: 14.2,
    radius: 0.23,
    spread: 3.0,
    crown: 0.34,
    lift: 0.13,
    tip: -0.23,
    spray: 0.85,
    limbs: 15,
  },
  {
    height: 13.3,
    radius: 0.34,
    spread: 3.8,
    crown: 0.3,
    lift: 0.14,
    tip: 0.08,
    spray: 1.02,
    limbs: 14,
  },
  {
    height: 15.0,
    radius: 0.3,
    spread: 3.5,
    crown: 0.28,
    lift: 0.025,
    tip: -0.07,
    spray: 0.9,
    limbs: 25,
  },
];
export function growStructure(seed, species = 0, shrub = false, age = 1) {
  const rng = seededRandom(seed),
    paths = [],
    leaves = [],
    joints = [],
    segments = [];
  const form = age % 3;
  const profile = { ...profiles[species % 4] };
  if (!shrub) {
    // Saplings, competition-grown canopy trees, and broad veteran/open-grown trees.
    profile.spread *= [0.65, 0.86, 1.18][form];
    profile.crown = form === 1 ? Math.max(0.42, profile.crown) : profile.crown;
    profile.limbs = Math.round(profile.limbs * [0.7, 1, 1.1][form]);
  }
  const ageScale = [0.52, 1.06, 1.2][form];
  const height = profile.height * ageScale * (0.92 + rng() * 0.16);
  const crownCenter = new T.Vector3(0, shrub ? 1.2 : height * 0.64, 0);
  function addPath(points, radius, endRadius = 0.002) {
    endRadius = Math.min(endRadius, radius * 0.3);
    const radii = points.map(
      (_, i) =>
        endRadius +
        (radius - endRadius) * Math.pow(1 - i / (points.length - 1), 1.25),
    );
    paths.push({ points, radii });
    for (let i = 1; i < points.length; i++)
      segments.push({
        a: points[i - 1],
        b: points[i],
        r0: radii[i - 1],
        r1: radii[i],
      });
    return paths.at(-1);
  }
  function sample(path, t) {
    const u = Math.min(0.99999, Math.max(0, t)) * (path.points.length - 1),
      i = Math.floor(u);
    return {
      p: path.points[i].clone().lerp(path.points[i + 1], u - i),
      d: path.points[i + 1].clone().sub(path.points[i]).normalize(),
      r: T.MathUtils.lerp(path.radii[i], path.radii[i + 1], u - i),
    };
  }
  function spray(attachment, direction, size, spread = 1) {
    const d = direction.clone().normalize(),
      q = new T.Quaternion().setFromUnitVectors(up, d);
    q.multiply(
      new T.Quaternion().setFromAxisAngle(up, (rng() - 0.5) * Math.PI * 1.65),
    );
    const p = attachment.clone().addScaledVector(d, size * 0.46),
      e = new T.Euler().setFromQuaternion(q);
    const normal = p.clone().sub(crownCenter);
    normal.y = normal.y * 0.35 + 0.85;
    normal.normalize();
    const value = 0.85 + rng() * 0.15;
    leaves.push({
      p: p.toArray(),
      r: [e.x, e.y, e.z],
      s: [size * spread, size, size],
      n: normal.toArray(),
      attachment: attachment.toArray(),
      c: new T.Color(
        value,
        value * (0.98 + rng() * 0.04),
        value * (0.91 + rng() * 0.06),
      ).getHex(),
    });
  }
  function limb(start, direction, len, radius, depth, shape = profile) {
    const d = direction.clone().normalize(),
      points = [start.clone().addScaledVector(d, -radius * 0.45)];
    let p = start.clone();
    const steps = depth === 2 ? 6 : depth === 1 ? 4 : 3;
    for (let i = 1; i <= steps; i++) {
      const bend = depth === 0 ? shape.tip : shape.lift;
      d.add(
        new T.Vector3((rng() - 0.5) * 0.12, bend, (rng() - 0.5) * 0.12),
      ).normalize();
      p = p.clone().addScaledVector(d, len / steps);
      points.push(p);
    }
    const path = addPath(points, radius, Math.max(0.0018, radius * 0.07));
    if (depth > 0) {
      // Lateral forks start along the parent, not at a single terminal junction.
      for (let k = 0; k < (depth === 2 ? 3 : 2); k++) {
        const t = 0.3 + k * (depth === 2 ? 0.23 : 0.38) + (rng() - 0.5) * 0.06,
          s = sample(path, t);
        const side = new T.Vector3(-s.d.z, 0.28, s.d.x)
          .normalize()
          .multiplyScalar(k % 2 ? 1 : -1);
        const next = s.d
          .clone()
          .multiplyScalar(0.6)
          .addScaledVector(side, 0.76)
          .addScaledVector(up, 0.18)
          .normalize();
        joints.push(s.p.clone());
        limb(
          s.p,
          next,
          len * (0.44 + rng() * 0.15),
          Math.min(s.r * 0.7, radius * 0.48),
          depth - 1,
          shape,
        );
      }
      const tip = sample(path, 0.87);
      spray(tip.p, tip.d, shape.spray * (0.75 + rng() * 0.25));
    } else {
      for (let k = 0; k < 4; k++) {
        const s = sample(path, 0.18 + k * 0.24);
        const side = new T.Vector3(-s.d.z, 0.35, s.d.x)
          .normalize()
          .multiplyScalar(k % 2 ? 1 : -1);
        const d = s.d
          .clone()
          .multiplyScalar(0.55)
          .addScaledVector(side, 0.65)
          .addScaledVector(up, 0.18)
          .normalize();
        spray(s.p, d, shape.spray * (0.72 + rng() * 0.38));
        if (k > 1)
          spray(
            s.p,
            s.d.clone().addScaledVector(up, 0.22),
            shape.spray * (0.62 + rng() * 0.28),
            0.85,
          );
      }
    }
    return path;
  }
  if (shrub) {
    // Independent shrub architecture: coppiced stems, arching canes, or low scrub.
    const kind = species % 3,
      stems = kind === 1 ? 11 : kind === 0 ? 8 : 10;
    const shape = {
      lift: kind === 1 ? -0.08 : 0.08,
      tip: kind === 1 ? -0.18 : 0.03,
      spray: kind === 1 ? 0.66 : kind === 0 ? 0.85 : 0.72,
    };
    for (let k = 0; k < stems; k++) {
      const a = k * 2.39996 + rng() * 0.6,
        reach = kind === 1 ? 1.7 + rng() * 1.25 : 0.9 + rng() * 0.8;
      const top =
        kind === 1
          ? 0.65 + rng() * 0.55
          : kind === 0
            ? 1.6 + rng() * 0.8
            : 1.15 + rng() * 0.65;
      const points = [];
      for (let j = 0; j <= 6; j++) {
        const t = j / 6,
          rad = 0.13 + reach * t;
        const y =
          kind === 1
            ? Math.sin(t * Math.PI * 0.9) * top
            : top * (1 - Math.pow(1 - t, 1.65));
        points.push(
          new T.Vector3(
            Math.cos(a + t * 0.25) * rad,
            Math.max(-0.04, y - 0.04),
            Math.sin(a + t * 0.25) * rad,
          ),
        );
      }
      const stem = addPath(points, kind === 1 ? 0.022 : 0.045, 0.002);
      for (let j = 1; j <= 5; j++) {
        const s = sample(stem, j / 6),
          b = a + (j % 2 ? 0.8 : -0.8),
          d = new T.Vector3(
            Math.cos(b),
            kind === 1 ? 0.1 : 0.45,
            Math.sin(b),
          ).normalize();
        joints.push(s.p.clone());
        limb(s.p, d, 0.38 + rng() * 0.42, s.r * 0.55, 0, shape);
      }
    }
  } else {
    const trunk = [],
      lean = (rng() - 0.5) * 0.11,
      phase = rng() * 6.28;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      trunk.push(
        new T.Vector3(
          (Math.sin(t * 3 + phase) - Math.sin(phase)) * 0.22 +
            lean * height * t * t,
          t * height - 0.22,
          (Math.cos(t * 3.2 + phase) - Math.cos(phase)) * 0.18,
        ),
      );
    }
    const stem = addPath(
      trunk,
      profile.radius * ageScale * (0.9 + rng() * 0.2),
      0.012,
    );
    // A flared root base is rooted below ground and follows the same trunk origin.
    for (let k = 0; k < 6; k++) {
      const a = k * 1.047 + rng() * 0.25,
        b = sample(stem, 0.045).p;
      addPath(
        [
          b,
          new T.Vector3(Math.cos(a) * 0.7, 0.07, Math.sin(a) * 0.7),
          new T.Vector3(Math.cos(a) * 1.4, -0.22, Math.sin(a) * 1.4),
        ],
        profile.radius * 0.52,
        0.006,
      );
    }
    for (let k = 0; k < profile.limbs; k++) {
      const pine = species === 3;
      const fraction = pine
        ? profile.crown + Math.floor(k / 5) * 0.135
        : profile.crown +
          (1 - profile.crown - 0.06) * (k / (profile.limbs - 1));
      const s = sample(stem, fraction + (rng() - 0.5) * 0.025);
      const angle = pine
        ? (k % 5) * Math.PI * 0.4 + Math.floor(k / 5) * 0.42
        : species === 2
          ? Math.floor(k / 2) * 2.1 + (k % 2) * Math.PI
          : k * 2.399963 + rng() * 0.45;
      const spread =
        profile.spread *
        ageScale *
        (0.83 + rng() * 0.35) *
        Math.pow(1 - fraction, 0.48);
      const direction = new T.Vector3(
        Math.cos(angle),
        pine ? 0.03 : 0.16 + fraction * 0.28,
        Math.sin(angle),
      ).normalize();
      joints.push(s.p.clone());
      limb(
        s.p,
        direction,
        spread,
        Math.min(s.r * 0.58, profile.radius * 0.52),
        pine ? 1 : 2,
        profile,
      );
    }
    // Fine terminal shoots finish the leader without a large isolated leaf ball.
    const tip = sample(stem, 0.9);
    limb(tip.p, tip.d, height * 0.13, tip.r * 0.8, 1, profile);
  }
  return {
    paths,
    leaves,
    joints,
    segments,
    species,
    shrub,
    age,
    speciesName: shrub ? SHRUB_TYPES[species % 3] : TREE_TYPES[species % 4],
  };
}
