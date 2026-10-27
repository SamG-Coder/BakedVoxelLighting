import * as T from "three/webgpu";
import { seededRandom } from "./habitat.js";
import { TREE_TYPES, SHRUB_TYPES } from "./plant-catalog.js";
import { leafColour } from "./plant-appearance.js";
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
    fork: 0.95,
    wander: 0.2,
  },
  {
    height: 14.2,
    radius: 0.23,
    spread: 3.0,
    crown: 0.34,
    lift: 0.13,
    tip: -0.36,
    spray: 1.08,
    limbs: 15,
    fork: 0.56,
    wander: 0.09,
  },
  {
    height: 13.3,
    radius: 0.34,
    spread: 3.8,
    crown: 0.3,
    lift: 0.14,
    tip: 0.08,
    spray: 1.15,
    limbs: 14,
    fork: 0.72,
    wander: 0.11,
  },
  {
    height: 15.0,
    radius: 0.3,
    spread: 3.5,
    crown: 0.28,
    lift: 0.025,
    tip: 0.04,
    spray: 1.3,
    limbs: 25,
    fork: 0.88,
    wander: 0.055,
  },
];
export function growStructure(seed, species = 0, shrub = false, age = 1) {
  const rng = seededRandom(seed),
    paths = [],
    leaves = [],
    joints = [],
    segments = [];
  const form = Math.max(0, Math.min(2, Math.floor(age)));
  const profile = { ...profiles[species % 4] };
  if (!shrub) {
    // Saplings, competition-grown canopy trees, and broad veteran/open-grown trees.
    profile.spread *= [0.65, 0.86, 1.18][form];
    profile.crown = form === 1 ? Math.max(0.42, profile.crown) : profile.crown;
    profile.limbs = Math.round(profile.limbs * [0.7, 1, 1.1][form]);
    profile.spray *= [0.78, 0.95, 1][form];
  }
  const ageScale = [0.52, 1.06, 1.2][form];
  const height = profile.height * ageScale * (0.92 + rng() * 0.16);
  const crownCenter = new T.Vector3(0, shrub ? 1.2 : height * 0.64, 0);
  // One growth bias per plant creates a coherent asymmetric crown. It is baked
  // into all representations, never animated or picked independently per LOD.
  const crownPhase = rng() * Math.PI * 2;
  const crownBias = shrub ? 0.22 : species === 3 ? 0.09 : 0.18;
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
    const direction = path.points[i + 1]
      .clone()
      .sub(path.points[i])
      .normalize();
    let distance = 0;
    for (let j = 1; j <= i; j++)
      distance += path.points[j].distanceTo(path.points[j - 1]);
    distance += path.points[i + 1].distanceTo(path.points[i]) * (u - i);
    let right = new T.Vector3(1, 0, 0).addScaledVector(direction, -direction.x);
    if (right.lengthSq() < 0.001)
      right = new T.Vector3(0, 0, 1).addScaledVector(direction, -direction.z);
    right.normalize();
    return {
      p: path.points[i].clone().lerp(path.points[i + 1], u - i),
      d: path.points[i + 1].clone().sub(path.points[i]).normalize(),
      r: T.MathUtils.lerp(path.radii[i], path.radii[i + 1], u - i),
      bark: {
        right,
        forward: new T.Vector3().crossVectors(direction, right).normalize(),
        circumference: Math.max(0.18, (path.radii[0] * Math.PI * 2) / 0.85),
        u: path.points[0].x * 0.19,
        v: distance * 0.28 + path.points[0].y * 0.17 + path.points[0].z * 0.13,
      },
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
    const value = 0.94 + rng() * 0.06;
    const colour = leafColour(p.x, p.y, p.z, seed, species, form, shrub).map(
      (v) => v * value,
    );
    leaves.push({
      p: p.toArray(),
      r: [e.x, e.y, e.z],
      s: [size * spread, size, size],
      n: normal.toArray(),
      attachment: attachment.toArray(),
      c: new T.Color(...colour).getHex(),
      colour,
    });
  }
  function limb(
    start,
    direction,
    len,
    radius,
    depth,
    shape = profile,
    parent = null,
  ) {
    const d = direction.clone().normalize(),
      points = [start.clone().addScaledVector(d, -radius * 0.45)];
    let p = start.clone();
    const steps = depth === 2 ? 6 : depth === 1 ? 4 : 3;
    for (let i = 1; i <= steps; i++) {
      // Birch terminal twigs hang; oak scaffold limbs turn back upward. Pine
      // branch shelves stay flatter than their upward-growing terminal shoots.
      const bend = depth === 0 ? shape.tip * (0.4 + i / steps) : shape.lift;
      const wander = shape.wander ?? 0.12;
      d.add(
        new T.Vector3((rng() - 0.5) * wander, bend, (rng() - 0.5) * wander),
      ).normalize();
      p = p.clone().addScaledVector(d, len / steps);
      points.push(p);
    }
    const path = addPath(points, radius, Math.max(0.0018, radius * 0.07));
    path.order = depth;
    if (parent)
      path.attachment = {
        p: start.clone(),
        d: parent.d.clone(),
        r: parent.r,
        bark: parent.bark,
      };
    if (depth > 0) {
      // Lateral forks start along the parent, not at a single terminal junction.
      for (let k = 0; k < (depth === 2 ? 3 : 2); k++) {
        const paired = !shrub && species === 2 && k < 2;
        const jitter = (rng() - 0.5) * 0.035;
        const t = paired ? 0.4 : 0.3 + k * (depth === 2 ? 0.23 : 0.38) + jitter,
          s = sample(path, t);
        const side = new T.Vector3(-s.d.z, 0, s.d.x)
          .normalize()
          .multiplyScalar(k % 2 ? 1 : -1);
        const next = s.d
          .clone()
          .multiplyScalar(0.6)
          .addScaledVector(side, shape.fork ?? 0.76)
          .addScaledVector(
            up,
            !shrub && species === 3
              ? 0.06
              : !shrub && species === 1
                ? 0.1
                : 0.24,
          )
          .normalize();
        joints.push(s.p.clone());
        limb(
          s.p,
          next,
          len * (0.44 + rng() * 0.15),
          Math.min(s.r * 0.7, radius * 0.48),
          depth - 1,
          shape,
          s,
        );
      }
      const tip = sample(path, 0.87);
      spray(tip.p, tip.d, shape.spray * (0.75 + rng() * 0.25));
    } else {
      for (let k = 0; k < 4; k++) {
        const s = sample(path, 0.18 + k * 0.24);
        const side = new T.Vector3(-s.d.z, 0, s.d.x)
          .normalize()
          .multiplyScalar(k % 2 ? 1 : -1);
        const d = s.d
          .clone()
          .multiplyScalar(0.55)
          .addScaledVector(side, 0.65)
          .addScaledVector(up, !shrub && species === 1 ? -0.13 : 0.18)
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
      wander: kind === 1 ? 0.17 : 0.12,
    };
    for (let k = 0; k < stems; k++) {
      const a = k * 2.39996 + rng() * 0.6,
        reach =
          (kind === 1 ? 1.7 + rng() * 1.25 : 0.9 + rng() * 0.8) *
          (1 + crownBias * Math.cos(a - crownPhase));
      const top =
        kind === 1
          ? 0.65 + rng() * 0.55
          : kind === 0
            ? 1.6 + rng() * 0.8
            : 1.15 + rng() * 0.65;
      const points = [];
      const baseX = Math.cos(a) * (kind === 1 ? 0.35 : 0.16);
      const baseZ = Math.sin(a) * (kind === 1 ? 0.35 : 0.16);
      const sweep = (rng() - 0.5) * 0.65;
      for (let j = 0; j <= 6; j++) {
        const t = j / 6,
          rad = reach * (kind === 0 ? t * t : t);
        const y =
          kind === 1
            ? Math.sin(t * Math.PI * 0.9) * top
            : top * (1 - Math.pow(1 - t, 1.65));
        points.push(
          new T.Vector3(
            baseX + Math.cos(a + t * sweep) * rad,
            Math.max(-0.04, y - 0.04),
            baseZ + Math.sin(a + t * sweep) * rad,
          ),
        );
      }
      const stem = addPath(points, kind === 1 ? 0.022 : 0.045, 0.002);
      for (let j = 1; j <= 5; j++) {
        const s = sample(stem, (j + (rng() - 0.5) * 0.22) / 6),
          b = a + (j % 2 ? 0.8 : -0.8),
          d = new T.Vector3(
            Math.cos(b),
            kind === 1 ? 0.04 : kind === 2 ? 0.7 : 0.35,
            Math.sin(b),
          ).normalize();
        joints.push(s.p.clone());
        limb(s.p, d, 0.38 + rng() * 0.42, s.r * 0.55, 0, shape, s);
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
    // The trunk mesh itself forms the root buttresses, avoiding intersecting spikes.
    stem.rootFlare = {
      radius: stem.radii[0],
      // Saplings have a modest collar, not a scaled-down veteran buttress.
      reach: Math.min(
        form === 0 ? stem.radii[0] * 0.55 : Infinity,
        ageScale * [0.16, 0.78, 1][form] * (1.15 + rng() * 0.35),
      ),
      phase,
    };
    // Retain a pine's whorled growth, but not identical five-spoke shelves.
    // Unequal annual extension, branch survival and inter-whorl shoots are
    // authored into the source so every baked LOD inherits the same silhouette.
    const pineNodes = [];
    if (species === 3) {
      let k = 0;
      const groups = [];
      while (k < profile.limbs) {
        const count = Math.min(profile.limbs - k, 3 + Math.floor(rng() * 4));
        groups.push({
          count,
          extension: 0.65 + rng() * 0.85,
          phase: rng() * Math.PI * 2,
        });
        k += count;
      }
      const total = groups.slice(0, -1).reduce((n, g) => n + g.extension, 0);
      let growth = 0;
      for (const g of groups) {
        const base =
          profile.crown +
          (growth / Math.max(1, total)) * (0.88 - profile.crown);
        for (let j = 0; j < g.count; j++) {
          pineNodes.push({
            fraction: Math.min(0.92, base + (rng() - 0.5) * 0.075),
            angle: g.phase + (j / g.count) * Math.PI * 2 + (rng() - 0.5) * 0.65,
            reach: 0.68 + rng() * 0.62,
            lift: -0.18 + rng() * 0.43,
          });
        }
        growth += g.extension;
      }
    }
    for (let k = 0; k < profile.limbs; k++) {
      const pine = species === 3;
      const fraction = pine
        ? pineNodes[k].fraction
        : species === 2
          ? profile.crown +
            (Math.floor(k / 2) /
              Math.max(1, Math.ceil(profile.limbs / 2) - 1)) *
              (0.92 - profile.crown)
          : profile.crown +
            (1 - profile.crown - 0.06) * (k / (profile.limbs - 1));
      const attachmentJitter = (rng() - 0.5) * 0.025;
      const s = sample(stem, fraction + (species === 2 ? 0 : attachmentJitter));
      const angle = pine
        ? pineNodes[k].angle
        : species === 2
          ? Math.floor(k / 2) * 2.1 + (k % 2) * Math.PI
          : k * 2.399963 + rng() * 0.45;
      const spread =
        profile.spread *
        ageScale *
        (0.83 + rng() * 0.35) *
        (pine ? pineNodes[k].reach : 1) *
        (1 + crownBias * Math.cos(angle - crownPhase)) *
        Math.pow(1 - fraction, pine ? 0.8 : species === 0 ? 0.3 : 0.48);
      const direction = new T.Vector3(
        Math.cos(angle),
        pine
          ? pineNodes[k].lift
          : species === 0
            ? 0.25 + fraction * 0.55
            : species === 2
              ? 0.48 + fraction * 0.4
              : 0.25 + fraction * 0.25,
        Math.sin(angle),
      ).normalize();
      joints.push(s.p.clone());
      const scaffold = limb(
        s.p,
        direction,
        spread,
        Math.min(s.r * 0.58, profile.radius * 0.52),
        pine ? 1 : 2,
        profile,
        s,
      );
      scaffold.trunkFraction = fraction;
    }
    // Fine terminal shoots finish the leader without a large isolated leaf ball.
    const tip = sample(stem, 0.9);
    limb(tip.p, tip.d, height * 0.13, tip.r * 0.8, 1, profile, tip);
  }
  return {
    paths,
    leaves,
    joints,
    segments,
    species,
    shrub,
    age,
    seed,
    speciesName: shrub ? SHRUB_TYPES[species % 3] : TREE_TYPES[species % 4],
  };
}
