import * as T from "three/webgpu";
import { WorkerClient } from "./worker-client.js";
import { packGeometry, unpackGeometry } from "./tree-cut-geometry.js";
import { woodInteriorTexture } from "./wood-interior.js";
import { applyTreeEdits } from "./tree-edit-visibility.js";
import { decorate, fadeMaterial, lightUniforms } from "./lighting.js";
import { height } from "./world-data.js";
import { treeTint } from "./plant-appearance.js";
import { MeshBVH } from "three-mesh-bvh";
import { makeAxe } from "./axe-model.js";
import {
  AxeSweep,
  SWING_SECONDS,
  AXE_REST_POSITION,
  AXE_REST_ROTATION,
} from "./axe-sweep.js";

const MAX_TREES = 32,
  MAX_CHUNKS = 24;
export class TreeCutting {
  constructor({ scene, camera, world, clusters, collision, onChanged }) {
    Object.assign(this, {
      scene,
      camera,
      world,
      clusters,
      collision,
      onChanged,
    });
    this.worker = new WorkerClient(
      new Worker(new URL("./tree-cut-worker.js", import.meta.url), {
        type: "module",
        name: "wood fracture",
      }),
      "wood fracture",
    );
    this.entries = new Map();
    this.busy = false;
    this.enabled = false;
    this.cooldown = 0;
    this.direction = new T.Vector3();
    this.scratch = new T.Vector3();
    this.axis = new T.Vector3();
    this.quaternion = new T.Quaternion();
    this.texture = woodInteriorTexture();
    this.wood = decorate(
      new T.MeshStandardMaterial({
        map: this.texture,
        roughness: 0.9,
        vertexColors: true,
      }),
    );
    this.chunks = Array.from({ length: MAX_CHUNKS }, () => ({
      mesh: new T.Mesh(new T.BufferGeometry(), this.wood),
      v: new T.Vector3(),
      spin: new T.Vector3(),
      age: 99,
      ground: 0,
    }));
    for (const p of this.chunks) {
      p.mesh.visible = false;
      p.mesh.castShadow = true;
      p.mesh.receiveShadow = true;
      scene.add(p.mesh);
    }
    this.chunkCursor = 0;
    this.stats = {
      cuts: 0,
      felled: 0,
      edited: 0,
      chunks: 0,
      remaining: 1,
      load: 0,
      worker: this.worker.stats,
    };
    this.hud = document.createElement("div");
    this.hud.id = "chopHint";
    this.hud.hidden = true;
    this.hud.setAttribute("role", "status");
    document.body.append(this.hud);
    this.axe = makeAxe();
    this.sweep = new AxeSweep();
    this.restPosition = AXE_REST_POSITION;
    this.restRotation = AXE_REST_ROTATION;
    if (!camera.parent) scene.add(camera);
    camera.add(this.axe);
    this.axe.visible = false;
    this.lastHud = 0;
    this.swing = 0;
    this.ready = this.worker
      .run("colliders", {
        geometry: clusters.prototypes.map((p) => packGeometry(p.high)),
      })
      .then(async (records) => {
        this.colliders = records.map((r) => {
          const g = unpackGeometry(r.geometry);
          g.clearGroups();
          g.boundsTree = MeshBVH.deserialize(r.bvh, g, { setIndex: false });
          return g;
        });
        await this.axe.userData.ready;
        await this.clusters.prepareGroup?.(this.axe, () => 0);
      })
      .catch((error) => {
        console.error("Axe collision preparation:", error);
        this.message = "Axe collision preparation failed.";
      });
  }
  pick() {
    this.camera.getWorldDirection(this.direction);
    return this.collision.pickTree(
      this.camera.position,
      this.direction,
      1.85,
      this.world.trees,
    );
  }
  strike() {
    if (!this.enabled || !this.colliders || this.busy || this.cooldown > 0)
      return;
    this.sweep.begin(this.camera, this.collision, this.world.trees);
    this.swing = SWING_SECONDS;
    this.cooldown = SWING_SECONDS + 0.1;
    this.message = "";
  }
  async cutAtContact(contact) {
    const id = contact.id;
    const tree = this.world.trees[id];
    let entry = this.entries.get(id);
    if (entry?.falling || tree.felled) return;
    if (!entry && this.entries.size >= MAX_TREES) {
      this.message =
        "This session has 32 edited trees. Existing notches can still be cut.";
      return;
    }
    this.busy = true;
    this.message = "Splitting wood…";
    try {
      if (!entry) entry = this.createEntry(id, tree, contact.point.y);
      const local = this.scratch
        .copy(contact.point)
        .sub(entry.origin)
        .applyAxisAngle(T.Object3D.DEFAULT_UP, -tree.rotation)
        .multiplyScalar(1 / tree.scale);
      const angle = Math.atan2(
        local.z - entry.section.z,
        local.x - entry.section.x,
      );
      const y = local.y;
      if (entry.history.length >= 96) {
        this.message =
          "This tree has reached the session limit of 96 distinct cuts.";
        return;
      }
      const radial = Math.hypot(
        local.x - entry.section.x,
        local.z - entry.section.z,
      );
      const cut = {
        angle,
        y,
        // Blade-sized chips, with a sloped entry matching this actual stroke.
        halfWidth: (contact.bladeHeight * 0.55) / tree.scale,
        halfHeight: 0.095 / tree.scale,
        slope: T.MathUtils.clamp(
          contact.direction.y /
            Math.max(0.1, Math.hypot(contact.direction.x, contact.direction.z)),
          -0.9,
          0.9,
        ),
        depth: Math.min(
          entry.section.radius * 1.96,
          Math.max(0, entry.section.radius - radial) + 0.07 / tree.scale,
        ),
      };
      this.stats.contact = {
        x: contact.point.x,
        y: contact.point.y,
        z: contact.point.z,
        angle,
      };
      const result = await this.worker.run("cut", {
        key: id,
        needsInitial: !entry.group,
        geometry: this.workerTarget === id ? null : entry.source,
        section: entry.section,
        mass: entry.mass,
        com: entry.com,
        history: entry.history,
        cut,
      });
      this.workerTarget = id;
      this.stats.calculation = result.timing;
      const pending = new T.Group(),
        replacements = [];
      const add = (record, name) => {
        const mesh = new T.Mesh(unpackGeometry(record), entry.materials);
        mesh.castShadow = mesh.receiveShadow = true;
        pending.add(mesh);
        replacements.push([name, mesh]);
        return mesh;
      };
      if (!entry.group) {
        add(result.initial.bottom, "bottom");
        add(result.initial.top, "top");
      }
      const band = add(result.band, "band");
      band.geometry.boundsTree = MeshBVH.deserialize(
        result.bvh,
        band.geometry,
        { setIndex: false },
      );
      if (result.stump) {
        add(result.stump, "stumpBand");
        add(result.fallen, "fallBand");
      }
      // Compile/upload the replacement while the old intact representation remains visible.
      try {
        await this.clusters.prepareGroup?.(pending, () => 0);
      } catch (error) {
        for (const [, m] of replacements) m.geometry.dispose();
        throw error;
      }
      if (!entry.group) this.publishEntry(entry);
      for (const [name, mesh] of replacements) {
        entry[name]?.removeFromParent();
        entry[name]?.geometry.dispose();
        entry[name] = mesh;
        entry.group.add(mesh);
      }
      entry.group.updateMatrixWorld(true);
      entry.history.push(cut);
      this.emitChunk(result.chunk, entry, angle);
      for (const released of result.released || [])
        this.emitChunk(released, entry, angle);
      this.stats.released =
        (this.stats.released || 0) + (result.released?.length || 0);
      this.stats.cuts++;
      this.stats.remaining = result.strength.fraction;
      this.stats.load = result.strength.load;
      this.stats.edited = this.entries.size;
      if (result.strength.failed) this.startFall(entry, result.strength);
      this.message = result.strength.failed
        ? "Timber — move clear!"
        : `Wood remaining ${Math.round(result.strength.fraction * 100)}% · hinge load ${Math.round(result.strength.load * 100)}%`;
    } catch (error) {
      this.workerTarget = null;
      console.error("Tree cutting:", error);
      this.message = "Cut could not finish. Try again.";
    } finally {
      this.busy = false;
    }
  }
  createEntry(id, tree, hitY = tree.y + 1.1) {
    const prototype = this.clusters.prototypes[tree.variant],
      path = prototype.paths.find((p) => p.rootFlare);
    const y = T.MathUtils.clamp(
      (hitY - tree.y) / tree.scale,
      0.4 / tree.scale,
      Math.min(2.15 / tree.scale, path.points.at(-1).y * 0.7),
    );
    let j = 0;
    while (j < path.points.length - 2 && path.points[j + 1].y < y) j++;
    const t =
      (y - path.points[j].y) / (path.points[j + 1].y - path.points[j].y);
    const section = {
      x: T.MathUtils.lerp(path.points[j].x, path.points[j + 1].x, t),
      y,
      z: T.MathUtils.lerp(path.points[j].z, path.points[j + 1].z, t),
      radius: T.MathUtils.lerp(path.radii[j], path.radii[j + 1], t),
      low: 0.15 / tree.scale,
      high: 2.5 / tree.scale,
    };
    // Copy only the interacted tree. Shared prototype geometry stays immutable.
    const geometry = prototype.high.clone(),
      p = geometry.attributes.position;
    const c = Math.cos(tree.rotation),
      s = Math.sin(tree.rotation);
    for (let i = 0; i < p.count; i++)
      if (p.getY(i) < 2) {
        const x = p.getX(i) * tree.scale,
          z = p.getZ(i) * tree.scale,
          y = p.getY(i);
        const wx = x * c + z * s,
          wz = -x * s + z * c,
          drop = Math.min(0, height(tree.x + wx, tree.z + wz) - tree.y);
        const r = Math.max(0.001, Math.hypot(wx, wz)),
          w = 1 - T.MathUtils.smoothstep(y, 0, 2),
          reach = 1 + (1 / Math.sqrt(1 + (drop / r) ** 2) - 1) * w;
        const fitted = Math.min(
          0,
          height(tree.x + wx * reach, tree.z + wz * reach) - tree.y,
        );
        p.setXYZ(
          i,
          p.getX(i) * reach,
          y + (fitted * w) / tree.scale,
          p.getZ(i) * reach,
        );
      }
    geometry.computeVertexNormals();
    let mass = 0,
      cx = 0,
      cy = 0,
      cz = 0;
    for (const branch of prototype.paths)
      for (let i = 1; i < branch.points.length; i++) {
        const a = branch.points[i - 1],
          b = branch.points[i],
          r0 = branch.radii[i - 1],
          r1 = branch.radii[i];
        const m =
          ((Math.PI * (r0 * r0 + r0 * r1 + r1 * r1)) / 3) *
          a.distanceTo(b) *
          650;
        mass += m;
        cx += (a.x + b.x) * 0.5 * m;
        cy += (a.y + b.y) * 0.5 * m;
        cz += (a.z + b.z) * 0.5 * m;
      }
    const bark = fadeMaterial(prototype.model.children[0].material.clone());
    const tint = treeTint(tree.seed);
    bark.color.multiply(new T.Color().setRGB(...tint));
    const leaf = fadeMaterial(prototype.model.children[1].material.clone());
    leaf.color.multiply(new T.Color().setRGB(...tint));
    const entry = {
      id,
      tree,
      prototype,
      section,
      origin: new T.Vector3(tree.x, tree.y, tree.z),
      mass: mass * tree.scale,
      com: { x: cx / mass, y: cy / mass, z: cz / mass },
      source: packGeometry(geometry),
      history: [],
      materials: [bark, this.wood],
      leafMaterial: leaf,
    };
    geometry.dispose();
    this.entries.set(id, entry);
    return entry;
  }
  publishEntry(entry) {
    const t = entry.tree,
      group = new T.Group();
    group.position.copy(entry.origin);
    group.rotation.y = t.rotation;
    group.scale.setScalar(t.scale);
    entry.leaves = new T.Mesh(entry.prototype.foliage, entry.leafMaterial);
    entry.leaves.castShadow = entry.leaves.receiveShadow = true;
    group.add(entry.leaves);
    this.scene.add(group);
    entry.group = group;
    const cluster = this.clusters.find((c) => c.trees.includes(t));
    cluster.editedTrees ||= new Set();
    cluster.editedTrees.add(t);
    for (const level of cluster.levels)
      applyTreeEdits(cluster, level, this.clusters.prototypes);
  }
  emitChunk(record, entry, angle) {
    if (!record.attributes.position.array.length || record.volume < 1e-9)
      return;
    const p = this.chunks[this.chunkCursor++ % MAX_CHUNKS],
      g = unpackGeometry(record);
    g.computeBoundingBox();
    g.boundingBox.getCenter(this.scratch);
    const center = this.scratch.clone();
    g.translate(-center.x, -center.y, -center.z);
    p.mesh.geometry.dispose();
    p.mesh.geometry = g;
    p.mesh.material = entry.materials;
    p.mesh.position
      .copy(center)
      .multiplyScalar(entry.tree.scale)
      .applyAxisAngle(T.Object3D.DEFAULT_UP, entry.tree.rotation)
      .add(entry.origin);
    p.mesh.rotation.set(0, entry.tree.rotation, 0);
    p.mesh.scale.setScalar(entry.tree.scale);
    p.scale = entry.tree.scale;
    p.mesh.visible = true;
    const a = angle - entry.tree.rotation;
    p.v.set(
      Math.cos(a) * (1.2 + Math.random()),
      1.1 + Math.random() * 1.8,
      Math.sin(a) * (1.2 + Math.random()),
    );
    p.spin.set(
      Math.random() * 8 - 4,
      Math.random() * 8 - 4,
      Math.random() * 8 - 4,
    );
    p.age = 0;
    p.ground = height(p.mesh.position.x, p.mesh.position.z) + 0.025;
    this.stats.chunks++;
  }
  startFall(entry, strength) {
    entry.section.y = strength.y ?? entry.section.y;
    entry.band.removeFromParent();
    entry.band.geometry.dispose();
    entry.band = null;
    const pivot = new T.Group();
    pivot.position.set(
      entry.section.x + strength.cx,
      entry.section.y,
      entry.section.z + strength.cz,
    );
    entry.group.add(pivot);
    for (const mesh of [entry.top, entry.fallBand, entry.leaves]) {
      mesh.position.sub(pivot.position);
      pivot.add(mesh);
    }
    entry.pivot = pivot;
    entry.falling = true;
    entry.angle = 0.001;
    entry.speed = 0.02;
    entry.fallDirection = strength.angle;
    entry.axis = new T.Vector3(
      Math.sin(strength.angle),
      0,
      -Math.cos(strength.angle),
    );
    entry.tree.felled = true;
    this.stats.felled++;
    // The upright collider becomes the stump; it no longer blocks the old crown.
    this.collision.data[entry.id * 5 + 4] = entry.section.y * entry.tree.scale;
    entry.logCollider = {
      ax: entry.tree.x,
      az: entry.tree.z,
      ay: entry.tree.y,
      bx: entry.tree.x,
      bz: entry.tree.z,
      by: entry.tree.y,
      r: entry.section.radius * entry.tree.scale,
    };
    this.collision.logs.push(entry.logCollider);
    this.onChanged?.();
  }
  update(dt, enabled, now) {
    this.enabled = enabled;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.axe.visible = enabled;
    for (const m of this.axe.userData.metalMaterials)
      m.envMapIntensity = 0.025 + lightUniforms.daylight.value * 1.15;
    if (!enabled) {
      this.swing = 0;
      this.sweep.active = false;
    }
    if (this.swing > 0) {
      if (this.sweep.active) {
        const traceStart = performance.now();
        const hit = this.sweep.advance(
          dt,
          this.world.trees,
          this.colliders,
          this.entries,
        );
        this.stats.traceMs = performance.now() - traceStart;
        this.stats.maxTraceMs = Math.max(
          this.stats.maxTraceMs || 0,
          this.stats.traceMs,
        );
        if (hit) void this.cutAtContact(hit);
      }
      this.swing = Math.max(0, this.swing - dt);
      this.sweep.pose(this.axe, this.camera, SWING_SECONDS - this.swing);
    } else {
      this.axe.position.copy(this.restPosition);
      this.axe.quaternion.copy(this.restRotation);
    }
    this.camera.updateMatrixWorld(true);
    for (const entry of this.entries.values())
      if (entry.falling) this.updateFall(entry, Math.min(dt, 0.05));
    for (const p of this.chunks)
      if (p.age < 12) {
        p.age += dt;
        if (p.age >= 12) {
          p.mesh.visible = false;
          continue;
        }
        if (p.age < 4) {
          p.v.y -= 9.81 * dt;
          p.mesh.position.addScaledVector(p.v, dt);
          p.ground = height(p.mesh.position.x, p.mesh.position.z) + 0.025;
          if (p.mesh.position.y < p.ground) {
            p.mesh.position.y = p.ground;
            p.v.y = Math.abs(p.v.y) * 0.16;
            p.v.x *= 0.65;
            p.v.z *= 0.65;
            p.spin.multiplyScalar(0.6);
          }
          p.mesh.rotation.x += p.spin.x * dt;
          p.mesh.rotation.y += p.spin.y * dt;
          p.mesh.rotation.z += p.spin.z * dt;
        }
        if (p.age > 10)
          p.mesh.scale.setScalar(
            p.scale * Math.max(0.001, 1 - (p.age - 10) / 2),
          );
        p.mesh.updateMatrixWorld(true);
      }
    if (now - this.lastHud > 0.1) {
      this.lastHud = now;
      const target = enabled ? this.pick() : -1;
      this.hud.hidden = !enabled;
      this.hud.textContent = enabled
        ? this.busy
          ? "Splitting wood…"
          : target >= 0
            ? `F / click — chop tree${this.message ? " · " + this.message : ""}`
            : "F — swing axe · aim at a trunk within reach"
        : "";
    }
  }
  updateFall(entry, dt) {
    const h = Math.max(1, entry.com.y - entry.section.y);
    // Gravity-driven rotation about the remaining hinge, using rod inertia.
    entry.speed += ((9.81 * Math.sin(entry.angle + 0.055)) / (h * 1.35)) * dt;
    const previous = entry.angle;
    entry.angle = Math.min(Math.PI * 0.61, entry.angle + entry.speed * dt);
    entry.pivot.quaternion.setFromAxisAngle(entry.axis, entry.angle);
    entry.group.updateMatrixWorld(true);
    const path = entry.prototype.paths.find((p) => p.rootFlare);
    let hit = false;
    for (let j = 2; j < path.points.length; j++) {
      const point = path.points[j];
      if (point.y < entry.section.y + 0.8) continue;
      this.scratch
        .copy(point)
        .sub(entry.pivot.position)
        .applyMatrix4(entry.pivot.matrixWorld);
      if (
        this.scratch.y - path.radii[j] * entry.tree.scale <
        height(this.scratch.x, this.scratch.z)
      ) {
        hit = true;
        break;
      }
    }
    if (hit || entry.angle >= Math.PI * 0.61) {
      entry.angle = previous;
      entry.pivot.quaternion.setFromAxisAngle(entry.axis, entry.angle);
      entry.group.updateMatrixWorld(true);
      entry.falling = false;
      entry.settled = true;
      entry.speed = 0;
    }
    const log = entry.logCollider;
    this.scratch.set(0, 0, 0).applyMatrix4(entry.pivot.matrixWorld);
    log.ax = this.scratch.x;
    log.az = this.scratch.z;
    log.ay = this.scratch.y;
    this.scratch
      .copy(path.points.at(-1))
      .sub(entry.pivot.position)
      .applyMatrix4(entry.pivot.matrixWorld);
    log.bx = this.scratch.x;
    log.bz = this.scratch.z;
    log.by = this.scratch.y;
    if (entry.settled) {
      // Keep the fallen trunk in future local voxel bakes, in its new position.
      const object = {
        wood: true,
        a: [log.ax, log.ay, log.az],
        b: [log.bx, log.by, log.bz],
        r: log.r,
      };
      this.world.areaIndexes.objects.insert(
        object,
        Math.min(log.ax, log.bx) - log.r,
        Math.min(log.az, log.bz) - log.r,
        Math.max(log.ax, log.bx) + log.r,
        Math.max(log.az, log.bz) + log.r,
      );
      this.onChanged?.();
    }
  }
}
