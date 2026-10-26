import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") {
    errors.push(m.text());
    console.log(m.text());
  }
});
try {
  await page.goto("http://127.0.0.1:5173/scripts/worker-fixture.html");
  const reports = [];
  for (const backend of ["webgpu", "webgl2"]) {
    console.log("testing upload pages", backend);
    reports.push(
      await page.evaluate(async (backend) => {
        const {
          T,
          N,
          fullscreen,
          readPixels,
          getGPUUploads,
          uploadTextures,
          setUploadsInteractive,
          prepareForRender,
        } = await import("/scripts/gpu-pages-fixture.js");
        const renderer = new T.WebGPURenderer({
          forceWebGL: backend === "webgl2",
        });
        await renderer.init();
        renderer.setSize(128, 64);
        const manager = getGPUUploads(renderer);
        setUploadsInteractive(true);
        const makeTexture = (w, h, depth = 1, float = false, red = false) => {
          const data = float
            ? new Float32Array(w * h * depth * (red ? 1 : 4))
            : new Uint8Array(w * h * depth * 4);
          for (let i = 0; i < data.length; i++)
            data[i] = float ? ((i * 17) % 251) / 250 : (i * 37) % 251;
          const t =
            depth > 1
              ? new T.Data3DTexture(data, w, h, depth)
              : new T.DataTexture(data, w, h);
          t.format = red ? T.RedFormat : T.RGBAFormat;
          t.type = float ? T.FloatType : T.UnsignedByteType;
          t.minFilter = t.magFilter = T.LinearFilter;
          t.needsUpdate = true;
          return t;
        };
        const makeSet = () => {
          const atlas = makeTexture(513, 257);
          let w = 513,
            h = 257,
            mip = 0;
          atlas.mipmaps = [];
          while (true) {
            const data = new Uint8Array(w * h * 4);
            for (let i = 0; i < data.length; i++)
              data[i] = (i * 41 + mip * 29) % 256;
            atlas.mipmaps.push({ width: w, height: h, data });
            if (w === 1 && h === 1) break;
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
            mip++;
          }
          atlas.minFilter = T.LinearMipmapLinearFilter;
          const auto = makeTexture(511, 257);
          auto.generateMipmaps = true;
          auto.minFilter = T.LinearMipmapLinearFilter;
          return [
            atlas,
            auto,
            makeTexture(97, 49, 65),
            makeTexture(2001, 19, 1, true, true),
            makeTexture(8192, 5, 1, true),
          ];
        };
        const capture = async (textures) => {
          const target = new T.RenderTarget(128, 64, { depthBuffer: false });
          const results = [];
          for (let i = 0; i < textures.length; i++) {
            for (const level of i < 2 ? [0, 1, 4, 8] : [0]) {
              const t = textures[i];
              const sample = t.isData3DTexture
                ? N.texture3D(t, N.vec3(N.uv(), 0.537))
                : N.texture(t, N.uv()).level(level);
              const q = new T.QuadMesh(fullscreen(sample));
              renderer.setRenderTarget(target);
              q.render(renderer);
              const pixels = new Uint8Array(128 * 64 * 4);
              await readPixels(renderer, target, 0, 0, 128, 64, pixels);
              results.push(pixels);
              q.material.dispose();
            }
          }
          renderer.setRenderTarget(null);
          target.dispose();
          return results;
        };
        const baseline = makeSet();
        baseline.forEach((t) => renderer.initTexture(t));
        const expected = await capture(baseline);
        const paged = makeSet();
        let frames = 0,
          running = true;
        const heartbeat = () => {
          if (running) {
            frames++;
            requestAnimationFrame(heartbeat);
          }
        };
        requestAnimationFrame(heartbeat);
        const start = performance.now();
        await uploadTextures(renderer, [...paged, ...paged]);
        const textureMs = performance.now() - start;
        running = false;
        const actual = await capture(paged);
        const comparisons = actual.map((pixels, i) => {
          let max = 0,
            changed = 0;
          for (let k = 0; k < pixels.length; k++) {
            const d = Math.abs(pixels[k] - expected[i][k]);
            max = Math.max(max, d);
            if (d) changed++;
          }
          return { max, changed };
        });
        const g = new T.PlaneGeometry(2, 2, 256, 256);
        const scene = new T.Scene(),
          camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        camera.position.z = 2;
        const mesh = new T.Mesh(
          g,
          new T.MeshBasicNodeMaterial({ map: paged[0] }),
        );
        scene.add(mesh);
        await prepareForRender(renderer, scene, camera);
        const attributeParity = [];
        for (const attribute of [
          g.index,
          g.attributes.position,
          g.attributes.uv,
        ]) {
          const buffer =
            await renderer.backend.attributeUtils.getArrayBufferAsync(
              attribute,
            );
          const actual = new Uint8Array(buffer),
            source = new Uint8Array(
              attribute.array.buffer,
              attribute.array.byteOffset,
              attribute.array.byteLength,
            );
          let changed = 0;
          for (let i = 0; i < source.length; i++)
            if (source[i] !== actual[i]) changed++;
          attributeParity.push({ bytes: source.byteLength, changed });
        }
        // Multi-page Uint16 indices widen to Uint32 on WebGPU, without a
        // whole-array conversion blocking submission of the first page.
        const small = new T.Mesh(
          new T.PlaneGeometry(2, 2, 80, 80),
          mesh.material,
        );
        await prepareForRender(renderer, small, camera, scene);
        const indexBytes = new Uint8Array(
          await renderer.backend.attributeUtils.getArrayBufferAsync(
            small.geometry.index,
          ),
        );
        const indexSource = new Uint8Array(small.geometry.index.array.buffer);
        let indexChanged = 0;
        for (let i = 0; i < indexSource.length; i++)
          if (indexBytes[i] !== indexSource[i]) indexChanged++;
        attributeParity.push({
          bytes: indexSource.length,
          changed: indexChanged,
        });
        small.geometry.dispose();
        const beforeDraw = {
          buffers: manager.stats.unpagedBufferBytes,
          textures: manager.stats.unpagedTextureBytes,
        };
        const target = new T.RenderTarget(128, 64);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const indexedDrawError = renderer.backend.isWebGPUBackend
          ? 0 : renderer.backend.gl.getError();
        const indexedPixels = new Uint8Array(128 * 64 * 4);
        await readPixels(renderer, target, 0, 0, 128, 64, indexedPixels);
        let indexedDrawPixels = 0;
        for (let i = 0; i < indexedPixels.length; i += 4)
          if (indexedPixels[i] + indexedPixels[i + 1] + indexedPixels[i + 2] > 30)
            indexedDrawPixels++;
        renderer.setRenderTarget(null);
        const firstDrawExtraBytes = {
          buffers: manager.stats.unpagedBufferBytes - beforeDraw.buffers,
          textures: manager.stats.unpagedTextureBytes - beforeDraw.textures,
        };
        const residentBeforeCancel = manager.stats.allocatedBytes;
        const cancelled = makeTexture(1024, 1024);
        const pending = uploadTextures(renderer, [cancelled]).then(
          () => "unexpected success",
          (e) => e.name,
        );
        cancelled.dispose();
        const cancellation = await pending;
        const residentAfterCancel = manager.stats.allocatedBytes;
        const partial = makeTexture(1024, 1024);
        const bytesBefore = manager.stats.uploadedBytes;
        const partialResult = uploadTextures(renderer, [partial]).then(
          () => "unexpected success",
          (e) => e.name,
        );
        while (manager.stats.uploadedBytes === bytesBefore)
          await new Promise(requestAnimationFrame);
        const partialBytes = manager.stats.uploadedBytes - bytesBefore;
        partial.dispose();
        const partialCancellation = await partialResult;
        const afterCancel = makeTexture(64, 32);
        await uploadTextures(renderer, [afterCancel]);
        afterCancel.dispose();
        const stats = structuredClone(manager.stats);
        for (const t of [...baseline, ...paged]) t.dispose();
        g.dispose();
        mesh.material.dispose();
        target.dispose();
        const remainingAllocatedBytes = manager.stats.allocatedBytes;
        renderer.dispose();
        return {
          backend,
          actualBackend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2",
          textureMs,
          frames,
          comparisons,
          attributeParity,
          indexedDrawError,
          indexedDrawPixels,
          firstDrawExtraBytes,
          cancellation,
          partialBytes,
          partialCancellation,
          residentBeforeCancel,
          residentAfterCancel,
          remainingAllocatedBytes,
          stats,
        };
      }, backend),
    );
  }
  await writeFile(
    "evidence/gpu-upload-pages.json",
    JSON.stringify({ reports, errors }, null, 2),
  );
  console.log(JSON.stringify({ reports, errors }, null, 2));
  for (const r of reports) {
    assert.equal(r.backend, r.actualBackend);
    assert.ok(r.frames >= 2, "upload pages must yield animation frames");
    for (let i = 0; i < r.comparisons.length; i++) {
      const c = r.comparisons[i];
      // GL automatic mip generation may round intermediate UNORM values by
      // 1-2 levels when uploads span submissions. Explicit baked mips and base
      // pixels must remain exact; no tolerance for silhouette/normal atlases.
      if (r.backend === "webgl2" && i >= 5 && i <= 7) assert.ok(c.max <= 2);
      else
        assert.equal(
          c.changed,
          0,
          "baked mips and base pixels must match native uploads",
        );
    }
    for (const c of r.attributeParity)
      assert.equal(
        c.changed,
        0,
        "paged vertex/index buffers must match source bytes",
      );
    assert.deepEqual(
      r.firstDrawExtraBytes,
      { buffers: 0, textures: 0 },
      "first draw must reuse prepared uploads",
    );
    assert.equal(r.indexedDrawError, 0, "paged indexed geometry must draw without GL errors");
    assert.ok(r.indexedDrawPixels > 128 * 64 * 0.9, "indexed draw must cover the target, not just pass byte readback");
    assert.equal(r.cancellation, "AbortError");
    assert.equal(r.partialCancellation, "AbortError");
    assert.ok(r.partialBytes > 0 && r.partialBytes < 4 * 1024 * 1024);
    assert.equal(r.residentAfterCancel, r.residentBeforeCancel);
    assert.equal(r.remainingAllocatedBytes, 0);
    assert.ok(r.stats.maxPageBytes <= 65536);
    assert.ok(r.stats.maxInteractiveFrameBytes <= r.stats.frameBytes);
    assert.ok(r.stats.peakInteractiveInFlightBytes <= r.stats.frameBytes * r.stats.framesInFlight);
    assert.equal(r.stats.pendingResources, 0);
    assert.equal(r.stats.pendingBytes, 0);
    assert.ok(
      r.stats.completedResources >= 9,
      "textures and shader-discovered buffers must both use pages",
    );
    assert.deepEqual(r.stats.errors, []);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
