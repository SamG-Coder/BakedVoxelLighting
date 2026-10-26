# Rendering and lighting resource lifetime

Measured 26 October 2026. Inactive lights retain their shadow maps without
redrawing them. The sun keeps its existing update rate while lit; the carried
torch still renders all six shadow faces every frame while emitting. Hidden
carried-torch meshes and smoke are excluded from draw submission. Density,
draw distances, texture/LOD quality, MSAA and shadow resolution are unchanged.

A same-session, resident-scene comparison in the desktop in-app browser,
WebGPU at 1280 x 720, measured 60 frames per case after 20 warmup frames:

| Measurement | Redraw inactive shadows | Skip inactive shadows |
| --- | ---: | ---: |
| Night CPU frame work | 35.2 ms | 26.7 ms |
| Night GPU render passes | 14.1 ms | 5.4 ms |
| Night submitted triangles, including shadows | 153.8 million | 28.9 million |
| Day CPU frame work, carried torch off | 37.7 ms | 28.2 ms |
| Day GPU render passes, carried torch off | 15.0 ms | 6.4 ms |

These are bounded local measurements, not delivered FPS or a 180 Hz guarantee.
GPU times use timestamp queries for render passes, not presentation or a full
compute/queue profile. An active carried torch remains expensive: a separate
night sample measured 55.5 ms CPU and 14.6 ms GPU with all six shadow faces active.
The optimization does not reduce those active-light shadows.

## Resource lifetime

Voxel radiance and direction atlases keep stable GPU identities per
renderer/resolution. A new area copies directions into the resident atlas and
publishes its origin and freshly rendered radiance together. Private bake
resources retire after submitted GPU work completes. The three supported
resolutions bound retained atlas storage to about 4.8 MiB. The point-light
shadow attachment is allocated before materials bind it, including when the
torch starts off and is enabled later.

## Local verification

- `node scripts/verify-lighting-resources.mjs` checks reuse and retirement.
- `/scripts/lighting-resources-browser.html?backend=webgpu` (or `webgl2`)
  checks 12 atlas updates/resolution changes, exact sampled pixels/row order,
  and eight inactive/active shadow toggles.
- `/scripts/render-profile.html?backend=webgpu&profile=1` exposes CPU phases,
  GPU timings, a controlled shadow comparison and full-world streaming stress.
  Wait for grass streaming/preparation to settle before measuring. Test controls
  are local development tools and are not bundled into the Pages application.

The clean WebGPU and WebGL2 full-world runs each completed eight area/resolution
swaps with the torch active and no console or application errors. An earlier development-tab
stress run crashed; the fresh repeat passed, so long-duration stability is not
established by this check.

Local raw measurements are saved under `evidence/render-compare-night-clean.json`,
`evidence/render-compare-day-clean.json`, `evidence/render-torch-active.json`,
`evidence/render-streaming-stress.json`, and
`evidence/render-streaming-stress-webgl2.json` (ignored generated artifacts).
