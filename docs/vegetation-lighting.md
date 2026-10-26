# Vegetation streaming and sunlight

This pass separates reusable geometry from illumination and presentation work.

## Loading

- Source PNGs are fetched/decoded concurrently and fetched only once; GPU bake passes stay serialized.
- Two bounded workers build/cache tree and shrub prototypes. Geometry keys depend on geometry and appearance sources, not unrelated lighting shaders.
- L0/L1 tree instance batches are created only when requested. The prepared resident representation remains until replacement pipelines and buffer pages are ready.
- Startup merges forest data without compiling each replacement individually. The merged scene receives one final warmup; runtime replacements still use the normal readiness gate.
- Two grass workers feed the existing bounded streaming/upload queue. Worker completions share small renderer preparation batches, and cached preparations share a 2 ms scheduling budget instead of each waiting for a new frame. Individual compiler calls cannot be interrupted; upload pages remain bounded independently (64 KiB pages, 1 MiB/frame and a 1 ms submission budget on this desktop target). The terrain's baked ground cover is visible before grass geometry streams in.
- Grass arrivals and swaps have a 650 ms temporal handoff. LOD distances are 45/110/280 m, with world-space thinning through 300 m and retention through 360 m. Increasing distance increases draw/overdraw cost; this is not a promise of constant frame rate.
- Ground colour and canopy normals blend by continuous position, not 24 m block centres. Patch edges and the final distance ring receive dithered coverage, retained when materials are cloned.

## Moss

A vertex mask depends on age class, height, seeded aspect and broken colonies. Saplings have little coverage; mature and old trunks have broader coverage. The material blends to moss reflectance rather than multiplying a green tint into dark bark. Its albedo is captured into HLODs, with a mean reflectance passed to voxel occupancy. This is an artistic ecological approximation, not a claim that age alone determines moss growth.

## Sunlight and colour

The reflection equation multiplies incident spectral radiance by surface response. In the RGB approximation used here, colour interactions are component-wise in Linear-sRGB. Warm light can reduce the blue component of a green surface; adding a pale colour over the final image is not the same operation. Specular reflection and display tone mapping can still legitimately reduce saturation in bright highlights.

The transport bake stores material-coloured diffuse bounce and sky visibility independently. The lighting pass applies the current sun colour to that bounce and adds a modest sky term. Foliage transmission uses the same sun colour as direct lighting, with lower gain. Dynamic sun direction still updates the lighting pass without rebuilding geometry or static transport. The screen-space beam pass uses baked sky visibility to localize density under canopy and composites attenuation plus scattered radiance rather than an unrestricted additive veil. Its density and phase remain approximations.

Albedo source images are sRGB; captured surface atlases and vertex colours are linear; normal maps are data. Illumination is applied after albedo capture, so time-of-day colour is not permanently painted into tree or grass textures.

References:
- [PBRT: Surface reflection](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Surface_Reflection)
- [Three.js: Colour management](https://threejs.org/manual/pages/color-management.html)
- [PBRT: Volume scattering processes](https://pbr-book.org/4ed/Volume_Scattering/Volume_Scattering_Processes)

Local verification includes delayed grass residency and long paused-frame handoffs, age-dependent moss coverage, topology and finite attributes, habitat/worker parity, and streamed voxel indexing. Browser rendering was checked in WebGPU and WebGL2 with morning, midday and evening settings. Warm-cache first-scene readiness was around 14-16 seconds in the measured sessions. The complete 300 m grass ring still has asynchronous preparation cost; worker cache retrieval is typically below a few milliseconds, but that is not end-to-end tile residency latency. No tests were added to GitHub Actions.
