import assert from "node:assert/strict";
import { AmbienceEcology } from "../src/ambience-ecology.js";
import { AtmosphereSynth, CALL_NAMES } from "../src/ambience-synth.js";
const forest = { height: 10, canopy: 0.8, forest: 0.8, traffic: 0 };
const ecology = new AmbienceEcology(() => forest),
  seen = new Map(),
  kinds = new Set();
let responses = 0,
  events = 0;
for (let t = 0; t < 600; t += 0.25) {
  const j = ecology.next(t, 10, 12, 10, 7);
  if (!j) continue;
  events++;
  kinds.add(j.kind);
  if (j.response) responses++;
  const key = `${j.territory}/${j.member}`;
  const signature = [j.x, j.z, j.pitch];
  if (seen.has(key))
    assert.deepEqual(
      signature,
      seen.get(key),
      "a resident retains position and pitch",
    );
  else seen.set(key, signature);
  assert.ok(j.duration > 0 && j.duration <= 6.2);
  assert.ok(ecology.pending.length === 56);
}
assert.ok(responses > 5, "resident contacts produce delayed replies");
assert.ok(kinds.size >= 4, "a local habitat has multiple call and foley types");
for (let area = 1; area < 6; area++) {
  const e = new AmbienceEcology(() => forest);
  for (let t = 0; t < 300; t += 0.25) {
    const j = e.next(t, area * 180, 12, area * 120, 7);
    if (j) kinds.add(j.kind);
  }
}
assert.ok(
  kinds.size === 8,
  "multiple territories include all eight daytime call and foley types",
);
// Leaving the area cancels old responses instead of moving the residents.
ecology.next(600, 1500, 12, 1500, 7);
for (let i = 0; i < 8; i++)
  if (ecology.pending[i * 7] >= 0)
    assert.ok(
      Math.hypot(
        (ecology.pending[i * 7 + 1] + 0.5) * 64 - 1500,
        (ecology.pending[i * 7 + 2] + 0.5) * 64 - 1500,
      ) <= 145,
    );
const silent = new AmbienceEcology(() => ({ ...forest, traffic: 1 }));
for (let t = 0; t < 60; t++) assert.equal(silent.next(t, 0, 12, 0, 12), null);
const synth = new AtmosphereSynth(48000),
  channels = Array.from({ length: 10 }, () => new Float32Array(128));
const energy = [];
for (let kind = 0; kind < CALL_NAMES.length; kind++) {
  synth.trigger(0, kind, 1, 3, 817 + kind);
  let e = 0;
  for (let b = 0; b < 1200; b++) {
    synth.process(channels);
    for (const v of channels[0]) {
      assert.ok(Number.isFinite(v));
      e += v * v;
    }
  }
  assert.ok(e > 0.01, CALL_NAMES[kind] + " is audible");
  energy.push(e);
}
synth.trigger(0, 0, 1, 3, 100);
const first = synth.noteFrom.slice(0, 64);
synth.trigger(0, 0, 1, 3, 101);
assert.notDeepEqual(
  synth.noteFrom.slice(0, 64),
  first,
  "successive songs use new phrases",
);
console.log(
  JSON.stringify({
    events,
    responses,
    residents: seen.size,
    daytimeKinds: [...kinds],
    callTypes: CALL_NAMES.length,
    energy,
  }),
);
