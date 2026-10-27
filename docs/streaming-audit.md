# Streaming and render preparation audit

This audit follows the fast-travel allocation and rendering path through the
application, worker clients, geometry/atlas builders, lighting passes, and the
installed Three.js 0.186.1 renderer. Geometry density, textures, mipmaps, LOD
distances, alpha coverage, shadows and lighting resolution are unchanged.

## Findings and changes

| Area                               | Finding                                                                                                                                                                        | Change                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tree, shrub and deadwood instances | Native instance buffers were embedded in each mesh's node graph. Three includes object UUIDs in these shader-state keys, even for identical species/materials.                 | Named matrix/colour geometry attributes share the shader graph. Every draw still binds its own transforms and colours.                                                             |
| Instance lifetime                  | Instance batches need private buffer disposal while prototype vertices remain shared. Disposing shared geometry attributes indiscriminately can destroy a neighbour's buffers. | Explicit prototype/batch leases guard the r186 attribute deletion path. Private instance buffers and retired materials are released.                                               |
| Tree preparation                   | The CPU construction queue completed before GPU preparation, allowing built groups to accumulate behind the renderer queue.                                                    | Two jobs maximum across construction, preparation and publication. Stale queued work is dropped before allocation; stale completed work returns to the bounded pool.               |
| Cluster compilation                | Each mesh called `compileAsync` separately; each call traversed the world for lights.                                                                                          | One compilation capture per group. Three still yields between objects internally. Renderer ownership remains serial.                                                               |
| Terrain streaming                  | Old LOD requests remained valid after passing their sections. Once uploaded, detailed terrain remained resident across the map.                                                | Live distance/frustum priorities cancel obsolete requests. Hidden detailed GPU geometry is retired beyond a hysteresis margin; CPU geometry and the coarse world remain available. |
| Grass generation                   | Two workers already generate tile batches; a four-job gate includes renderer preparation. RAM cache and spare pools are bounded.                                               | Retained the existing worker pipeline and representation. Shared attribute disposal now applies consistently to grass too.                                                         |
| Forest merging                     | Indexed worker merge work is small relative to preparation, with transferable arrays and bounded concurrency.                                                                  | Kept worker merging and exact baked atlases.                                                                                                                                       |
| Voxel lighting                     | Area-indexed worker voxelization, cancellation checks, paged GPU uploads and stable published texture identities already exist.                                                | Kept these safeguards and measured them during traversal.                                                                                                                          |
| Clouds, river and torches          | Recurring cloud work is sliced; river and flame simulation resources are reused. Torch neighbourhood selection is indexed.                                                     | No quality or update-rate reductions.                                                                                                                                              |

## Validation

The allocation pass also reuses LOD targets, fade weights, counters, grass
priorities, movement vectors, renderer capture scratch arrays and queue storage.
Grass grid queries are rebuilt only when crossing a grid cell; moving inside a
cell no longer creates 1,089 lookup strings per update. Live distance, frustum
priority and fade decisions still update while moving. Equivalent shadow depth
nodes are shared across material instances.

- `scripts/verify-streaming-memory.mjs`: voxel byte equivalence, retirement,
  stale work cancellation, live frustum priorities, bounded construction through
  residency, and pooled matrix/colour identity.
- `scripts/attribute-instances-browser.html`: native versus named-attribute
  rendering, including transformed normals, instance colour and changed buffers.
- `scripts/tree-pool-browser.html`: reuse and 24 retirement cycles, checking
  pixels, shader sharing, render objects, geometry and private GPU buffer counts.
- `scripts/streaming-profile.html`: 24 m/s route and three-lap 6 km soak; reports
  heap, actual renderer memory, paged allocations, shader ownership, synchronous
  shader builds, long tasks, frame percentiles and errors. The save button exports
  the complete result. Tests are local; no tests were added to Actions.

## Measured traversal (2026-10-27)

Local WebGPU, same 24 m/s out-and-return 2 km route, followed by 25 seconds of
settling. These are delivered animation callback intervals, not GPU-only times.
The browser/driver, caches and garbage collection are not deterministic; this is
a before/after observation rather than a guaranteed minimum FPS.

| Measurement | Before | Shared instance/shadow graphs and reusable LOD buffers |
| --- | ---: | ---: |
| 95th percentile frame interval | 33.4 ms | 16.8 ms |
| 99th percentile frame interval | 50.0 ms | 33.4 ms |
| Largest frame interval | 533.4 ms | 83.3 ms |
| Heap at route start | 2.984 GB | 2.119 GB |
| Heap after route and settling | 4.267 GB | 2.105 GB |
| Shader states at route start | 1,346 | 203 |
| Shader states after route | 2,018 | 215 |

The improved run reported 15 long tasks, the longest 82 ms, and no captured
application errors. The long-animation-frame API attributed several long script
callbacks to `animate`; it did not provide GC attribution. Therefore this does
not prove that all remaining hitches are GC. The final queue scratch, cached-grid
query, and walking-vector changes were added after this measurement and are
covered by separate checks.

The final 6 km / three-lap run used a bounded live metrics display (the earlier
profiler rendered its entire growing history every five seconds and introduced
its own layout stalls). It completed with p95 16.8 ms, p99 33.3 ms, largest
interval 166.7 ms, eight long tasks (maximum 171 ms), and no captured application
errors. Heap went from 4.081 GB of post-startup allocations to 2.131 GB; shader
states went from 203 to 215 and remained at 215 on repeated travel. Paged GPU
accounting ended at 777 MB; this excludes some renderer allocations and is not
total GPU memory. Final instance-bound scratch reuse and removal of the duplicate
colour allocation were checked with the pool pixel/lifetime fixture separately.

## Remaining architecture boundaries

`compileAsync` is cooperative main-thread JavaScript plus asynchronous GPU
pipeline creation; it is not a worker. Geometry generation, atlas processing,
voxel details and forest merging already use workers. Moving the entire renderer
to an OffscreenCanvas worker would require transferring renderer ownership,
input, cache/publication coordination and recovery, rather than sending existing
Three objects or the same GPU device to arbitrary worker jobs.

Further optimization should follow measured synchronous-build, frame-tail and
memory trends. A bounded route is not proof that every route, GPU driver or
multi-hour session is free of stalls or memory exhaustion.

This is not a zero-allocation renderer. Newly encountered geometry, voxel bake
inputs/readbacks, worker messages, promises and Three internals still allocate.
Existing pools are bounded deliberately: retaining everything ever visited would
trade collection churn for another out-of-memory failure. Heavy work should use
bounded reusable storage where ownership allows it, and remaining unavoidable
allocations must stay outside the per-frame path where possible. The measured
166.7 ms soak tail still fails a 59 FPS minimum (about 16.95 ms per frame).
