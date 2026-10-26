// Every request has a reply or rejection. Transfer lists avoid copying completed buffers.
export class WorkerClient {
  constructor(worker, name) {
    this.worker = worker;
    this.pending = new Map();
    this.next = 0;
    this.stats = {
      name,
      pending: 0,
      completed: 0,
      workerMs: 0,
      lastWorkerMs: 0,
      errors: [],
    };
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      job.cleanup?.();
      this.stats.pending = this.pending.size;
      if (data.error) {
        this.stats.errors.push(data.error);
        job.reject(new Error(data.error));
      } else {
        this.stats.completed++;
        this.stats.lastWorkerMs = data.workerMs || 0;
        this.stats.workerMs += this.stats.lastWorkerMs;
        job.resolve(data.result);
      }
    };
    const fail = (event) => {
      this.error = new Error(
        event.message || `${name} worker could not decode a message`,
      );
      this.stats.errors.push(this.error.message);
      for (const job of this.pending.values()) {
        job.cleanup?.();
        job.reject(this.error);
      }
      this.pending.clear();
      this.stats.pending = 0;
    };
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
  }
  run(type, payload, transfer = [], signal) {
    if (this.error) return Promise.reject(this.error);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.stats.pending = this.pending.size;
        this.worker.postMessage({ type: "cancel", id });
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.get(id).cleanup = () =>
        signal?.removeEventListener("abort", abort);
      this.stats.pending = this.pending.size;
      try {
        this.worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        this.stats.pending = this.pending.size;
        reject(error);
      }
    });
  }
}
