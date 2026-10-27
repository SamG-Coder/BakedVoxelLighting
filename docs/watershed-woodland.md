# Watershed and woodland generation

The playable world remains 4 x 4 km. A deterministic 5.12 km regional heightfield supplies drainage and the surrounding horizon. This is a procedural landscape approximation, not a calibrated geological or vegetation simulation.

## Generation order

1. Construct connected valley sides and uplands on a 257 x 257 regional grid.
2. Resolve drainage using a priority flood. Each interior cell has a downhill receiver; accumulation gives upstream catchment area.
3. Apply five stream-power-inspired incision passes, re-routing between passes.
4. Extract connected channels above an area threshold, widen reaches with catchment area and smooth their coordinates without breaking graph connections.
5. Generate the playable 2001 x 2001 heightfield, run the existing droplet and thermal erosion, carve all channels, and calculate moisture, slope and traffic paths.
6. Generate coherent forest habitat, then use age-dependent spacing, species communities, canopy gaps and mortality to place trees and deadwood.
7. Use the same moisture/canopy fields for understory species and ground-cover baking.

The full-resolution erosion and path pass runs in `terrain-generation-worker.js`. Its buffers transfer to the main thread, then the worker terminates. The compact watershed graph and 8m nearest-channel index are deterministic in each preparation worker. Runtime placement checks four indexed channel candidates rather than scanning every river segment. Habitat distances remain finite so grass tile interpolation cannot create NaNs away from rivers.

## Rendering and assets

- Water reaches are combined into 125m spatial pages. Their positions, width and scrolling phase share graph endpoints.
- River terrain retains the existing full-resolution surface, but uses one resident mesh instead of three identical LOD copies.
- The surrounding horizon uses world-tiled materials because the playable ground-cover lookup is only valid inside the 4km square.
- Fern, bracken and wild strawberry join the existing shared plant material. Placement exchanges species weights without increasing grass instance budgets.
- Shaded forest-floor bakes use generated leaf litter. Exposed slope texture uses generated scree; existing boulder material stays separate.
- The plant atlas now uses a 4-column grid. Each plant retains 1024 x 1024 pixels; the ten-species atlas is 4096 x 3072. Species are filtered separately before folding the mip levels, preventing cross-species colour bleed.
- Existing browser normal-map derivation, coverage-preserving mipmaps, grass patch impostors, far ground-cover bakes and voxel material profiles consume the new sources. Derived normals are luminance approximations, not scanned surface geometry.
- New generator, material and plant revisions invalidate incompatible cached bakes automatically.

## Deterministic seed measurements

`node scripts/verify-watershed.mjs` reports 1,929 regional channel segments, 36 junctions and 36.13 km of rendered channels inside the playable square. All 1,528 tested interior channel centres are submerged (minimum measured centre depth 0.617m). Water uses 328 pages / 305,519 triangles.

The generated population contains 146,815 trees and 1,861 fallen-wood records. One-hectare cells range from 0 to 217 trees, with 91.76 trees/ha averaged across the entire map including open ground. These are generated tree counts, not a field inventory calibrated to a diameter threshold. The age/diameter metadata is approximate. The earlier 300-600 stems/ha research target has not been imposed on every dense stand; that would require more small regeneration stems and further performance validation.

## Validation

Run locally:

- `node scripts/verify-watershed.mjs`
- `node scripts/verify-river.mjs`
- `node scripts/landscape-data.mjs`
- `node scripts/verify-habitats.mjs`
- `node scripts/verify-plant-grid.mjs`
- `node scripts/verify-voxel-index.mjs`
- `node scripts/verify-grass-streaming.mjs`
- `npm run build:pages`

No tests were added to GitHub Actions. Browser checks cover both graphics backends separately. A stationary FPS reading does not establish a minimum frame rate during traversal; cold bakes and viewpoint jumps still need distinct performance interpretation.

## Limits and subsequent refinements

This pass does not simulate long-term lateral river migration, bank collapse, flood deposition, lakes or soil chemistry. Roads use the existing slope/moisture cost routing, not a settlement history model. The regional horizon is terrain only and does not extend the playable forest population. River confluences share graph data, but their overlapping strips are not a watertight triangulated river network. These are explicit follow-on refinements rather than claims made for this implementation.

## Research basis

- Hydrology-driven terrain: https://doi.org/10.1145/2461912.2461996
- Stream-power-inspired terrain evolution: https://onlinelibrary.wiley.com/doi/10.1111/cgf.12820
- Priority-Flood reference: https://github.com/r-barnes/Barnes2013-Depressions
- Forest structure and diameter-threshold context: https://www.wsl.ch/en/publications/inventory-of-the-largest-primeval-beech-forest-in-europe/
- Understory light: https://nph.onlinelibrary.wiley.com/doi/10.1111/nph.17803
- Plant distribution modelling: https://graphics.stanford.edu/papers/ecosys/
