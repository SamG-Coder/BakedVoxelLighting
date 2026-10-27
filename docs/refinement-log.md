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
2. **Riverbank transitions are too uniform.** The water edge needs an irregular wet soil / gravel / vegetation transition, with shared near/far coverage.
3. **River geometry is still an approximation.** Tight confluences overlap strips; later work should triangulate junctions and add erosion/deposition detail.
4. **Forest ground can still repeat.** New understory species help, but fallen leaves, decayed wood, moss and bare patches need more spatial variation.
5. **Distant terrain needs scrutiny.** The surrounding ring must avoid clamped voxel/ground lookup stripes and blend its material with the playable region.
6. **Density is not yet a field-calibrated forest inventory.** Generated one-hectare counts peak at 217 trees; small regeneration stems and diameter distributions need further calibration.

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

## Iteration rule

Choose one item, record a before result, implement it, compare the same view/route and retain it only if its intended improvement is supported. Keep quality settings unchanged. Record remaining regressions instead of claiming the global 60 FPS goal from a local success.
