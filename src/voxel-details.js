import { snapshotTerrain } from "./terrain-field.js";
import { WorkerClient } from "./worker-client.js";
export { buildVoxelDetails } from "./voxel-core.js";
const worker = new WorkerClient(
  new Worker(new URL("./voxel-worker.js", import.meta.url), {
    type: "module",
    name: "voxel preparation",
  }),
  "voxel preparation",
);
export const voxelWorkerStats = worker.stats;
const prepared = new WeakMap();
function prepare(world) {
  if (!prepared.has(world))
    prepared.set(
      world,
      worker.run("init", {
        profiles: world.materialProfiles,
        prototypes: world.treePrototypes.map((p) => ({
          species: p.species,
          leaves: p.leaves,
          paths: p.paths.map((path) => ({
            radii: path.radii,
            points: path.points.map((v) => v.toArray()),
          })),
        })),
      }),
    );
  return prepared.get(world);
}
export async function buildVoxelDetailsAsync(world, n, min, size) {
  await prepare(world);
  // Area indexes select overlapping objects, never the whole 16 km² world.
  const query = (index) =>
    index.query(min.x, min.z, min.x + size.x, min.z + size.z);
  const grass = query(world.areaIndexes.grass).map((p) => ({
    x: p.x,
    z: p.z,
    seed: p.seed,
  }));
  const terrain = snapshotTerrain(
    min.x - 28,
    min.z - 28,
    min.x + size.x + 28,
    min.z + size.z + 28,
  );
  return worker.run(
    "details",
    {
      n,
      min: { x: min.x, y: min.y, z: min.z },
      size: { x: size.x, y: size.y, z: size.z },
      identity: world.grassBake.identity || world.surfaceIdentity,
      trees: query(world.areaIndexes.trees),
      objects: query(world.areaIndexes.objects),
      grass,
      terrain,
    },
    [terrain.pixels.buffer, terrain.roots.buffer, terrain.canopy.buffer],
  );
}
export function reorderVoxels(packed, n) {
  return worker.run("reorder", { packed, n }, [packed.buffer]);
}
