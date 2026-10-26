// Keep a streaming bake off the frame's critical path. Every output pixel uses
// the original full-target UVs and shader; only raster submission is partitioned.
export async function renderBakeSlices(
  renderer,
  scene,
  camera,
  target,
  interactive = false,
  signal,
) {
  const rows = interactive
    ? Math.max(1, Math.floor(65536 / target.width))
    : target.height;
  let slices = 0;
  for (let y = 0; y < target.height; y += rows) {
    signal?.throwIfAborted();
    if (interactive)
      await new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)),
      );
    signal?.throwIfAborted();
    const previous = renderer.getRenderTarget(),
      autoClear = renderer.autoClear;
    const scissor = target.scissor.clone(),
      scissorTest = target.scissorTest;
    try {
      target.scissor.set(0, y, target.width, Math.min(rows, target.height - y));
      target.scissorTest = true;
      renderer.autoClear = false; // A WebGPU attachment clear would erase earlier slices.
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      slices++;
    } finally {
      target.scissor.copy(scissor);
      target.scissorTest = scissorTest;
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(previous);
    }
    // Bound outstanding bake work; presentation is free to run while it finishes.
    if (interactive && renderer.backend.device)
      await renderer.backend.device.queue.onSubmittedWorkDone();
  }
  return slices;
}
