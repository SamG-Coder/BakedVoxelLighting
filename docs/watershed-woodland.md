# Watershed and woodland generation

The playable world remains 4 x 4 km. A deterministic 5.12 km regional heightfield supplies drainage and the surrounding horizon. This is a procedural landscape approximation, not a calibrated geological or vegetation simulation.

## Generation order

1. Construct connected valley sides and uplands on a 257 x 257 regional grid.
2. Resolve drainage using a priority flood. Each interior cell has a downhill receiver; accumulation gives upstream catchment area.
3. Apply five stream-power-inspired incision passes, re-routing between passes.
4. Extract connected channels above an area threshold, widen reaches with catchment area and smooth their coordinates without breaking graph connections.
5. Generate the playable 2001 x 2001 heightfield, run the existing droplet and thermal erosion, carve all channels, and calculate moisture, slope and traffic paths. Side paths project their origins onto the generated main road before slope-cost routing; exact attachment points survive grid snapping and smoothing.
6. Generate coherent forest habitat, then use age-dependent spacing, species communities, canopy gaps and mortality to place trees and deadwood.
7. Use the same moisture/canopy fields for understory species and ground-cover baking.

The full-resolution erosion and path pass runs in `terrain-generation-worker.js`. Its buffers transfer to the main thread, then the worker terminates. The compact watershed graph and 8m nearest-channel index are deterministic in each preparation worker. Runtime placement checks four indexed channel candidates rather than scanning every river segment. Habitat distances remain finite so grass tile interpolation cannot create NaNs away from rivers.

## Rendering and assets

- Water uses a single clipped 2m lattice, divided into 126m spatial pages. Each wet point belongs to one surface, including confluences. Compact local reach weights blend water elevation and flow; page-edge values are identical. Ripples use world coordinates and the interpolated downstream flow instead of independent strip UVs.
- The terrain worker builds water geometry against the eroded channel bed and transfers typed buffers with the heightfield. The main thread attaches those arrays directly to geometry attributes. No water mesh generation or flow-field lookup occurs during walking.
- River terrain retains the existing full-resolution surface, but uses one resident mesh instead of three identical LOD copies.
- The surrounding horizon uses world-tiled materials because the playable ground-cover lookup is only valid inside the 4km square.
- Fern, bracken and wild strawberry join the existing shared plant material. Placement exchanges species weights without increasing grass instance budgets.
- Shaded forest-floor bakes use generated leaf litter. Exposed slope texture uses generated scree; existing boulder material stays separate.
- The plant atlas now uses a 4-column grid. Each plant retains 1024 x 1024 pixels; the ten-species atlas is 4096 x 3072. Species are filtered separately before folding the mip levels, preventing cross-species colour bleed.
- Existing browser normal-map derivation, coverage-preserving mipmaps, grass patch impostors, far ground-cover bakes and voxel material profiles consume the new sources. Derived normals are luminance approximations, not scanned surface geometry.
- Riverbank exposure and gravel patches are baked into the existing ground influence texture. The same exposure function suppresses near, middle and distant grass, and the ground shader retains the soil/gravel margin beyond geometry distance. Inland populations are unchanged.
- New generator, material and plant revisions invalidate incompatible cached bakes automatically.

## Deterministic seed measurements

`node scripts/verify-watershed.mjs` reports 1,929 regional channel segments and 36 junctions. All 1,528 tested interior channel centres are submerged (minimum measured centre depth 0.617m). The continuous water surface uses 350 pages / 185,206 triangles and 8,655,192 bytes of vertex/index buffers, versus 328 pages / 305,519 triangles / 12,575,076 bytes for the overlapping strips. Page count increases slightly because clipping and culling use a regular spatial lattice. Reaches crossing the playable boundary are now included and their surface is clipped at the boundary.

The generated population contains 146,590 trees and 1,827 fallen-wood records after connecting the branch roads. One-hectare cells range from 0 to 217 trees, with 91.62 trees/ha averaged across the entire map including open ground. These are generated tree counts, not a field inventory calibrated to a diameter threshold. The age/diameter metadata is approximate. The earlier 300-600 stems/ha research target has not been imposed on every dense stand; that would require more small regeneration stems and further performance validation.

## Validation

Run locally:

- `node scripts/verify-route-network.mjs`
- `node scripts/verify-road-torches.mjs`
- `node scripts/verify-watershed.mjs`
- `node scripts/verify-river.mjs`
- `node scripts/verify-river-union.mjs`
- `node scripts/verify-riverbanks.mjs`
- `node scripts/landscape-data.mjs`
- `node scripts/verify-habitats.mjs`
- `node scripts/verify-plant-grid.mjs`
- `node scripts/verify-voxel-index.mjs`
- `node scripts/verify-grass-streaming.mjs`
- `npm run build:pages`

No tests were added to GitHub Actions. Browser checks cover both graphics backends separately. A stationary FPS reading does not establish a minimum frame rate during traversal; cold bakes and viewpoint jumps still need distinct performance interpretation.

## Limits and subsequent refinements

This pass does not simulate long-term lateral river migration, bank collapse, flood deposition, lakes or soil chemistry. Roads use the existing slope/moisture cost routing, not a settlement history model. The regional horizon is terrain only and does not extend the playable forest population. Water is now a continuous height-field surface, but it cannot represent stacked water, waterfalls or overhangs. It retains the existing baked sky/cloud reflection estimate; screen-space scene reflections have not been added. Branch roads now connect to the main road. Deliberate bridges or fords remain follow-on work at existing water crossings.

## Research basis

- Hydrology-driven terrain: https://doi.org/10.1145/2461912.2461996
- Stream-power-inspired terrain evolution: https://onlinelibrary.wiley.com/doi/10.1111/cgf.12820
- Priority-Flood reference: https://github.com/r-barnes/Barnes2013-Depressions
- Forest structure and diameter-threshold context: https://www.wsl.ch/en/publications/inventory-of-the-largest-primeval-beech-forest-in-europe/
- Understory light: https://nph.onlinelibrary.wiley.com/doi/10.1111/nph.17803
- Plant distribution modelling: https://graphics.stanford.edu/papers/ecosys/
