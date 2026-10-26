import * as T from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { growStructure } from "./plant-growth.js";
import { barkColour } from "./plant-appearance.js";
import { smooth } from "./habitat.js";
import { unionWood } from "./wood-union.js";

export function skinPath(path, level = 0) {
  const { points, radii } = path;
  const distance = [0];
  for (let i = 1; i < points.length; i++)
    distance.push(distance[i - 1] + points[i].distanceTo(points[i - 1]));
  const at = (s) => {
    let i = 0;
    while (i < points.length - 2 && distance[i + 1] < s) i++;
    const t = T.MathUtils.clamp(
      (s - distance[i]) / (distance[i + 1] - distance[i]),
      0,
      1,
    );
    return {
      p: points[i].clone().lerp(points[i + 1], t),
      r: T.MathUtils.lerp(radii[i], radii[i + 1], t),
    };
  };
  if (path.rootFlare) {
    const end = Math.min(distance.at(-1), 1.8),
      samples = [];
    const rings = level ? 8 : 16;
    for (let i = 0; i <= rings; i++) samples.push(at((end * i) / rings));
    for (let i = 1; i < points.length; i++)
      if (distance[i] > end) samples.push({ p: points[i], r: radii[i] });
    return {
      ...path,
      points: samples.map((s) => s.p),
      radii: samples.map((s) => s.r),
    };
  }
  if (!path.attachment) return path;
  const parent = path.attachment;
  const span = Math.min(
    // End before the first lateral fork (>= 0.27 of its source path), so
    // smoothing the collar cannot move the parent away from attached twigs.
    distance.at(-1) * 0.24,
    parent.r * 2.2 + radii[0] * 3.5,
  );
  const end = at(span),
    direction = end.p.clone().sub(parent.p).normalize();
  const start = parent.p
    .clone()
    .addScaledVector(parent.d, -Math.min(parent.r * 0.9, span * 0.45));
  const curve = new T.CubicBezierCurve3(
    start,
    parent.p.clone().addScaledVector(parent.d, span * 0.22),
    end.p.clone().addScaledVector(direction, -span * 0.4),
    end.p,
  );
  const samples = [];
  const rings = level ? 4 : 8;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    samples.push({
      p: curve.getPoint(t),
      r:
        T.MathUtils.lerp(radii[0], end.r, t) *
        (1 + 0.45 * Math.sin(Math.PI * t)),
    });
  }
  for (let i = 1; i < points.length; i++)
    if (distance[i] > span) samples.push({ p: points[i], r: radii[i] });
  return {
    ...path,
    points: samples.map((s) => s.p),
    radii: samples.map((s) => s.r),
  };
}
// Adjacent rings share vertices: bends cannot open into separate cylinders.
function tube(path, sides, plant, level) {
  const { points, radii } = skinPath(path, level);
  const positions = [],
    uvs = [],
    indices = [];
  let distance = 0,
    previousRight = new T.Vector3(1, 0, 0);
  for (let j = 0; j < points.length; j++) {
    const prev = points[Math.max(0, j - 1)],
      next = points[Math.min(points.length - 1, j + 1)],
      tangent = next.clone().sub(prev).normalize();
    const right = previousRight
      .clone()
      .addScaledVector(tangent, -previousRight.dot(tangent))
      .normalize();
    const forward = new T.Vector3().crossVectors(tangent, right).normalize();
    previousRight = right;
    if (j) distance += points[j].distanceTo(points[j - 1]);
    for (let k = 0; k <= sides; k++) {
      const angle = (k / sides) * Math.PI * 2;
      const flare = path.rootFlare;
      const rootRadius = flare
        ? flare.reach *
          (0.16 +
            0.84 * Math.pow(0.5 + 0.5 * Math.cos(angle * 5 + flare.phase), 4)) *
          Math.exp(-Math.pow(Math.max(0, points[j].y + 0.22) / 0.4, 1.4))
        : 0;
      const p = points[j]
        .clone()
        .addScaledVector(right, Math.cos(angle) * (radii[j] + rootRadius))
        .addScaledVector(forward, Math.sin(angle) * (radii[j] + rootRadius));
      positions.push(...p.toArray());
      let u =
        (k / sides) * Math.max(0.18, (radii[0] * Math.PI * 2) / 0.85) +
        points[0].x * 0.19;
      let v = distance * 0.28 + points[0].y * 0.17 + points[0].z * 0.13;
      const parent = path.attachment;
      if (parent?.bark) {
        const delta = p.clone().sub(parent.p),
          axial = delta.dot(parent.d);
        const radial = delta.clone().addScaledVector(parent.d, -axial);
        const weight =
          1 - smooth(parent.r * 0.9, parent.r * 2, radial.length());
        let theta = Math.atan2(
          radial.dot(parent.bark.forward),
          radial.dot(parent.bark.right),
        );
        if (theta < 0) theta += Math.PI * 2;
        u = T.MathUtils.lerp(
          u,
          (theta / (Math.PI * 2)) * parent.bark.circumference + parent.bark.u,
          weight,
        );
        v = T.MathUtils.lerp(v, parent.bark.v + axial * 0.28, weight);
      }
      uvs.push(u + (plant.seed % 71) * 0.173, v + (plant.seed % 53) * 0.137);
    }
    if (j)
      for (let k = 0; k < sides; k++) {
        const a = (j - 1) * (sides + 1) + k,
          b = j * (sides + 1) + k;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
  }
  // Capped ends are embedded in parent wood at forks and below the soil at roots.
  for (const j of [0, points.length - 1]) {
    const center = positions.length / 3;
    positions.push(...points[j].toArray());
    uvs.push(0.5, j ? distance * 0.17 : 0);
    for (let k = 0; k < sides; k++) {
      const a = j * (sides + 1) + k;
      if (j) indices.push(center, a, a + 1);
      else indices.push(center, a + 1, a);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  const normals = g.attributes.normal;
  // Join duplicate UV seam normals; bark UVs can wrap without a lighting crease.
  for (let j = 0; j < points.length; j++) {
    const a = j * (sides + 1),
      b = a + sides;
    const n = new T.Vector3()
      .fromBufferAttribute(normals, a)
      .add(new T.Vector3().fromBufferAttribute(normals, b))
      .normalize();
    normals.setXYZ(a, n.x, n.y, n.z);
    normals.setXYZ(b, n.x, n.y, n.z);
  }
  if (path.attachment) {
    const parent = path.attachment;
    for (let i = 0; i < points.length * (sides + 1); i++) {
      const p = new T.Vector3()
        .fromBufferAttribute(g.attributes.position, i)
        .sub(parent.p);
      const radial = p.clone().addScaledVector(parent.d, -p.dot(parent.d));
      const influence =
        1 - smooth(parent.r * 0.9, parent.r * 1.7, radial.length());
      if (radial.lengthSq() > 1e-8 && influence > 0) {
        const n = new T.Vector3()
          .fromBufferAttribute(normals, i)
          .lerp(radial.normalize(), influence)
          .normalize();
        normals.setXYZ(i, n.x, n.y, n.z);
      }
    }
  }
  const colours = [];
  for (let i = 0; i < positions.length; i += 3)
    colours.push(
      ...barkColour(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        plant.seed,
        plant.species,
      ),
    );
  g.setAttribute("color", new T.Float32BufferAttribute(colours, 3));
  return g;
}
export function growPlant(seed, species = 0, shrub = false, age = 1) {
  const plant = growStructure(seed, species, shrub, age);
  const unionGeometries = new Map();
  function geometry(level) {
    const solid = shrub
      ? []
      : plant.paths.filter((p) => p.rootFlare || p.radii[0] > 0.06);
    const parts = plant.paths
      .filter((p) => !solid.includes(p))
      .filter((p) => level < 2 || p.radii[0] > (shrub ? 0.008 : 0.025))
      .map((path) => {
        const r = path.radii[0];
        const sides =
          level === 0
            ? r > 0.22
              ? path.rootFlare
                ? 30
                : 14
              : r > 0.08
                ? 7
                : r > 0.025
                  ? 5
                  : 3
            : r > 0.22
              ? path.rootFlare
                ? 20
                : 10
              : r > 0.06
                ? 4
                : 3;
        if (
          level === 0 ||
          path.points.length <= 4 ||
          path.rootFlare ||
          path.attachment
        )
          return tube(path, sides, plant, level);
        const indices = [
          0,
          Math.floor(path.points.length / 2),
          path.points.length - 1,
        ];
        return tube(
          {
            ...path,
            points: indices.map((i) => path.points[i]),
            radii: indices.map((i) => path.radii[i]),
          },
          sides,
          plant,
          level,
        );
      });
    if (solid.length) {
      const key = level > 0;
      if (!unionGeometries.has(key))
        unionGeometries.set(key, unionWood(solid, plant, key));
      parts.push(unionGeometries.get(key).clone());
    }
    const g = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    return g;
  }
  return {
    ...plant,
    // The voxel baker uses the curved collars too. Root radii conservatively
    // enclose the lobed buttress footprint without depending on render residency.
    paths: plant.paths.map((path) => {
      const skin =
        !shrub && (path.rootFlare || path.radii[0] > 0.06)
          ? path
          : skinPath(path);
      return {
        ...skin,
        colour: barkColour(
          skin.points[0].x,
          skin.points[0].y,
          skin.points[0].z,
          seed,
          species,
        ),
        radii: skin.radii.map(
          (r, i) =>
            r +
            (path.rootFlare
              ? path.rootFlare.reach *
                Math.exp(
                  -Math.pow(Math.max(0, skin.points[i].y + 0.22) / 0.4, 1.4),
                )
              : 0),
        ),
      };
    }),
    high: geometry(0),
    low: geometry(1),
    farWood: geometry(2),
  };
}
