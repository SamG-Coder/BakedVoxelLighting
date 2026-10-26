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

## CPU traversal pass, 26 October 2026

An active point light previously traversed the entire scene for each of its six
shadow faces, including the non-casting grass, sky and terrain. `ResidentPointShadow`
now collects visible caster subtree roots once per shadow update and submits those
roots to the existing six face renders. Original objects, parenting, matrices,
materials, shadow settings and scene identity are retained. The original scene
children are restored in `finally`. LOD, clipping, bundle and ordered-group
containers remain intact. Rebuilding the list each update includes streamed
objects and visibility changes immediately, without a stale membership cache.

This does not reduce geometry, density, texture quality, draw distance, shadow
resolution or active-light shadow update rate. It targets active point lights;
there is no corresponding benefit when the carried/dynamic lamp is off.

Same-session comparisons at 861 x 1244 in the desktop in-app browser, with the
resident night scene and carried torch active:

| CPU frame work | Original traversal | Caster roots | Reduction |
| --- | ---: | ---: | ---: |
| WebGPU | 22.14 ms | 19.02 ms | 14.1% |
| WebGL2 | 26.62 ms | 22.15 ms | 16.8% |

Each comparison runs A/B/B/A, with 20 warmup and 60 measured frames per run,
averaging the two runs of each variant. An initial WebGPU pair measured
19.51 / 16.31 ms. The first WebGL2 torch warmup was unstable (baseline drifted
from 32.96 to 25.76 ms); the table uses the subsequent settled comparison,
whose two baseline runs were 26.67 and 26.56 ms. These are CPU render/frame
measurements, not guaranteed display FPS. They must not be compared directly
with the earlier 1280 x 720 measurements above.

Instrumented traversal time fell from about 5.40 to 1.94 ms/frame. Instrumentation
adds overhead, so those figures diagnose where work was removed rather than
replace the uninstrumented frame measurements. WebGPU GPU render-pass time
remained about 10.9 ms; GPU geometry work was not reduced. Scene draws remained
1146 and submitted geometry about 140 million triangles including all shadows;
periodic cloud updates add a fractional average pass/draw in some runs.

Validation:

- `node scripts/verify-shadow-cpu.mjs` checks hidden ancestors, subtree handling,
  parenting, ordered groups and LOD preservation.
- `/scripts/shadow-cpu-browser.html?backend=webgpu` and `webgl2` compare exact
  rendered pixels and draw counts across four camera/light positions, including
  transformed groups, hidden objects, masked foliage and shader wind. Both
  backends passed with zero changed pixel channels and identical draw counts.
- Full-world streaming: eight area/resolution swaps with the torch active on
  each backend; both passed without console/application errors.
- `npm run build:pages` and the existing lighting-resource checks passed.

`/scripts/render-profile.html?backend=webgpu&profile=1` now has **CPU breakdown**
and **Compare CPU** controls. Wait for streaming and preparation to settle and
enable the torch before comparison. These tools remain local development pages;
no tests were added to Actions. Raw evidence is in the ignored
`evidence/cpu-compare-webgpu-abba.json`, `evidence/cpu-compare-webgl2.json`,
`evidence/cpu-breakdown-{before,after}.json`, `evidence/shadow-cpu-{webgpu,webgl2}.json`
and `evidence/cpu-streaming-{webgpu,webgl2}.json` files.

The remaining significant CPU work is per-draw material/node updates, resource
bindings and submission. This pass does not claim to solve that cost or prove
long-duration stability.
