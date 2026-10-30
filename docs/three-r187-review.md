# Three.js r187 review — 31 October 2026

The project moved from pinned `three@0.186.1` to `three@0.187.0`, the npm
`latest` release on the review date. The upstream release was published on
30 October. This is a compatibility upgrade, not a change in visual presets.
MSAA remains the default. Cutting is disabled in the main application; its
source remains available but its module, axe assets and worker are not loaded.

## Changes carried into this project

- Adopt the upstream binding-key allocation fix and remove our equivalent local
  `Bindings` patch. r187 collects resource IDs in a reusable array and creates
  a key only when bindings need updating. Our integer-uniform view/dirty-index
  patch remains necessary. The new uniform clone path also needs array flags.
- Register voxel sun and moon node classes with `Light.registerNode()`.
- Adapt the shader-stage budget to the new `buildAsync(yieldFn)` callback.
  Frame-budget pauses pass through the renderer's compile-state restore boundary;
  they must not leave compilation state active while animation renders.
- Preserve camera type when selecting a nested preparation context. The old
  fixed-renderer-view hook is no longer installed; r187 owns compile-state handling.
- Update paged upload capture to use `_precompilationState`; `_isPreCompiling`
  no longer exists. Preserve the existing bounded transfer and cancellation policy.
- Restore the host render target when async preparation completes. Explicitly
  select the canvas for the atmosphere composite, preventing a scene texture
  from being sampled while it is also the current output attachment.
- Adapt the optional TRAA patch to r187's stable constructor depth binding and
  depth-format inheritance. Keep two reusable history targets and history resets.

A warm-cache test also exposed the pre-existing grass palette exceeding Chromium's
single IndexedDB value limit (134,218,636 bytes versus 133,169,152 allowed).
Its colour/normal mip payloads now use separate records, with the manifest published
last. Resolution, normal data and coverage-preserving mips remain unchanged.

## Which new features are useful?

| Change | Project assessment |
| --- | --- |
| Binding allocation, resource disposal and pipeline lifecycle fixes | Adopt with the upgrade. Directly relevant to streaming churn; no promised FPS increase without a controlled comparison. |
| Parallel pipeline compilation and shared node builds | Already exercised by existing `compileAsync` preparation. Retain frame and upload budgets rather than removing them. |
| `NodeMaterialInstance` | Best next experiment: share a configured node graph across vegetation material variants. First convert per-material fade/tint/texture reads to material references. Compare shader-build counts, memory and LOD fade correctness before broad adoption. |
| `referenceAttribute()` sharing for instanced meshes | Promising for grass/tree batches whose data differs but shader structure matches. Current instance nodes bind concrete buffers; this needs a measured prototype, not a blind replacement. |
| EON rough diffuse shading (`diffuseRoughness`) | Consider an opt-in comparison on bark, rocks and soil. Uses Physical materials and adds shader work. Not a fix for billboard grass normals or transmission. Keep existing look until measured and visually reviewed. |
| Cube-target PMREM filtering | Potentially useful for future environment-lit rough surfaces. This project uses custom sky/water reflections; a PMREM pass would need explicit sky/environment integration. |
| `mipmapsAutoUpdate` | Useful when manually scheduling updates of generated textures. Do not turn it off globally: distant plant coverage relies on correct mip chains, and the app already builds coverage-preserving atlas mips. |
| BatchedMesh draw consolidation / previous-matrix leak fixes | Useful if migrating more geometry to BatchedMesh later. Current merged and instanced vegetation does not automatically become BatchedMesh. |

## Validation scope

Passed the local allocation, shader-budget, temporal-history, visual-pipeline,
GPU-page and backend checks, plus the production Pages build. The backend check
passed starting from both WebGPU and WebGL2, with 118 cache hits and zero misses
after switching in either direction. It covers GPU bake/readback, 31 plant atlases, mip chains,
cutouts, camera-independent billboard normals, dynamic lighting, backend switching
and four LOD selections. These are functional checks, not a long-duration memory
soak or an apples-to-apples performance benchmark. A live New Game check also
confirmed F/click/walking no longer load cutting code, axe assets or its worker,
with no captured browser errors. No CI workflow was added.

## Primary references

- [r187 release](https://github.com/mrdoob/three.js/releases/tag/r187)
- [186 to 187 migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide#186--187)
- [Binding allocation PR #35120](https://github.com/mrdoob/three.js/pull/35120)
- [Pinned material-instance implementation](https://github.com/mrdoob/three.js/blob/r187/src/materials/nodes/NodeMaterialInstance.js)
- [Pinned physical material implementation](https://github.com/mrdoob/three.js/blob/r187/src/materials/nodes/MeshPhysicalNodeMaterial.js)

The upstream binding PR was authored by Snuble-bot and merged on 20 October.
The local corresponding patch first appears in commit `d3e2aea` on 27 October.
Both defer key-string construction; upstream uses a module-level array, while
our patch used per-bind-group storage. This comparison does not establish copying.
