// XZ cell headers followed by contiguous trunk records. Built in the voxel worker;
// shaders visit only trunks overlapping their column, without a global tree cap.
export function buildVoxelTreeGrid(trees, n, min, size) {
  const cells = Array.from({ length: n * n }, () => []);
  for (const source of trees) {
    // Match the Float32 texture representation before calculating conservative bounds.
    const t = [source.x, source.y, source.z, source.scale].map(Math.fround);
    const r = t[3] * 0.42;
    const x0 = Math.max(0, Math.floor(((t[0] - r - min.x) * n) / size.x));
    const x1 = Math.min(n - 1, Math.floor(((t[0] + r - min.x) * n) / size.x));
    const z0 = Math.max(0, Math.floor(((t[2] - r - min.z) * n) / size.z));
    const z1 = Math.min(n - 1, Math.floor(((t[2] + r - min.z) * n) / size.z));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) cells[x + z * n].push(t);
  }
  const records = cells.reduce((sum, cell) => sum + cell.length, 0);
  const height = Math.ceil((cells.length + records) / n);
  const data = new Float32Array(n * height * 4);
  let offset = cells.length;
  cells.forEach((cell, i) => {
    data[i * 4] = offset;
    data[i * 4 + 1] = cell.length;
    for (const tree of cell) data.set(tree, offset++ * 4);
  });
  return {
    data,
    width: n,
    height,
    trees: trees.length,
    records,
    meanCandidates: records / cells.length,
  };
}
