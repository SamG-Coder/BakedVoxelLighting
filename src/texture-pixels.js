import { WorkerClient } from "./worker-client.js";
let workers;
let sequence = 0;
export function decodeTexture(blob) {
  workers ||= Array.from(
    { length: 2 },
    () =>
      new WorkerClient(
        new Worker(new URL("./texture-pixels-worker.js", import.meta.url), {
          type: "module",
        }),
        "texture pixels",
      ),
  );
  return workers[sequence++ % workers.length].run("decode", { blob });
}
export function closeTextureDecoders() {
  if (workers) for (const client of workers) client.worker.terminate();
  workers = null;
}
