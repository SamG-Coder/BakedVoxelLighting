# Natural-world refinement log

This is a working good/bad list, updated from rendered checks and measurements. A stationary 60 FPS reading is not an acceptance test for streaming. Target: natural appearance at the existing quality settings with smooth 60 FPS traversal.

## Good

- Connected downhill drainage replaces the former single sinusoidal river.
- Tributaries, terrain carving, wetness and planting exclusions share the same graph.
- Larger forest regions include canopy gaps, mixed ages, species communities and fallen wood.
- Five new assets are integrated: fern, bracken, wild strawberry, woodland litter and scree.
- The ten-species plant palette retains 1024px per species and isolated mip filtering in a 4096 x 3072 atlas.
- WebGPU and WebGL2 both reached ready and rendered without captured shader errors in the browser checks.
- Existing HLOD handoff and grass streaming unit checks continue to pass.

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
