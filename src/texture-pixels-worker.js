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
