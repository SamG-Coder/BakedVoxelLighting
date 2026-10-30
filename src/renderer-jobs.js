import { getGPUUploads, setUploadsInteractive } from "./gpu-uploads.js";
import { PreparationQueue } from "./preparation-queue.js";
// GPU objects belong to this renderer. Serialize their preparation, outside animate().
// compileAsync still runs JS on the main thread; it yields between shader stages.
const queues = new WeakMap();
// Async compilation yields while the presentation pass changes renderer state.
// Node builders must retain the target/MRT that owns their render context.
export function installCompilationContext(renderer) {
  const previous = renderer.debug.onNodeBuilderCreated;
  renderer.debug.onNodeBuilderCreated = (builder, object) => {
    previous?.(builder, object);
    const context = object.context;
    if (!context) return;
    const target = context.renderTarget,
      mrt = context.mrt;
    const view = Object.create(renderer);
    view.getRenderTarget = () => target;
    view.getMRT = () => mrt;
    Object.defineProperty(view, "currentSamples", {
      value: context.sampleCount,
    });
    builder.renderer = view;
  };
}
export const rendererJobStats = {
  pending: 0,
  completed: 0,
  maxStartMs: 0,
  shaderStageMs: 0,
  maxShaderStageMs: 0,
  shaderBudgetYields: 0,
  errors: [],
};
let presenting = false;
let preparationMs = 0;
let creditAt = 0;
let shaderChargedMs = 0;
const nextPresentation = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      creditAt = performance.now();
      preparationMs = 0;
      setTimeout(resolve, 0);
    });
  });
function budgetShaderStage(ms) {
  // Called by the pinned Three build after each CPU shader stage, including
  // continuations after awaits. Waiting time is never charged as CPU time.
  shaderChargedMs += ms;
  rendererJobStats.shaderStageMs += ms;
  rendererJobStats.maxShaderStageMs = Math.max(
    rendererJobStats.maxShaderStageMs,
    ms,
  );
  preparationMs += ms;
  if (presenting && !document.hidden && preparationMs >= 2) {
    rendererJobStats.shaderBudgetYields++;
    return nextPresentation();
  }
  return null;
}
export function setPreparationPresenting(value) {
  presenting = value;
  setUploadsInteractive(value);
}
const afterFrame = () =>
  new Promise((resolve) => {
    // Several cached tiles can share a frame's CPU preparation budget. Uploads
    // retain their independent page/byte limits. Never force one frame per tile.
    if (performance.now() - creditAt > 16) {
      creditAt = performance.now();
      preparationMs = 0;
    }
    if (presenting && !document.hidden && preparationMs >= 2)
      nextPresentation().then(resolve);
    else setTimeout(resolve, 0);
  });
export function prepareForRender(
  renderer,
  object,
  camera,
  scene = object,
  target = null,
  substituteMaterial = null,
  callDepth = 0,
  priority,
) {
  rendererJobStats.pending++;
  renderer.nodeBuildBudgetYield = budgetShaderStage;
  let queue = queues.get(renderer);
  if (!queue) queues.set(renderer, (queue = new PreparationQueue()));
  const job = queue
    .run(async () => {
      await afterFrame();
      if (priority && !Number.isFinite(priority())) return;
      object.updateMatrixWorld(true);
      // Capture/restore happens synchronously, before compileAsync yields.
      // Reuse the queue's scratch storage instead of one tuple per scene object.
      const saved = (queue.savedObjects ||= []);
      const savedFlags = (queue.savedFlags ||= []);
      let savedCount = 0;
      object.traverse((o) => {
        saved[savedCount] = o;
        savedFlags[savedCount++] =
          (o.visible ? 1 : 0) | (o.frustumCulled ? 2 : 0);
        o.frustumCulled = false;
      });
      object.visible = true;
      const previous = renderer.getRenderTarget(),
        previousMRT = renderer.getMRT(),
        started = performance.now(),
        chargedBefore = shaderChargedMs;
      const sourceMaterial = object.material;
      const contexts = renderer._renderContexts;
      const getContext = contexts.get;
      const uploads = getGPUUploads(renderer),
        batch = uploads.begin();
      let compiling;
      try {
        // compileAsync captures the target and render list before its first await.
        // Restore immediately so frames can render while the pipeline is prepared.
        renderer.setRenderTarget(target);
        renderer.setMRT(target?.worldMRT || null);
        if (substituteMaterial) object.material = substituteMaterial;
        // Retain the intended nested draw depth and r187 camera-type context.
        // The wrapper exists only during synchronous render-list capture.
        contexts.get = function (
          renderTarget,
          mrt,
          depth = 0,
          contextCamera = null,
        ) {
          const context = getContext.call(
            this,
            renderTarget,
            mrt,
            depth + callDepth,
            contextCamera,
          );
          context.renderTarget = renderTarget;
          return context;
        };
        compiling = renderer.compileAsync(object, camera, scene);
      } finally {
        renderer.setRenderTarget(previous);
        renderer.setMRT(previousMRT);
        contexts.get = getContext;
        if (substituteMaterial) object.material = sourceMaterial;
        for (let i = 0; i < savedCount; i++) {
          const o = saved[i],
            flags = savedFlags[i];
          o.visible = !!(flags & 1);
          o.frustumCulled = !!(flags & 2);
          saved[i] = null;
        }
        // The first shader stage runs before compileAsync returns its promise.
        // Its hook already charged that CPU slice; only add capture overhead.
        preparationMs += Math.max(
          0,
          performance.now() - started - (shaderChargedMs - chargedBefore),
        );
        rendererJobStats.maxStartMs = Math.max(
          rendererJobStats.maxStartMs,
          performance.now() - started,
        );
      }
      try {
        await compiling;
      } finally {
        // r187 also restores nested render state during async continuations.
        // End this preparation transaction on the host's original target.
        renderer.setRenderTarget(previous);
        renderer.setMRT(previousMRT);
        // Pipeline readiness alone is not residency: compileAsync also discovers
        // shader-created instance attributes and texture bindings. Those copies
        // now enter the shared page queue instead of uploading in this call.
        await uploads.finish(batch);
      }
      rendererJobStats.completed++;
    }, priority)
    .catch((error) => {
      rendererJobStats.errors.push(error.message);
      throw error;
    })
    .finally(() => {
      rendererJobStats.pending--;
    });
  return job;
}
