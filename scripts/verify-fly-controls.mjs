import assert from "node:assert/strict";
import { PerspectiveCamera } from "three/webgpu";
import { FlyControls } from "../src/fly-controls.js";

function fixture() {
  const handlers = new Map();
  const element = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    setPointerCapture() {},
    clientHeight: 800,
    ownerDocument: { defaultView: { addEventListener() {} } },
  };
  const camera = new PerspectiveCamera();
  camera.position.set(20, 30, 40);
  return { camera, controls: new FlyControls(camera, element), handlers };
}
const a = fixture();
const position = a.camera.position.clone();
a.controls.look(200, -100);
assert.ok(
  a.camera.position.equals(position),
  "looking must never orbit the camera",
);
assert.notEqual(a.camera.quaternion.y, 0);
const rotation = a.camera.quaternion.clone();
a.controls.update(1 / 60);
assert.ok(
  a.camera.quaternion.equals(rotation),
  "idle update must preserve direction",
);

for (const fps of [60, 180]) {
  const b = fixture();
  const keys = new Set(["KeyW", "KeyE"]);
  const motion = b.controls.motion;
  for (let i = 0; i < fps; i++) b.controls.update(1 / fps, keys);
  assert.ok(Math.abs(b.camera.position.distanceTo(position) - 18) < 1e-9);
  assert.equal(b.controls.motion, motion);
  assert.ok(b.camera.position.y > 30);
}
const b = fixture();
b.controls.look(0, -300);
const direction = b.camera.getWorldDirection(b.controls.forward).clone();
b.controls.update(1, new Set(["KeyW"]));
const displacement = b.camera.position.clone().sub(position);
assert.ok(displacement.y > 0, "looking upward and flying forward must climb");
assert.ok(displacement.normalize().distanceTo(direction) < 1e-9);
b.controls.update(1, new Set(["KeyS"]));
assert.ok(
  b.camera.position.distanceTo(position) < 1e-9,
  "reverse flight follows the same pitched direction",
);
b.camera.rotation.set(0, 0, 0);
b.handlers.get("wheel")({ deltaY: -120, deltaMode: 0, preventDefault() {} });
for (let i = 0; i < 120; i++) b.controls.update(1 / 60);
assert.ok(
  Math.abs(b.camera.position.z - 37) < 0.001,
  "scroll must move along view direction",
);
b.controls.enabled = false;
const stopped = b.camera.position.clone();
b.controls.update(1, new Set(["KeyW"]));
assert.ok(b.camera.position.equals(stopped));
b.controls.enabled = true;
b.controls.update(1);
assert.ok(
  b.camera.position.equals(stopped),
  "resuming must not replay stale scroll movement",
);
console.log(
  "Fly controls: rotation, refresh-independent flight, diagonal speed, scroll and mode handoff passed.",
);
