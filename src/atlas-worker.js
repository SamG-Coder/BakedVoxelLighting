// Each frame is reduced independently: no colour/alpha bleeding between views.
self.onmessage = ({ data: { id, record, sources, tileSize } }) => {
  if (sources) {
    const w = tileSize * sources.length,
      h = tileSize,
      data = new Uint8Array(w * h * 4),
      normals = new Uint8Array(data.length);
    // Packing/resampling is a bake job on this worker, never camera-movement work.
    for (let f = 0; f < sources.length; f++) {
      const source = sources[f];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < tileSize; x++) {
          const sx = ((x + 0.5) / tileSize) * source.w - 0.5,
            sy = ((y + 0.5) / h) * source.h - 0.5;
          const ix = Math.floor(sx),
            iy = Math.floor(sy),
            u = sx - ix,
            v = sy - iy,
            o = (y * w + f * tileSize + x) * 4;
          let alpha = 0,
            nx = 0,
            ny = 0,
            nz = 0,
            r = 0,
            g = 0,
            b = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const i =
                (Math.max(0, Math.min(source.h - 1, iy + dy)) * source.w +
                  Math.max(0, Math.min(source.w - 1, ix + dx))) *
                4;
              const a =
                source.data[i + 3] * (dx ? u : 1 - u) * (dy ? v : 1 - v);
              alpha += a;
              r += source.data[i] * a;
              g += source.data[i + 1] * a;
              b += source.data[i + 2] * a;
              nx += (source.normals[i] / 127.5 - 1) * a;
              ny += (source.normals[i + 1] / 127.5 - 1) * a;
              nz += (source.normals[i + 2] / 127.5 - 1) * a;
            }
          if (alpha) {
            data[o] = r / alpha;
            data[o + 1] = g / alpha;
            data[o + 2] = b / alpha;
            const n = Math.hypot(nx, ny, nz) || 1;
            normals[o] = ((nx / n) * 0.5 + 0.5) * 255;
            normals[o + 1] = ((ny / n) * 0.5 + 0.5) * 255;
            normals[o + 2] = ((nz / n) * 0.5 + 0.5) * 255;
          }
          data[o + 3] = normals[o + 3] = alpha;
        }
    }
    record = {
      w,
      h,
      data,
      normals,
      views: sources.length,
      srgb: true,
      cutoff: 87,
    };
  }
  const { w, h, views } = record,
    base = record.data,
    normals = record.normals;
  const levels = [{ data: base, normals, width: w, height: h }],
    cutoff = record.cutoff ?? 82;
  const coverage = [];
  for (let f = 0; f < views; f++) {
    let count = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w / views; x++)
        if (base[(y * w + (f * w) / views + x) * 4 + 3] >= cutoff) count++;
    coverage.push(count / ((w / views) * h));
  }
  const decode = (v) =>
    !record.srgb
      ? v
      : v / 255 <= 0.04045
        ? v / 12.92
        : 255 * Math.pow((v / 255 + 0.055) / 1.055, 2.4);
  const encode = (v) =>
    !record.srgb
      ? v
      : v / 255 <= 0.0031308
        ? v * 12.92
        : 255 * (1.055 * Math.pow(v / 255, 1 / 2.4) - 0.055);
  let previous = levels[0],
    weights = Float32Array.from({ length: w * h }, (_, i) => base[i * 4 + 3]);
  while (previous.height > 1 || previous.width > views) {
    const height = Math.max(1, previous.height >> 1),
      width = Math.max(views, previous.width >> 1),
      frame = width / views;
    const data = new Uint8Array(width * height * 4),
      ns = new Uint8Array(data.length),
      nextWeights = new Float32Array(width * height);
    for (let f = 0; f < views; f++) {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < frame; x++) {
          const out = (y * width + f * frame + x) * 4;
          let a = 0,
            r = 0,
            g = 0,
            b = 0,
            nx = 0,
            ny = 0,
            nz = 0,
            payload = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const i =
                  (Math.min(previous.height - 1, y * 2 + dy) * previous.width +
                    f * (previous.width / views) +
                    Math.min(previous.width / views - 1, x * 2 + dx)) *
                  4,
                alpha = weights[i / 4];
              a += alpha;
              payload += previous.normals[i + 3] * alpha;
              r += decode(previous.data[i]) * alpha;
              g += decode(previous.data[i + 1]) * alpha;
              b += decode(previous.data[i + 2]) * alpha;
              nx += (previous.normals[i] / 127.5 - 1) * alpha;
              ny += (previous.normals[i + 1] / 127.5 - 1) * alpha;
              nz += (previous.normals[i + 2] / 127.5 - 1) * alpha;
            }
          if (a) {
            data[out] = encode(r / a);
            data[out + 1] = encode(g / a);
            data[out + 2] = encode(b / a);
            const length = Math.hypot(nx, ny, nz) || 1;
            ns[out] = ((nx / length) * 0.5 + 0.5) * 255;
            ns[out + 1] = ((ny / length) * 0.5 + 0.5) * 255;
            ns[out + 2] = ((nz / length) * 0.5 + 0.5) * 255;
          }
          data[out + 3] = a / 4;
          ns[out + 3] = record.mossPayload ? (a ? payload / a : 0) : a / 4;
          nextWeights[out / 4] = a / 4;
        }
      // Preserve projected leaf coverage at the runtime alpha cutoff.
      if (cutoff > 0) {
        let lo = 0,
          hi = 8;
        for (let it = 0; it < 12; it++) {
          const scale = (lo + hi) / 2;
          let count = 0;
          for (let y = 0; y < height; y++)
            for (let x = 0; x < frame; x++)
              if (data[(y * width + f * frame + x) * 4 + 3] * scale >= cutoff)
                count++;
          if (count / (frame * height) < coverage[f]) lo = scale;
          else hi = scale;
        }
        for (let y = 0; y < height; y++)
          for (let x = 0; x < frame; x++) {
            const i = (y * width + f * frame + x) * 4 + 3;
            data[i] = Math.min(255, data[i] * hi);
            if (!record.mossPayload) ns[i] = data[i];
          }
      }
    }
    weights = nextWeights;
    previous = { data, normals: ns, width, height };
    levels.push(previous);
  }
  self.postMessage(
    { id, levels },
    levels.flatMap((l) => [l.data.buffer, l.normals.buffer]),
  );
};
