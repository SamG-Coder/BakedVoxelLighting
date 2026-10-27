import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { AtmosphereSynth } from "../src/ambience-synth.js";
const rate = 48000,
  synth = new AtmosphereSynth(rate),
  channels = Array.from({ length: 10 }, () => new Float32Array(128));
const refs = channels.slice(),
  states = [synth.remaining, synth.phase, synth.low, synth.target];
const sums = new Float64Array(10),
  peaks = new Float64Array(10);
synth.target.set([0.6, 0.6, 0.65, 0.65], 6);
for (let i = 0; i < 4; i++) synth.trigger(i, i, 1, 3.1);
const seconds = 14,
  pcm = new Int16Array(rate * seconds * 2);
for (let frame = 0; frame < rate * seconds; frame += 128) {
  if (frame === rate * 8) synth.trigger(0, 2, 0.93, 2.3);
  synth.process(channels);
  for (let i = 0; i < 128 && frame + i < rate * seconds; i++) {
    let left = 0,
      right = 0;
    for (let b = 0; b < 10; b++) {
      const v = channels[b][i];
      assert.ok(Number.isFinite(v));
      sums[b] += v * v;
      peaks[b] = Math.max(peaks[b], Math.abs(v));
      left += v * (b % 2 ? 0.28 : 0.72);
      right += v * (b % 2 ? 0.72 : 0.28);
    }
    pcm[(frame + i) * 2] = Math.round(
      Math.max(-1, Math.min(1, left)) * 0.6 * 32767,
    );
    pcm[(frame + i) * 2 + 1] = Math.round(
      Math.max(-1, Math.min(1, right)) * 0.6 * 32767,
    );
  }
}
for (let b = 0; b < 4; b++)
  assert.ok(sums[b] > 1, "every call has audible energy");
for (let b = 6; b < 8; b++)
  assert.equal(sums[b], 0, "river stays silent even with nonzero input levels");
for (let b = 8; b < 10; b++) {
  assert.ok(sums[b] > 0, "quiet wind remains active");
  assert.ok(peaks[b] < 0.01, "wind is restrained at the source");
}
for (let b = 0; b < 10; b++)
  assert.ok(peaks[b] < 0.5, "individual voice stays below clipping");
assert.ok(channels.every((c, i) => c === refs[i]));
assert.deepEqual(states, [
  synth.remaining,
  synth.phase,
  synth.low,
  synth.target,
]);
assert.ok(
  channels.slice(0, 6).every((c) => c.every((v) => v === 0)),
  "expired birds return to silence",
);
synth.target.fill(0);
for (let i = 0; i < 2000; i++) synth.process(channels);
assert.ok(
  channels.slice(6).every((c) => c.every((v) => Math.abs(v) < 1e-5)),
  "environment fades out without a stuck voice",
);
const header = Buffer.alloc(44);
header.write("RIFF");
header.writeUInt32LE(36 + pcm.byteLength, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.byteLength, 40);
if (process.argv.includes("--preview"))
  writeFileSync(
    "evidence/atmosphere-synthesis.wav",
    Buffer.concat([header, Buffer.from(pcm.buffer)]),
  );
console.log(
  JSON.stringify({
    passed: true,
    seconds,
    voicePeaks: Array.from(peaks),
    fixedBuffers: true,
    expiredCallsSilent: true,
  }),
);
