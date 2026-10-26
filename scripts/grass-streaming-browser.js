const options = new URLSearchParams(location.search);
const speed = Number(options.get("speed")) || 6;
const output = document.getElementById("walk-report");
// Load the ordinary app in this document: nested frames can be independently
// throttled by the browser and make a streaming measurement misleading.
const markup = new DOMParser().parseFromString(
  await (await fetch("../")).text(),
  "text/html",
);
markup.querySelectorAll("script").forEach((script) => script.remove());
document.body.innerHTML = markup.body.innerHTML;
document.body.append(output);
output.style.cssText =
  "position:fixed;top:0;left:0;z-index:9999;max-height:90vh;overflow:auto;background:#111e;color:white;font:12px monospace;padding:8px";
await import("../src/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = window;
while (
  !app.worldDiagnostics?.ready ||
  app.worldDiagnostics.baking ||
  !app.worldTest?.grass
) {
  output.textContent =
    "Waiting for world: " + document.getElementById("status").textContent;
  await sleep(1000);
}
await sleep(1000);
const w = app.worldTest,
  d = app.worldDiagnostics;
w.controls.update = () => {};
const origin = w.camera.position.clone();
const builds = [],
  prepares = [],
  samples = [],
  frames = [];
for (const p of w.grass.patches) {
  const build = p.build;
  p.build = async (...args) => {
    const t = performance.now();
    try {
      return await build(...args);
    } finally {
      builds.push(performance.now() - t);
    }
  };
}
const prepare = w.grass.prepare;
w.grass.prepare = async (...args) => {
  const t = performance.now();
  try {
    return await prepare(...args);
  } finally {
    prepares.push(performance.now() - t);
  }
};
const summary = (a) => {
  const s = a.slice().sort((a, b) => a - b);
  return {
    n: s.length,
    p50: Math.round(s[Math.floor(s.length * 0.5)] || 0),
    p95: Math.round(s[Math.floor(s.length * 0.95)] || 0),
    max: Math.round(s.at(-1) || 0),
  };
};
const t0 = app.performance.now();
let invalid = false;
let last = t0,
  lastSample = 0;
await new Promise((resolve) => {
  function frame(now) {
    const elapsed = (now - t0) / 1000;
    if (document.hidden) {
      invalid = true;
      output.textContent =
        "Benchmark invalid: tab was hidden. Reload and keep the tab visible.";
      resolve();
      return;
    }
    frames.push(now - last);
    last = now;
    w.camera.position.x = origin.x + Math.min(elapsed, 30) * speed;
    w.camera.position.y =
      w.terrainSample(w.camera.position.x, w.camera.position.z).height + 2;
    w.camera.lookAt(
      w.camera.position.x + 50,
      w.camera.position.y,
      w.camera.position.z,
    );
    w.camera.updateMatrixWorld();
    if (elapsed - lastSample >= 1) {
      lastSample = elapsed;
      const near = w.grass.patches.filter(
        (p) => p.center.distanceTo(w.camera.position) < 38,
      );
      const sample = {
        second: Math.round(elapsed),
        near: near.length,
        missing: near.filter((p) => !p.levels[0]).length,
        pending: w.grass.patches.reduce((n, p) => n + p.pending.size, 0),
      };
      samples.push(sample);
      output.textContent = JSON.stringify(
        {
          state: elapsed < 30 ? `walking at ${speed}m/s` : "catching up",
          sample,
          buildMs: summary(builds),
          prepareMs: summary(prepares),
          frameMs: summary(frames),
          streaming: d.grassStreaming,
          errors: d.errors,
        },
        null,
        2,
      );
    }
    if (elapsed < 45) app.requestAnimationFrame(frame);
    else resolve();
  }
  requestAnimationFrame(frame);
});
output.textContent = JSON.stringify(
  {
    state: invalid ? "invalid-hidden-tab" : "complete",
    speed,
    samples,
    buildMs: summary(builds),
    prepareMs: summary(prepares),
    frameMs: summary(frames),
    streaming: d.grassStreaming,
    bakes: d.bakes,
    lighting: d.lighting,
    preparation: d.preparation,
    merged: d.mergedVisibility,
    errors: d.errors,
  },
  null,
  2,
);
