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

Moss potential is baked as irregular object-space colonies with age and height falloff. A persistent 256 x 256 habitat field stores moisture and canopy shelter. The shader combines that field with an approximation of surface exposure along the daylight sun path; it does not follow the current sun, so colonies do not move overnight. This is a moisture/exposure approximation, not a seasonal growth simulation.

The repeating UV sine detail was removed. Fine variation now follows the bark. HLOD normal alpha stores moss potential separately from silhouette alpha, and mip generation averages it without applying alpha-coverage amplification. Near wood, captured trees, shrubs and merged forest HLODs use the same habitat response.

Moss usually favours moisture and shelter, but it is not restricted to surfaces that never receive direct sunlight. Sources: [University of Maryland Extension](https://extension.umd.edu/resource/moss-landscape) and [RHS moss guidance](https://www.rhs.org.uk/garden-inspiration/plants-we-love/the-magic-of-moss).

## Night exploration

The Carry torch control (or T while exploring) equips a camera-relative wooden torch with a charred, continuously folded cloth head, ray-marched volumetric flames, a small recycled smoke plume, warm inverse-square point illumination and soft filtered shadows. The ray march integrates emission through the volume and stops at the charred cloth, retaining gaps around the head. A 32 x 48 x 24 heat/fuel grid is advected on the GPU at 60 fixed steps per second, with a four-step catch-up limit. Fuel enters around the cloth surface; cooling and turbulent flow break up the flame. This is a lightweight combustion approximation, not a full fluid-pressure or chemical solver. The carried prop sits 1.15 m ahead of the camera, with a visible shaft. A GPU reduction of the visible emission field supplies energy, temperature and the emission centroid. One asynchronous 1-pixel readback is allowed in flight, at most 10 times per second; these measurements drive the point emitter instead of a separate sine flicker. Direct lighting, foliage transmission and refreshed voxel radiance share its colour and strength. It reuses the moving-light voxel radiance pass; static occupancy and surface atlases are retained. The checkbox can be selected before entering exploration.

The Look at sun button becomes Look at moon at night. A full-moon approximation travels opposite the sun, with cool directional lighting attenuated by cloud coverage and baked sky visibility. A seeded star field fades with daylight and cloud opacity. Faint night hemisphere illumination represents diffuse sky/starlight; stars are not separate point lights. The existing 24-minute day remains unchanged. Lunar phases and a separate lunar calendar are not simulated.

## Sunlight and colour

The reflection equation multiplies incident spectral radiance by surface response. In the RGB approximation used here, colour interactions are component-wise in Linear-sRGB. Warm light can reduce the blue component of a green surface; adding a pale colour over the final image is not the same operation. Specular reflection and display tone mapping can still legitimately reduce saturation in bright highlights.

The transport bake stores material-coloured diffuse bounce and sky visibility independently. The lighting pass applies the current sun colour to that bounce and adds a modest sky term. Foliage transmission uses the same sun colour as direct lighting, with lower gain. Dynamic sun direction still updates the lighting pass without rebuilding geometry or static transport. The screen-space beam pass uses baked sky visibility to localize density under canopy and composites attenuation plus scattered radiance rather than an unrestricted additive veil. Its density and phase remain approximations.

Albedo source images are sRGB; captured surface atlases and vertex colours are linear; normal maps are data. Illumination is applied after albedo capture, so time-of-day colour is not permanently painted into tree or grass textures.

References:
- [PBRT: Surface reflection](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Surface_Reflection)
- [Three.js: Colour management](https://threejs.org/manual/pages/color-management.html)
- [PBRT: Volume scattering processes](https://pbr-book.org/4ed/Volume_Scattering/Volume_Scattering_Processes)

Local verification includes delayed grass residency and long paused-frame handoffs, age-dependent moss coverage, topology and finite attributes, habitat/worker parity, and streamed voxel indexing. Browser rendering was checked in WebGPU and WebGL2 with morning, midday and evening settings. Warm-cache first-scene readiness was around 14-16 seconds in the measured sessions. The complete 300 m grass ring still has asynchronous preparation cost; worker cache retrieval is typically below a few milliseconds, but that is not end-to-end tile residency latency. No tests were added to GitHub Actions.

The night pass was also rendered in WebGPU and WebGL2. Both reported a running 32 x 48 x 24 fire simulation and completed asynchronous emission reductions without runtime errors. Moon/stars, the restored road blend, and the wrapped torch were inspected in-browser. These are functional/visual checks, not a controlled FPS benchmark or a claim of photographic fire fidelity.
