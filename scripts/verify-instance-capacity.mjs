import assert from "node:assert/strict";
import {
  instanceCapacity,
  takeCapacityGroup,
} from "../src/instance-capacity.js";
for (let count = 0; count <= 7800; count++) {
  const capacity = instanceCapacity(count);
  assert.ok(capacity >= count);
  if (count > 256) assert.ok(capacity < count * 2);
  assert.equal(instanceCapacity(capacity), capacity);
}
const small = { userData: { instanceCapacity: 256 } },
  medium = { userData: { instanceCapacity: 1024 } },
  large = { userData: { instanceCapacity: 8192 } };
const pool = [small, medium, large];
assert.equal(takeCapacityGroup(pool, 256), small);
assert.equal(pool.length, 2);
assert.equal(takeCapacityGroup(pool, 512), null);
assert.equal(pool.length, 2);
assert.equal(takeCapacityGroup(pool, 8192), large);
assert.equal(takeCapacityGroup(pool, 1024), medium);
assert.equal(pool.length, 0);
console.log(
  "All grass populations fit without thinning; exact capacity groups reuse buffers without mismatched allocation.",
);
