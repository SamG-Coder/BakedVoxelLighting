// Pinned Basis Universal encoder/transcoder, isolated from the render thread.
importScripts("../vendor/basis/basis_encoder.js");
const ready = BASIS({
  locateFile: (name) =>
    new URL("../vendor/basis/" + name, self.location.href).href,
  print: () => {},
  printErr: () => {},
}).then((module) => {
  module.initializeBasis();
  return module;
});
let chain = Promise.resolve();
self.onmessage = ({ data: { id, data, width, height } }) => {
  chain = chain.then(async () => {
    let encoder, file;
    try {
      for (let i = 3; i < data.length; i += 4)
        if (data[i] !== 255) {
          self.postMessage({ id, result: { rejected: "alpha" } });
          return;
        }
      const module = await ready;
      // WebGPU BC base extents must be block-aligned. Resample by at most
      // three pixels rather than padding the UVs and breaking seamless repeats.
      const w = Math.ceil(width / 4) * 4,
        h = Math.ceil(height / 4) * 4;
      let pixels = data;
      if (w !== width || h !== height) {
        const source = new OffscreenCanvas(width, height);
        source
          .getContext("2d")
          .putImageData(
            new ImageData(
              new Uint8ClampedArray(
                data.buffer,
                data.byteOffset,
                data.byteLength,
              ),
              width,
              height,
            ),
            0,
            0,
          );
        const target = new OffscreenCanvas(w, h),
          ctx = target.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(source, 0, 0, w, h);
        pixels = ctx.getImageData(0, 0, w, h).data;
      }
      encoder = new module.BasisEncoder();
      encoder.setCreateKTX2File(true);
      encoder.setKTX2UASTCSupercompression(false);
      encoder.setFormatMode(module.basis_tex_format.cUASTC_LDR_4x4.value);
      encoder.setPackUASTCFlags(2);
      encoder.setPerceptual(true);
      encoder.setMipSRGB(true);
      encoder.setKTX2AndBasisSRGBTransferFunc(true);
      encoder.setMipGen(true);
      encoder.setMipWrapping(true);
      encoder.setSliceSourceImage(
        0,
        pixels,
        w,
        h,
        module.ldr_image_type.cRGBA32.value,
      );
      const output = new Uint8Array(w * h * 4 + 65536);
      const length = encoder.encode(output);
      if (!length) throw Error("Basis encode failed");
      file = new module.KTX2File(output.subarray(0, length));
      if (!file.startTranscoding()) throw Error("Basis transcode failed");
      const levels = [];
      for (let level = 0; level < file.getLevels(); level++) {
        const bytes = new Uint8Array(
          file.getImageTranscodedSizeInBytes(level, 0, 0, 6),
        );
        if (!file.transcodeImage(bytes, level, 0, 0, 6, 0, -1, -1))
          throw Error("BC7 transcode failed");
        levels.push({
          width: Math.max(1, w >> level),
          height: Math.max(1, h >> level),
          data: bytes,
        });
      }
      // Validate decoded UASTC colour before accepting lossy storage. BC7 uses
      // the encoder's transcode path; GPU readback separately validates uploads.
      const decoded = new Uint8Array(w * h * 4);
      if (!file.transcodeImage(decoded, 0, 0, 0, 13, 0, -1, -1))
        throw Error("Quality decode failed");
      let squared = 0;
      for (let i = 0; i < decoded.length; i += 4)
        for (let c = 0; c < 3; c++)
          squared += (pixels[i + c] - decoded[i + c]) ** 2;
      const rmse = Math.sqrt(squared / (w * h * 3));
      if (rmse > 4.5) {
        self.postMessage({ id, result: { rejected: "colour error", rmse } });
        return;
      }
      self.postMessage(
        { id, result: { levels, rmse } },
        levels.map((l) => l.data.buffer),
      );
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    } finally {
      file?.close();
      file?.delete();
      encoder?.delete();
    }
  });
};
