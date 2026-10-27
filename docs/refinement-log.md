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
3. **River geometry is still an approximation.** Tight confluences overlap strips; later work should triangulate junctions and add erosion/deposition detail.
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
