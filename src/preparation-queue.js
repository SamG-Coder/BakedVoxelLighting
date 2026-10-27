// Serial GPU ownership with live priorities. A FIFO lets hundreds of newly
// requested trees hold a tiny grass tile up for seconds. Periodically service
// the oldest request so background terrain/shadows still make progress.
export class PreparationQueue {
  constructor(concurrency = 1) {
    this.jobs = [];
    this.running = false;
    this.active = 0;
    this.concurrency = concurrency;
    this.burst = 0;
  }
  run(work, priority = () => 1000) {
    const promise = new Promise((resolve, reject) => {
      this.jobs.push({ work, priority, resolve, reject });
    });
    this.pump();
    return promise;
  }
  pump() {
    this.running = true;
    while (this.jobs.length && this.active < this.concurrency) {
      // Released/passed tiles must free their pipeline slots promptly, rather
      // than waiting at the tail of a long forest preparation queue.
      let retained = 0;
      for (let i = 0; i < this.jobs.length; i++) {
        const job = this.jobs[i];
        if (Number.isFinite(job.priority())) this.jobs[retained++] = job;
        else job.resolve();
      }
      this.jobs.length = retained;
      if (!this.jobs.length) break;
      let next = 0;
      if (++this.burst < 8) {
        for (let i = 1; i < this.jobs.length; i++)
          if (this.jobs[i].priority() < this.jobs[next].priority()) next = i;
      } else this.burst = 0;
      const job = this.jobs[next];
      for (let i = next + 1; i < this.jobs.length; i++)
        this.jobs[i - 1] = this.jobs[i];
      this.jobs.pop();
      this.active++;
      let result;
      try {
        result = job.work();
      } catch (error) {
        result = Promise.reject(error);
      }
      Promise.resolve(result)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
    this.running = this.active > 0;
  }
}
