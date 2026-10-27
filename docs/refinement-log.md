# Natural-world refinement log

This is a working good/bad list, updated from rendered checks and measurements. A stationary 60 FPS reading is not an acceptance test for streaming. Target: natural appearance at the existing quality settings with smooth 60 FPS traversal.

## 2026-10-28: native temporal-AA preview

Performance correction 74cf149 was committed, pushed, and its Pages deployment succeeded before continuing AA work. MSAA remains the default. A selector now exposes the native `?aa=taa` preview and retains `?aa=taau` for comparison.

The native path uses Three 0.186.1 TRAA rather than its upscaling-oriented TAAU resolve. A version-pinned postinstall patch alternates the two retained colour targets instead of copying resolved colour into history each frame. Depth retains one stable owner and still copies once per frame. The patch removes the temporary camera-view-offset object, adds explicit history reset/validity, and supports the existing reactive mask with a 0.15 minimum current-frame weight. Upstream depth reprojection, neighborhood variance clipping and luminance weighting remain. The patch is reproducible from a clean npm install and fails on unsupported Three versions.

Native TAA resolves scene colour directly, then applies half-resolution contact shading and low-resolution scattering in the final composite. This removes the full-resolution RGBA16F intermediate composite and its render pass. Scattering uses deterministic samples because it is composited after the temporal resolve; it must not inject unresolved per-frame noise. Resize, abrupt camera displacement/rotation, projection-FOV changes and large sun-direction changes reject history. The unjittered projection remains bound between asynchronous shader builds, and the final canvas alpha remains opaque.

The 200-frame local history test checks target reuse, previous-frame identity, no read/write alias, stable depth ownership, seed/reset behavior, jitter and disposal. A real WebGPU camera sweep rendered 455 frames with zero colour-history copies and 455 depth copies; resize and night/day changes produced no captured GPU validation errors. WebGL2 also loaded and completed resize/motion checks (180 sweep frames, zero colour-history copies, 180 depth copies) without captured errors; its observed roughly 24 FPS is compatibility evidence, not a performance success. The selector reload back to MSAA was exercised. These short checks do not certify absence of ghosting for all vegetation or streaming transitions.

At the matched 1280x800/noon starting view, after the performance correction: TAAU measured 58.2 FPS; the first native implementation measured 56.2; removing the intermediate pass measured 57.7. The final native sample had 16.8ms p95, 33.4ms p99 and 49.9ms maximum interval. Average render-pass count fell from 7.68 to 6.66 (background bakes/reflections make it fractional), at approximately 2,210 draw calls. This establishes a pass/history-bandwidth reduction, not a clear FPS improvement over corrected TAAU. MSAA remains the recommended default and neither temporal mode is claimed to sustain 60 FPS. Evidence: `evidence/aa-taau-corrected.json`, `aa-native-first.json`, `aa-native-final.json`, `aa-motion-webgpu.json`.

## 2026-10-28: rendering regression correction

Compared c16938d with its parent after the user reported a slowdown. Restored 4x MSAA as the default; `?aa=taau` explicitly selects the experimental temporal/contact-shadow path. The opaque final composite and the distant grass colour fix remain in both modes.

The diff also introduced work outside temporal presentation: explicit previous-position assignments repeated wind, root fitting, billboard rotation and water displacement in passes without velocity output. These assignments are now gated at shader-build time to the velocity MRT. Shadow, reflection, surface-bake and ordinary MSAA passes do not generate them. Distant radiance was an eagerly evaluated native-function argument, even in the interior of the fine voxel volume. Its horizon fallback now runs only in the original 24m horizontal/6m vertical blend border or outside the volume. The existing blend weights and lighting equations are retained.

Whole-world lighting now shares a single texture node and render-scoped sun parameters, reusing a Vector4. It removes per-material object-scoped sun references and repeated per-pixel azimuth calculations; habitat samples are reused within each radiance lookup. No vegetation population, geometry, LOD range, texture resolution or bake resolution was reduced.

Three 0.186.1 source inspection did not establish a new large per-frame allocation in its temporal history targets or VelocityNode matrices: these are retained after setup. Existing pinned binding/uniform allocation patches and the asynchronous build-budget hook still pass their local regression checks. No speculative new engine patch was applied.

Local WebGPU 1280x800, noon, same stationary starting camera: the prior temporal path measured 44.1 FPS (22.7ms average interval, 33.4ms p99); disabling only contact shadows measured 45.3 FPS. After the combined corrections with restored MSAA, a 15-second check measured 59.5 FPS, 16.8ms average/p99, and a 33.4ms maximum interval, with no captured errors. Draw count stayed approximately 2,200. These are combined-change results, not an isolated attribution or a guarantee for traversal. Heap remained around 1.84–1.87GB during the fixed sample; this is not a claim of zero GC or resolved long-session memory growth. Evidence: `evidence/aa-taau-baseline.json`, `aa-taau-no-contact.json`, `aa-regression-fixed.json`, `aa-regression-fixed.png`.

Local sun-parameter/motion-pass, visual-pipeline, Three allocation, and async-builder checks pass, along with the production build. No Actions tests added. Further water/cloud visual work is paused.

## 2026-10-28: foliage and temporal rendering

- Baked a transmission approximation into existing normal-map alpha. Source mips, packed grass, tree HLODs and meadow surfaces preserve it separately from cutout coverage. This is inferred from occupancy/pigment, not a measured leaf thickness scan.
- Added native-resolution temporal reconstruction, previous-frame vegetation/water positions, conservative solid-surface contact shadows and cloud-modulated single scattering. `?aa=msaa` retains the 4-sample reference path.
- Fixed asynchronous compilation retaining the wrong MRT context; terrain now reuses its meadow atlas binding to stay within the baseline 16 sampled-texture limit.
- Kept the unjittered motion projection bound between frames and stopped mixing jittered source pixels back into reconstructed output. User confirmed distant shaking was resolved.
- Made the final world composite opaque: foliage coverage alpha must not expose the HTML background after temporal filtering. User confirmed the distant grey-grass correction.
- A cached 2.25 MiB eight-direction world horizon atlas supplies distant terrain/canopy visibility. It is coarse directional coverage, not full-world fine GI or a replacement for local voxel shadows.
- Production build and the local async-context/material-mip regression checks pass. WebGPU preview reached ready without captured validation errors. WebGL2 temporal parity and a long traversal performance comparison remain to be completed; observed frame rates varied by view, so this is not a locked-60-FPS claim. No tests were added to Actions.

## Good

- Connected downhill drainage replaces the former single sinusoidal river.
- Tributaries, terrain carving, wetness and planting exclusions share the same graph.
- Larger forest regions include canopy gaps, mixed ages, species communities and fallen wood.
- Five new assets are integrated: fern, bracken, wild strawberry, woodland litter and scree.
- The ten-species plant palette retains 1024px per species and isolated mip filtering in a 4096 x 3072 atlas.
- WebGPU and WebGL2 both reached ready and rendered without captured shader errors in the browser checks.
- Existing HLOD handoff and grass streaming unit checks continue to pass.
- Global shader values now share render-scoped uniform bindings. A matched five-second WebGPU trace reduced node/binding CPU work by 27.8% with the same draw counts and scene detail; traversal spikes still remain.
- Asynchronous shader stages now share the interactive preparation budget, including work resumed after an await. Replacements remain hidden until pipeline/upload readiness, with the existing resident LOD retained.

## Bad / needs refinement

1. **Streaming frame spikes and high memory.** The first 200m walk at 6m/s had 16.7ms median, 33.4ms p95, 133.4ms maximum callback interval. Reported JS memory reached 2.36GB. This is not a smooth-60-FPS result.
2. **Riverbank transitions need more physical detail.** Shared bank masks now expose patchy soil/gravel and suppress grass at the shore at every LOD. Water geometry still makes some bends angular; erosion/deposition shapes and bank-specific stones are not implemented.
3. **River geometry is still an approximation.** The continuous-surface pass below removes overlapping strips. Bank erosion/deposition detail and deliberate road crossings remain unfinished.
4. **Middle-distance grass clumps can read as repeated blocks.** The open-bank view exposes this more clearly than dense woodland. Patch silhouette/coverage needs a dedicated follow-up.
5. **Forest ground can still repeat.** New understory species help, but fallen leaves, decayed wood, moss and bare patches need more spatial variation.
6. **Distant terrain needs scrutiny.** The surrounding ring must avoid clamped voxel/ground lookup stripes and blend its material with the playable region.
7. **Density is not yet a field-calibrated forest inventory.** Generated one-hectare counts peak at 217 trees; small regeneration stems and diameter distributions need further calibration.

## Selected improvement: sparse grass buffer waste

Sparse woodland tiles previously allocated buffers for 7,800 near instances or 2,600 middle-distance instances regardless of their actual population. Reusable capacity classes now reserve the next power-of-two capacity, minimum 256, and only reuse matching groups. Every generated instance is retained. Grass density, geometry, source textures and render distances are unchanged.

The construction path also stops allocating a second complete set of zero-filled input arrays just to copy them into the instance buffers. Pools remain bounded at 48 groups per LOD.

Validation:
- Exhaustive capacities 0 through 7,800 never truncate a population.
- Pool checks verify exact-capacity reuse and preserve unmatched groups.
- Repeated the same 200m route: GPU page allocations fell from 899,849,478 to 546,708,158 bytes (39.2%). Observed JS memory snapshots were 2.36GB before and 2.20GB after, but GC timing prevents attributing that entire difference to the change.
- Frame intervals did not establish a smoothness improvement: median 16.7ms and p95 33.4ms in both runs; maximum 133.4ms before / 116.7ms after; intervals above 33.4ms were 23 before / 41 after. Keep this change for the demonstrated GPU memory reduction, not as a claim that 60 FPS is fixed.
- Both runs retained all ten plant species and 1024px per-species textures. No captured browser warnings/errors during the repeat walk.
- Browser callback timings are not GPU timings. Cache warmth, day-cycle position and normal desktop scheduling can influence the samples; memory readings are snapshots rather than leak proofs.

## Selected improvement: riverbank material and plant continuity

The previous near/distant reference views had a continuous green ribbon beside the water. Bank exposure now follows the indexed channel distance, with irregular 2.4-10m soil/gravel fringes and world-space patches. Soil and scree textures already resident in the scene supply the surface detail. No new bitmap was needed for this iteration.

- Terrain preparation bakes exposure and gravel into B/A of the existing root/canopy texture. R/G keep their previous meaning. The transferred worker buffer becomes the texture data directly.
- The texture changes from RG8 to RGBA8: 8,008,002 additional bytes in both the CPU backing buffer and nominal GPU texture storage. No extra texture binding, geometry or draw call is introduced.
- Grass population and the distant ground bake use the same exposure function. Grass becomes sparse only along exposed banks; inland populations and quality settings remain unchanged.
- Both native GLSL and WGSL ground kernels blend the bank after the forest-floor material, so woodland litter cannot cover the river edge again at distance. Road wear still takes precedence.
- Cache identities include the new mask source to avoid retaining old grass tiles or ground bakes.

Validation:
- Actual generated masks tested at 1,459 channel-adjacent samples; 1,458 had exposed material. The soil/gravel selector spans its full 0-1 range.
- Root/canopy channels stay untouched during bank generation; bank grass density agrees with the shared mask. Inland density is unchanged. Continuity checks pass at 24m tile boundaries and the shoreline.
- Existing habitat/worker parity and river geometry checks pass, and the Pages production build succeeds.
- Same near and distant camera positions at noon were captured before/after. The distant view now retains a brown/gravel margin instead of returning to a green ribbon. Close forest views show a subtler change because much of the shoreline is occluded by trees.
- A 200m WebGPU walk measured median 16.7ms and p95 16.8ms before and after. p99 was 33.3ms / 33.4ms; maximum was 50ms / 66.7ms; intervals above 33.4ms were 2 / 4. These single desktop samples do not establish a performance improvement or a guaranteed minimum frame rate. Streaming spikes remain open.
- WebGPU and WebGL2 both reached ready without captured shader errors. WebGL2 showed about 41 FPS in the default preview, so backend parity is rendering correctness only; it does not meet the 60 FPS requirement.
- Evidence lives in the local ignored `evidence/riverbank-*` captures/reports. Cache residency, async scheduling and cloud motion can differ between captures; this is a visual/material comparison rather than a deterministic GPU benchmark.

## Iteration rule

Choose one item, record a before result, implement it, compare the same view/route and retain it only if its intended improvement is supported. Keep quality settings unchanged. Record remaining regressions instead of claiming the global 60 FPS goal from a local success.

## Selected improvement: roots on uneven terrain

Downhill buttresses exposed the prototype's flat lower surface as vertical slabs. Placed trees now sample the existing terrain height field at root vertices, bend exposed downhill wood into the slope, and smoothly return to the unchanged trunk above the two-metre prototype collar. Uphill wood remains embedded. The inverse-transpose of the deformation adjusts geometric normals; existing bark normal maps remain active. Low leaves within the collar receive the same displacement before wind, keeping sapling attachments consistent.

- Uses the existing instanced geometry and existing terrain texture: no per-tree geometry generation, additional draw, texture allocation or per-frame CPU work.
- Four height texel loads only for vertices below the collar. This adds bounded vertex shader work; a complete traversal performance comparison has not been performed for this change.
- Applies to wood levels L0, L1 and L2. Prototype capture remains undeformed; the most distant L3 whole-tree impostor is still a flat-ground approximation, not a terrain-specific root bake.
- Manual browser fixture: `/scripts/root-slope.html?backend=webgpu` or `?backend=webgl2` on the Vite dev server. Toggle fitting to reproduce the exposed slab; switch wood LOD and transform the instance to check attachment.
- WebGPU L0/L1/L2 and WebGL2 L0 rendered successfully. The WebGPU production woodland reached ready and a sloped-tree view rendered with no captured errors. The Pages build and whitespace checks passed.
- Local evidence: `evidence/root-slope-before.png`, `evidence/root-slope-after.png`, `evidence/root-world-after.png`.

Remaining landscape issues after the root pass: river strip overlaps and deliberate road crossings, distant lighting consistency, and sparse landmark torch placement. The torch pass below addresses the last item.

## Selected improvement: sparse junction torches

The continuous 18 m rows made wild woodland look built-up. Torches now mark actual route intersections (or endpoints meeting another route), with one lamp on a dry, unobstructed verge 7 m before each junction. The current map changes from 271 torches / 43 static pages to one torch / one page. Ordinary stretches remain unlit. The timber post, wrapped head, iron collars, volumetric flame, rendering distances and simulation resolution are unchanged.

- Pool capacities follow the number of placed lamps: one flame and one point light here, bounded at 48 / 12 for larger networks. Light count stays fixed during movement to avoid pipeline recompilation.
- Candidate records and the sorting comparator are reused instead of recreating selection arrays and spatial-query strings every 150 ms.
- Road fires fade out during daylight. With no carried flame or visible road flame, the shared GPU simulation/readback stops. Browser daytime diagnostics stayed at the initial 60 warm-up steps and zero readbacks.
- Segment intersection checks found the real crossing midway along a branch. Checking only branch endpoints would miss it. A different branch remains disconnected by over 200 m; road connectivity and deliberate river crossings need a separate correction.

Validation:
- Production layout and constructor checks passed: route tessellation invariance, shared-vertex crossing deduplication, parallel routes not mistaken for junctions, opposite-verge fallback, dry ground, trunk clearance, finite transforms, height, bounded pools, daytime shutdown and distant deactivation.
- Same WebGPU junction overview captured before/after at noon and night. The close night view retains a visible flame and lit verge; the long illuminated rows are gone. No captured WebGPU errors.
- WebGL2 also reached ready and rendered the night junction with no captured errors. Its default preview reported 49 FPS, so this is a backend correctness check, not evidence of meeting the performance target.
- Two 200 m night walks at 6 m/s before and after: median 16.7 ms and p95 16.8 ms throughout. Baseline p99 16.8 / 16.8 ms, max 50.0 / 50.1 ms, intervals above 33.4 ms 2 / 1. Revised p99 33.3 / 33.3 ms, max 49.9 / 66.6 ms, intervals above 33.4 ms 6 / 2. This does **not** demonstrate smoother whole-scene performance or a guaranteed 59 FPS minimum. Keep the change for the verified placement improvement and lower torch work.
- Scene residency differed between the independent builds, so total draw/heap snapshots are not an isolated torch benchmark. Cache warmth, streaming completion and desktop scheduling remain uncontrolled. Frame callback intervals are not GPU timings.
- Production Pages build succeeds; no Actions tests added. Local evidence is in `evidence/torch-before-*` and `evidence/torch-after-*`.

Current good: terrain-following roots, coherent riverbank material/grass masks, sparse purposeful lighting, retained full-detail plant assets. Current bad: streaming frame spikes and high memory, overlapping river confluences, a disconnected branch road and missing crossings, distant tree lighting mismatch, repeated middle-distance grass silhouettes. Next visual priority is a connected river/path network; the 60 FPS objective remains unresolved.

## Selected improvement: continuous river surface

Separate transparent strips overlapped at bends and junctions, producing dark triangular patches and doubled reflection/opacity. Water now uses one clipped global lattice, split into spatial pages. Compact local reach weights blend height and flow at junctions; world-space ripple coordinates keep the texture continuous. Dry cells are removed and the boundary follows interpolated water depth/channel coverage. The existing ripple bake, foam, shallow transparency and sky/cloud reflection remain active.

- Terrain preparation builds the mesh in its worker and transfers the finished arrays. Main-thread construction attaches those arrays directly. There is no new per-frame CPU work, render pass or texture binding.
- Water triangles: 305,519 → 185,206 (39.4% fewer). Vertex/index buffer bytes: 12,575,076 → 8,655,192 (31.2% fewer). Spatial pages: 328 → 350; this is not a draw-count reduction claim.
- Four local Node preparation samples were 19-36 ms for strips and 278-609 ms for the new mesh. The new preparation is more expensive but now occurs before play in the terrain worker, not synchronously during scene construction. These are CPU construction samples, not browser startup or GPU timings.

Validation:
- All 2,776 duplicated page-edge vertices have exactly matching position, flow, depth and ripple coordinates.
- At 28,644 confluence samples there is at most one surface; all tested junction centres and 4,640 channel-centre samples remain covered. Fully dry and empty networks produce no meshes.
- An independent sample of the pictured bend found 700 doubled points before and zero after. The same WebGPU camera shows the dark triangular patch removed; the bank-level view retains ripples and shallow-water detail.
- WebGPU 200 m walks at 6 m/s: before/after median 16.7/16.7 ms, p95 16.8/16.8 ms, p99 16.8/16.8 ms, maximum 50.0/50.1 ms; one interval above 33.4 ms in each. No measured whole-scene speedup and no guaranteed 59 FPS minimum. Streaming hitches remain.
- River geometry, watershed, bank-material and habitat/worker-parity checks pass. Evidence lives under local ignored `evidence/river-union-*`.
- WebGPU and WebGL2 both reached ready and rendered the continuous confluence without captured errors. WebGL2's default preview was about 48 FPS; this verifies backend correctness, not the 60 FPS target. No tests were added to Actions.

Current good: continuous water joins, smaller water buffers, worker-side preparation, terrain-fitting roots, coherent bank materials and purposeful torch placement. Current bad: streaming hitches and memory remain the main performance problem; roads still need connected routes and proper water crossings; distant tree lighting and repeated grass patches remain visible. No new bitmap asset was needed to fix the geometry defect.


## Selected improvement: connected branch roads

Fixed-coordinate branch origins had become stranded after the watershed/erosion pass moved the main road. Side paths now project their intended origin onto the generated main-road polyline, then use the existing slope/moisture routing to reach their destinations. Exact projected endpoints are retained through grid snapping and smoothing. The eastern path gains a real connection; the western path starts at the main road rather than continuing as an unintended spur across it.

- Both branches attach exactly: (-230.078, 40) and (-232, -30). Routing, traffic, soil compaction, tree exclusion and vegetation bakes use the same connected polylines. World bake revision advances to 19.
- The main road is unchanged. Branch lengths change from 379.3 / 409.0 m to 612.0 / 249.5 m. The eastern connection is dry; existing main-road and western river crossings are still pending bridge/ford work.
- Projection and routing occur during terrain worker preparation. No new render pass, material, texture or per-frame route lookup. The two recognised junctions now place two sparse lamps instead of one; existing daytime fire shutdown remains active.
- New seed population: 146,590 trees and 1,827 fallen-wood records. This is an updated clearance/placement result, not a density or quality setting reduction.

Validation:
- Production connectivity checks pass at both attachment points, plus 1,188 road-surface samples checking traffic continuity and tree exclusion. Projection covers segment interiors, endpoints and duplicate vertices; no attachment introduces a segment longer than 4 m.
- Road torch placement/constructor, habitat/worker parity and river-union checks pass. River topology/buffer counts are unchanged.
- Matching WebGPU overview shows the new connection through the woodland. The same 200 m main-road walk at 6 m/s measured before/after median 16.7/16.7 ms, p95 16.8/16.8 ms, p99 16.8/16.8 ms, maximum 33.4/66.7 ms. Intervals above 33.4 ms: 0/1. This is a visual/connectivity improvement, not a performance win or proof of minimum 59 FPS. Streaming hitches remain. Independent build caches/populations differ; callback intervals are not GPU timings.
- WebGPU and WebGL2 rendered the connected overview without captured errors. WebGL2 default preview was about 52 FPS, so its 60 FPS target remains unmet. Pages production build passes; no Actions tests added.
- Local captures/reports: `evidence/road-network-before-*` and `evidence/road-network-after-*`. No new bitmap asset was needed for a route topology correction.

Current good: connected branch roads, continuous river joins, terrain-fitting roots, coherent bank materials and sparse landmark lamps. Current bad: streaming spikes/high memory, missing bridges/fords, distant tree lighting mismatch, repeated grass patches and forest-floor tiling. Next performance priority remains finding the actual long-frame work during streaming; the full 60 FPS objective stays open.

## Root follow-up: bend downhill instead of stretching

The first terrain fit changed only vertex height. Downhill roots therefore gained length as the slope increased. The placed-tree shader now contracts horizontal reach by the local slope before fitting the root to the ground at its new position. On a planar slope the base's radial reach is preserved in 3D. The adjustment fades out at the existing two-metre prototype collar; uphill wood and the upper trunk are unchanged. The full deformation Jacobian updates normals, including the horizontal bend.

- Keeps the same instanced geometry, vertex counts, textures and draw calls. No new per-frame CPU work or per-tree geometry. Root vertices use a second four-texel terrain sample; GPU cost has not been separately benchmarked.
- Browser checks: WebGPU flat, uneven and steep slopes; L0 and transformed L2. WebGL2 steep L0 and transformed L1. No captured shader/runtime errors. The full WebGPU landscape loaded and its slope-root view was inspected (`evidence/root-bend-world.png`).
- `npm run test:tree-surfaces`, `npm run build` and `git diff --check` passed. The slope fixture accepts `slope=flat` and `slope=steep` alongside its default uneven surface.
- This remains an instanced root deformation, not a per-tree growth simulation. L3 whole-tree impostors still use their prototype capture. Terrain mesh approximation at different LODs can still differ from the sampled height field; the checks do not establish contact at every position on the map.

## Selected improvement: repeated world-uniform work

The current CPU profile selected render preparation as the next performance target. Every `ref()` use previously made a separate object-scoped `ReferenceNode` for a value already explicitly bound to a world/bake uniform record. That repeatedly resolved and copied the same daylight, wind time, volume transform and light vectors for each object draw.

`ref()` now caches one live UniformNode per source record/type in a WeakMap and uses Three's shared render group. The value accessor preserves both scalar replacement and in-place/replacement vector updates. Render scope is essential: direction baking changes values between render calls within an animation frame. Per-object fade nodes and texture references are unchanged. No density, geometry, textures, render distances or lighting equations were reduced.

Measured locally in the dev WebGPU scene after the root fix, at the same noon viewpoint:

| Five-second trace | Before | After |
| --- | ---: | ---: |
| Node update calls | 410,658 | 410,658 |
| Node update CPU total | 1,374.3 ms | 897.1 ms |
| Binding update calls | 410,357 | 410,357 |
| Binding update CPU total | 933.2 ms | 768.1 ms |
| Combined node/binding CPU | 2,307.5 ms | 1,665.2 ms |
| Scene draws / reported triangles | 1,332 / 62,018,128 | 1,332 / 62,018,128 |

The combined measured path improved 27.8%. These are instrumented CPU totals, not GPU timings or a claim of 28% higher FPS. The scene was refresh-limited to 60 FPS at this viewpoint.

The same 600m route at 22m/s had 16.7ms median, 16.8ms p95/p99 and 66.6ms maximum before and after. Both had two intervals over 33.4ms; the after run also had additional approximately 33.3ms intervals. An after-run long frame attributed 50.7ms to `animate`, mostly rendering. The change saves steady render CPU time but does **not** establish a streaming-hitch improvement or the minimum-59-FPS requirement. JS heap remained around 2GB; memory is a separate unresolved problem.

Validation:

- `/scripts/uniform-bindings.html?backend=webgpu` and `?backend=webgl2`: real render-target readbacks match the old ReferenceNode path for initial values, scalar changes, vector mutation/replacement, zero/restored power and independent uniform records. Six cases passed on each backend without captured errors.
- The full WebGPU scene loaded, completed the 600m route, and visibly changed from noon to night. Shader preparation reported no errors. Vite hot replacement briefly produced a river-preparation ordering error during editing; a clean page reload completed successfully.
- The full WebGL2 scene also loaded, reported 60 FPS at the default view and no preparation errors, and was visually checked at noon. This is a stationary compatibility check, not a WebGL2 traversal benchmark.
- Existing 14 LOD-handoff checks and 7 grass-streaming checks passed; production build passed. No Actions tests added.
- Evidence: `evidence/uniform-render-before.json`, `uniform-render-after.json`, `uniform-walk-before.json`, `uniform-walk-after.json`, both `uniform-readback-*.json`, and `uniform-world-day.png` / `uniform-world-night.png`.

Current good: cheaper global uniform updates without lost detail, natural root bends, continuous river joins, connected paths and habitat-based vegetation. Current bad: occasional render-thread spikes, high memory, unfinished water crossings, distant tree-lighting mismatch and repeated grass/ground patterns. Next performance investigation should isolate the remaining slow render calls during first traversal, rather than claiming a smooth-60 result from the median.

## Selected improvement: shader preparation across asynchronous stages

The walking trace found repeated 2.5-4.8ms shader-node builds. Stack traces identify `compileAsync` preparation, not synchronous drawing. The old preparation budget charged only the initial call before its first await; subsequent shader stages could run consecutively through scheduler continuations before the browser presented another frame.

The pinned Three 0.186.1 postinstall patch now exposes an optional asynchronous stage-yield hook. Renderer preparation charges each stage's actual CPU time, excluding awaited time, against its existing 2ms interactive budget. When that budget is exhausted it resumes after an animation callback and a task boundary. Synchronous builds, stage order, shader equations, density, geometry, textures, distances and LOD readiness rules are unchanged. The initial stage is not charged twice. An individual stage remains indivisible and can exceed 2ms; this is cooperative scheduling, not a hard real-time guarantee.

Two controlled pairs used the same 600m route at 22m/s in the full WebGPU world. Each run started from a fresh page on the same origin with cached world data; the control disabled only the new stage-budget callback. The trace measured shader CPU accumulated between frame callbacks, not GPU time.

| Measurement | Control 1 / 2 | Budgeted 1 / 2 |
| --- | --- | --- |
| Peak shader CPU between callbacks | 56.3 / 52.3ms | 4.3 / 3.9ms |
| Median frame interval | 16.7 / 16.7ms | 16.7 / 16.7ms |
| p95 / p99 frame interval | 16.8 / 16.8ms both runs | 16.8 / 16.8ms both runs |
| Maximum frame interval | 66.7 / 50.0ms | 33.3 / 33.3ms |
| Intervals above 33.4ms | 1 / 1 | 0 / 0 |

The first pair completed the same 43 tree jobs with zero pending jobs, 85 shader states, 7,138 geometries, 15 detailed tree groups and 696 active grass tiles. Pool timing/total preparation-job counts vary with streaming. The revised scene still reached about 2.37GB JS heap: memory growth remains unresolved. These short instrumented walks establish a reduction in shader bursts, not a guaranteed 59 FPS minimum, an overnight stability result or a general GPU speedup.

Validation:

- The pinned-patch test verifies identical stage order, default behavior without the hook, CPU-only time accounting and awaited backpressure. Existing five allocation checks, 14 LOD-handoff checks and seven grass-streaming checks pass. Production build passes; no tests added to Actions.
- Both WebGPU walks finished without captured runtime/preparation errors. Day and night still render the retained landscape detail.
- WebGL2 also completed the 600m traversal with zero pending preparation jobs and no captured errors. Peak shader CPU between callbacks was 5.2ms, but the maximum frame interval was 66.7ms with three intervals above 33.4ms. This validates compatibility, not a WebGL2 performance win; other stalls remain.
- Local evidence: `evidence/shader-budget-control*.json`, `shader-budget-after*.json`, `shader-budget-world.png` and `shader-budget-night.png`.

Current good: preparation no longer packs many shader stages into one presentation interval, existing LODs remain visible until replacement readiness, and the natural-world assets/settings are retained. Current bad: occasional 33.3ms intervals still miss smooth 60 FPS, memory remains high, and visual work on crossings, distant lighting and grass repetition is still outstanding. Next performance target is long-session residency/retirement rather than more density reduction.

## Selected visual improvement: softer meadow colonies

Visual work is the current priority. The L2 grass bake previously scattered its source plants across a square and chose only the dominant habitat type for each distant colony. The new source layout has an irregular lobed outline, shorter plants at the margins, and independent width/height variation. Distant colonies now sample the same habitat proportions used by the nearby population, blending dry grass, meadow flowers and understory through habitat boundaries. All eight captured views and their normal maps come from the shaped source plants; the silhouette is not a camera-facing runtime mask. Cache identity includes the shape source so existing users receive the revised bakes.

Validation: production build and the existing habitat continuity/worker parity checks pass. The WebGPU world loaded without captured runtime errors and was inspected at the open riverbank and elevated valley views. The nearby flower meadow remains intact. This is a bounded improvement to L2 silhouettes and species mixing, not a complete solution to grass repetition: isolated near-bank tufts still look too uniform, and the distant ground cover remains flatter than the foreground. Local evidence: `evidence/meadow-visual-after.png`.

Current good: dense mixed foreground grasses and flowers, habitat-based placement, irregular baked meadow colonies, connected routes and continuous river joins. Current visual priorities: improve the visible tufts along bare banks, strengthen distant ground-cover texture agreement, reconcile distant tree lighting, then refine river surface/shore transitions and crossings.

An already-completed cleanup in the preceding commit shares identical atlas base pixels with mip level zero. A bounded ownership census found 296,706,332 fewer duplicate CPU buffer bytes; pixels and all mip levels are unchanged. This is retained maintenance, not the focus of the visual pass or a total-memory claim.

## Selected visual improvement: riverbank growth gradient

Following the meadow silhouette pass, the selected issue was full-sized grass tufts isolated on exposed riverbank soil. The existing bank field reduced density but did not reduce the size of the surviving plants. Height and width now taper smoothly toward exposed gravel using that same world-space field. Near crossed cards and L2 baked colonies share the response; the established meadow beyond the bank stays unchanged. This is a procedural growth approximation, not a botanical simulation.

Good: mixed foreground flowers and grasses; coherent meadow/woodland habitats; irregular L2 colonies; connected river surfaces; and now a low shoreline fringe leading into established grass. Still bad: repeated tuft textures remain recognizable; distant ground cover is flatter than the foreground; some distant tree lighting differs; river ripples and crossings still need visual refinement. The next visual choice should address the water's overly uniform bright ripple pattern or distant ground-cover agreement.

Validation:

- Existing habitat and generated-riverbank checks pass (1,459 channel-bank samples). Production build passes.
- An isolated fixed-seed comparison of the bank-growth change, using the same terrain inputs, preserved plant counts, positions and species. Inland plant records were identical in that comparison. The subsequent channel-profile change regenerates terrain and therefore can move vegetation. At 0.1m beyond the nominal shore, mean height changed from 0.785m to 0.173m; at 2m it changed from 0.816m to 0.422m. Height/width return to their inland values smoothly. L2 resizing retains ground contact. Submerged locations still reject grass.
- A close camera comparison at the same noon view shows the isolated large tufts on gravel replaced by smaller growth, with the taller meadow retained upslope. The world was checked in WebGPU; the inspected settled view reports 60 FPS without captured errors. This is a visual/stationary check, not a claim of a 60 FPS minimum throughout traversal.
- Evidence: `evidence/bank-detail-before.png`, `bank-detail-after.png`, and `bank-growth-comparison.json`. No new render passes, bindings or per-frame growth calculations; the size adjustment is part of worker preparation and cached batches.

## Selected visual improvement: eroded banks, reflective water and vegetation shading

The user prioritized water edges/colour, evidence of bank erosion, reflections, grass shadows and bark variety. Channels now use their connected graph's turn direction to deepen outer bends and create steeper cut banks, with shallower shelves on inner bends. The profile joins the floodplain continuously and retains the original ground as its upper bound. Exposed bank grass scales down in height and width instead of leaving isolated full-size plants on gravel.

Water now has a muted green-brown depth response, clearer shallow edges, quieter ripple normals and less persistent white foam. A first terrain/canopy-only reflection looked too uniformly green during inspection. The final implementation uses a half-resolution planar capture for nearby water at the current reach elevation, blending to the cheaper terrain/canopy and sky estimate farther away. The reflection camera is limited to 320m; its distant grass uses baked ground cover beyond 64m plus tile radius. The regular scene retains all existing grass detail. Reflection rendering reuses shadow maps, scratch arrays and the existing visible scene, and does not rebuild water geometry. It is an extra render pass, not a free baked effect.

L0/L1 grass cards now cast alpha-cut shadows, including their existing wind/material masks. Incoming batches prepare shadow materials before publication; recycled hidden groups are included in preparation. Bark uses stronger seeded species palettes, elongated weathering and age-scaled lichen. Existing texture/normal detail, moss response, geometry and HLOD capture paths are retained; this pass does not supply new scanned bark maps.

Validation:

- Production and Pages builds pass. Habitat checks, seven grass-streaming checks and tree surface/seed-colour/merged-colour parity checks pass.
- River profile checks cover 697 actual bends plus synthetic continuity/scour/shelf boundaries. The generated-bank check covers 1,459 samples; the river union check covers 2,807 shared vertices and 28,644 confluence samples. Watershed channel centres and route attachment checks pass.
- The final WebGPU riverbank view reached settled queues with no captured errors and reported 60 FPS at 1280x720. This is a stationary visual check, not a traversal or minimum-FPS guarantee. Nearby grass shadows and bank/vegetation reflections are visible in `evidence/river-final-webgpu.png`; its diagnostic snapshot is alongside it.
- The final WebGL2 view also settled without captured errors and shows the same reflection/shadow result (`evidence/river-final-webgl2.png`). It reported about 41 FPS versus 60 FPS in WebGPU at this view. The extra scene-reflection pass has a material WebGL2 cost; this change does not meet a 59 FPS minimum on both backends.
- The 2m terrain heightfield supports steep ledges but cannot make undercut cliffs or overhangs. This is accumulated-erosion-inspired shaping, not continuous lateral erosion, collapse or sediment simulation. The planar capture fades away across reach elevation differences; distant reflections remain approximate, and reflected objects are limited by scene residency.

Good: bank slope contrast, low shoreline fringe, clearer water edges, actual nearby scene reflections, grounded grass shadows, and more varied bark tints. Still needs visual refinement: gravel texture repetition, broad distant canopy reflection shapes, coarse bank silhouettes at the 2m terrain grid, grass tuft repetition, and some distant tree lighting differences. No tests were added to Actions.

## Repetition and vegetation shadow refinement

The user requested less repeated texture detail and an investigation of overly dark shadows. Inspection found direct sun visibility was multiplied by both the raster shadow and the baked voxel visibility, even when both represented the same trees. The sun now uses the more occluded of those two visibility estimates rather than multiplying them. Separate obstacles still occlude the light; correlated partial canopy occlusion is no longer squared. Cloud attenuation is applied once after this combination.

Daylight sky irradiance in the volume bake is increased from (0.035, 0.055, 0.085) to (0.085, 0.115, 0.16), still modulated by baked sky accessibility and the bent normal. The whole-world fallback uses the same response. This is a calibrated RGB approximation, not a spectral or multi-bounce solver. At zero daylight the old night floor is unchanged. Direct sun intensity and exposure are unchanged. Existing thin-leaf/grass transmission remains separate from opaque wood shading; this change does not implement coloured, multi-layer transmitted shadows.

A bounded contact-hardening sun filter estimates blocker distance with five comparison probes and filters with five PCF samples. Its penumbra uses the solar angular radius: close grass contact remains tight, while elevated canopy shadows spread more. The distance estimate is a centre-ray approximation (64m search bound), not the full area blocker search used by high-sample PCSS. The comparison-only formulation avoids mixing raw/comparison depth samplers in Three's WebGPU/WebGL2 bindings. It reuses the existing shadow map and adds no render pass or texture binding, but does add shader samples.

Ground soil, gravel, fine meadow detail and the four-metre baked canopy/litter surface now blend two offset samples selected by a continuous, irregular world-space phase. The phase endpoints share samples, avoiding square tile boundaries. Albedo and normals use the same offsets, with unwrapped UV gradients for correct mip selection across atlas seams. The existing habitat colour field and far-cover means remain in use. This is a lightweight offset blend, not full histogram-preserving texture synthesis. Grass cards also mirror deterministically by plant height, with the normal's horizontal component mirrored too. Height stays stable through L0/L1 thinning and wrapped source copies; capture materials use the same UVs. Grass surface cache revisions invalidate old captures.

Research informing the changes:

- [NVIDIA: Percentage-Closer Soft Shadows](https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf): contact sharpness and penumbra width depend on caster/receiver separation and light size. A tree shadow is not intrinsically softer everywhere than a grass shadow; its crown is generally farther from the receiving ground.
- [GPU Gems 3: Next-Generation SpeedTree Rendering, section 4.4](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-4-next-generation-speedtree-rendering): thin leaves have different reflected and transmitted lighting, and card normals need care.
- [GPU Gems 2: Dynamic Ambient Occlusion and Indirect Lighting](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-14-dynamic-ambient-occlusion-and): environmental accessibility and indirect light are distinct from the direct-sun shadow term.
- [JCGT: Histogram-Preserving Blending for Randomized Texture Tiling](https://jcgt.org/published/0008/04/02/): repeated samples can be randomized, but blending affects contrast. The implementation here uses a smaller two-sample blend and retains source detail/mipmaps rather than claiming that full method.

Validation: habitat continuity/worker parity, all seven grass-streaming checks, and tree surface/seed-colour/merged-colour parity pass. The corrected shaders rendered without new errors in both WebGPU and WebGL2, with streaming/preparation queues settled. The same 1280x720 riverbank view reported 60 FPS on WebGPU and 39 FPS on WebGL2 (previous pass about 41); this is a stationary visual check, not a performance guarantee. Night was inspected separately. Local evidence: `evidence/texture-shadows-webgpu.png`, `texture-shadows-webgl2.png` and their diagnostic JSON, `texture-bank-detail.png`, and `texture-shadows-night.png`.

Good: the gravel/soil and far-cover repeats no longer align on a regular grid; normal detail and mipmaps remain; partial visibility is not double-darkened; canopy shadow softness responds to height. Remaining: recognisable grass tuft silhouettes from the source atlas, approximate distant lighting, and no physically layered coloured transmission through foliage. Broader source-plant variety is still useful. No tests were added to Actions.

## More distinct grass source plants

Added two generated transparent source images: an open upright seed grass and a low, spreading grass with asymmetric arching blades. They occupy the two unused cells in the existing 4096 x 3072 colour/normal atlas. The 12-source palette still uses one instanced material for near grass, the existing four habitat captures for L2 and distant cover, and the same material-profile lookup for voxel occupancy/colour. Source downloads add approximately 2.67 MB; normal/mipmap source caching and initial preparation also increase, while the packed atlas dimensions and population count stay the same.

Meadow and dry-ground mixtures replace some of the dominant rounded tufts with the new plants. Flowers, ferns, bracken and woodland litter retain their existing roles. The upright grass is 0.55-1.2m before habitat scaling; spreading grass is 0.26-0.62m tall and 0.85-1.45m wide. Bank growth, canopy suppression, colour gradients, wind, alpha shadows, LOD fading and deterministic mirroring remain in the shared path. Asset/catalog hashes invalidate the old captures automatically. Full prompts and provenance are recorded in `docs/grass-assets.md`.

Validation: habitat mixture normalization and both new plants reaching deterministic generation pass, along with all seven grass-streaming checks and tree surface checks. WebGPU and WebGL2 both loaded and baked the new sources without captured errors. Settled matching riverbank views have no pending grass jobs and preserve cutout silhouettes. Browser diagnostics confirm 12 palette sources, a 4096 x 3072 atlas with 11 mip levels, and both source normals at 1254 x 1254. Evidence: evidence/grass-variety-webgpu.png and evidence/grass-variety-webgl2.png, with diagnostic JSON alongside. Existing rounded tufts still appear intentionally; this adds two different growth habits rather than removing all repeated source silhouettes. No tests added to Actions.

## Restore grass coverage after sparse-source regression

The v9 palette replaced 42.5% of meadow candidates with new sparse silhouettes. Source alpha coverage measured at the atlas cutoff is 9.3% for upright grass and 18.2% for spreading grass, versus 60.2% for meadow-long. Equal instance count did not preserve visible coverage. The prior screenshot and successful render checks missed this visual regression.

V10 restores the original ten-source distributions and uses a separate seeded pass for the two additional types (25% more candidate plants). Original placement, sizes, colours and random sequence are retained. New upright blades are 0.85–1.45m tall and 0.7–1.1m wide; spreading grass is 0.45–0.85m tall and 1.05–1.65m wide before habitat scaling. Near geometry, L2 capture and far ground capture share this two-pass population. The normalized combined mix still drives distant colour. The revision invalidates old captures.

The fixed regression sample retains all 3,168 pre-v9 plants with a matching quantized position/type/size/colour fingerprint and adds 768 accent plants. The golden fixture was obtained from commit 8014756. Habitat and all seven streaming tests pass. This deliberately increases near-instance buffer and fragment/overdraw cost, without adding atlas pixels, texture bindings or material groups. Density is restored rather than claimed free. Corrected same-camera evidence: evidence/grass-coverage-restored-webgpu.png and corresponding diagnostic JSON.

WebGPU and WebGL2 both rendered the corrected matching view without captured errors; grass queued/active counts settled to zero. Evidence also saved as evidence/grass-coverage-restored-webgl2.png and JSON. WebGPU reported 60 FPS in this stationary check. Both normal build and Pages build passed; no tests added to Actions.

## Grass tuft shadow reception

The user identified dark vertical bands on the restored dense grass. A same-camera diagnostic with only `userData.grassCard` casters disabled removed the bands while retaining tree shadows: the dominant error was raster self-shadowing between the intersecting alpha cards. Source normals already represent upward-biased blades, and Three r186's `normalWorld` uses the material shading normal; no extra normal replacement was needed.

Near grass now receives raster shadows at an upper-envelope proxy: the world-space height of each instance lifts the receiver by `height * (1 - uv.y) * 0.95 + 0.06m`. The receiver follows the actual wind-deformed world position and each plant's scale. Grass continues to cast its original alpha-tested shadows onto terrain. A smooth ambient occlusion term goes from 0.8 near the roots to 1 above 70% of the card, providing modest root grounding without the directional intersection seam. Neither sunlight/exposure nor source albedo is globally brightened. Population, atlas size, and shadow passes are unchanged.

This is an artistic foliage-volume approximation, not ray-traced individual blades. Nearby low blockers can be less influential at the lifted receiver, and coarse voxel occlusion remains approximate. Trees and overhead occluders still affect the proxy and baked visibility. L2/ground captures are unlit albedo plus represented normals and do not bake these raster bands, so their caches do not need invalidation.

Reference: [AMD GPUOpen procedural grass rendering, pixel shader](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/#pixel-shader) uses controlled root darkening to approximate grass self-occlusion. The upper-envelope receiver here is our project-specific adaptation for crossed cards, not an implementation attributed to that article.

Validation: same-camera WebGPU and WebGL2 screenshots show the vertical bands removed while grass ground shadows and tree shade remain. Captured errors are empty and streaming queues settled. Morning and night views were also inspected; night remains dark. WebGPU reported 60 FPS in the stationary scene. Evidence: evidence/grass-tuft-shadows-webgpu.png, grass-tuft-shadows-webgl2.png, grass-tuft-shadows-morning.png, grass-tuft-shadows-night.png and backend diagnostic JSON. Habitat regression and all seven streaming tests pass. No additional render pass, sampler, texture or per-frame JS work; no Actions tests added.
