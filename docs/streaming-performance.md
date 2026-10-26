# Walking residency and preparation

This pass preserves terrain/vegetation density, mesh detail, texture resolution,
mipmaps, LOD distances, shadow resolution, and the existing fade handoff. It
changes scheduling and the lifetime of resident resources.

- Grass reuses a bounded spare pool (48 groups per LOD) with stable instance
  buffers. Each newly loaded tile still receives its original generated matrices,
  colours and plant types. Trees retire high-detail instances beyond their return
  margin; middle tree LOD and shrub preparation is also retired outside retention.
- An installed merged far cluster releases its superseded source group, including
  private billboard geometry. Shared prototype geometry and atlas textures survive.
- CPU tree construction no longer waits for the previous cluster's material and
  shadow preparation. GPU preparation remains serialized and uses live priorities.
- Detailed tree instances also reuse prepared meshes/materials, with at most four
  spare meshes per prototype geometry. Their matrices, colours, instance counts
  and bounds are replaced while attribute identities stay stable. The focused
  `scripts/tree-pool-browser.html` comparison produced identical pixel bytes to
  freshly built instances on both WebGPU and WebGL2.
- The camera frustum raises the priority of visible areas. Off-screen prefetch
  remains available, with periodic fairness; frustum membership does not change
  density or determine whether an area permanently exists.
- Pending obsolete LOD/preparation requests are skipped. Shadow jobs inherit the
  same validity checks. Streaming voxel jobs can be aborted, stop at worker and
  raster-slice boundaries, and cannot publish an obsolete volume. Submitted GPU
  commands are allowed to finish before private resources are retired.
- Voxel preparation consumes one decoded grass block at a time, instead of
  retaining all decoded blocks in the volume. Occupancy and transport are cached;
  streaming does not read back/cache an unused historical radiance snapshot.
- Streaming raster bakes retain the complete target and original UVs, but submit
  at most 65,536 pixels per slice with a presentation opportunity between slices.

## Reproducible checks

`node scripts/verify-streaming-memory.mjs` checks byte-identical streamed voxel
output, one decoded grass load at a time, safe LOD retirement, changing frustum
priorities, skipped stale jobs, and ignored replies from aborted workers.

`scripts/bake-slices-browser.html?backend=webgpu` (also `webgl2`) compares a full
raster pass against sliced rendering, including exact pixel bytes and restored
renderer state. `scripts/streaming-profile.html?backend=webgpu&profile=1` exposes
normal-speed and accelerated return routes with memory, queue and stage counters.
It reports completion separately from performance; completing a route is not proof
that stutter or out-of-memory risk has been eliminated. No Actions tests were added.

## Current evidence and limits

Initial instrumentation reproduced substantial memory pressure: an accelerated
2 km route grew the reported JS heap from approximately 3.0 GB to 5.7 GB. A first
pooling revision also exposed destroyed-buffer validation errors and was rejected.

The later normal-speed WebGPU route (720 m out-and-back, 6 m/s, 25 s settling)
completed without console/application/GPU validation errors. Reported JS heap was
4.18 GB at the beginning and 4.64 GB at the final sample; paged allocations were
471 MB and 604 MB. These counters are not total browser RSS or total VRAM.
Frame intervals were p95 50.1 ms, p99 116.6 ms, maximum 644.5 ms. Thus this pass
does **not** establish hitch-free walking or long-duration crash freedom.

A second lap in the same session completed without errors: p95 33.4 ms, p99
66.6 ms, maximum 516.7 ms. Paged allocations stayed approximately flat
(604 to 603 MB), with shader states 3813 to 3855. Reported JS heap still ranged
from 4.47 to 5.33 GB. This is evidence of substantially better resource reuse,
but not proof of a stable long-term JS heap. Tree priority was subsequently
raised relative to grass prefetch; that scheduling adjustment is not an A/B
performance claim.

The subsequent tree-pool revision completed a 2 km route at 24 m/s with no
console/application/GPU errors, 365 reused tree batches, 15 cancelled tree requests
and two aborted stale volume bakes. Its p95/p99/max frame intervals were
50.1/133.2/600.2 ms, and final reported JS heap was 4.79 GB. This faster route is
not comparable to the 6 m/s figures as a speedup benchmark. It validates reuse,
cancellation and rendering correctness while still exposing significant hitches.

Stage counters distinguish generation from renderer preparation. In this session,
970 initial merged pages took about 1.99 s total worker time; only seven more pages
were merged during the walking route, adding about 5 ms worker time. The initial
nine tree groups accumulated 41.3 s of preparation latency (including queue waits,
uploads and shadow preparation). These overlapping durations are not CPU time and
must not be summed into a wall-clock load time. The remaining investigation should
target per-object material/node preparation and allocation churn, rather than
assuming the mesh-merging worker is the dominant walking cost.

## Shared grass instance attributes

Grass tiles now bind matrix and colour data as named instanced geometry
attributes. Three can share their node-builder state without capturing another
tile's buffers. The original grass geometry, instance counts, textures, normals,
fades and lighting calculations are retained. The comparison harness checks
native versus attribute instancing on both backends, including different buffers
and changed instance counts using the shared state.

The subsequent 720 m, 6 m/s WebGPU route completed without rendering errors.
Initial shader states fell from approximately 2,900 to 1,346. Frame intervals
were p95 33.4 ms and p99 33.5 ms (earlier normal route: 50.1 / 116.6 ms).
The maximum remained 583.3 ms; final reported JS heap was 3.98 GB. This is a
useful reduction in repeated preparation, not a claim of hitch-free operation
or an established long-session memory bound. Raw evidence is
`evidence/walk-shared-attributes-webgpu.json`.

The optional `?showcase=1` controls export four 30-second 1080p path walks.
They settle only the starting view and record the normal live render loop with
MediaRecorder while the camera walks using real elapsed time. Streaming stalls
remain visible; there is no offline rendering or time compression.

Local raw evidence: `evidence/walk-normal-webgpu.json`,
`evidence/walk-memory-cancel.json`, and the earlier rejected
`evidence/walk-memory-pool.json`. The final stress run is
`evidence/walk-tree-pool-webgpu.json`, and the repeated normal route is
`evidence/walk-repeat-webgpu.json`. Evidence files are ignored by Git.
