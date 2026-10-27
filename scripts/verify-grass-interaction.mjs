import assert from "node:assert/strict";
import { GrassInteractionField } from "../src/grass-interaction-field.js";
const field = new GrassInteractionField();
const data = field.data,
  velocity = field.velocity;
const sample = 4; // x=.4, z=0: inside the player's contact radius.
for (let i = 0; i < 120; i++) field.update(0, 0, 0, 0, 1 / 60);
const held = field.data[sample];
assert.ok(held > 0.1, "standing holds nearby grass aside");
let drift = 0;
for (let i = 0; i < 300; i++) {
  field.update(0, 0, 0, 0, 1 / 60);
  drift = Math.max(drift, Math.abs(field.data[sample] - held));
}
assert.ok(drift < 1e-6, "stationary contact does not restart or oscillate");
let previous = held;
for (let i = 0; i < 150; i++) {
  field.update(3, 0, 0, 0, 1 / 60);
  assert.ok(
    field.data[sample] >= -1e-7 && field.data[sample] <= previous + 1e-7,
    "released grass recovers without ringing",
  );
  previous = field.data[sample];
}
assert.ok(previous < 1e-5);
const fast = new GrassInteractionField(),
  slow = new GrassInteractionField();
for (let i = 0; i < 60; i++) slow.update(0, 0, 0, 0, 1 / 60);
for (let i = 0; i < 180; i++) fast.update(0, 0, 0, 0, 1 / 180);
assert.ok(
  Math.abs(slow.data[sample] - fast.data[sample]) < 1e-5,
  "refresh rate does not change spring response",
);
field.update(1000, -1000, 0, 0, 1 / 60);
assert.ok(field.data.every(Number.isFinite), "grid scrolling stays finite");
field.reset();
assert.ok(
  field.data.every((v) => v === 0),
  "Fly/menu reset removes contact history",
);
assert.equal(field.data, data);
assert.equal(field.velocity, velocity);
console.log(
  JSON.stringify({
    passed: true,
    stationaryDrift: drift,
    refreshRates: [60, 180],
    fixedBuffers: true,
  }),
);
