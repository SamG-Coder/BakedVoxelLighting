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
const snapshot = () =>
  structuredClone({
    memory: d.streamingMemory,
    trees: d.treeStreaming,
    grass: d.grassStreaming,
    preparation: d.preparation,
    merged: d.mergedVisibility,
    baking: d.baking,
    cancelledBakes: d.cancelledBakes || 0,
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
async function walk(speed, distance) {
  if (running) return;
  running = true;
  result = null;
  const points = [],
    frames = [],
    longTasks = [],
    start = performance.now();
  let last = start,
    point = -1;
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(e.duration);
  });
  observer.observe({ type: "longtask" });
  const duration = (distance * 2) / speed + 25;
  try {
    while (performance.now() - start < duration * 1000) {
      const now = await new Promise(requestAnimationFrame);
      frames.push(now - last);
      last = now;
      const seconds = (now - start) / 1000,
        offset =
          seconds < distance / speed
            ? seconds * speed
            : Math.max(0, 2 * distance - seconds * speed);
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
          { running: true, seconds, points, errors },
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
      routeMetres: distance * 2,
      p95: frames[Math.floor(frames.length * 0.95)],
      p99: frames[Math.floor(frames.length * 0.99)],
      maxFrame: frames.at(-1),
      longTaskCount: longTasks.length,
      maxLongTask: Math.max(0, ...longTasks),
      points,
      bakes: d.bakes,
      errors,
      worldErrors: d.errors,
    };
  } catch (error) {
    result = { completed: false, error: String(error), points, errors };
  } finally {
    observer.disconnect();
    running = false;
    out.textContent = JSON.stringify(result, null, 2);
  }
}
button("Walk 6 m/s", () => walk(6, 360));
button("Stress 24 m/s", () => walk(24, 1000));
setInterval(() => {
  if (!running && !result)
    out.textContent = JSON.stringify(
      { ready: true, ...snapshot(), errors },
      null,
      2,
    );
}, 1000);
