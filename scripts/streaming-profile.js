const markup = new DOMParser().parseFromString(
  await (await fetch("../")).text(),
  "text/html",
);
markup.querySelectorAll("script").forEach((s) => s.remove());
document.body.innerHTML = markup.body.innerHTML;
const panel = document.createElement("aside");
panel.style.cssText =
  "position:fixed;left:0;top:0;z-index:99999;background:#123;color:white;padding:12px;max-width:520px;max-height:90vh;overflow:auto";
const out = document.createElement("pre");
out.id = "profile";
panel.append(out);
document.body.append(panel);
const errors = [];
const reportError = (e) => {
  if (errors.length < 16) errors.push(String(e));
};
addEventListener("error", (e) => reportError(e.message));
addEventListener("unhandledrejection", (e) => reportError(e.reason));
const originalError = console.error;
console.error = (...args) => {
  reportError(args.join(" "));
  originalError(...args);
};
await import("../src/main.js");
while (!window.worldDiagnostics?.ready || window.worldDiagnostics.baking) {
  out.textContent = "Loading " + document.querySelector("#status").textContent;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const w = window.worldTest,
  d = window.worldDiagnostics;
w.controls.update = () => {};
w.capture.setHour(13);
document.body.classList.add("exploring");
let running = false,
  result;
const compileCosts = { count: 0, totalMs: 0, maxMs: 0, slow: [] };
const getForRender = w.renderer._nodes.getForRender;
w.renderer._nodes.getForRender = function (object, async) {
  const start = performance.now();
  const value = getForRender.call(this, object, async);
  const ms = performance.now() - start;
  if (!async && ms > 8) {
    compileCosts.count++;
    compileCosts.totalMs += ms;
    compileCosts.maxMs = Math.max(compileCosts.maxMs, ms);
    if (compileCosts.slow.length < 32)
      compileCosts.slow.push({
        ms,
        terrain: !!object.object.userData.terrainTile,
        grass: !!object.object.userData.grassCard,
        shadow: !!object.material.isShadowPassMaterial,
      });
  }
  return value;
};
const snapshot = () =>
  structuredClone({
    memory: d.streamingMemory,
    rendererMemory: w.renderer.info.memory,
    trees: d.treeStreaming,
    grass: d.grassStreaming,
    preparation: d.preparation,
    merged: d.mergedVisibility,
    baking: d.baking,
    cancelledBakes: d.cancelledBakes || 0,
    synchronousBuilds: compileCosts,
    shaderOwnership: (() => {
      const nodes = w.renderer._nodes;
      const used = new Set(
        [...w.renderer._objects._renderObjects]
          .map((o) => nodes.get(o).nodeBuilderState)
          .filter(Boolean),
      );
      return {
        live: used.size,
        cached: nodes.nodeBuilderCache.size,
        unreferenced: [...nodes.nodeBuilderCache.values()].filter(
          (v) => !used.has(v),
        ).length,
      };
    })(),
  });
const button = (text, fn) => {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = fn;
  panel.prepend(b);
};
button("Night and torch", () => {
  w.capture.setHour(0);
  document.querySelector("#torch").click();
});
button("Hide metrics", () => {
  out.hidden = !out.hidden;
});
button("Save result", () => {
  if (!result) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "streaming-profile.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function walk(speed, distance, laps = 1) {
  if (running) return;
  running = true;
  result = null;
  const points = [],
    frames = [],
    slowFrames = [],
    longAnimations = [],
    longTasks = [],
    start = performance.now();
  let last = start,
    point = -1;
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(e.duration);
  });
  observer.observe({ type: "longtask" });
  const animationObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      longAnimations.push({
        duration: e.duration,
        blockingDuration: e.blockingDuration,
        scripts: e.scripts?.map((s) => ({
          duration: s.duration,
          invoker: s.invoker,
          function: s.sourceFunctionName,
          url: s.sourceURL,
        })),
      });
    longAnimations.sort((a, b) => b.duration - a.duration);
    longAnimations.length = Math.min(longAnimations.length, 24);
  });
  if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"))
    animationObserver.observe({ type: "long-animation-frame" });
  const lapSeconds = (distance * 2) / speed;
  const duration = lapSeconds * laps + 25;
  try {
    while (performance.now() - start < duration * 1000) {
      const now = await new Promise(requestAnimationFrame);
      frames.push(now - last);
      if (now - last > 50) {
        slowFrames.push({
          ms: now - last,
          seconds: (now - start) / 1000,
          render: structuredClone(d.renderProfile),
          baking: d.baking,
          heap: performance.memory?.usedJSHeapSize,
        });
        slowFrames.sort((a, b) => b.ms - a.ms);
        slowFrames.length = Math.min(slowFrames.length, 24);
      }
      last = now;
      const seconds = (now - start) / 1000,
        phase = seconds < lapSeconds * laps ? seconds % lapSeconds : lapSeconds,
        offset =
          phase < distance / speed
            ? phase * speed
            : Math.max(0, 2 * distance - phase * speed);
      w.camera.position.set(
        19 + offset,
        w.terrainSample(19 + offset, 43).height + 2,
        43,
      );
      w.camera.updateMatrixWorld();
      if (Math.floor(seconds / 5) !== point) {
        point = Math.floor(seconds / 5);
        points.push({ seconds, ...snapshot() });
        out.textContent = JSON.stringify(
          // Rendering the growing multi-lap history here creates layout stalls
          // in the profiler itself. Retain history in memory, show one sample.
          {
            running: true,
            seconds,
            sampleCount: points.length,
            points: [points.at(-1)],
            errors,
          },
          null,
          2,
        );
      }
    }
    frames.sort((a, b) => a - b);
    result = {
      completed: true,
      backend: d.backend,
      speed,
      routeMetres: distance * 2 * laps,
      laps,
      p95: frames[Math.floor(frames.length * 0.95)],
      p99: frames[Math.floor(frames.length * 0.99)],
      maxFrame: frames.at(-1),
      longTaskCount: longTasks.length,
      maxLongTask: Math.max(0, ...longTasks),
      points,
      slowFrames,
      longAnimations,
      bakes: d.bakes,
      errors,
      worldErrors: d.errors,
    };
  } catch (error) {
    result = { completed: false, error: String(error), points, errors };
  } finally {
    observer.disconnect();
    animationObserver.disconnect();
    running = false;
    out.textContent = JSON.stringify(result, null, 2);
  }
}
button("Walk 6 m/s", () => walk(6, 360));
button("Stress 24 m/s", () => walk(24, 1000));
button("Stress 3 laps", () => walk(24, 1000, 3));
setInterval(() => {
  if (!running && !result)
    out.textContent = JSON.stringify(
      { ready: true, ...snapshot(), errors },
      null,
      2,
    );
}, 1000);
