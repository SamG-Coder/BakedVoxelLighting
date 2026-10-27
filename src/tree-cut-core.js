import * as T from "three";
import { splitLooseWood } from "./wood-connectivity.js";
import { MeshBVH } from "three-mesh-bvh";
import { Brush, Evaluator, SUBTRACTION, INTERSECTION } from "three-bvh-csg";

// Only the short cutting band is modified after promotion. All booleans run in
// the chopping worker; the intact crown and root geometry are never re-meshed per hit.
const evaluator = new Evaluator();
evaluator.useCDTClipping = true;
evaluator.attributes = ["position", "normal", "uv", "color", "moss"];
const bark = new T.MeshBasicMaterial(),
  wood = new T.MeshBasicMaterial();

export { packGeometry, unpackGeometry } from "./tree-cut-geometry.js";
import { packGeometry, unpackGeometry } from "./tree-cut-geometry.js";
function brush(g, material = bark) {
  if (!g.attributes.color)
    g.setAttribute(
      "color",
      new T.Float32BufferAttribute(
        new Float32Array(g.attributes.position.count * 3).fill(1),
        3,
      ),
    );
  if (!g.attributes.moss)
    g.setAttribute(
      "moss",
      new T.Float32BufferAttribute(
        new Float32Array(g.attributes.position.count),
        1,
      ),
    );
  const b = new Brush(g, material);
  b.updateMatrixWorld();
  return b;
}
function boxBelow(y) {
  const g = new T.BoxGeometry(128, 128, 128);
  g.translate(0, y - 64, 0);
  return brush(g, wood);
}
function fractureBelow(section) {
  const span = Math.max(4, section.radius * 6);
  const g = new T.BoxGeometry(span, 128, span, 20, 1, 20);
  g.translate(section.x, section.y - 64, section.z);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++)
    if (p.getY(i) > section.y - 0.01) {
      const x = p.getX(i) - section.x,
        z = p.getZ(i) - section.z;
      // Short grain-aligned splinters on the final tensile break, not a sawn cap.
      const rough =
        0.022 * Math.sin(x * 91 + z * 17) + 0.016 * Math.sin(z * 113 - x * 23);
      p.setY(i, section.y + rough);
    }
  g.computeVertexNormals();
  return brush(g, wood);
}
function disposeBrush(b) {
  b.disposeCacheData();
  b.geometry.dispose();
}
function solidVolume(b) {
  const g = b.geometry,
    p = g.attributes.position,
    index = g.index;
  let volume = 0;
  const count = index ? index.count : p.count;
  const a = new T.Vector3(),
    c = new T.Vector3(),
    d = new T.Vector3();
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(p, index ? index.getX(i) : i);
    c.fromBufferAttribute(p, index ? index.getX(i + 1) : i + 1);
    d.fromBufferAttribute(p, index ? index.getX(i + 2) : i + 2);
    volume += a.dot(c.cross(d)) / 6;
  }
  return Math.abs(volume);
}
function boolean(a, b, op) {
  const result = evaluator.evaluate(a, b, op);
  result.updateMatrixWorld();
  return result;
}
function subtractWithChunk(a, b) {
  // Split intersecting triangles once for both the surviving solid and chip.
  const result = evaluator.evaluate(
    a,
    b,
    [SUBTRACTION, INTERSECTION],
    [new Brush(), new Brush()],
  );
  for (const item of result) item.updateMatrixWorld();
  return result;
}

// The cutter is a closed triangular prism, with the apex inside the trunk.
// Its intersection with the remaining band IS the emitted wood chunk.
export function makeWedge(cut, section) {
  const { angle, depth } = cut,
    { x, z, radius: r } = section;
  const y = cut.y ?? section.y;
  const inner = r - depth,
    outer = r + 0.22,
    half = cut.halfHeight ?? Math.min(0.34, r * 0.8 + 0.05);
  const width = cut.halfWidth ?? Math.max(0.12, r * 0.9),
    c = Math.cos(angle),
    s = Math.sin(angle);
  const shape = new T.Shape();
  shape.moveTo(inner, 0);
  shape.lineTo(outer, -half);
  shape.lineTo(outer, half);
  shape.closePath();
  const g = new T.ExtrudeGeometry(shape, {
    depth: width * 2,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  g.translate(0, 0, -width);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const a = p.getX(i),
      b = p.getZ(i);
    p.setXYZ(
      i,
      x + c * a - s * b,
      y + p.getY(i) + (cut.slope || 0) * (r - a),
      z + s * a + c * b,
    );
  }
  g.computeVertexNormals();
  return brush(g, wood);
}

// Two kerfs bound a chip. The side faces split ALONG the trunk grain when
// the wedge has enough penetration relative to the remaining chip height.
// This is a bounded fracture approximation, not a full elastic wood solver.
export function bridgeFracture(a, b, section) {
  if (a.y === undefined || b.y === undefined) return null;
  const upper = a.y > b.y ? a : b,
    lower = a.y > b.y ? b : a;
  const gap = upper.y - lower.y,
    r = section.radius;
  const wa = upper.halfWidth ?? Math.max(0.12, r * 0.9),
    wb = lower.halfWidth ?? Math.max(0.12, r * 0.9);
  const angleDelta = Math.atan2(
    Math.sin(upper.angle - lower.angle),
    Math.cos(upper.angle - lower.angle),
  );
  if (Math.abs(angleDelta) > 0.35 || gap < 0.025 || gap > Math.min(wa, wb) * 3)
    return null;
  const angle = lower.angle + angleDelta * 0.5;
  const lateral = r * Math.sin(angleDelta * 0.5);
  const left = Math.max(lateral - wa, -lateral - wb),
    right = Math.min(lateral + wa, -lateral + wb);
  if (right - left < Math.min(wa, wb) * 0.6) return null;
  let depth = Math.min(upper.depth, lower.depth);
  const convergence = (lower.slope || 0) - (upper.slope || 0);
  if (convergence > 0) depth = Math.min(depth, gap / convergence);
  // Shallow scratches retain their middle. Deep paired cuts can split the weak
  // longitudinal side fibres; separated cuts on opposite trunk sides cannot.
  if (depth < gap * 0.7 || depth < 0.035) return null;
  return {
    angle,
    left,
    right,
    depth,
    upperY: upper.y,
    lowerY: lower.y,
    upperSlope: upper.slope || 0,
    lowerSlope: lower.slope || 0,
  };
}
function fractureCutter(f, section) {
  const outer = section.radius + 0.22,
    inner = section.radius - f.depth;
  const top = (a) => f.upperY + f.upperSlope * (section.radius - a);
  const bottom = (a) => f.lowerY + f.lowerSlope * (section.radius - a);
  const shape = new T.Shape();
  shape.moveTo(outer, bottom(outer));
  shape.lineTo(inner, bottom(inner));
  shape.lineTo(inner, Math.max(bottom(inner) + 0.00001, top(inner)));
  shape.lineTo(outer, top(outer));
  shape.closePath();
  const g = new T.ExtrudeGeometry(shape, {
    depth: f.right - f.left,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  const p = g.attributes.position,
    c = Math.cos(f.angle),
    s = Math.sin(f.angle);
  for (let i = 0; i < p.count; i++) {
    const a = p.getX(i),
      b = p.getZ(i) + f.left;
    p.setXYZ(
      i,
      section.x + c * a - s * b,
      p.getY(i),
      section.z + s * a + c * b,
    );
  }
  g.computeVertexNormals();
  return brush(g, wood);
}

// Remaining section properties, not a hit counter. Sample the actual wedge
// cross-sections, then calculate centroid, bending inertia and edge stress.
// This is a calibrated green-wood gameplay model, not engineering certification.
export function sectionStrength(
  section,
  cuts,
  mass,
  com,
  loose = [],
  fractures = [],
  occupied = null,
) {
  const r = section.radius,
    n = 48,
    step = (2 * r) / n,
    da = step * step;
  let area = 0,
    sx = 0,
    sz = 0,
    xx = 0,
    zz = 0,
    xz = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = -r + (i + 0.5) * step,
        z = -r + (j + 0.5) * step;
      if (x * x + z * z > r * r) continue;
      const cell = j * n + i;
      if (occupied && !occupied[cell]) continue;
      let removed = false;
      for (const cut of cuts) {
        const c = Math.cos(cut.angle),
          s = Math.sin(cut.angle);
        const half = cut.halfHeight ?? Math.min(0.34, r * 0.8 + 0.05);
        const radial = x * c + z * s;
        const centerY = (cut.y ?? section.y) + (cut.slope || 0) * (r - radial);
        const dy = Math.abs(section.y - centerY);
        const opening =
          (half * (radial - (r - cut.depth))) / (cut.depth + 0.22);
        if (
          radial >= r - cut.depth &&
          radial <= r + 0.22 &&
          dy <= opening &&
          Math.abs(-x * s + z * c) <= (cut.halfWidth ?? Math.max(0.12, r * 0.9))
        ) {
          removed = true;
          break;
        }
      }
      if (!removed)
        for (const f of fractures) {
          const c = Math.cos(f.angle),
            s = Math.sin(f.angle),
            radial = x * c + z * s,
            lateral = -x * s + z * c;
          const d = r - radial;
          if (
            d >= -0.22 &&
            d <= f.depth &&
            lateral >= f.left &&
            lateral <= f.right &&
            section.y >= f.lowerY + f.lowerSlope * d &&
            section.y <= f.upperY + f.upperSlope * d
          ) {
            removed = true;
            break;
          }
        }
      if (!removed && loose.length) {
        sectionRay.origin.set(section.x + x, section.y, section.z + z);
        for (const fragment of loose) {
          if (!fragment.geometry.boundingBox.containsPoint(sectionRay.origin))
            continue;
          const hit = fragment.geometry.boundsTree.raycastFirst(
            sectionRay,
            T.DoubleSide,
          );
          if (hit && hit.face.normal.x > 0) {
            removed = true;
            break;
          }
        }
      }
      if (removed) {
        if (occupied) occupied[cell] = 0;
        continue;
      }
      area += da;
      sx += x * da;
      sz += z * da;
      xx += x * x * da;
      zz += z * z * da;
      xz += x * z * da;
    }
  const fraction = area / (Math.PI * r * r),
    cx = sx / Math.max(area, 1e-9),
    cz = sz / Math.max(area, 1e-9);
  const dx = com.x - section.x - cx,
    dz = com.z - section.z - cz,
    lever = Math.hypot(dx, dz);
  const last = cuts.at(-1),
    angle = lever > 0.015 ? Math.atan2(dz, dx) : last?.angle || 0;
  const ux = Math.cos(angle),
    uz = Math.sin(angle);
  const inertia = Math.max(
    1e-10,
    ux * ux * (xx - area * cx * cx) +
      uz * uz * (zz - area * cz * cz) +
      2 * ux * uz * (xz - area * cx * cz),
  );
  const stress =
    (mass * 9.81) / Math.max(area, 1e-9) +
    (mass * 9.81 * Math.max(0.025, lever) * (r + Math.hypot(cx, cz))) / inertia;
  const strength = 8e6; // effective strength including knots/splits at the notch
  return {
    fraction,
    stress,
    strain: stress / 8e9,
    load: stress / strength,
    angle,
    cx,
    cz,
    failed: fraction < 0.09 || stress > strength,
  };
}

const sectionRay = new T.Ray(new T.Vector3(), new T.Vector3(1, 0, 0));

export function createCutState(record, section, mass, com) {
  const original = brush(unpackGeometry(record)),
    low = boxBelow(section.low ?? section.y - 0.38),
    high = boxBelow(section.high ?? section.y + 0.38);
  const bottom = boolean(original, low, INTERSECTION),
    top = boolean(original, high, SUBTRACTION);
  const lower = boolean(original, high, INTERSECTION),
    band = boolean(lower, low, SUBTRACTION);
  for (const b of [original, low, high, lower]) disposeBrush(b);
  return {
    bottom,
    top,
    band,
    section,
    mass,
    com,
    cuts: [],
    fractures: [],
    sections: new Map(),
  };
}
export function sameCutChannel(a, b, section) {
  return (
    Math.abs(a.angle - b.angle) < 1e-8 &&
    Math.abs((a.y ?? section.y) - (b.y ?? section.y)) < 1e-8 &&
    a.halfWidth === b.halfWidth &&
    a.halfHeight === b.halfHeight &&
    (a.slope || 0) === (b.slope || 0)
  );
}
export function cutState(state, cut) {
  const started = performance.now();
  const wedge = makeWedge(cut, state.section);
  let [band, chunk] = subtractWithChunk(state.band, wedge);
  // A bucket/key is not geometry identity. Replacing a nearby cut shifts the
  // old empty space and grows wood back. Only an identical channel may deepen.
  const existing = state.cuts.findIndex((c) =>
    sameCutChannel(c, cut, state.section),
  );
  const changed = existing < 0 || cut.depth > state.cuts[existing].depth + 1e-8;
  if (existing < 0) state.cuts.push({ ...cut });
  else
    state.cuts[existing] = {
      ...cut,
      depth: Math.max(state.cuts[existing].depth, cut.depth),
    };
  let candidate = null;
  for (const other of state.cuts) {
    const f = changed ? bridgeFracture(cut, other, state.section) : null;
    if (
      f &&
      (!candidate ||
        f.depth * (f.right - f.left) >
          candidate.depth * (candidate.right - candidate.left))
    )
      candidate = f;
  }
  const newFracture =
    candidate &&
    !state.fractures.some(
      (f) => JSON.stringify(f) === JSON.stringify(candidate),
    );
  if (newFracture) state.fractures.push(candidate);
  // Incremental solid subtraction: the previous result is authoritative.
  // Work scales with the touched surface, not the entire stroke history.
  // This also makes removal monotonic by construction.
  disposeBrush(wedge);
  const loose = [],
    released = [];
  for (const fracture of newFracture ? [candidate] : []) {
    const cutter = fractureCutter(fracture, state.section);
    const [next, piece] = subtractWithChunk(band, cutter);
    if (piece.geometry.attributes.position.count) {
      if (solidVolume(piece) > 1e-8)
        released.push(surfaceRecord(piece, state.section));
      piece.geometry.computeBoundingBox();
      piece.geometry.boundsTree = new MeshBVH(piece.geometry, {
        indirect: true,
        targetLeafSize: 8,
      });
      loose.push(piece);
    } else disposeBrush(piece);
    disposeBrush(band);
    disposeBrush(cutter);
    band = next;
  }
  const split = splitLooseWood(
    band.geometry,
    state.section.low ?? state.section.y - 0.38,
    state.section.high ?? state.section.y + 0.38,
  );
  if (split) {
    for (const geometry of split.pieces) {
      const fragment = brush(geometry, band.material);
      if (solidVolume(fragment) > 1e-8)
        released.push(surfaceRecord(fragment, state.section));
      geometry.computeBoundingBox();
      geometry.boundsTree = new MeshBVH(geometry, {
        indirect: true,
        targetLeafSize: 8,
      });
      loose.push(fragment);
    }
    const body = brush(split.body, band.material);
    disposeBrush(band);
    band = body;
  }
  disposeBrush(state.band);
  state.band = band;
  const geometryMs = performance.now() - started;
  // Persist occupancy at tested cross-sections. Existing sections only erase
  // this hit's material; they never walk the full cut history again. A newly
  // requested section samples the current solid, including earlier loose chips.
  const addSection = (y) => {
    if (state.sections.has(y)) return;
    const occupied = new Uint8Array(48 * 48);
    band.geometry.boundsTree ||= new MeshBVH(band.geometry, {
      indirect: true,
      targetLeafSize: 8,
    });
    const r = state.section.radius,
      step = (2 * r) / 48;
    for (let j = 0; j < 48; j++)
      for (let i = 0; i < 48; i++) {
        const x = -r + (i + 0.5) * step,
          z = -r + (j + 0.5) * step;
        if (x * x + z * z > r * r) continue;
        sectionRay.origin.set(state.section.x + x, y, state.section.z + z);
        const hit = band.geometry.boundsTree.raycastFirst(
          sectionRay,
          T.DoubleSide,
        );
        if (hit && hit.face.normal.x > 0) occupied[j * 48 + i] = 1;
      }
    state.sections.set(y, occupied);
  };
  addSection(state.section.y);
  if (cut.y !== undefined) addSection(cut.y);
  let strength = null;
  for (const [y, occupied] of state.sections) {
    const sampled = sectionStrength(
      { ...state.section, y },
      [cut],
      state.mass,
      state.com,
      loose,
      newFracture ? [candidate] : [],
      occupied,
    );
    if (
      !strength ||
      sampled.load > strength.load ||
      sampled.fraction < strength.fraction
    )
      strength = { ...sampled, y };
  }
  const result = {
    released,
    band: surfaceRecord(band, state.section),
    chunk: {
      ...surfaceRecord(chunk, state.section),
      volume: solidVolume(chunk),
    },
    strength,
    timing: {
      geometryMs,
      strengthMs: performance.now() - started - geometryMs,
    },
  };
  disposeBrush(chunk);
  for (const fragment of loose) disposeBrush(fragment);
  if (strength.failed) {
    const splitter = fractureBelow({ ...state.section, y: strength.y });
    const stump = boolean(band, splitter, INTERSECTION),
      fallen = boolean(band, splitter, SUBTRACTION);
    result.stump = surfaceRecord(stump, state.section);
    result.fallen = surfaceRecord(fallen, state.section);
    disposeBrush(splitter);
    disposeBrush(stump);
    disposeBrush(fallen);
  }
  return result;
}
export function surfaceRecord(b, section) {
  const g = b.geometry.index ? b.geometry.toNonIndexed() : b.geometry.clone();
  const materials = Array.isArray(b.material) ? b.material : [b.material];
  for (const group of g.groups) {
    group.materialIndex = materials[group.materialIndex] === wood ? 1 : 0;
    if (group.materialIndex !== 1) continue;
    const p = g.attributes.position,
      norm = g.attributes.normal,
      uv = g.attributes.uv,
      col = g.attributes.color;
    for (let i = group.start; i < group.start + group.count; i++) {
      // One atlas: growth rings on end grain, longitudinal fibres on split faces.
      const end = Math.abs(norm.getY(i)) > 0.45;
      const x = p.getX(i) - section.x,
        z = p.getZ(i) - section.z;
      const u = end
        ? 0.25 + x / (section.radius * 5)
        : 0.75 + (Math.abs(norm.getX(i)) > 0.5 ? z : x) * 0.16;
      const v = end
        ? 0.5 + z / (section.radius * 2.5)
        : 0.5 + (p.getY(i) - section.y) * 0.65;
      uv.setXY(
        i,
        Math.max(end ? 0.005 : 0.505, Math.min(end ? 0.495 : 0.995, u)),
        Math.max(0.005, Math.min(0.995, v)),
      );
      col.setXYZ(i, 1, 1, 1);
    }
  }
  const record = packGeometry(g);
  g.dispose();
  return record;
}
export function disposeCutState(state) {
  for (const b of new Set([
    state.bottom,
    state.top,
    state.band,
  ]))
    disposeBrush(b);
}
