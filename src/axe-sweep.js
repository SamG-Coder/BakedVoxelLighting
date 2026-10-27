import * as T from "three/webgpu";
import { acceleratedRaycast } from "three-mesh-bvh";
import {
  AXE_EDGE_POINTS as EDGE,
  AXE_EDGE_CENTER,
  AXE_BIT_HEIGHT,
} from "./axe-geometry.js";

export const SWING_SECONDS = 0.94;
export const AXE_REST_POSITION = new T.Vector3(0.34, -0.64, -0.82);
export const AXE_REST_ROTATION = new T.Quaternion().setFromEuler(
  new T.Euler(0, Math.PI / 2, 0),
);
const WINDUP = 0.24,
  CONTACT_END = 0.52;
export class AxeSweep {
  constructor() {
    this.origin = new T.Vector3();
    this.forward = new T.Vector3();
    this.right = new T.Vector3();
    this.up = new T.Vector3(0, 1, 0);
    this.a = new T.Vector3();
    this.b = new T.Vector3();
    this.direction = new T.Vector3();
    this.ray = new T.Raycaster();
    this.hits = [];
    this.candidates = [];
    this.proxy = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshBasicMaterial({ side: T.DoubleSide }),
    );
    this.proxy.raycast = acceleratedRaycast;
    this.ray.firstHitOnly = true;
    this.rotation = new T.Quaternion();
    this.strokeRotation = new T.Quaternion();
    this.turn = new T.Quaternion();
    this.localAxis = new T.Vector3(0, 0, 1);
    this.edgeOffset = new T.Vector3();
    this.cutDirection = new T.Vector3();
    this.frameRotation = new T.Quaternion();
    this.cameraRotation = new T.Quaternion();
    this.restWorldPosition = new T.Vector3();
    this.restWorldRotation = new T.Quaternion();
    this.matrixA = new T.Matrix4();
    this.matrixB = new T.Matrix4();
    this.basis = new T.Matrix4();
    this.position = new T.Vector3();
    this.unit = new T.Vector3(1, 1, 1);
    this.x = new T.Vector3();
    this.y = new T.Vector3();
    this.z = new T.Vector3();
    this.elapsed = 0;
    this.active = false;
    this.contact = null;
  }
  begin(camera, collision, trees) {
    camera.getWorldPosition(this.origin);
    camera.getWorldDirection(this.forward);
    this.restWorldPosition.copy(AXE_REST_POSITION);
    camera.localToWorld(this.restWorldPosition);
    camera
      .getWorldQuaternion(this.restWorldRotation)
      .multiply(AXE_REST_ROTATION);
    this.pitch = T.MathUtils.clamp(this.forward.y, -0.7, 0.35);
    this.rising = this.pitch < -0.38;
    this.forward.y = 0;
    this.forward.normalize();
    this.right.crossVectors(this.forward, this.up).normalize();
    this.candidates.length = 0;
    collision.nearTrees(this.origin, 2.4, trees, this.candidates);
    // Commit the swing plane at wind-up. The blade leads along this plane;
    // moving the camera later cannot swivel a committed strike into a tree.
    this.x.set(-0.66, this.rising ? 0.32 : -0.32, -0.68).normalize();
    this.y.set(0, 0.75, -0.66);
    this.y.addScaledVector(this.x, -this.y.dot(this.x)).normalize();
    this.z.crossVectors(this.x, this.y).normalize();
    this.strokeRotation.setFromRotationMatrix(
      this.basis.makeBasis(this.x, this.y, this.z),
    );
    this.z.copy(this.forward).negate();
    this.frameRotation.setFromRotationMatrix(
      this.basis.makeBasis(this.right, this.up, this.z),
    );
    this.elapsed = 0;
    this.active = true;
    this.contact = null;
  }
  // Authored grip translation and tool orientation, shared by display AND traces.
  // This is deliberately not a blade orbit around the camera.
  sample(t, matrix) {
    const u = T.MathUtils.clamp((t - WINDUP) / (CONTACT_END - WINDUP), 0, 1);
    // Accelerating shoulder stroke. Head and haft rotate together while the
    // edge follows a descending plane; the grip is derived from that rigid pose.
    const progress = u * u;
    this.turn.setFromAxisAngle(this.localAxis, -0.42 + 0.64 * progress);
    this.rotation.copy(this.strokeRotation).multiply(this.turn);
    this.position.set(
      0.82 - 1.2 * progress,
      (this.rising ? -0.52 + 0.58 * progress : 0.24 - 0.58 * progress) +
        this.pitch * 1.3,
      -0.48 - 1.27 * progress,
    );
    this.edgeOffset.copy(AXE_EDGE_CENTER).applyQuaternion(this.rotation);
    this.position
      .sub(this.edgeOffset)
      .applyQuaternion(this.frameRotation)
      .add(this.origin);
    this.rotation.premultiply(this.frameRotation);
    if (t < WINDUP) {
      const lift = T.MathUtils.smoothstep(t, 0, WINDUP);
      this.position.lerpVectors(this.restWorldPosition, this.position, lift);
      this.rotation.slerpQuaternions(
        this.restWorldRotation,
        this.rotation,
        lift,
      );
    }
    matrix.compose(this.position, this.rotation, this.unit);
    return matrix;
  }
  advance(dt, trees, prototypes, entries) {
    const end = Math.min(SWING_SECONDS, this.elapsed + dt);
    let contact = null;
    for (
      let t = Math.max(WINDUP, this.elapsed);
      t < Math.min(CONTACT_END, end) && !contact;
    ) {
      const next = Math.min(t + 1 / 240, Math.min(CONTACT_END, end));
      this.sample(t, this.matrixA);
      this.sample(next, this.matrixB);
      let earliest = Infinity;
      for (const id of this.candidates) {
        const tree = trees[id];
        if (tree.felled) continue;
        const entry = entries.get(id);
        this.proxy.geometry =
          entry?.band?.geometry ||
          prototypes[tree.variant].high ||
          prototypes[tree.variant];
        this.proxy.position.set(tree.x, tree.y, tree.z);
        this.proxy.rotation.set(0, tree.rotation, 0);
        this.proxy.scale.setScalar(tree.scale);
        this.proxy.updateMatrixWorld(true);
        for (let edgeIndex = 0; edgeIndex < EDGE.length; edgeIndex++) {
          this.a.copy(EDGE[edgeIndex]).applyMatrix4(this.matrixA);
          this.b.copy(EDGE[edgeIndex]).applyMatrix4(this.matrixB);
          this.direction.subVectors(this.b, this.a);
          const length = this.direction.length();
          if (length < 1e-7) continue;
          this.direction.normalize();
          this.ray.ray.origin.copy(this.a);
          this.ray.ray.direction.copy(this.direction);
          this.ray.near = 0;
          this.ray.far = length;
          this.hits.length = 0;
          this.proxy.raycast(this.ray, this.hits);
          for (const hit of this.hits) {
            const time = t + ((next - t) * hit.distance) / length;
            if (
              time < earliest &&
              hit.point.y - tree.y > 0.4 &&
              hit.point.y - tree.y < 2.15
            ) {
              earliest = time;
              contact = {
                id,
                point: hit.point.clone(),
                time,
                edgeIndex,
                direction: this.direction.clone(),
                bladeHeight: AXE_BIT_HEIGHT,
              };
            }
          }
        }
      }
      t = next;
    }
    this.elapsed = end;
    if (contact) {
      this.contact = contact;
      this.active = false;
    }
    if (end >= CONTACT_END) this.active = false;
    return contact;
  }
  pose(axe, camera, elapsed) {
    const hitTime = this.contact?.time ?? CONTACT_END;
    const stop = this.contact ? hitTime : CONTACT_END;
    this.sample(Math.min(elapsed, stop), this.matrixB);
    // Arrest the stroke at first contact; withdraw along its approach before
    // returning to ready. Never continue the animation through the standing wood.
    if (elapsed > stop + 0.065) {
      const pull = T.MathUtils.smoothstep(elapsed, stop + 0.065, stop + 0.24);
      this.position
        .addScaledVector(this.right, pull * 0.12)
        .addScaledVector(this.forward, -pull * 0.1);
    }
    axe.position.copy(this.position);
    camera.worldToLocal(axe.position);
    camera.getWorldQuaternion(this.cameraRotation).invert();
    axe.quaternion.copy(this.rotation).premultiply(this.cameraRotation);
    const recover = T.MathUtils.smoothstep(
      elapsed,
      Math.max(0.6, stop + 0.24),
      SWING_SECONDS,
    );
    axe.position.lerp(AXE_REST_POSITION, recover);
    axe.quaternion.slerp(AXE_REST_ROTATION, recover);
  }
}
