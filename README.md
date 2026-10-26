# BakedVoxelLighting

A desktop Three.js woodland prototype with browser GPU baking, IndexedDB persistence, live lighting updates, and four tree and grass distance levels.

**[Try the live world](https://samg-coder.github.io/BakedVoxelLighting/)** · [Source on GitHub](https://github.com/SamG-Coder/BakedVoxelLighting) · [Deployment status](https://github.com/SamG-Coder/BakedVoxelLighting/actions/workflows/pages.yml)

Use a desktop browser with hardware acceleration enabled. The first visit downloads
the textures and bakes the world on your GPU; leave the tab open until the Bake
Studio says ready. Later visits reuse bakes from IndexedDB. WebGPU is selected
when available; WebGL2 is also available in the graphics backend selector. This
is an experimental desktop demo, and initial loading and streaming can take time.

## Run

```powershell
git clone https://github.com/SamG-Coder/BakedVoxelLighting.git
cd BakedVoxelLighting
npm ci
npm run dev -- --port 5173
```

Open http://127.0.0.1:5173. Drag to orbit; scroll to travel. Explore world enables mouse look and WASD, with Shift for faster walking and Escape to release the pointer. Next viewpoint cycles cameras. The landing-page dark gradient is removed while exploring so the scene lighting remains visible. Tree and grass controls can force levels for inspection. The sun slider updates lighting; the moving-light checkbox animates a point light. Bake & cache world saves the current sun/volume configuration. Clear cache removes this application's stored bakes.

## World and vegetation

The deterministic 4,000 x 4,000 m world (16 km²) uses a 2001-square terrain grid, 42,000 erosion droplets, sediment deposition, thermal relaxation, and slope-aware routes. Moisture, slope and foot traffic drive meadow, dry grass, rock and soil blending. It contains 56,287 trees in 1,024 spatial batches, twelve tree prototypes across oak/birch/ash/pine, distinct hazel/bramble/elder shrubs, clustered rocks, and 27,556 grass patch locations. Nearby grass geometry is generated lazily and released beyond the active region.

Woodland stands share a static habitat field with meadow patches and regeneration gaps. Tree species and age determine a composited canopy field: closed canopy suppresses tall meadow grass and blends in baked leaf litter and low plants; gaps and edges support flowers and taller vegetation. Moisture and continuous world-coordinate patch noise produce green-to-straw colour gradients and growth direction across grass tile boundaries. The same four habitat mixtures drive near plants, patch impostors, and mipmapped terrain captures. These are ecological art rules, not a calibrated ecosystem simulation.

Young, crowded, and mature trees have different crown proportions. Hazel, bramble, and elder placement responds to canopy edges, moisture, and clearings while retaining their distinct branch structures. Fallen trunks replace selected mature tree placements, with stumps and attached branch stubs; 1,126 logs pass terrain, road, and river placement checks in the current seed. Their geometry is instanced per spatial cluster, with reduced distant geometry and prepared LOD handoffs. Indexed source segments contribute to voxel occlusion regardless of render visibility. Leaf litter is baked into the ground surface rather than submitted as individual leaves each frame.

Run `npm run test:habitats` for local checks of patch continuity, canopy suppression, worker sampling, colour gradients, and deadwood placement/voxelization. These checks are not added to Actions.

Main trunks and larger branches use a smooth implicit union with shared mesh vertices at their junctions. Roots are lobed buttresses in that trunk surface. Fine twigs retain tapered tubes with curved collars, blended normals and parent-aligned bark UVs. Prototype surfaces are generated in a worker and cached in IndexedDB, with a coarser union mesh for reduced LODs. Seeded bark UV offsets, baked moss/lichen vertex colour, crown colour patches, and per-tree tints are preserved in high-detail geometry, captured HLODs, merged distance batches, and voxel colour. Grass uses broad world-coordinate green-to-straw gradients that remain visible in the ground-only LOD. A shared irregular root field scales with tree size, raises the soil by up to 12 cm, blends exposed soil into surrounding grass and suppresses grass placements, including grass impostors. Ground and grass use the same field so a soil patch is not covered by the old grass distribution. This is an artistic root-zone approximation, not a biological root simulation.

| Level | Trees | Grass |
|---|---|---|
| L0 | Below 85 m: detailed branch tubes and foliage cards | Below 38 m: seven grass/flower types in one atlas batch |
| L1 | 85-190 m: fewer branch ring sides, same branch skeleton and foliage positions | 38-82 m: reduced density of the same source population |
| L2 | 190-420 m: simplified actual branches plus 16-view canopy captures from the high-detail source | 82-155 m: four shared 8-view patch captures |
| L3 | Beyond 420 m: 8-view full-tree captures, each anchored at its original terrain position | Beyond 155 m: baked grass canopy colour and normals blended into terrain |

Distances use spatial batch centres. Complementary screen-door fades overlap adjacent levels over 14/26/45 m for trees and 8/13/22 m for grass. Far trees are batched spatially but retain their individual transforms: rotating a whole cluster billboard would incorrectly shift their ground contacts on slopes. Atlas minification uses mip filtering. Rendering uses 4-sample multisampling where supported. There is no fog.

## Layered meadow and connected plant growth

Seven grass and flower types have different widths and heights, from short clover
through long curved blades and tall seed heads, with yellow/white and purple flower
patches. Habitat fields control their mixtures, colour, density and wind direction.
The deterministic test samples heights from about 0.16 to 1.82 m. Close grass uses
bent crossed cards with camera-independent lighting normals. One shared atlas
keeps each near grass block to one material batch.

Oak has spreading limbs, birch a slender leader and drooping ends, ash opposing
branching, and pine whorled boughs. Tapered secondary and terminal branches attach
along their parent paths; foliage attaches along twigs. Three age groups share
those rules. Hazel grows from multiple basal stems, bramble spreads along low
arching canes, and elder forms a denser multi-stem shrub. They have their own
source geometry and far captures rather than using scaled-down tree prototypes.

The distant meadow blends three seamless four-metre canopy tiles into terrain.
Each 512-square colour/normal tile is rendered from the same grass cards, with
wrapped edge copies and ground beneath. A 1024-square habitat/coverage field
selects the mixtures and source mip averages maintain colour at distance.
Explicit mipmaps retain detail and normals through minification. Last-level
patches settle toward the ground as the terrain blend takes over. Tree roots,
roads, water and rock exclusions still affect both placements and terrain.

The live texture binding was also corrected: sampled node clones previously
retained the grey placeholder after a bake replaced the texture. A GPU regression
check swaps a sampled texture after its first draw and verifies the new pixel.

Local checks: `node scripts/verify-vegetation-data.mjs` validates connected tapered
branches, distinct growth forms and deterministic grass mixtures. With Vite
running, `node scripts/verify-meadow-clouds.mjs webgpu` (or `webgl2`) checks the
live binding, canopy tile coverage/detail, mip chains and cloud bake reuse,
then captures close/distant meadow and sky views. `verify-cloud-volume.mjs` checks
packed-height continuity and compares a complete sky bake against the incremental
update; both backends produced identical pixels in that check. Performance remains dependent
on visible geometry, shader preparation and streaming; these checks do not certify
180 Hz presentation or photographic fidelity.

## Lighting and persistence

Three.js manages scene objects, instancing and rendering. Direct GLSL/WGSL render passes run on the selected WebGPU or WebGL2 backend. They combine terrain and trunks with partial-coverage proxies for grass, leaf clusters, shrubs, rocks, branches and water, then trace approximate sky/bounce radiance and directional visibility. CPU code assembles the detail proxies; GPU passes bake occupancy and transport. The default local light volume is 96 x 48 x 96 over 256 x 64 x 256 m, repositioned as the camera travels. Other resolutions are selectable.

Live materials sample RGB indirect light and scalar sun visibility. Direct point lights and shadows update each frame; the moving light refreshes the GPU volume about every 180 ms. Grass and leaves include an approximate thin-leaf backlighting contribution. Tree and grass captures store unlit colour and normals and are relit at runtime. This avoids rebaking their colour atlases whenever the sun moves.

Initial GPU results are read asynchronously and stored in IndexedDB. SHA-256 identities include texture contents and relevant generator/shader sources. Live light updates stay on the GPU and do not add cache entries per frame. A cold default bake creates 82 main-cache records: 21 source mip chains, 21 normal maps, the packed grass atlas, occupancy/transport/radiance, 24 tree atlases, 3 grass atlases, 3 shrub atlases, 3 canopy captures plus their combined ground atlas, a habitat/coverage field, and cloud density. Origin, settings or source changes invalidate relevant entries. Old configurations remain until cleared; automatic eviction is not implemented.

## Assets

There are 21 generated base-colour PNGs in public/textures. The latest eight add long meadow grass, mature seed grass, yellow/white flowers, purple flowers, hazel, bramble, pine and fine meadow ground. Prompts and saved filenames are recorded in [docs/vegetation-texture-prompts.md](docs/vegetation-texture-prompts.md). Source images are actually **1254 x 1254**, despite 2048 being requested. Normal maps are browser GPU finite differences of source luminance, not scanned high-poly normals. Texture tiling is not guaranteed mathematically seamless.

## Reference

D:\KingdomComeGlueMapper was inspected read-only, particularly tools/voxel_lighting.py, voxel_raster_cuda.cu, vegetation_gi.py, setup_bake_cache.py and world_lighting.py. The browser implementation adopts separate occupancy/light channels, partially opaque vegetation and source-aware cache identities. No KCD textures, native SVO payloads or CUDA/OptiX binaries are used.

## Verification and limits

With the dev server running, use `npm test` and `npm run build`. The Playwright suite uses installed Edge and checks cold/warm cache reuse, colour/normal capture coverage, all four levels, complementary fades, live GPU light changes, cache stability during animation, source-independent sun updates, resolution changes, root-mask falloff, erosion conservation and cache clearing. Screenshots and results are written to evidence/.

This remains a prototype. Voxel occupancy uses coarse proxies, not alpha-aware triangle voxelization; individual grass blades and rocks do not occlude that field. Lighting is approximate RGBA8 radiance, not a converged path trace. Impostors have discrete azimuth views, no depth reprojection or elevation views, and freeze captured foliage motion. Shared grass variants still repeat. The terrain grid is 2 m, so root mounds are subtle interpolated features. Mobile work and 3D block merges are deferred.


## Landscape distribution and distant terrain

Woodland density is controlled at two scales: broad habitat suitability and smaller 12-34 m clumps. Slope and upland exposure reduce suitability; river-side moisture modifies it. A 3.3 m minimum trunk spacing prevents overlapping stems. Stand composition varies with habitat. Sparse isolated trees remain outside the dense cores. This is a deterministic ecological approximation, not a simulation of seed dispersal, succession, fire or competition through time.

The river has one continuous meandering channel and a monotonically descending water profile. The terrain is carved to that profile after erosion, with a blended bank/floodplain. This is a prescribed drainage corridor, not a hydrological network generated from flow accumulation.

Water follows that channel downhill with two blended scrolling phases, slower shallow-bank flow, small surface displacement, broken shoreline foam, depth-dependent colour/transparency, and Fresnel sky/cloud reflections. Its native WGSL and GLSL shaders share the same inputs. A 256-square ripple/foam field is baked on the selected GPU backend, cached in IndexedDB and uploaded through the existing page queue with mipmaps. Channel direction, depth and speed are prepared once into mesh attributes; animation uses the existing time uniform and requires no per-frame CPU simulation or geometry uploads. The 4 km river is split into 63 independently culled sections (72,000 triangles in total) sharing one material and texture. Adjacent sections share identical boundary attributes. Direct sunlight and cloud/voxel shadows use the world lighting system. Reflections use the baked sky, not reflected scene geometry; this is an animated surface approximation rather than a fluid solver.

Choose the river stop with **Next viewpoint**, or open the [river view](https://samg-coder.github.io/BakedVoxelLighting/?view=river). `node scripts/verify-river.mjs` checks downhill flow, upward triangle winding and seamless section boundaries locally; it is not added to Actions.

Terrain is divided into 1,024 tiles, each with 48, 12 and 4 subdivisions per side. Distance chooses the mesh at 260 and 850 m. All levels sample the same eroded and river-carved height data; vertical skirts conceal resolution joins. River-intersecting tiles retain fine subdivisions at distance so the narrow channel does not disappear in coarse triangles. The camera can see across the full map without fog. Terrain changes levels discretely; vegetation retains its existing fades. No invented mountains are added beyond the 4 km boundary.

Dirt repeats at 1.25 m, meadow at approximately 1.39 m, and rock at 2.5 m, independently of map size. Ground normal sampling also uses world coordinates. Nearby grass uses 3,900 candidate roots per 24 m patch, with traffic, water and root exclusions retained. Far grass uses 190 candidate patch impostors. Forest cores are denser while exposed uplands remain more open.

Research informing the spatial rules: [US Forest Service: individuals, clumps and openings](https://research.fs.usda.gov/treesearch/54887) and [National Park Service: soils and moisture in riparian communities](https://www.nps.gov/pohe/learn/nature/gorge-riparian-comm.htm). These sources describe particular ecosystems; their exact species or densities are not presented as universal targets for this woodland.

`node scripts/landscape-data.mjs` verifies dimensions, density variation, river exclusion and river-bed coverage, writing evidence/landscape-data.json. The browser suite captures an overview and river corridor. Forced detailed tree levels are capped beyond 650 m to keep a diagnostic selection from expanding full-detail geometry across all 16 km².


Frustum culling uses Three.js mesh bounding volumes. Terrain is culled per tile and vegetation per instanced batch, not per plant. There is no hierarchical occlusion culling: terrain-hidden batches can still be submitted. Very distant empty grass groups are skipped before scene traversal. This prototype does not yet maintain a GPU per-instance visibility list.


## Visibility-triggered merged mesh baking

Far-tree L3 batches now merge all twelve prototype variants into one indexed mesh per spatial cluster. A shared colour/normal atlas packs the source prototype captures into twelve rows. Every tree keeps its own centre, yaw, scale and camera-facing quad; this is merged geometry, not one flat image of a whole forest. Nearer tree levels keep their existing meshes and transitions.

At startup, active far-distance clusters are prepared around the camera in all directions, preventing a turn from revealing hundreds of unprepared draws. Subsequent updates queue clusters whose far level is active and whose conservative bounds intersect the camera frustum. The nearest eligible cluster is processed first, with at most one asynchronous cache/bake job in flight. Existing L3 geometry stays in place until replacement is ready. Camera turns can request new clusters; previously invisible geometry is not permanently discarded. Frustum checks include an allowance for shader-rotated quad corners.

Merged typed-array geometry is persisted in the BakedVoxelLightingMerged IndexedDB database using source identity and cluster ID. The project cache button clears both databases. This is a CPU geometry assembly bake using browser-generated GPU surface atlases; it is not a GPU mesh simplifier. It does not implement hill/occluder visibility, per-tree culling, or merged near-detail branches. Sun changes relight the shared materials without rebuilding merged geometry.

The footer reports merged versus visible far clusters. Detailed counts are available at worldDiagnostics.mergedVisibility. `npm run test:merged` checks single-mesh replacement, untouched unrequested clusters, cache restoration and camera-turn continuation; evidence is written to evidence/merged-visibility.json. Ordinary regression checks remain available with `npm test`.


## Variable-refresh frame timing

Rendering uses one continuous requestAnimationFrame chain with no application 60 FPS cap. Hidden tabs cancel that chain; returning starts one chain and resets timing. Baking pauses reset the FPS window, avoiding misleading low readings that include time when no frames were rendered. The FPS tooltip reports callback interval and CPU submission time; neither is a measurement of panel refresh or GPU completion.

Orbit damping is normalized by elapsed seconds against the original 60 Hz feel. Walking, wind and moving lights remain time based. `npm run test:frames` tests synthetic 60/180/90/60 Hz changes, pause/resume and damping equivalence, then records idle and pointer-motion browser timing in evidence/frame-timing.json. The headless browser test cannot verify the user's physical 180 Hz/DRR display. Windows/browser scheduling can change callback cadence during input; the page does not force the display refresh mode.


Terrain uses FrontSide back-face culling, including outward-wound edge skirts. Orbit and walking cameras stay above both the source heightfield and the actual near-tile triangle surface, with 1.85 m clearance. Thin foliage remains double-sided deliberately. `npm run test:terrain-faces` verifies downward terrain hits, rejection from below, and recovery from an underground camera position.


## Direct GLSL/WGSL rendering and baking

The Bake Studio graphics selector chooses WebGPU or forced WebGL2. Switching reloads the scene and remembers the choice in localStorage; a `?backend=webgpu` or `?backend=webgl2` URL overrides it. The header reports the actual backend, including an explicit message if WebGPU is unavailable and Three.js falls back. Both modes use Three.js WebGPURenderer with a thin node-material binding layer for native shader functions. Hardware 4-sample MSAA replaces the legacy WebGL EffectComposer/SMAA chain.

Normal-map derivation, voxel occupancy, static sky/bounce transport, dominant incoming light direction, live sun/point-light visibility and tree/grass colour-normal atlas captures all run through the selected renderer. WebGPU mode uses WGSL GPU render passes, with no hidden WebGL baking renderer. These are render-to-texture GPU passes, not compute-dispatch kernels. Mesh generation, partial vegetation occupancy preparation, merged mesh assembly and statistical ground-coverage generation remain CPU work.

Grass stays textured cards. Its lighting normal represents the upright tuft and rotates with plant yaw, independently of the carrier card. Leaves retain curved cluster vertex normals with texture normal detail. Impostor normal atlases store source/world-space directions; runtime shading rotates those directions with the plant, rather than with the camera-facing card. Captures are unlit and can be relit without rebaking when the sun moves. Cache rows use a canonical bottom-up order across both backends.

Shader graphs are shared between material variants. Per-object LOD fade uniforms stay separate; the shared light/terrain texture state is not serialized into cloned material userData.

Run `npm run test:backends` with the dev server running to exercise cold baking in both backends, cross-backend cache reuse through the real selector, all four LODs, live-light readback changes, padded-row readback orientation, colour/normal atlas coverage, and camera-independent billboard normals. The test uses installed Edge with WebGPU support. Source row alignment is handled explicitly for Three r186's raw WebGPU readback buffers. Incorrect pre-conversion caches are invalidated by the new identities.

Startup precompiles the visible scene asynchronously with progress. Instancing prefers attributes to avoid a shader variant for every batch's instance count. First-use shader preparation and merged-cluster construction still cost time; a higher frame rate is not guaranteed by the backend migration.

Custom voxel occupancy, transport and live-light kernels are authored in `src/shaders/volume.glsl` and `volume.wgsl`. `src/native-kernels.js` contains paired native functions for normal baking, grass normals, wind, foliage radiance, terrain blending, volume sampling, atlas selection and fades. The `tsl-materials.js` and `tsl-baking.js` names are retained for compatibility: they bind textures/uniforms/attributes and connect the native functions to Three.js. Three still generates its built-in PBR, shadows and render plumbing with nodes; this is not a separate raw WebGPU renderer or a WebAssembly conversion.

Static scene world matrices are now initialized once, with explicit updates for moving lights and newly attached objects. This removes repeated full-world matrix propagation from shadow passes. A local 1280x800 headless Edge CPU profile before native-kernel conversion improved from about 8 FPS / 118 ms CPU submission to 60 FPS / 16 ms after this fix and visible-cluster premerging. These measurements diagnose the regression; they are not a guarantee of physical display refresh, GPU completion time, or performance on another computer.

### Cutout and movement regression fixes

Material clones explicitly preserve alphaTest (Three r186 NodeMaterial.copy omits this inherited property). Surface capture uses explicit alpha discard and writes RGBA directly. Colour tests reject black-only captures. Atlas mip chains are built per view in an atlas worker, with alpha-weighted colour/normal reduction and coverage preservation; merged forests pack the same mip chains. Mipmaps, four tree HLOD levels, billboard plant normals and merged far meshes remain enabled.

Ground shader UVs bypass texture repeat matrices so world-space tiling is applied once. Startup warms the active distance rings in all camera directions. Inactive LOD and shrub groups detach from scene traversal. Grass construction and local voxel contributor preparation yield in small chunks. Local volume rebuilding keeps rendering the previous lighting until the replacement is ready; GPU readback restores the presentation target before yielding. This is cooperative main-thread scheduling for geometry/proxies, plus a dedicated worker for atlas mip processing, not a claim that all CPU work has moved to workers.

`node scripts/verify-camera-turn.mjs` exercises actual pointer drags and checks that frames continue during a displaced-volume rebuild. It writes interval measurements to `evidence/camera-turn.json`. Physical 180 Hz presentation is not covered by this headless test.

### Sun, clouds and local scattering

The visible sky sun, directional shadow light and voxel sun direction share one
normalized direction. The sky follows the camera across the 4 km map. Clouds
occupy a world-space layer at 650 m; a shared 512-square GPU texture supplies the
visible cloud pattern and sunlight attenuation (up to 48%). Clouds attenuate
both direct surface lighting and foliage transmission. This is live shading;
the static occupancy/transport cache is not rebuilt as clouds drift.

A depth-limited, eight-sample scattering pass runs at 35% linear resolution and
uses the streamed voxel visibility. It adds local lit-air scattering without a
blanket distance-fog extinction term. This is an approximate single-scattering
pass, not full atmospheric transport; its shafts are limited by voxel resolution
and the 256 m local volume. Volume boundaries blend over 24 m horizontally and
6 m vertically. Recenter requests begin 64 m from the current requested centre.
Fast travel can still outrun asynchronous bake completion.

Grass placement uses 3,900 candidates per near block, with darker/shorter coherent
patches and a varying preferred growth direction. The worker and bake-source
placement use the same changes. Seven grass and flower textures share a packed
source atlas. Oak, birch, ash and pine form coherent groves in the open-land selection.

Validation: `node scripts/verify-sun.mjs` checks multi-block grass and shared sun
parameters and captures `evidence/visible-sun.png`. Backend verification checks
cutout thresholds, atlas mipmaps, live relighting and cache reuse. Headless timing
does not certify smooth 180 Hz presentation on a physical display.
Cloud density is generated once and cached. Materials sample a shared shadow
texture; they do not carry their own procedural-noise or RTT dependency.
Observed movement limitation: the final profiled WebGPU traversal kept 257 frames
flowing through a roughly 7.2-second volume rebuild, but its worst interval was
about 500 ms. The two camera sweeps had 95th-percentile intervals of about 83 and
50 ms. Shader graph construction and scene traversal remain substantial costs;
this change does not establish hitch-free high-speed streaming. The separate
settled-view check reached 60 FPS; these are different acceptance boundaries.

### Indexed static bakes, colour-preserving LODs and the 24-minute cycle

- `AreaIndex` stores bounds in 64 m X/Z cells and returns candidates in stable
  source order. Voxel tree/grass/shrub/rock queries use these indexes. Instanced
  rock/shrub transforms and bounds are extracted once at world setup.
- The static world fingerprint is hashed once, rather than serializing all trees
  on every streamed-volume request.
- All three rendered grass LOD placements are worker-generated and persisted in
  `BakedGrassBlocks-v2`, addressed by source identity, block coordinates, seed and
  LOD. A bounded 96-entry resident cache avoids repeated database reads. Voxel
  grass uses the same cached high-detail placement. The project-cache button
  clears this database too. First visits still require missing blocks to bake.
- Every source colour and normal texture has an explicitly generated, cached mip
  chain. Colour reduction uses linear light and original alpha weights; normal
  vectors are renormalized and cutout coverage is handled independently. Atlas
  frames remain isolated. Far grass uses the same habitat mixture, material tint
  and transmission strength as near grass; the ground-cover colour comes from
  source mip averages with the matching tint. Mipmaps cannot remove differences
  caused by geometry silhouettes or local lighting coverage.
- Clouds use a GPU-baked 256 x 48 x 256 density volume with periodic three-dimensional
  lobes and edge erosion. The same field produces sunlight visibility and the sky.
  Density persists in IndexedDB. Sun-dependent lighting, a 512-square ground-shadow
  field and a 2048 x 1024 sky view update in 64-row GPU slices; complete sky/shadow
  buffers swap together. Camera rotation does not trigger a bake; periodic sky updates continue.
  Shadow attenuation is capped at 22 percent, replacing the previous 48 percent.
  This is a bounded single-scattering approximation, not a full weather simulation.
- One real second advances one world minute. A full cycle is 1,440 real seconds
  (24 minutes). The time slider scrubs time, the checkbox pauses/resumes, and
  **Look at sun** aims toward the daytime sun. Sun intensity, ambient light,
  vegetation transmission and scattering respond to daylight; live radiance
  refreshes periodically without rebuilding static occupancy or transport.

Checks: `verify-area-cycle.mjs` compares indexed queries to exhaustive bounds
checks and verifies clock arithmetic; `verify-mip-colour.mjs` checks linear-light
averaging, transparent-pixel rejection and atlas-view isolation;
`verify-cycle-browser.mjs` checks daytime/nighttime, clock progression and cloud
variation on both axes. Backend checks validate 30 relightable plant atlases and reuse the main-cache bakes.
Static lookup work is reduced; GPU draw submission, visibility decisions, dynamic
lighting and first-use shader preparation remain runtime work.
Voxel-volume origins now use a 64 m horizontal area address and an 8 m quantized
height derived from that area's centre. Camera sub-cell movement therefore does
not change the occupancy cache key. The browser cycle test checks this reuse.

Latest profiled traversal before this final address correction: cold/warm sweep
p95 intervals were about 83/50 ms; a background rebuild took about 5.5 seconds,
continued rendering 180 frames, and had a worst interval around 483 ms. These
results do not establish hitch-free movement; shader preparation and draw/scene
work remain costs beyond the static-data bake changes.


## Worker preparation and first-use rendering

Missing area data is now prepared off the animation thread:

- The grass worker receives a small copy of the addressed heightfield/root grid.
  Interpolation, habitat noise, plant placement, and cache access run in the worker.
- A dedicated voxel worker builds grass, branch, leaf, shrub, rock and water
  occupancy, packs material masks, and reorders GPU readback. Area indexes select
  the overlapping entries before dispatch; the worker does not regenerate the
  full terrain. Completed typed-array buffers are transferred back, not cloned.
- A separate forest worker creates and caches merged far-tree meshes. The
  existing HLOD remains visible until its replacement is compiled and ready.
- GPU resource and shader preparation uses a serialized queue outside the frame
  update. During exploration, a new preparation item starts after a presented
  frame. Three's async compiler yields between shader stages; this remaining
  renderer-owned work is still on the main thread, not a Web Worker.
- Grass streaming keeps up to four tile jobs in flight so worker generation and
  cache reads can overlap an earlier tile's GPU preparation. All meshes in one
  grass tile prepare together. Visible grass receives priority over background
  renderer work, with every eighth selection servicing the oldest queued job.
  LODs preload one 24 m tile beyond their fade boundary, plus up to 48 m of
  movement prediction. Resident tiles are retained within 240 m; stale requests
  are cancelled. IndexedDB persistence is submitted before transferring worker
  buffers, without waiting for disk commit before displaying the tile. Upload
  page and frame budgets remain unchanged. `worldDiagnostics.grassStreaming`
  exposes active/queued counts, cancellations, wait/build maxima and errors.
- Stable minimal sun-shadow materials retain the same alpha masks, fade, wind
  positions and shadow sides without reconstructing a shared override shader
  on first encounter. The colour and shadow paths are prepared before publishing
  new tree LODs. An isolated cutout/wind comparison matches the original shadow
  image byte-for-byte on both APIs.
- Three r186.1's async compilation uses a depth-zero render context, while this
  app's nested world and shadow passes use depths one and two. The preparation
  wrapper captures the matching context synchronously and immediately restores
  renderer state before awaiting compilation. No files in node_modules are
  patched. Recheck this compatibility wrapper when upgrading Three.
- Turning in place reuses distance-LOD decisions (with a 1 mm movement tolerance
  for floating-point drift). Frustum culling and drawing continue every frame.
  Completed jobs invalidate those decisions. Released grass generations reject
  stale results without clearing a newer request's pending flag.
- The old voxel volume, direction map and origin stay together until the new
  volume is prepared, preventing partially published lighting during streaming.

Local checks (not GitHub Actions):

Voxel occupancy uses a worker-built XZ index of trunks. Each GPU voxel checks
only the trunks overlapping its column; dense woodland no longer truncates at
1,100 trunks. Grass cache reads in the voxel worker overlap in bounded groups
of eight. Voxel preparation has priority over background forest work, and bake
reports include separate worker/occupancy/transport/lighting stage durations plus
preparation, readback and cache timings. These are elapsed durations, including
queue waits, not isolated GPU timestamps.

Far-tree merge preparation can overlap eight jobs during loading and three while
travelling. GPU ownership and paged upload limits remain serialized. Far bounds
come from the baked quad dimensions instead of traversing full-detail tree
meshes; ready replacements still inherit the outgoing LOD's fade before removal.

`npm run test:voxel-index` compares indexed/exhaustive trunk occupancy, checks
dense cells beyond the previous cap, and checks merged bounds. For actual shader
pixel equivalence, open `/scripts/voxel-index-browser.html?backend=webgpu` or
`backend=webgl2` with the dev server running. The report must show no errors,
nonzero output, and zero byte differences. Render/readback timings are noisy and
should not be treated as isolated GPU performance measurements.

The 2026-10-26 local 180 m walking check (6 m/s for 30 s, then 15 s stationary)
had zero missing nearby L0 grass tiles at every one-second sample on both
backends. WebGPU had no queued grass at the stop; WebGL2 cleared remaining
outer/preload requests three seconds later. WebGPU fresh volume rebuilds measured
1.17 s initially and 1.51�1.83 s while travelling, with 0.31�0.37 s in streamed
voxel-detail preparation. This excludes whole-world startup; asset and driver
caches were already warm. WebGL2 reused occupancy/transport records from the
WebGPU run, so its bake times are not a cold-backend comparison. Both shader
comparison runs produced identical indexed/exhaustive output. Frame intervals
still included outliers of 450 ms (WebGPU) and 433 ms (WebGL2); this is not a
hitch-free claim. Reports/screenshots are under `evidence/grass-walk-priority-*`
and `evidence/voxel-index-*` locally.

`npm run test:grass-streaming` checks bounded overlapping tile jobs, renderer
priority/fairness, stale request cancellation, recovery after errors, LOD
preloading and release of prefetched tiles. `npm run test:lod-handoff` checks
resident coverage during asynchronous LOD replacement.
With the dev server running, open `/scripts/grass-streaming-browser.html?backend=webgpu`
for a 30-second, 180 m straight walk followed by 15 seconds at rest. The displayed
report samples missing L0 tiles inside 38 m, pending jobs, preparation latency,
frame intervals and errors. Use `backend=webgl2` to compare APIs or `speed=22`
for a 660 m sprint. This is a local profiling harness, not a GitHub Actions test.

`node scripts/verify-preparation-workers.mjs` checks byte-identical worker voxel
colour/opacity and material masks, transferred ownership, merged cache reuse,
worker error rejection, and continued animation during worker execution.
`node scripts/verify-prepared-shadows.mjs` compares original/prepared shadow
cutouts and displaced geometry on both backends.
`node scripts/verify-streaming-preparation.mjs webgpu` (or `webgl2`) rotates
in place, checks worker counters and unexpected synchronous shader builds, then
moves to a new area and verifies that the old lighting remains valid while baking.

## Paged GPU uploads

Prepared data now follows a separate residency stage:

`area index / cache -> worker buffers -> upload pages -> complete submission -> LOD / lighting swap`

`src/gpu-upload-queue.js` shares credits across every resource on a renderer.
Copies run in tasks after animation callbacks, with the following limits:

| Limit | Exploring | Loading screen |
| --- | ---: | ---: |
| Maximum transfer page | 64 KiB | 64 KiB |
| Upload bytes per animation frame | 256 KiB | 4 MiB |
| CPU submission time target per frame | 1 ms | 4 ms |
| Maximum submitted bytes awaiting completion | 512 KiB | 8 MiB |

The byte limits are hard limits for managed transfers; the CPU target is checked
between pages and cannot interrupt a driver call. Completing one resource does
not reset the frame budget. A lightweight frame clock replenishes credits; it
does not render a second scene or cap the application's refresh rate.

`src/gpu-uploads.js` allocates Three-compatible resources, then uploads buffer
ranges and texture rows/tiles instead of copying an entire worker result at once.
It handles 2D textures, voxel volumes, explicit atlas mip chains, vertex/index
buffers and instance attributes discovered by shader compilation. WebGPU uses
queue writes. WebGL2 uses sub-data/sub-image copies. Both use asynchronous fences
to bound the staging backlog, without a synchronous `finish()`. Once all pages
are submitted, later draws are safe by GPU command ordering. There is no CPU
fence wait per resource; that would serialize startup around driver completion
notifications even when the upload itself is small.

Tree, merged-forest, grass, shrub and terrain replacements stay behind the
preparation gate until all their copies are queued and pipelines are ready. Existing LODs remain
visible. Voxel direction maps and cached radiance are resident before publication,
so texture data and volume coordinates switch together. Disposal cancels pending
copies and releases the corresponding tracked allocation.

These are **transfer pages**, not sparse virtual textures or a GPU heap allocator.
The complete destination buffer/texture is still allocated. Native image uploads
during initial baking, render-target allocation, shader construction/compilation,
uniform updates and GPU rendering remain outside the transfer budget. The existing
grass residency policy still controls eviction. Three is pinned to **0.186.1**;
the adapter uses backend internals and must be revalidated before upgrading.

Diagnostics: `worldDiagnostics.preparation.uploads` reports pending and in-flight
bytes, submitted pages, frame maxima, cancellation, estimated allocated bytes for
managed resources, allocation timing and uploads outside this path. Allocated
bytes are not a measurement of the device's complete VRAM usage.

Local checks, with no Actions workflow:

- `node scripts/verify-gpu-pages.mjs`: real WebGPU/WebGL2 transfers, byte-exact
  geometry, explicit mip and volume comparisons, duplicate requests, frame byte
  limits, GPU backlog, cancellation and disposal. Explicit baked mips match the
  native uploads exactly. WebGL2 automatic mip generation in the test differs
  by at most 2/255 in a channel; base pixels and supplied mips remain identical.
- `node scripts/verify-streaming-preparation.mjs webgpu paged-streaming` (or
  `webgl2`): full-world rotation and travel, unchanged uploads when turning,
  page/backlog limits during streaming, and no new bulk uploads bypassing the
  queue. Evidence is written under `evidence/paged-streaming-<backend>.*`.
- `node scripts/verify-terrain-faces.mjs`: front-face culling and camera clearance,
  including a teleport onto a still-visible four-subdivision terrain fallback
  while the detailed tile is being prepared.

Measured locally in headless Edge at 1280 x 800 after paging and LOD gating:

| Measurement | WebGPU | WebGL2 |
| --- | ---: | ---: |
| Rotation p95 frame interval (both sweeps) | 16.8 ms | 33.4 ms |
| New-area voxel rebuild elapsed | 6.43 s | 8.07 s |
| Worst interval during that rebuild | 50.0 ms | 100.1 ms |
| Maximum managed upload submission time per exploration frame | 0.3 ms | 0.2 ms |
| New bulk uploads bypassing paging during the test | 0 | 0 |

Both backends retained the previous lighting and recorded no shader/console
errors. Rotation issued no new uploads. Bounded uploads intentionally spread
resource availability over multiple frames; LOD shader preparation can continue
after the voxel rebuild completes, so these are not full-area-ready timings.
The remaining WebGL2 frame spikes need separate profiling. These measurements
do not establish smooth 180 Hz or measure a physical variable-refresh display.

## Movement measurement before upload paging

A local headless Edge WebGPU comparison at 1280 x 800 using
`scripts/verify-camera-turn.mjs` (including CPU profiler overhead):

| Measurement | Before worker/preparation changes | After |
| --- | ---: | ---: |
| First moving camera sweep, p95 interval | 83.4 ms | 49.9 ms |
| Repeated moving camera sweep, p95 interval | 49.8 ms | 33.5 ms |
| Streamed voxel rebuild duration | 5.40 s | 3.05 s |
| Worst frame interval during that rebuild | 583.3 ms | 66.7 ms |

The rebuilt area continued presenting 120 frames. No shader or console errors
were recorded. This comparison retains the same test path and viewport; the
moving camera's timing affects the exact sampled views, and it is not a GPU-time
or physical-display measurement. Evidence: `evidence/camera-turn.json` and
`evidence/camera-turn-before-workers.json`.

A separate fixed-position WebGPU rotation check, without the CPU profiler,
recorded 16.8 ms p95 over each of two 180-frame sweeps, maximum 33.4 ms and no
intervals over 50 ms. Worker/preparation completion counters did not change:
turning did not trigger missing asset preparation. Its new-area rebuild had a
100 ms maximum interval. The corresponding WebGL2 rotation check had 33.4 ms
p95, no intervals over 50 ms, and unchanged preparation counters. Its new-area
rebuild peaked at 116.6 ms. Both backends retained the old lighting during the
worker job and reported no shader/console errors. Movement hitches are reduced,
not eliminated.
Runtime scene traversal, draw submission, GPU uploads and rendering still cost
frame time. These checks do not establish smooth 180 Hz operation.

## License

Released under the [MIT License](LICENSE). Generated texture provenance is
recorded in [docs/asset-prompts.md](docs/asset-prompts.md). Third-party npm
dependencies retain their respective licenses.

Local verification scripts are included. GitHub Actions builds and deploys the
demo to GitHub Pages on pushes to `main`, or when the Pages workflow is run
manually. No tests run in Actions. To preview the same subdirectory build locally,
run `npm run build:pages`, then `npm run preview -- --base /BakedVoxelLighting/`
and open `http://127.0.0.1:4173/BakedVoxelLighting/`. This is an experimental
desktop renderer; the streaming/performance limitations above remain open.

WebGL2 index buffers are initialized as element buffers before their payload is
paged through the copy target. This fixes missing terrain, trees and sky on
backends that reject indexed draws from untyped copied buffers. The upload check
also verifies rendered coverage and GL errors; buffer byte equality alone did
not catch this failure.
