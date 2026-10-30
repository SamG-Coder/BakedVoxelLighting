# Material and upload upgrade

This transfers rendering techniques reviewed in KCDInWeb, not its assets.

- `FoliageMaterial` adds bounded thin-surface transmission inside Three's direct
  lighting model. It receives each light's shadowed colour and uses the represented
  grass/leaf normal. Baked indirect light remains separate. This is an artistic
  thin-surface approximation, not a full subsurface scattering simulation.
- Dirt and scree share explicit-mip colour and normal texture arrays. Their blend
  boundaries use a small luminance-derived micro-height correction, fading from
  40 to 160 metres. There are no authored height maps and no new displacement.
  Existing habitat and distant grass coverage remain in use.
- The fallback instanced-matrix shader path now uses a shared reference attribute
  instead of creating an interleaved buffer and update callback per instance set.
  Existing named instance attributes and matrix layouts are preserved.
- Texture fetch/decode uses two-job lookahead. OffscreenCanvas pixel extraction
  and downsampling run in workers. Terrain array packing also runs in a worker.
- Seven opaque colour textures can be encoded to UASTC and transcoded to BC7 by
  the pinned Basis Universal worker. All mip levels are cached in IndexedDB.
  Unsupported adapters keep the original textures. Transient encoder/upload
  failures also keep the originals and are not cached as permanent failures.
  Grass/leaf alpha maps and normal maps are not compressed by this path.
- Array and BC7 texture uploads use the existing bounded upload queue. BC7 pages
  align to compression blocks, including the smallest mip levels.

The encoder rejects an asset if its UASTC reconstruction exceeds RGB RMSE 4.5
on the 0–255 scale. This check is not an exact error measurement of final BC7
sampling. Non-block-aligned images are resampled upward by at most three pixels
to preserve repeating UVs. Compression is lossy and adds one-time startup work;
subsequent starts reuse the cached mip chain. Vendor provenance and Apache-2.0
license/NOTICE are in `public/vendor/basis/`.

Local checks on both WebGPU and WebGL2:

- `node scripts/verify-material-upgrade.mjs`: array layers and mip tails,
  compressed upload readback, direct backlighting on/off, cloned material, and
  original-texture fallback when worker creation fails.
- `node scripts/verify-gpu-pages.mjs`: existing upload paging regressions.
- `node scripts/verify-backends.mjs webgpu` and `webgl2`: full-world loading,
  four LOD levels, and backend switching, with no captured browser errors.
- `npm run build:pages`: production build, including worker and WASM delivery.

The seven accepted source mip chains total 58,688,504 bytes; BC7 chains total
14,741,776 bytes (about 75% less). This is storage for those textures, not total
GPU-memory or FPS savings. The terrain arrays add separate storage while original
textures remain available to other materials. No controlled frame-time improvement
has been claimed and no tests have been added to GitHub Actions.
