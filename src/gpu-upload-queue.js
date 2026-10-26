// Logical transfer pages, not sparse GPU memory. GPU allocations still belong
// to Three; this queue bounds the CPU -> GPU traffic and staging backlog.
export const UPLOAD_LIMITS = Object.freeze({
  pageBytes: 64 * 1024,
  // Desktop streaming: retain a 1 ms CPU cap, but avoid throttling large
  // tree/grass batches to 15 MB/s at 60 Hz.
  frameBytes: 1024 * 1024,
  frameMs: 1,
  loadingBytes: 4 * 1024 * 1024,
  loadingMs: 4,
  framesInFlight: 2,
});

export class GPUUploadQueue {
  constructor(backend) {
    this.backend = backend;
    this.interactive = false;
    this.jobs = [];
    this.pending = new Set();
    this.fences = [];
    this.disposed = false;
    this.usedBytes = 0;
    this.usedMs = 0;
    this.frame = 0;
    this.task = null;
    this.stats = {
      ...UPLOAD_LIMITS,
      pendingResources: 0,
      pendingBytes: 0,
      inFlightBytes: 0,
      peakInFlightBytes: 0,
      peakInteractiveInFlightBytes: 0,
      uploadedBytes: 0,
      pages: 0,
      completedResources: 0,
      cancelledResources: 0,
      maxPageBytes: 0,
      maxFrameBytes: 0,
      maxInteractiveFrameBytes: 0,
      maxFrameSubmitMs: 0,
      maxInteractiveSubmitMs: 0,
      allocatedBytes: 0,
      peakAllocatedBytes: 0,
      maxAllocationMs: 0,
      maxFenceMs: 0,
      unpagedBufferBytes: 0,
      unpagedTextureBytes: 0,
      errors: [],
    };
    this.tick = () => {
      if (this.disposed) return;
      this.frame++;
      this.usedBytes = 0;
      this.usedMs = 0;
      this.pollFences();
      this.kick();
      this.scheduleFrame();
    };
    this.visibility = () => {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.hiddenTimer);
      this.scheduleFrame();
    };
    document.addEventListener("visibilitychange", this.visibility);
    this.scheduleFrame();
  }

  scheduleFrame() {
    // This clock submits no renders and does no preparation in rAF. It only
    // replenishes credits; actual copies run in a subsequent task.
    if (document.hidden) this.hiddenTimer = setTimeout(this.tick, 16);
    else this.raf = requestAnimationFrame(this.tick);
  }

  enqueue(pages, bytes, label) {
    if (this.disposed) throw new Error("GPU upload queue is disposed");
    let resolve, reject;
    const promise = new Promise((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // A shader can fail before its owner awaits its uploads.
    promise.catch(() => {});
    const job = {
      pages,
      bytes,
      remaining: bytes,
      label,
      resolve,
      reject,
      promise,
      done: false,
      next: pages.next(),
    };
    this.stats.pendingResources++;
    this.stats.pendingBytes += bytes;
    this.jobs.push(job);
    this.pending.add(job);
    this.kick();
    return job;
  }

  cancel(
    job,
    reason = new DOMException(
      "GPU resource disposed before upload",
      "AbortError",
    ),
  ) {
    if (!job || job.done) return;
    job.done = true;
    this.pending.delete(job);
    this.stats.pendingResources--;
    this.stats.pendingBytes -= job.remaining;
    job.remaining = 0;
    this.stats.cancelledResources++;
    job.reject(reason);
    // Release the generator's captured typed arrays without waiting for a frame.
    job.pages.return?.();
  }

  finish(job) {
    if (job.done) return;
    job.done = true;
    this.pending.delete(job);
    this.stats.pendingResources--;
    this.stats.completedResources++;
    job.resolve();
  }

  kick() {
    if (this.disposed || this.task !== null || !this.jobs.length || !this.frame)
      return;
    const bytes = this.interactive
      ? UPLOAD_LIMITS.frameBytes
      : UPLOAD_LIMITS.loadingBytes;
    const ms = this.interactive
      ? UPLOAD_LIMITS.frameMs
      : UPLOAD_LIMITS.loadingMs;
    if (
      this.usedBytes >= bytes ||
      this.usedMs >= ms ||
      this.stats.inFlightBytes >= bytes * UPLOAD_LIMITS.framesInFlight
    )
      return;
    const nextBytes = this.jobs[0]?.next.value?.bytes || 0;
    if (
      this.usedBytes + nextBytes > bytes ||
      this.stats.inFlightBytes + nextBytes >
        bytes * UPLOAD_LIMITS.framesInFlight
    )
      return;
    this.task = setTimeout(() => {
      this.task = null;
      this.pump();
    }, 0);
  }

  pump() {
    if (this.disposed) return;
    const maxBytes = this.interactive
      ? UPLOAD_LIMITS.frameBytes
      : UPLOAD_LIMITS.loadingBytes;
    const maxMs = this.interactive
      ? UPLOAD_LIMITS.frameMs
      : UPLOAD_LIMITS.loadingMs;
    const started = performance.now(),
      finished = [];
    let submitted = 0,
      operations = 0;
    while (
      this.jobs.length &&
      this.usedMs + performance.now() - started < maxMs
    ) {
      const job = this.jobs[0];
      if (job.done) {
        this.jobs.shift();
        continue;
      }
      if (job.next.done) {
        this.jobs.shift();
        finished.push(job);
        continue;
      }
      const page = job.next.value;
      if (
        this.usedBytes + page.bytes > maxBytes ||
        this.stats.inFlightBytes + submitted + page.bytes >
          maxBytes * UPLOAD_LIMITS.framesInFlight
      )
        break;
      try {
        if (page.bytes > UPLOAD_LIMITS.pageBytes)
          throw new Error("Oversized GPU upload page");
        page.submit();
        operations++;
        submitted += page.bytes;
        this.usedBytes += page.bytes;
        job.remaining -= page.bytes;
        this.stats.pendingBytes -= page.bytes;
        this.stats.uploadedBytes += page.bytes;
        if (page.bytes) this.stats.pages++;
        this.stats.maxPageBytes = Math.max(this.stats.maxPageBytes, page.bytes);
        job.next = job.pages.next();
        // The last page must join this fence, even if it exhausts the budget.
        if (job.next.done) {
          this.jobs.shift();
          finished.push(job);
        }
      } catch (error) {
        this.stats.errors.push(`${job.label}: ${error.message}`);
        this.cancel(job, error);
        this.jobs.shift();
      }
    }
    if (operations) this.fence(submitted);
    // Copies and subsequent draws use the SAME GPU command stream. Once every
    // page (and any mip generation) is submitted, drawing is safe by ordering.
    // Waiting for a CPU fence acknowledgement per resource serializes WebGL
    // startup (~300 ms per small object on some drivers). Fences only throttle
    // the aggregate in-flight staging bytes; they never serialize LOD jobs.
    for (const job of finished) this.finish(job);
    this.usedMs += performance.now() - started;
    this.stats.maxFrameBytes = Math.max(
      this.stats.maxFrameBytes,
      this.usedBytes,
    );
    this.stats.maxFrameSubmitMs = Math.max(
      this.stats.maxFrameSubmitMs,
      this.usedMs,
    );
    if (this.interactive) {
      this.stats.maxInteractiveFrameBytes = Math.max(
        this.stats.maxInteractiveFrameBytes,
        this.usedBytes,
      );
      this.stats.maxInteractiveSubmitMs = Math.max(
        this.stats.maxInteractiveSubmitMs,
        this.usedMs,
      );
    }
    // Continue within the SAME frame's remaining credits. Completing one small
    // resource never resets the budget for the next resource.
    this.kick();
  }

  fence(bytes) {
    const submittedAt = performance.now();
    this.stats.inFlightBytes += bytes;
    this.stats.peakInFlightBytes = Math.max(
      this.stats.peakInFlightBytes,
      this.stats.inFlightBytes,
    );
    if (this.interactive)
      this.stats.peakInteractiveInFlightBytes = Math.max(
        this.stats.peakInteractiveInFlightBytes,
        this.stats.inFlightBytes,
      );
    const complete = (error) => {
      this.stats.maxFenceMs = Math.max(
        this.stats.maxFenceMs,
        performance.now() - submittedAt,
      );
      this.stats.inFlightBytes -= bytes;
      if (error && !this.disposed) {
        this.stats.errors.push(error.message);
        for (const job of this.pending) this.cancel(job, error);
      }
      this.kick();
    };
    if (this.backend.isWebGPUBackend) {
      this.backend.device.queue
        .onSubmittedWorkDone()
        .then(() => complete(), complete);
    } else {
      const gl = this.backend.gl;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.fences.push({ sync, complete });
    }
  }

  pollFences() {
    if (!this.fences.length) return;
    const gl = this.backend.gl;
    this.fences = this.fences.filter(({ sync, complete }) => {
      const status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0); // zero timeout; never gl.finish()
      if (status === gl.TIMEOUT_EXPIRED) return true;
      gl.deleteSync(sync);
      complete(
        status === gl.WAIT_FAILED
          ? new Error("GPU upload fence failed")
          : undefined,
      );
      return false;
    });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hiddenTimer);
    clearTimeout(this.task);
    document.removeEventListener("visibilitychange", this.visibility);
    for (const job of this.pending) this.cancel(job);
    this.jobs.length = 0;
    for (const { sync, complete } of this.fences) {
      this.backend.gl.deleteSync(sync);
      complete();
    }
    this.fences.length = 0;
  }
}
