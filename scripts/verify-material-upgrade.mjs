import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.stack));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
try {
  await page.goto("http://127.0.0.1:5173/scripts/worker-fixture.html");
  const reports = [];
  for (const backend of ["webgpu", "webgl2"]) {
    reports.push(
      await page.evaluate(async (backend) => {
        const { T, N } = await import("/scripts/gpu-pages-fixture.js");
        const { uploadTextures, getGPUUploads, setUploadsInteractive } =
          await import("/src/gpu-uploads.js");
        const { fullscreen, readPixels } = await import("/src/tsl-baking.js");
        const { FoliageMaterial } = await import("/src/foliage-lighting.js");
        const { WorkerClient } = await import("/src/worker-client.js");
        const { supportsBC7, compressOpaqueTextures } =
          await import("/src/texture-compression.js");
        const renderer = new T.WebGPURenderer({
          forceWebGL: backend === "webgl2",
        });
        await renderer.init();
        renderer.setSize(32, 32);
        const manager = getGPUUploads(renderer);
        setUploadsInteractive(true);
        const read = async (node) => {
          const target = new T.RenderTarget(32, 32, { depthBuffer: false }),
            q = new T.QuadMesh(fullscreen(node));
          renderer.setRenderTarget(target);
          q.render(renderer);
          const pixels = new Uint8Array(32 * 32 * 4);
          await readPixels(renderer, target, 0, 0, 32, 32, pixels);
          renderer.setRenderTarget(null);
          target.dispose();
          q.material.dispose();
          return [...pixels.slice(0, 4)];
        };
        const mipmaps = [];
        let w = 516,
          h = 260,
          m = 0;
        while (true) {
          const data = new Uint8Array(w * h * 4 * 3);
          for (let l = 0; l < 3; l++)
            for (let p = 0; p < w * h; p++)
              data.set(
                [30 + l * 60 + m, 80 + m, 150 - l * 30, 255],
                (l * w * h + p) * 4,
              );
          mipmaps.push({ width: w, height: h, depth: 3, data });
          if (w === 1 && h === 1) break;
          w = Math.max(1, w >> 1);
          h = Math.max(1, h >> 1);
          m++;
        }
        const array = new T.DataArrayTexture(mipmaps[0].data, 516, 260, 3);
        array.mipmaps = mipmaps;
        array.generateMipmaps = false;
        array.minFilter = T.LinearMipmapLinearFilter;
        array.magFilter = T.LinearFilter;
        array.needsUpdate = true;
        await uploadTextures(renderer, [array]);
        const samples = [];
        for (let l = 0; l < 3; l++)
          for (const level of [0, 1, 3, 9])
            samples.push({
              l,
              level,
              pixel: await read(N.texture(array, N.uv()).depth(l).level(level)),
            });
        let compressed = null;
        if (supportsBC7(renderer)) {
          // Optional encoder failures must preserve all original textures.
          const names = [
            "bark",
            "bark-birch",
            "bark-ash",
            "rock",
            "meadow-ground",
            "ground-meadow",
            "woodland-litter",
          ];
          const assets = Object.fromEntries(
            names.map((name) => [name, { hash: name, map: array }]),
          );
          const NativeWorker = window.Worker;
          let fallback;
          try {
            window.Worker = class {
              constructor() {
                throw Error("blocked encoder fixture");
              }
            };
            fallback = await compressOpaqueTextures(assets, renderer, {
              get: async () => null,
              put: async () => {
                throw Error("Transient failure must not be cached");
              },
            });
          } finally {
            window.Worker = NativeWorker;
          }
          if (
            fallback.textures.length !== names.length ||
            fallback.residentBytes !== fallback.sourceBytes ||
            names.some((name) => assets[name].map !== array)
          )
            throw Error("Compression fallback changed source textures");
          const client = new WorkerClient(
            new Worker("/workers/texture-compress.js"),
            "test compress",
          );
          try {
            const width = 514,
              height = 258,
              data = new Uint8Array(width * height * 4);
            for (let i = 0; i < data.length; i += 4)
              data.set([48, 96, 144, 255], i);
            const result = await client.run(
              "compress",
              { data, width, height },
              [data.buffer],
            );
            if (result.rejected) throw Error(result.rejected);
            const t = new T.CompressedTexture(
              result.levels,
              result.levels[0].width,
              result.levels[0].height,
              T.RGBA_BPTC_Format,
            );
            t.minFilter = T.LinearMipmapLinearFilter;
            t.magFilter = T.LinearFilter;
            t.needsUpdate = true;
            await uploadTextures(renderer, [t]);
            const actual = [];
            for (const level of [0, 1, 4, 9])
              actual.push(await read(N.texture(t, N.uv()).level(level)));
            compressed = { rmse: result.rmse, actual };
            t.dispose();
          } finally {
            client.worker.terminate();
          }
        }
        // Direct transmission responds to a light behind the represented leaf,
        // vanishes with that light, and survives material cloning.
        const material = new FoliageMaterial({ color: 0xffffff, roughness: 1 });
        material.foliageTransmissionNode = N.float(0.4);
        const clone = material.clone();
        const scene = new T.Scene(),
          camera = new T.PerspectiveCamera(45, 1, 0.1, 10);
        camera.position.z = 2;
        const mesh = new T.Mesh(new T.PlaneGeometry(1, 1), clone);
        scene.add(mesh);
        const sun = new T.DirectionalLight(0xffffff, 2);
        sun.position.z = -2;
        scene.add(sun);
        const target = new T.RenderTarget(32, 32);
        const light = [];
        for (const intensity of [2, 0]) {
          sun.intensity = intensity;
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          const pixels = new Uint8Array(32 * 32 * 4);
          await readPixels(renderer, target, 0, 0, 32, 32, pixels);
          light.push(pixels[(16 * 32 + 16) * 4]);
        }
        renderer.setRenderTarget(null);
        target.dispose();
        mesh.geometry.dispose();
        material.dispose();
        clone.dispose();
        array.dispose();
        const stats = { ...manager.stats };
        renderer.dispose();
        return { backend, samples, compressed, light, stats };
      }, backend),
    );
  }
  for (const r of reports) {
    for (const s of r.samples) {
      const expected = [
        30 + s.l * 60 + s.level,
        80 + s.level,
        150 - s.l * 30,
        255,
      ];
      assert.ok(
        s.pixel.every((v, i) => Math.abs(v - expected[i]) <= 1),
        JSON.stringify(s),
      );
    }
    if (r.compressed)
      for (const pixel of r.compressed.actual)
        assert.ok(
          pixel.every((v, i) => Math.abs(v - [48, 96, 144, 255][i]) <= 3),
          JSON.stringify(pixel),
        );
    assert.ok(r.light[0] > r.light[1] + 5, JSON.stringify(r.light));
  }
  assert.deepEqual(errors, []);
  await writeFile(
    "evidence/material-upgrade-check.json",
    JSON.stringify(reports, null, 2),
  );
  console.log(
    reports.map((r) => ({
      backend: r.backend,
      arraySamples: r.samples.length,
      compressed: r.compressed,
      backLight: r.light,
    })),
  );
} finally {
  await browser.close();
}
