import {
  REVISION,
  RGBAFormat,
  RGFormat,
  RedFormat,
  UnsignedByteType,
  FloatType,
  HalfFloatType,
} from "three/webgpu";
import { GPUUploadQueue, UPLOAD_LIMITS } from "./gpu-upload-queue.js";
import { installGeometryLeases } from "./shared-geometry.js";

const managers = new WeakMap(),
  live = new Set();
let interactive = false;
export function setUploadsInteractive(value) {
  interactive = value;
  for (const manager of live) manager.queue.interactive = value;
}

// These small adapters deliberately target the installed Three 0.187.0 backend.
// Preserve Three's handles, binding generations, samplers and disposal paths;
// only substitute the INITIAL payload copies while preparing hidden objects.
// Uniform updates and rendering are never intercepted as asynchronous work.
class PagedUploads {
  constructor(renderer) {
    if (REVISION !== "187")
      throw new Error("Revalidate paged uploads against this Three revision");
    this.renderer = renderer;
    this.backend = renderer.backend;
    this.queue = new GPUUploadQueue(this.backend);
    this.queue.interactive = interactive;
    this.stats = this.queue.stats;
    this.resources = new WeakMap();
    this.textures = new WeakMap();
    this.batch = null;
    this.explicit = 0;
    this.restore = [];
    this.install();
    live.add(this);
  }

  get capturing() {
    return (
      this.explicit > 0 ||
      (this.batch !== null && this.renderer._precompilationState !== null)
    );
  }

  hook(owner, name, wrap) {
    const original = owner[name];
    owner[name] = wrap(original);
    this.restore.push(() => {
      owner[name] = original;
    });
  }

  allocation(fn) {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.stats.maxAllocationMs = Math.max(
        this.stats.maxAllocationMs,
        performance.now() - start,
      );
    }
  }

  track(handle, job, bytes) {
    this.resources.set(handle, { job, bytes });
    this.stats.allocatedBytes += bytes;
    this.stats.peakAllocatedBytes = Math.max(
      this.stats.peakAllocatedBytes,
      this.stats.allocatedBytes,
    );
    this.batch?.add(job.promise);
  }

  release(handle) {
    if (!handle) return;
    const entry = this.resources.get(handle);
    if (!entry) return;
    this.queue.cancel(entry.job);
    this.stats.allocatedBytes -= entry.bytes;
    this.resources.delete(handle);
  }

  begin() {
    if (this.batch)
      throw new Error("GPU preparation must be serialized per renderer");
    this.batch = new Set();
    return this.batch;
  }

  async finish(batch) {
    // The batch remains attached until all copies are submitted ahead of draws.
    // A material cannot be published just because its shader compiled first.
    try {
      const results = await Promise.allSettled(batch);
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    } finally {
      if (this.batch === batch) this.batch = null;
    }
  }

  async texturesReady(textures) {
    // Explicit texture publication can run alongside a shader build. It uses
    // its own set while synchronously invoking initTexture, then restores it.
    const batch = new Set(),
      previous = this.batch;
    this.batch = batch;
    this.explicit++;
    try {
      for (const texture of textures) {
        this.renderer.initTexture(texture);
        const existing = this.textures.get(texture);
        if (existing) batch.add(existing.job.promise);
      }
    } finally {
      this.explicit--;
      this.batch = previous;
    }
    await Promise.all(batch);
  }

  install() {
    installGeometryLeases(this.renderer);
    const backend = this.backend,
      manager = this,
      utils = backend.attributeUtils;
    this.hook(
      backend,
      "createTexture",
      (original) =>
        function (texture, options) {
          return manager.allocation(() =>
            original.call(this, texture, options),
          );
        },
    );
    this.hook(
      utils,
      "createAttribute",
      (original) =>
        function (attribute, usage) {
          const base = attribute.isInterleavedBufferAttribute
            ? attribute.data
            : attribute;
          const data = backend.get(base),
            existing = data.buffer || data.bufferGPU;
          if (existing) return original.call(this, attribute, usage);
          // Transform feedback / storage has a different lifetime and padding. It
          // is not used for streamed vegetation. Keep its native Three path intact.
          const supported =
            !base.isStorageBufferAttribute &&
            !base.isStorageInstancedBufferAttribute;
          if (!manager.capturing || !supported) {
            manager.stats.unpagedBufferBytes += base.array.byteLength;
            return original.call(this, attribute, usage);
          }
          if (backend.isWebGPUBackend) {
            if (!manager.createGPUBuffer(attribute, usage)) {
              manager.stats.unpagedBufferBytes += base.array.byteLength;
              return original.call(this, attribute, usage);
            }
          } else {
            // Let Three populate GL format, integer and interleaved metadata. Its
            // allocator takes a byte count here, rather than a whole typed array.
            const create = this._createBuffer;
            this._createBuffer = (gl, type, array, hint) => {
              const buffer = manager.allocation(() => {
                const b = gl.createBuffer();
                // Establish an element buffer before filling it through the copy
                // target. Otherwise indexed draws can fail WebGL validation even
                // though the copied bytes read back correctly. Detach the cached
                // VAO first so allocation cannot replace its element binding.
                const target =
                  type === gl.ELEMENT_ARRAY_BUFFER
                    ? gl.ELEMENT_ARRAY_BUFFER
                    : gl.COPY_WRITE_BUFFER;
                if (target === gl.ELEMENT_ARRAY_BUFFER)
                  backend.state.resetVertexState();
                gl.bindBuffer(target, b);
                gl.bufferData(target, array.byteLength, hint);
                gl.bindBuffer(target, null);
                return b;
              });
              const job = manager.queue.enqueue(
                manager.bufferPages(buffer, array),
                array.byteLength,
                "geometry buffer",
              );
              manager.track(buffer, job, array.byteLength);
              return buffer;
            };
            try {
              original.call(this, attribute, usage);
            } finally {
              this._createBuffer = create;
            }
          }
        },
    );
    this.hook(
      backend,
      "destroyAttribute",
      (original) =>
        function (attribute) {
          const base = attribute.isInterleavedBufferAttribute
            ? attribute.data
            : attribute;
          const data = backend.get(base);
          manager.release(data.buffer || data.bufferGPU);
          return original.call(this, attribute);
        },
    );
    this.hook(
      backend,
      "updateTexture",
      (original) =>
        function (texture, options) {
          // Never stream over an already visible texture. Replacements must be new
          // texture objects and become visible atomically after texturesReady().
          const previous = manager.textures.get(texture);
          if (
            manager.capturing &&
            !previous &&
            !manager.renderer._textures.get(texture).initialized &&
            manager.canPageTexture(texture)
          ) {
            manager.createTexturePages(texture);
            return;
          }
          const image = texture.image;
          manager.stats.unpagedTextureBytes +=
            image?.data?.byteLength ||
            (image?.width || 0) * (image?.height || 0) * 4;
          return original.call(this, texture, options);
        },
    );
    this.hook(
      backend,
      "generateMipmaps",
      (original) =>
        function (texture) {
          const entry = manager.textures.get(texture);
          if (entry && !entry.job.done) {
            entry.generate = () => original.call(this, texture);
            return;
          }
          return original.call(this, texture);
        },
    );
    this.hook(
      backend,
      "destroyTexture",
      (original) =>
        function (texture) {
          const data = backend.get(texture);
          manager.release(data.texture || data.textureGPU);
          manager.textures.delete(texture);
          return original.call(this, texture);
        },
    );
    this.hook(
      this.renderer,
      "dispose",
      (original) =>
        function () {
          manager.queue.dispose();
          for (const undo of manager.restore) undo();
          live.delete(manager);
          managers.delete(this);
          return original.call(this);
        },
    );
  }

  createGPUBuffer(attribute, usage) {
    const base = attribute.isInterleavedBufferAttribute
      ? attribute.data
      : attribute;
    const source = base.array;
    let array = source;
    // Match Three's integer vertex/index widening. Conversion itself is paged.
    if (!attribute.normalized && !attribute.isInterleavedBufferAttribute) {
      if (source instanceof Uint16Array || source instanceof Uint8Array)
        array = new Uint32Array(source.length);
      if (source instanceof Int16Array || source instanceof Int8Array)
        array = new Int32Array(source.length);
    }
    const stride =
      (base.stride || base.itemSize || 1) * array.BYTES_PER_ELEMENT;
    if (stride % 4 || array.byteLength % 4) return false;
    base.array = array;
    const buffer = this.allocation(() =>
      this.backend.device.createBuffer({
        label: base.name || "paged geometry",
        size: array.byteLength,
        usage,
        mappedAtCreation: false,
      }),
    );
    this.backend.get(base).buffer = buffer;
    const job = this.queue.enqueue(
      this.bufferPages(buffer, array, source, !!(usage & GPUBufferUsage.INDEX)),
      array.byteLength,
      "geometry buffer",
    );
    this.track(buffer, job, array.byteLength);
    return true;
  }

  *bufferPages(buffer, array, source = array, index = false) {
    const gpu = this.backend.isWebGPUBackend,
      gl = this.backend.gl;
    for (
      let offset = 0;
      offset < array.byteLength;
      offset += UPLOAD_LIMITS.pageBytes
    ) {
      const bytes = Math.min(
        UPLOAD_LIMITS.pageBytes,
        array.byteLength - offset,
      );
      yield {
        bytes,
        submit: () => {
          if (source !== array) {
            const start = offset / array.BYTES_PER_ELEMENT,
              end = (offset + bytes) / array.BYTES_PER_ELEMENT;
            array.set(source.subarray(start, end), start);
            if (index)
              for (let i = start; i < end; i++)
                if (array[i] === 0xffff) array[i] = 0xffffffff;
          }
          const view = new Uint8Array(
            array.buffer,
            array.byteOffset + offset,
            bytes,
          );
          if (gpu) this.backend.device.queue.writeBuffer(buffer, offset, view);
          else {
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer);
            gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, view);
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
          }
        },
      };
    }
  }

  canPageTexture(t) {
    return (
      (t.isDataTexture || t.isData3DTexture) &&
      !t.flipY &&
      !t.premultiplyAlpha &&
      [RGBAFormat, RGFormat, RedFormat].includes(t.format) &&
      [UnsignedByteType, FloatType, HalfFloatType].includes(t.type) &&
      ArrayBuffer.isView(t.image?.data)
    );
  }

  createTexturePages(texture) {
    const levels = texture.mipmaps.length ? texture.mipmaps : [texture.image];
    const channels =
      texture.format === RGBAFormat ? 4 : texture.format === RGFormat ? 2 : 1;
    const bpt = channels * texture.image.data.BYTES_PER_ELEMENT;
    const bytes = levels.reduce((sum, level) => sum + level.data.byteLength, 0);
    const data = this.backend.get(texture),
      handle = data.texture || data.textureGPU;
    data.version = texture.version;
    const entry = { generate: null, job: null };
    entry.job = this.queue.enqueue(
      this.texturePages(texture, levels, bpt, entry),
      bytes,
      texture.name || "baked texture",
    );
    this.textures.set(texture, entry);
    // Include allocated automatic mip levels in resident memory accounting.
    let allocated = bytes;
    if (texture.generateMipmaps && !texture.mipmaps.length) {
      let w = texture.image.width,
        h = texture.image.height;
      while (w > 1 || h > 1) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        allocated += w * h * bpt;
      }
    }
    this.track(handle, entry.job, allocated);
  }

  *texturePages(texture, levels, bpt, entry) {
    const backend = this.backend,
      gpu = backend.isWebGPUBackend,
      gl = backend.gl;
    for (let mip = 0; mip < levels.length; mip++) {
      const { width, height, data } = levels[mip],
        depth = levels[mip].depth || 1;
      // Full rows where possible. Very wide images split a row horizontally so
      // even a single scanline can never exceed the page byte limit.
      const tileWidth = Math.min(
        width,
        Math.floor(UPLOAD_LIMITS.pageBytes / bpt),
      );
      const rows = Math.max(
        1,
        Math.floor(UPLOAD_LIMITS.pageBytes / (tileWidth * bpt)),
      );
      for (let z = 0; z < depth; z++)
        for (let y = 0; y < height; y += rows) {
          for (let x = 0; x < width; x += tileWidth) {
            const w = Math.min(tileWidth, width - x),
              h = Math.min(rows, height - y);
            const bytes = w * h * bpt;
            const offset = (z * width * height + y * width + x) * bpt;
            yield {
              bytes,
              submit: () => {
                const resource = backend.get(texture);
                if (gpu) {
                  backend.device.queue.writeTexture(
                    {
                      texture: resource.texture,
                      mipLevel: mip,
                      origin: [x, y, z],
                    },
                    new Uint8Array(
                      data.buffer,
                      data.byteOffset + offset,
                      bytes,
                    ),
                    { bytesPerRow: w * bpt, rowsPerImage: h },
                    { width: w, height: h, depthOrArrayLayers: 1 },
                  );
                } else {
                  const { textureGPU, glTextureType, glFormat, glType } =
                    resource;
                  backend.state.bindTexture(glTextureType, textureGPU);
                  backend.state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                  backend.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                  backend.state.pixelStorei(
                    gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
                    false,
                  );
                  backend.state.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
                  backend.state.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
                  backend.state.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
                  backend.state.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
                  backend.state.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
                  const view = new data.constructor(
                    data.buffer,
                    data.byteOffset + offset,
                    bytes / data.BYTES_PER_ELEMENT,
                  );
                  if (texture.isData3DTexture)
                    gl.texSubImage3D(
                      glTextureType,
                      mip,
                      x,
                      y,
                      z,
                      w,
                      h,
                      1,
                      glFormat,
                      glType,
                      view,
                    );
                  else
                    gl.texSubImage2D(
                      glTextureType,
                      mip,
                      x,
                      y,
                      w,
                      h,
                      glFormat,
                      glType,
                      view,
                    );
                }
              },
            };
          }
        }
    }
    // Prebaked atlas mips are uploaded above exactly, including alpha coverage.
    // Automatic ground-map mips run once, after every base page is present.
    if (entry.generate) yield { bytes: 0, submit: () => entry.generate() };
  }
}

export function getGPUUploads(renderer) {
  let manager = managers.get(renderer);
  if (!manager) {
    manager = new PagedUploads(renderer);
    managers.set(renderer, manager);
  }
  return manager;
}
export function uploadTextures(renderer, textures) {
  return getGPUUploads(renderer).texturesReady(textures);
}
