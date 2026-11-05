// Fill the colour of fully transparent texels from the nearest opaque texels
// (push-pull). Canvas decoding premultiplies alpha, so those texels were
// black; linear filtering and mipmaps then pulled black into every leaf edge
// and darkened distant foliage. Alpha is unchanged.
function fillTransparent(data, w, h) {
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 4) transparent++;
  if (!transparent) return;
  const levels = [];
  let lw = w,
    lh = h;
  let colour = new Float32Array(w * h * 3),
    weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] >= 4 ? 1 : 0;
    weight[i] = a;
    colour[i * 3] = data[i * 4] * a;
    colour[i * 3 + 1] = data[i * 4 + 1] * a;
    colour[i * 3 + 2] = data[i * 4 + 2] * a;
  }
  levels.push({ w: lw, h: lh, colour, weight });
  // Push: weighted 2x2 reductions down to 1x1.
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, lw >> 1),
      nh = Math.max(1, lh >> 1);
    const c = new Float32Array(nw * nh * 3),
      wt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const o = y * nw + x;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(lw - 1, x * 2 + dx),
              sy = Math.min(lh - 1, y * 2 + dy),
              i = sy * lw + sx;
            wt[o] += weight[i];
            c[o * 3] += colour[i * 3];
            c[o * 3 + 1] += colour[i * 3 + 1];
            c[o * 3 + 2] += colour[i * 3 + 2];
          }
      }
    lw = nw;
    lh = nh;
    colour = c;
    weight = wt;
    levels.push({ w: lw, h: lh, colour, weight });
  }
  // Pull: empty texels take the normalised colour of their coarser parent.
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l],
      coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y++)
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        if (fine.weight[i] > 0) continue;
        const p =
          Math.min(coarse.h - 1, y >> 1) * coarse.w +
          Math.min(coarse.w - 1, x >> 1);
        const wt = coarse.weight[p] || 1;
        fine.colour[i * 3] = coarse.colour[p * 3] / wt;
        fine.colour[i * 3 + 1] = coarse.colour[p * 3 + 1] / wt;
        fine.colour[i * 3 + 2] = coarse.colour[p * 3 + 2] / wt;
        fine.weight[i] = 1;
      }
    // Normalise filled/kept texels so the next finer level reads colours.
    for (let i = 0; i < fine.w * fine.h; i++) {
      const wt = fine.weight[i];
      if (wt > 0 && wt !== 1) {
        fine.colour[i * 3] /= wt;
        fine.colour[i * 3 + 1] /= wt;
        fine.colour[i * 3 + 2] /= wt;
        fine.weight[i] = 1;
      }
    }
  }
  const base = levels[0].colour;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] >= 4) continue;
    data[i * 4] = base[i * 3];
    data[i * 4 + 1] = base[i * 3 + 1];
    data[i * 4 + 2] = base[i * 3 + 2];
  }
}

// Only two decode jobs can be live. Transfer pixel storage; never clone it.
self.onmessage = async ({ data: { id, blob } }) => {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const w = bitmap.width,
      h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const raw = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(raw.length),
      stride = w * 4;
    for (let y = 0; y < h; y++)
      data.set(
        raw.subarray(y * stride, (y + 1) * stride),
        (h - 1 - y) * stride,
      );
    fillTransparent(data, w, h);
    canvas.width = canvas.height = 64;
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    const sample = ctx.getImageData(0, 0, 64, 64).data;
    self.postMessage({ id, result: { w, h, data, sample } }, [
      data.buffer,
      sample.buffer,
    ]);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  } finally {
    bitmap?.close();
  }
};
