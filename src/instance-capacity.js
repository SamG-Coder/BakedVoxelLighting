// Fixed capacity classes retain reusable GPU buffers without reserving a full
// meadow for every sparse woodland tile. Never thin the source population.
export function instanceCapacity(count) {
  if (count === 0) return 0;
  return Math.max(256, 2 ** Math.ceil(Math.log2(count)));
}

export function takeCapacityGroup(pool, capacity) {
  for (let i = pool.length - 1; i >= 0; i--) {
    if (pool[i].userData.instanceCapacity !== capacity) continue;
    const group = pool[i];
    pool[i] = pool[pool.length - 1];
    pool.pop();
    return group;
  }
  return null;
}
