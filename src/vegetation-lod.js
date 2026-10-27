import { MathUtils } from "three/webgpu";
import { requestGrassAhead } from "./grass-stream-queue.js";
import { prioritizeArea, updateStreamingView } from "./streaming-view.js";
const handoffMs = 240;
const preparing = new WeakSet();
const treeBlendWidths = [14, 26, 45];
const grassBlendWidths = [12, 30, 64];

function setFade(group, low, high) {
  const material = group.material;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++)
      material[i]?.userData.fade?.value.set(low, high);
  } else material?.userData.fade?.value.set(low, high);
  for (let i = 0; i < group.children.length; i++)
    setFade(group.children[i], low, high);
}

function present(c, weights, scene) {
  // Partition the SAME screen-door mask using the weights actually resident.
  // A pending LOD must never reserve pixels that its fallback cannot draw.
  let cursor = 0;
  for (let i = 3; i >= 0; i--) {
    const low = cursor;
    cursor += weights[i];
    const object = c.levels[i];
    if (!object) continue;
    object.visible = weights[i] > 0;
    if (object.visible) {
      setFade(object, low, Math.min(1, cursor));
      if (object.parent !== scene) scene.add(object);
    } else if (object.parent) object.removeFromParent();
  }
}

function advance(c, now, scene, transitions) {
  const state = c.lodBlend;
  let difference = 0,
    presented = true;
  for (let i = 0; i < 4; i++) {
    difference = Math.max(
      difference,
      Math.abs(state.target[i] - state.weights[i]),
    );
    const object = c.levels[i];
    if (
      object &&
      (object.visible !== state.weights[i] > 0 ||
        (object.visible && object.parent !== scene))
    )
      presented = false;
  }
  if (difference === 0 && !transitions.has(c) && presented) {
    state.time = now;
    return;
  }
  // Bound the first visible step after a paused tab or a long upload. A completed
  // upload starts a handoff; it doesn't inherit the time spent waiting for it.
  const step =
    Math.min(50, Math.max(0, now - state.time)) /
    (c.kind === "grass" ? 650 : handoffMs);
  const alpha = difference <= step + 1e-8 ? 1 : step / difference;
  state.time = now;
  for (let i = 0; i < 4; i++)
    state.weights[i] =
      alpha === 1
        ? state.target[i]
        : state.weights[i] + (state.target[i] - state.weights[i]) * alpha;
  present(c, state.weights, scene);
  if (alpha === 1) transitions.delete(c);
  else transitions.add(c);
}

// Merging changes the draw layout, not the LOD. Publish a prepared replacement
// with identical coverage and scene membership before retiring its source.
export function replaceLODLevel(c, level, replacement) {
  const previous = c.levels[level];
  let range;
  previous.traverse((object) => {
    const material = Array.isArray(object.material)
      ? object.material[0]
      : object.material;
    range ||= material?.userData.fade?.value;
  });
  if (range) setFade(replacement, range.x, range.y);
  replacement.visible = previous.visible;
  if (previous.parent) previous.parent.add(replacement);
  c.levels[level] = replacement;
  previous.visible = false;
  previous.removeFromParent();
  return previous;
}

export function updateLOD(
  items,
  camera,
  force,
  distances,
  scene,
  now = performance.now(),
) {
  if (camera.projectionMatrix) updateStreamingView(camera);
  const previous = items.lodState,
    position = camera.position,
    revision = items.lodRevision || 0;
  const transitions = (items.lodTransitions ||= new Set());
  // Turning changes frustum visibility, not distance LOD. Renderer culling still runs each frame.
  if (
    previous &&
    previous.force === force &&
    previous.revision === revision &&
    Math.abs(previous.x - position.x) < 0.001 &&
    Math.abs(previous.y - position.y) < 0.001 &&
    Math.abs(previous.z - position.z) < 0.001 &&
    previous.distances[0] === distances[0] &&
    previous.distances[1] === distances[1] &&
    previous.distances[2] === distances[2]
  ) {
    // Only unfinished handoffs need work when the camera stops or just turns.
    for (const c of transitions) advance(c, now, scene, transitions);
    return previous.counts;
  }
  const counts = previous?.counts || [0, 0, 0, 0];
  counts.fill(0);
  const elapsed = previous ? (now - previous.time) / 1000 : 0;
  let leadX = 0,
    leadZ = 0;
  if (items.grid && elapsed > 0 && elapsed < 0.5) {
    leadX = ((position.x - previous.x) / elapsed) * 2;
    leadZ = ((position.z - previous.z) / elapsed) * 2;
    const limit = Math.min(1, 48 / (Math.hypot(leadX, leadZ) || 1));
    leadX *= limit;
    leadZ *= limit;
  }
  let candidates = items;
  if (items.grid) {
    // Keep the active set and scratch storage alive across frames. A numeric
    // visit stamp deduplicates the query without rebuilding a Set every move.
    candidates = items.lodCandidates ||= [];
    candidates.length = 0;
    const stamp = (items.lodVisit = (items.lodVisit || 0) + 1);
    for (const p of items.active) {
      p.lodVisit = stamp;
      candidates.push(p);
    }
    items.active.clear();
    const gx = Math.floor((camera.position.x + 2000) / 24),
      gz = Math.floor((camera.position.z + 2000) / 24);
    const query = (items.lodGridQuery ||= {
      x: NaN,
      z: NaN,
      grid: null,
      cells: [],
    });
    if (query.x !== gx || query.z !== gz || query.grid !== items.grid) {
      query.x = gx;
      query.z = gz;
      query.grid = items.grid;
      query.cells.length = 0;
      for (let z = gz - 16; z <= gz + 16; z++)
        for (let x = gx - 16; x <= gx + 16; x++) {
          const p = items.grid.get(`${x}:${z}`);
          if (p) query.cells.push(p);
        }
    }
    for (const p of query.cells) {
      if (p.lodVisit !== stamp) {
        p.lodVisit = stamp;
        candidates.push(p);
      }
    }
    counts[3] = items.length - candidates.length;
  }
  for (const c of candidates) {
    const d = c.center.distanceTo(camera.position);
    c.priority = d;
    if (c.kind === "tree") {
      if (d > Math.max(720, distances[2] + 96) && !c.lodBlend?.weights[2])
        c.releaseMiddle?.();
      for (let i = 0; i < 2; i++) {
        // Retain a generous return buffer and never retire a visible fade source.
        const outside = d > (force >= 0 ? 720 : distances[i] + 96);
        if (outside && !c.lodBlend?.weights[i] && c.keepDetail?.[i])
          c.releaseDetail?.(i);
      }
    }
    if (c.kind === "grass" && d > 360) {
      counts[3]++;
      if (
        c.current !== 3 ||
        c.pending?.size ||
        c.levels[0] ||
        c.levels[1] ||
        c.levels[2]
      ) {
        c.release?.();
        for (const object of c.levels) if (object) object.visible = false;
      }
      c.current = 3;
      transitions.delete(c);
      continue;
    }
    items.active?.add(c);
    let level =
      force < 0
        ? d < distances[0]
          ? 0
          : d < distances[1]
            ? 1
            : d < distances[2]
              ? 2
              : 3
        : force;
    if (c.kind === "grass" && d > 320) level = 3;
    if (c.kind === "tree" && d > 650 && force >= 0) level = 3;
    counts[level]++;
    c.current = level;
    const weights = (c.lodTarget ||= [0, 0, 0, 0]);
    weights.fill(0);
    weights[level] = 1;
    if (force < 0) {
      for (let i = 0; i < 3; i++) {
        const width = (c.kind === "tree" ? treeBlendWidths : grassBlendWidths)[
          i
        ];
        if (Math.abs(d - distances[i]) < width / 2) {
          const blend = MathUtils.smoothstep(
            d,
            distances[i] - width / 2,
            distances[i] + width / 2,
          );
          weights.fill(0);
          weights[i] = 1 - blend;
          weights[i + 1] = blend;
          break;
        }
      }
    }
    if (c.kind === "grass") {
      const predicted = Math.hypot(
        c.center.x - position.x - leadX,
        c.center.y - position.y,
        c.center.z - position.z - leadZ,
      );
      if (force < 0) requestGrassAhead(c, weights, d, predicted, distances);
      else {
        c.requestPriority ||= [Infinity, Infinity, Infinity];
        for (let i = 0; i < 3; i++)
          c.requestPriority[i] = weights[i] > 0 ? d : Infinity;
        for (let i = 0; i < 3; i++) if (weights[i] > 0) c.ensure?.(i);
      }
      if (d > 336) {
        for (const object of c.levels)
          if (object) {
            object.visible = false;
            object.removeFromParent();
          }
        transitions.delete(c);
        continue;
      }
    }
    if (c.kind === "tree")
      for (let i = 0; i < 2; i++) if (weights[i] > 0) c.ensure?.(i);
    let resident = 0;
    for (let i = 0; i < 4; i++) {
      const object = c.levels[i];
      if (object && (!items.prepareGroup || object.userData.pipelineReady))
        resident |= 1 << i;
    }
    for (let i = 0; i < 4; i++) {
      if (weights[i] <= 0 || resident & (1 << i)) continue;
      const object = c.levels[i];
      if (object && items.prepareGroup && !preparing.has(object)) {
        preparing.add(object);
        items
          .prepareGroup(object, () => {
            const distance = c.priority ?? d;
            return distance <=
              (i === 0 ? 181 : i === 1 ? 286 : i === 2 ? 720 : Infinity)
              ? prioritizeArea(c.center, distance)
              : Infinity;
          })
          .catch(() => {})
          .finally(() => preparing.delete(object));
      }
      // Keep the representation already on screen while waiting, instead of
      // briefly switching to the coarsest resident LOD and then back again.
      let fallback = -1;
      for (let j = 0; j < 4; j++) {
        if (!(resident & (1 << j))) continue;
        const shown = c.lodBlend?.weights[j] || 0;
        const best = c.lodBlend?.weights[fallback] || 0;
        if (
          fallback < 0 ||
          shown > best ||
          (shown === best && Math.abs(j - i) < Math.abs(fallback - i))
        )
          fallback = j;
      }
      if (fallback >= 0) weights[fallback] += weights[i];
      weights[i] = 0;
    }
    const state = c.lodBlend;
    let hasWeight = false,
      missingResident = false;
    if (state)
      for (let i = 0; i < 4; i++) {
        if (state.weights[i] > 0) {
          hasWeight = true;
          if (!(resident & (1 << i))) missingResident = true;
        }
      }
    if (
      (c.kind !== "tree" && c.kind !== "grass") ||
      (c.kind === "tree" && !items.prepareGroup) ||
      !state ||
      missingResident ||
      !hasWeight
    ) {
      const blend = (c.lodBlend ||= {
        weights: [0, 0, 0, 0],
        target: weights,
        time: now,
      });
      for (let i = 0; i < 4; i++) blend.weights[i] = weights[i];
      blend.target = weights;
      blend.time = now;
      transitions.delete(c);
      present(c, weights, scene);
    } else {
      if (!transitions.has(c)) state.time = now;
      state.target = weights;
      advance(c, now, scene, transitions);
    }
  }
  const next = (items.lodState ||= { distances: [0, 0, 0], counts });
  next.x = position.x;
  next.y = position.y;
  next.z = position.z;
  next.time = now;
  next.force = force;
  next.revision = revision;
  for (let i = 0; i < 3; i++) next.distances[i] = distances[i];
  return counts;
}
