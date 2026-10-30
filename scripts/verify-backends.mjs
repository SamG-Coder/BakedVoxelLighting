import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const backend = process.argv[2] || "webgpu";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
  errors = [];
page.on("pageerror", (e) => {
  errors.push(e.stack);
  console.log("PAGE", e.stack);
});
page.on("console", (m) => {
  if (m.type() === "log") console.log(m.text());
  if (m.type() === "error") {
    errors.push(m.text());
    console.log("ERR", m.text().slice(0, 5500));
  }
});
try {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const el = document.getElementById("status");
      if (el && el.textContent !== window.lastStatus) {
        window.lastStatus = el.textContent;
        console.log("PROGRESS", el.textContent);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.goto("http://127.0.0.1:5173/?backend=" + backend + "&aa=msaa");
  await page.waitForFunction(
    () =>
      (window.worldDiagnostics?.ready && !worldDiagnostics?.baking) ||
      window.worldDiagnostics?.errors.length,
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(3000);
  assert.deepEqual(errors, []);
  console.log(
    "STATE",
    await page.evaluate(() => ({
      backend: worldDiagnostics.backend,
      ready: worldDiagnostics.ready,
      errors: worldDiagnostics.errors,
      lighting: worldDiagnostics.lighting,
      bakes: worldDiagnostics.bakes,
    })),
  );
  const measures = await page.evaluate(async () => {
    const w = worldTest;
    const { T, N, fullscreen, readPixels, billboardNormalCheck } =
      await import("/scripts/tsl-fixture.js");
    const target = new T.RenderTarget(4, 4, { depthBuffer: false }),
      material = fullscreen(N.vec4(N.uv(), 0, 1)),
      scene = new T.Scene(),
      mesh = new T.Mesh(new T.PlaneGeometry(2, 2), material);
    scene.add(mesh);
    w.renderer.setRenderTarget(target);
    w.renderer.render(scene, new T.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    w.renderer.setRenderTarget(null);
    const pixels = new Uint8Array(64);
    await readPixels(w.renderer, target, 0, 0, 4, 4, pixels);
    w.renderer.setRenderTarget(null);
    mesh.geometry.dispose();
    material.dispose();
    target.dispose();
    w.refreshLighting([20, w.terrainSample(20, 10).height + 4, 10], 0);
    const a = await w.readLighting();
    w.refreshLighting([20, w.terrainSample(20, 10).height + 4, 10], 1500);
    const b = await w.readLighting();
    let delta = 0;
    for (let i = 0; i < a.length; i++) delta += Math.abs(a[i] - b[i]);
    const db = w.cache.db;
    const records = await new Promise((ok) => {
      const r = db.transaction("bakes").objectStore("bakes").getAll();
      r.onsuccess = () => ok(r.result);
    });
    const atlases = records.filter((r) => r.normals && !r.topDown);
    const coverage = atlases.map((r) => {
      let a = 0,
        t = 0,
        colour = 0;
      for (let i = 3; i < r.data.length; i += 4) {
        if (r.data[i] > 50) {
          a++;
          if (r.data[i - 3] + r.data[i - 2] + r.data[i - 1] > 12) colour++;
        } else t++;
      }
      return { a, t, colour };
    });
    let cutouts = 0,
      missingCutoffs = 0;
    w.scene.traverse((o) => {
      if (o.isMesh && o.material.userData.alphaCutoff > 0) {
        cutouts++;
        if (o.material.alphaTest <= 0) missingCutoffs++;
      }
    });
    const mipLevels = atlases.map((r) => r.mips?.length || 0);
    const normals = await billboardNormalCheck(w.renderer);
    return {
      normals,
      cutouts,
      missingCutoffs,
      mipLevels,
      expectedAtlases:
        w.clusters.prototypes.length * 2 +
        w.grass.templates.length +
        w.shrubs.prototypes.length,
      gradient: [...pixels],
      dynamicDelta: delta,
      coverage,
      frame: worldDiagnostics.frameTiming,
      textureCompression: worldDiagnostics.textureCompression,
    };
  });
  console.log("MEASURES", JSON.stringify(measures));
  assert.equal(await page.evaluate(() => worldDiagnostics.backend), backend);
  assert.deepEqual(errors, []);
  assert.equal(measures.gradient[0], 32);
  assert.equal(measures.gradient[1], 32);
  assert.equal(measures.gradient[61], 223);
  assert.ok(measures.dynamicDelta > 1000);
  assert.equal(measures.coverage.length, measures.expectedAtlases);
  assert.ok(measures.cutouts > 0);
  assert.equal(measures.missingCutoffs, 0);
  assert.ok(measures.mipLevels.every((n) => n >= 8));
  assert.ok(
    measures.coverage.every(
      (v) => v.a > 1000 && v.t > 1000 && v.colour > v.a * 0.8,
    ),
  );
  for (const value of measures.normals)
    for (let i = 0; i < 3; i++)
      assert.ok(
        Math.abs(value[i] - measures.normals[0][i]) <= 1,
        "billboard normal must not rotate with camera",
      );
  await writeFile(
    `evidence/tsl-${backend}-measures.json`,
    JSON.stringify(measures, null, 2),
  );
  await page.screenshot({ path: `evidence/tsl-${backend}.png` });
  const key = await page.evaluate(() => worldDiagnostics.volumeKey);
  const keysBefore = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = worldTest.cache.db
          .transaction("bakes")
          .objectStore("bakes")
          .getAllKeys();
        request.onsuccess = () => resolve(request.result);
      }),
  );
  const other = backend === "webgpu" ? "webgl2" : "webgpu";
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("backend") === other),
    page.selectOption("#backend", other, { force: true }),
  ]);
  await page.waitForFunction(
    () => window.worldDiagnostics?.ready && !worldDiagnostics.baking,
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(500);
  const warm = await page.evaluate(() => ({
    backend: worldDiagnostics.backend,
    hits: worldTest.cache.hits,
    misses: worldTest.cache.misses,
    key: worldDiagnostics.volumeKey,
  }));
  const keysAfter = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = worldTest.cache.db
          .transaction("bakes")
          .objectStore("bakes")
          .getAllKeys();
        request.onsuccess = () => resolve(request.result);
      }),
  );
  console.log(
    "CACHE SWITCH",
    warm,
    keysAfter.filter((key) => !keysBefore.includes(key)),
  );
  assert.equal(warm.backend, other);
  assert.equal(warm.key, key);
  assert.equal(warm.misses, 0);
  assert.ok(warm.hits > measures.expectedAtlases);
  assert.deepEqual(errors, []);
  console.log("SWITCH", warm);
  await writeFile(
    `evidence/tsl-${backend}-switch.json`,
    JSON.stringify(warm, null, 2),
  );
  for (let level = 0; level < 4; level++) {
    await page.selectOption("#treeLod", String(level), { force: true });
    await page.selectOption("#grassLod", String(level), { force: true });
    await page.waitForTimeout(700);
    const levels = await page.evaluate(() => ({
      tree: worldDiagnostics.treeLevels,
      grass: worldDiagnostics.grassLevels,
    }));
    assert.ok(levels.tree[level] > 0);
    assert.ok(levels.grass[level] > 0);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `evidence/tsl-${backend}-errors.json`,
    JSON.stringify(errors, null, 2),
  );
} finally {
  await browser.close();
}
