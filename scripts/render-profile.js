const markup = new DOMParser().parseFromString(
  await (await fetch("../")).text(),
  "text/html",
);
markup.querySelectorAll("script").forEach((s) => s.remove());
document.body.innerHTML = markup.body.innerHTML;
const panel = document.createElement("div");
panel.style.cssText =
  "position:fixed;left:0;top:0;z-index:99999;background:#123;color:white;padding:12px;max-width:550px;max-height:90vh;overflow:auto";
const out = document.createElement("pre");
out.id = "profile";
panel.append(out);
document.body.append(panel);
const errors = [];
addEventListener("error", (e) => errors.push(e.message));
addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
const ce = console.error;
console.error = (...a) => {
  errors.push(a.map(String).join(" "));
  ce(...a);
};
await import("../src/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
while (!window.worldDiagnostics?.ready || window.worldDiagnostics.baking) {
  out.textContent = "Loading " + document.querySelector("#status").textContent;
  await wait(1000);
}
const w = window.worldTest,
  d = window.worldDiagnostics;
w.controls.update = () => {};
w.capture.setHour(0);
document.body.classList.add("exploring");
const buttons = {};
for (const label of ["Night", "Day", "Torch", "Stream", "Benchmark"]) {
  const b = document.createElement("button");
  b.textContent = label;
  panel.prepend(b);
  buttons[label] = b;
}
buttons.Night.onclick = () => w.capture.setHour(0);
buttons.Day.onclick = () => w.capture.setHour(13);
buttons.Torch.onclick = () => document.querySelector("#torch").click();
let hop = 0;
buttons.Stream.onclick = () => {
  hop++;
  w.camera.position.x = hop % 2 ? 240 : 19;
  w.camera.position.z = hop % 2 ? 50 : 43;
  w.camera.position.y =
    w.terrainSample(w.camera.position.x, w.camera.position.z).height + 4;
  w.camera.updateMatrixWorld();
};
let running = false,
  result = null;
buttons.Benchmark.onclick = async () => {
  if (running) return;
  running = true;
  result = null;
  w.capture.pause();
  const samples = [];
  try {
    await w.renderer.resolveTimestampsAsync();
    let t = performance.now() / 1000;
    for (let i = 0; i < 80; i++) {
      await new Promise(requestAnimationFrame);
      w.capture.render(t + i / 60);
      const metrics = structuredClone(d.renderProfile);
      metrics.gpuMs = await w.renderer.resolveTimestampsAsync();
      if (i >= 20) samples.push(metrics);
      out.textContent = "Benchmark " + i + "/80";
    }
    const avg = (key) =>
      samples.reduce((a, s) => a + (s[key] || 0), 0) / samples.length;
    const phases = {};
    for (const key of Object.keys(samples[0].phases))
      phases[key] =
        samples.reduce((a, s) => a + s.phases[key], 0) / samples.length;
    result = {
      backend: d.backend,
      viewport: [innerWidth, innerHeight],
      samples: samples.length,
      cpuMs: avg("cpuMs"),
      gpuMs: avg("gpuMs"),
      draws: avg("draws"),
      passes: avg("passes"),
      triangles: avg("triangles"),
      phases,
      errors,
    };
  } catch (e) {
    errors.push(String(e));
  } finally {
    w.capture.resume();
    running = false;
  }
};
setInterval(() => {
  if (!running)
    out.textContent = JSON.stringify(
      result || {
        ready: d.ready,
        frame: d.frameTiming,
        render: d.renderProfile,
        streaming: d.grassStreaming,
        preparation: d.preparation?.renderer,
        night: d.night,
        errors,
      },
      null,
      2,
    );
}, 1000);
const ab = document.createElement("button");
ab.textContent = "Compare shadows";
panel.prepend(ab);
ab.onclick = async () => {
  if (running) return;
  w.lamp.shadow.autoUpdate = true;
  w.sun.shadow.autoUpdate = w.sun.intensity === 0;
  await buttons.Benchmark.onclick();
  const before = result;
  w.lamp.shadow.autoUpdate = false;
  w.sun.shadow.autoUpdate = false;
  await buttons.Benchmark.onclick();
  result = {
    comparison: "same resident scene; only zero-energy shadow passes changed",
    before,
    after: result,
  };
};
const stress = document.createElement("button");
stress.textContent = "Stress streaming";
panel.prepend(stress);
stress.onclick = async () => {
  if (running) return;
  running = true;
  result = null;
  const ids = new Map(),
    checks = [];
  try {
    for (let i = 0; i < 8; i++) {
      while (d.baking) await wait(250);
      const n = [96, 96, 64, 48, 96, 96, 64, 96][i];
      document.querySelector("#resolution").value = n;
      w.camera.position.set(
        i % 2 ? 240 : 19,
        w.terrainSample(i % 2 ? 240 : 19, 43).height + 4,
        43,
      );
      w.camera.updateMatrixWorld();
      await w.rebake();
      const pair = [
        w.lightUniforms.bakedAtlas.value.uuid,
        w.lightUniforms.directionAtlas.value.uuid,
      ];
      if (ids.has(n) && JSON.stringify(ids.get(n)) !== JSON.stringify(pair))
        throw Error("Atlas identity changed");
      ids.set(n, pair);
      checks.push({
        n,
        pair,
        volume: w.lightUniforms.volumeMin.value.toArray(),
        bakes: d.bakes.length,
      });
      out.textContent = JSON.stringify({ stress: i + 1, checks, errors });
      await wait(1000);
    }
    result = {
      stressPassed: errors.length === 0,
      checks,
      errors,
      worldErrors: d.errors,
    };
  } catch (e) {
    result = { stressPassed: false, error: String(e), errors };
  } finally {
    running = false;
  }
};
const hide = document.createElement("button");
hide.textContent = "Hide profile";
panel.prepend(hide);
hide.onclick = () => (panel.style.display = "none");
const cpuButton = document.createElement("button");
cpuButton.textContent = "CPU breakdown";
panel.prepend(cpuButton);
cpuButton.onclick = async () => {
  if (running) return;
  running = true;
  w.capture.pause();
  const totals = {},
    undo = [];
  function instrument(owner, key, label) {
    const original = owner[key];
    if (typeof original !== "function") return;
    let depth = 0;
    totals[label] = { ms: 0, calls: 0 };
    owner[key] = function (...args) {
      const root = depth++ === 0,
        t = root ? performance.now() : 0;
      try {
        return original.apply(this, args);
      } finally {
        depth--;
        if (root) {
          totals[label].ms += performance.now() - t;
          totals[label].calls++;
        }
      }
    };
    undo.push(() => (owner[key] = original));
  }
  for (const [owner, key, label] of [
    [w.renderer, "_projectObject", "traversal"],
    [w.renderer._objects, "get", "objectLookup"],
    [w.renderer._objects, "createRenderObject", "objectCreation"],
    [w.renderer._nodes, "needsRefresh", "refreshCheck"],
    [w.renderer._nodes, "updateForRender", "nodeUpdates"],
    [w.renderer._bindings, "updateForRender", "bindings"],
    [w.renderer._pipelines, "updateForRender", "pipelines"],
    [w.renderer._geometries, "updateForRender", "geometryUpdates"],
    [w.renderer.backend, "draw", "drawSubmit"],
  ])
    instrument(owner, key, label);
  try {
    let t = performance.now() / 1000;
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      w.capture.render(t + i / 60);
    }
    result = {
      cpuBreakdown: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [
          k,
          { ms: v.ms / 60, calls: v.calls / 60 },
        ]),
      ),
      lastFrame: d.renderProfile,
      errors,
    };
  } finally {
    undo.forEach((fn) => fn());
    w.capture.resume();
    running = false;
  }
};

const cpuCompare = document.createElement("button");
cpuCompare.textContent = "Compare CPU";
panel.prepend(cpuCompare);
cpuCompare.onclick = async () => {
  if (running) return;
  const shadow = w.lamp.shadow.shadowNode;
  const original = shadow.useCasterList;
  const runs = [];
  try {
    // Reverse the order for the second pair to reduce warmup/order bias.
    for (const optimized of [false, true, true, false]) {
      shadow.useCasterList = optimized;
      await buttons.Benchmark.onclick();
      if (!result) throw Error("CPU benchmark did not finish");
      runs.push({ optimized, ...structuredClone(result) });
    }
    const mean = (optimized, key) =>
      runs
        .filter((r) => r.optimized === optimized)
        .reduce((sum, r) => sum + r[key], 0) / 2;
    result = {
      comparison:
        "Same resident scene; only shadow traversal changed; ABBA order",
      beforeCpuMs: mean(false, "cpuMs"),
      afterCpuMs: mean(true, "cpuMs"),
      runs,
    };
  } catch (e) {
    result = { error: String(e), runs };
  } finally {
    shadow.useCasterList = original;
  }
};
