// Serial GPU ownership with live priorities. A FIFO lets hundreds of newly
// requested trees hold a tiny grass tile up for seconds. Periodically service
// the oldest request so background terrain/shadows still make progress.
export class PreparationQueue {
  constructor() {
    this.jobs = [];
    this.running = false;
    this.burst = 0;
  }
  run(work, priority = () => 1000) {
    const promise = new Promise((resolve, reject) => {
      this.jobs.push({ work, priority, resolve, reject });
    });
    if (!this.running) this.pump();
    return promise;
  }
  async pump() {
    this.running = true;
    while (this.jobs.length) {
      // Released/passed tiles must free their pipeline slots promptly, rather
      // than waiting at the tail of a long forest preparation queue.
      this.jobs = this.jobs.filter((job) => {
        if (Number.isFinite(job.priority())) return true;
        job.resolve();
        return false;
      });
      if (!this.jobs.length) break;
      let next = 0;
      if (++this.burst < 8) {
        for (let i = 1; i < this.jobs.length; i++)
          if (this.jobs[i].priority() < this.jobs[next].priority()) next = i;
      } else this.burst = 0;
      const job = this.jobs.splice(next, 1)[0];
      try {
        job.resolve(await job.work());
      } catch (error) {
        job.reject(error);
      }
    }
    this.running = false;
  }
}
