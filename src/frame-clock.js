// Measures delivered animation callbacks, not the monitor's advertised refresh rate.
export class FrameClock {
  constructor() {
    this.reset();
  }
  reset() {
    this.last = null;
    this.samples ||= [];
    this.work ||= [];
    this.samples.length = this.work.length = 0;
  }
  begin(now, paused = false) {
    if (paused) {
      this.reset();
      return 0;
    }
    const elapsed = this.last === null ? 0 : Math.max(0, now - this.last);
    this.last = now;
    // Background/resume and suspended callbacks are not a new steady frame rate.
    if (elapsed > 250) {
      this.samples.length = this.work.length = 0;
    }
    this.samples.push(now);
    while (this.samples.length > 2 && this.samples[0] < now - 750) {
      this.samples.shift();
      this.work.shift();
    }
    return Math.min(elapsed / 1000, 0.05);
  }
  end(cpuMs) {
    this.work.push(cpuMs);
  }
  read() {
    const n = this.samples.length,
      span = n > 1 ? this.samples[n - 1] - this.samples[0] : 0;
    return {
      fps: span > 0 ? ((n - 1) * 1000) / span : 0,
      frameMs: n > 1 ? span / (n - 1) : 0,
      cpuMs: this.work.length
        ? this.work.reduce((a, b) => a + b, 0) / this.work.length
        : 0,
      samples: n,
    };
  }
}
export function dampingAtDelta(base, dt) {
  return 1 - Math.pow(1 - base, Math.max(0, dt) * 60);
}
