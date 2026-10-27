// Fixed synthesis buffers. Calls are newly articulated note sequences, never samples on a loop.
const SIZE = 8192,
  sine = new Float32Array(SIZE),
  MAX_NOTES = 64;
for (let i = 0; i < SIZE; i++) sine[i] = Math.sin((i / SIZE) * Math.PI * 2);
const wave = (p) => sine[(p * SIZE) & (SIZE - 1)];
export const AMBIENCE_BUSES = 10;
export const CALL_NAMES = [
  "fluty song",
  "two-note woodland call",
  "repeated thrush motif",
  "owl hoot",
  "wood tapping",
  "wren-like trill",
  "five-note coo",
  "insect chirps",
  "wing and leaf rustle",
  "contact chirrup",
];
export class AtmosphereSynth {
  constructor(rate = 48000) {
    this.rate = rate;
    this.clock = 0;
    this.remaining = new Float64Array(6);
    this.elapsed = new Float64Array(6);
    this.kind = new Uint8Array(6);
    this.pitch = new Float32Array(6);
    this.phase = new Float64Array(10);
    this.secondPhase = new Float64Array(6);
    this.level = new Float32Array(10);
    this.target = new Float32Array(10);
    this.noiseState = new Int32Array(10);
    this.low = new Float64Array(10);
    this.slow = new Float64Array(10);
    this.noteCount = new Uint8Array(6);
    this.noteIndex = new Uint8Array(6);
    this.noteStart = new Float32Array(6 * MAX_NOTES);
    this.noteLength = new Float32Array(6 * MAX_NOTES);
    this.noteFrom = new Float32Array(6 * MAX_NOTES);
    this.noteTo = new Float32Array(6 * MAX_NOTES);
    this.noteMod = new Float32Array(6 * MAX_NOTES);
    for (let i = 0; i < 10; i++) this.noiseState[i] = 18371 + i * 8273;
    this.smooth = 1 - Math.exp(-1 / (rate * 0.35));
  }
  random(i) {
    let x = this.noiseState[i];
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noiseState[i] = x;
    return (x >>> 0) / 2147483648 - 1;
  }
  note(slot, start, len, from, to, mod = 0) {
    const count = this.noteCount[slot];
    if (count >= MAX_NOTES) return;
    const i = slot * MAX_NOTES + count;
    this.noteCount[slot]++;
    this.noteStart[i] = start;
    this.noteLength[i] = len;
    this.noteFrom[i] = from;
    this.noteTo[i] = to;
    this.noteMod[i] = mod;
  }
  trigger(slot, kind, pitch = 1, duration = 2.5, seed = 3127) {
    if (slot < 0 || slot >= 6) return;
    this.kind[slot] = kind;
    this.pitch[slot] = pitch;
    this.elapsed[slot] = 0;
    this.remaining[slot] = duration;
    this.phase[slot] = 0;
    this.secondPhase[slot] = 0;
    this.noteCount[slot] = 0;
    this.noteIndex[slot] = 0;
    this.noiseState[slot] = seed | 0 || 3127;
    let time = 0;
    const motif = 1500 + (this.random(slot) + 1) * 450;
    for (let n = 0; n < MAX_NOTES && time < duration - 0.06; n++) {
      const r = (this.random(slot) + 1) * 0.5;
      let len = 0.15,
        from = 2200,
        to = 2800,
        mod = 0,
        gap = 0.06;
      if (kind === 0) {
        len = 0.12 + r * 0.22;
        from = 1450 + r * 1700;
        to = from + this.random(slot) * (n > 3 ? 1000 : 480);
        mod = n > 3 ? 130 : 18;
        gap = 0.045 + r * 0.09;
        if (n % 5 === 4) gap += 0.3;
      } else if (kind === 1) {
        len = 0.12 + r * 0.025;
        from = n % 2 ? 2850 : 3850;
        to = from - 180;
        gap = n % 2 ? 0.28 : 0.07;
        mod = 35;
      } else if (kind === 2) {
        len = 0.19;
        from = motif + (n % 3) * 390;
        to = from + (n % 3 === 1 ? -700 : 400);
        gap = n % 3 === 2 ? 0.24 : 0.07;
        mod = 40;
      } else if (kind === 3) {
        len = n === 0 ? 0.25 : 0.65;
        from = 490;
        to = n === 0 ? 460 : 390;
        gap = n === 0 ? 0.48 : 0.9;
        mod = 5;
      } else if (kind === 4) {
        len = 0.025;
        from = 1400;
        to = 650;
        gap = 0.035 + r * 0.015;
      } else if (kind === 5) {
        len = n < 3 ? 0.16 : 0.035 + r * 0.025;
        from = n < 3 ? 4900 : 3800 + (n % 2) * 800;
        to = from - 650;
        gap = n < 3 ? 0.11 : 0.018;
        mod = 80;
      } else if (kind === 6) {
        const j = n % 5;
        len = j === 1 ? 0.45 : 0.23;
        from = j === 1 ? 520 : 405;
        to = from - 25;
        gap = j === 4 ? 0.85 : 0.09;
        mod = 4;
      } else if (kind === 7) {
        len = 0.025;
        from = 5100;
        to = 5200;
        gap = n % 4 === 3 ? 0.4 : 0.035;
        mod = 10;
      } else if (kind === 8) {
        len = 0.06 + r * 0.08;
        from = 1100;
        to = 600;
        gap = 0.08 + r * 0.1;
      } else {
        len = 0.06 + r * 0.06;
        from = 3200 + r * 700;
        to = from - 1100;
        mod = 90;
        gap = 0.08 + r * 0.2;
      }
      this.note(slot, time, Math.min(len, duration - time), from, to, mod);
      time += len + gap;
    }
  }
  process(channels) {
    const dt = 1 / this.rate,
      frames = channels[0].length;
    for (let b = 0; b < 10; b++) {
      const out = channels[b];
      if (b < 6) {
        for (let i = 0; i < frames; i++) {
          if (this.remaining[b] <= 0) {
            out[i] = 0;
            continue;
          }
          const t = this.elapsed[b],
            kind = this.kind[b];
          let ni = this.noteIndex[b],
            idx = b * MAX_NOTES + ni;
          while (
            ni < this.noteCount[b] &&
            t > this.noteStart[idx] + this.noteLength[idx]
          ) {
            ni++;
            idx++;
          }
          this.noteIndex[b] = ni;
          let value = 0;
          if (ni < this.noteCount[b] && t >= this.noteStart[idx]) {
            const nt = t - this.noteStart[idx],
              len = this.noteLength[idx],
              u = nt / len;
            const envelope =
              Math.min(1, nt / 0.008) *
              Math.max(0, Math.min(1, (len - nt) / 0.045)) *
              Math.min(1, this.remaining[b] / 0.06);
            const frequency =
              (this.noteFrom[idx] +
                (this.noteTo[idx] - this.noteFrom[idx]) * u +
                this.noteMod[idx] * wave(nt * (kind === 5 ? 33 : 12))) *
              this.pitch[b];
            this.phase[b] = (this.phase[b] + frequency * dt) % 1;
            this.secondPhase[b] =
              (this.secondPhase[b] +
                frequency * (1.18 + 0.03 * wave(t * 0.7)) * dt) %
              1;
            const p = this.phase[b];
            if (kind === 4)
              value =
                (wave(p) + this.random(b) * 0.3) * Math.pow(1 - u, 3) * 0.15;
            else if (kind === 8) {
              const n = this.random(b);
              this.low[b] += (n - this.low[b]) * 0.35;
              value = (n - this.low[b]) * 0.075;
            } else
              value =
                (wave(p) +
                  0.08 * wave(p * 2) +
                  (kind === 0 || kind === 5
                    ? 0.11 * wave(this.secondPhase[b])
                    : 0)) *
                (kind === 3
                  ? 0.16
                  : kind === 6
                    ? 0.13
                    : kind === 7
                      ? 0.045
                      : 0.105);
            value *= envelope;
          }
          out[i] = value;
          this.elapsed[b] += dt;
          this.remaining[b] -= dt;
        }
      } else if (b < 8) {
        // Reserved river buses stay silent, including stale environment messages.
        out.fill(0);
      } else {
        for (let i = 0; i < frames; i++) {
          const n = this.random(b);
          this.low[b] += (n - this.low[b]) * 0.28;
          this.slow[b] += (n - this.slow[b]) * 0.07;
          this.level[b] += (this.target[b] - this.level[b]) * this.smooth;
          const t = this.clock + i * dt;
          const breath =
            0.12 + 0.88 * Math.pow(Math.max(0, wave(t * 0.055 + b * 0.23)), 2);
          // Mid/high leaf friction without the previous low-pass rumble/muffle.
          out[i] =
            (this.low[b] - this.slow[b]) * 0.024 * this.level[b] * breath;
        }
      }
    }
    this.clock += frames * dt;
  }
}
