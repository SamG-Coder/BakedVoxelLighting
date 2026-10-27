// Keep the worker fed while previous tiles wait for renderer/GPU residency.
// Renderer preparation still serializes GPU state and enforces upload credits.
import { prioritizeArea } from "./streaming-view.js";
const preloadWidths = [6, 15, 32];
const compareJobs = (a, b) => a.score - b.score;
export class GrassStreamQueue {
  constructor({ concurrency = 4, schedule = (fn) => setTimeout(fn, 0) } = {}) {
    this.concurrency = concurrency;
    this.schedule = schedule;
    this.jobs = [];
    this.running = 0;
    this.scheduled = false;
    this.paused = false;
    this.waiters = [];
    this.stats = {
      queued: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
      maxActive: 0,
      maxWaitMs: 0,
      maxBuildMs: 0,
      errors: [],
    };
  }

  enqueue(p, level, generation) {
    this.jobs.push({ p, level, generation, time: performance.now(), score: 0 });
    this.stats.queued = this.jobs.length;
    this.kick();
  }

  wanted({ p, level, generation }) {
    return (
      generation === p.generation && Number.isFinite(p.requestPriority[level])
    );
  }

  kick() {
    if (this.paused || this.scheduled || this.running >= this.concurrency)
      return;
    this.scheduled = true;
    // Enqueue the whole spatial query before selecting its nearest requests.
    this.schedule(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  pump() {
    let retained = 0;
    for (let i = 0; i < this.jobs.length; i++) {
      const job = this.jobs[i];
      if (this.wanted(job)) {
        // Frustum priority is refreshed once per pump, not once per comparison.
        job.score = prioritizeArea(
          job.p.center,
          job.p.requestPriority[job.level],
        );
        this.jobs[retained++] = job;
      } else {
        const { p, level, generation } = job;
        if (p.pending.get(level) === generation) p.pending.delete(level);
        this.stats.cancelled++;
      }
    }
    this.jobs.length = retained;
    this.stats.queued = this.jobs.length;
    this.jobs.sort(compareJobs);
    while (this.jobs.length && this.running < this.concurrency) {
      const job = this.jobs.shift(),
        { p, level, generation } = job;
      this.stats.queued = this.jobs.length;
      this.running++;
      this.stats.active = this.running;
      this.stats.maxActive = Math.max(this.stats.maxActive, this.running);
      const start = performance.now();
      this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, start - job.time);
      Promise.resolve()
        .then(() => p.build(level, generation))
        .then(() => {
          this.stats.completed++;
        })
        .catch((error) => {
          this.stats.errors.push(error.message);
          console.error(error);
        })
        .finally(() => {
          if (p.pending.get(level) === generation) p.pending.delete(level);
          this.stats.maxBuildMs = Math.max(
            this.stats.maxBuildMs,
            performance.now() - start,
          );
          this.stats.active = --this.running;
          this.kick();
        });
    }
    if (!this.running && !this.jobs.length)
      this.waiters.splice(0).forEach((resolve) => resolve());
  }

  finish() {
    if (!this.running && !this.jobs.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function requestGrassAhead(
  c,
  weights,
  distance,
  predictedDistance,
  distances,
) {
  // One tile of lead time even at walking speed; velocity adds up to two tiles.
  // Nearby fine preloads precede distant grass, but a tile's visible LOD
  // precedes its own speculative work. The coarsest resident
  // geometry covers the ground while finer detail is preparing.
  c.requestPriority ||= [Infinity, Infinity, Infinity];
  c.requestPriority.fill(Infinity);
  for (let i = 0; i < 3; i++) {
    if (weights[i] > 0) c.requestPriority[i] = distance;
    else if (
      Math.min(distance, predictedDistance) <
        distances[i] + preloadWidths[i] + 24 &&
      (i === 0 || Math.max(distance, predictedDistance) > distances[i - 1] - 12)
    )
      c.requestPriority[i] =
        (i === 2 ? 500 : 32) + Math.min(distance, predictedDistance);
  }
  if (
    distance < distances[2] + 32 &&
    !c.levels[0] &&
    !c.levels[1] &&
    !c.levels[2]
  )
    c.requestPriority[2] = Math.min(c.requestPriority[2], distance + 5);
  for (let i = 0; i < 3; i++)
    if (Number.isFinite(c.requestPriority[i])) c.ensure?.(i);
}
