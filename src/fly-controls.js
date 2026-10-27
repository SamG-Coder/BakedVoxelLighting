import { Euler, Vector3 } from "three/webgpu";

// Rotation changes the view at the current position; there is no orbit pivot.
// Keep target for explicit viewpoints and capture tools, not as a frame constraint.
export class FlyControls {
  constructor(camera, element) {
    this.camera = camera;
    this.target = new Vector3();
    this.rotation = new Euler(0, 0, 0, "YXZ");
    this.forward = new Vector3();
    this.motion = new Vector3();
    this._enabled = true;
    this.sensitivity = 1;
    this.invertY = false;
    this.pointer = null;
    this.travel = 0;
    element.addEventListener("pointerdown", (event) => {
      if (
        !this.enabled ||
        event.button !== 0 ||
        element.ownerDocument.pointerLockElement === element
      )
        return;
      this.pointer = event.pointerId;
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener("pointermove", (event) => {
      if (
        !this.enabled ||
        this.pointer !== event.pointerId ||
        element.ownerDocument.pointerLockElement === element
      )
        return;
      this.look(event.movementX, event.movementY);
    });
    const release = () => {
      this.pointer = null;
    };
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
    element.addEventListener(
      "wheel",
      (event) => {
        if (!this.enabled) return;
        event.preventDefault();
        const scale =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? element.clientHeight
              : 1;
        this.travel = Math.max(
          -60,
          Math.min(60, this.travel - event.deltaY * scale * 0.025),
        );
      },
      { passive: false },
    );
    element.ownerDocument.defaultView.addEventListener("blur", () => {
      release();
      this.travel = 0;
    });
  }

  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    this._enabled = value;
    this.pointer = null;
    this.travel = 0;
  }

  look(dx, dy) {
    this.rotation.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.rotation.y -= dx * 0.002 * this.sensitivity;
    this.rotation.x = Math.max(
      -1.55,
      Math.min(
        1.55,
        this.rotation.x -
          dy * 0.002 * this.sensitivity * (this.invertY ? -1 : 1),
      ),
    );
    this.rotation.z = 0;
    this.camera.quaternion.setFromEuler(this.rotation);
  }

  lookAtTarget() {
    this.travel = 0;
    this.camera.lookAt(this.target);
  }

  update(dt, keys) {
    // Existing capture tools explicitly set target and call update without dt.
    if (dt === undefined) {
      if (this.enabled) this.lookAtTarget();
      return;
    }
    if (!this.enabled || dt <= 0) return;
    this.rotation.setFromQuaternion(this.camera.quaternion, "YXZ");
    const yaw = this.rotation.y;
    const forward =
      Number(keys?.has("KeyW") || false) - Number(keys?.has("KeyS") || false);
    const right =
      Number(keys?.has("KeyD") || false) - Number(keys?.has("KeyA") || false);
    const up =
      Number(keys?.has("KeyE") || false) - Number(keys?.has("KeyQ") || false);
    this.camera.getWorldDirection(this.forward);
    this.motion.set(
      this.forward.x * forward + Math.cos(yaw) * right,
      this.forward.y * forward + up,
      this.forward.z * forward - Math.sin(yaw) * right,
    );
    if (this.motion.lengthSq() > 0) {
      const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 60 : 18;
      this.camera.position.addScaledVector(this.motion.normalize(), speed * dt);
    }
    const step = this.travel * (1 - Math.exp(-14 * dt));
    this.travel -= step;
    if (Math.abs(this.travel) < 0.0001) this.travel = 0;
    this.camera.position.addScaledVector(this.forward, step);
  }
}
