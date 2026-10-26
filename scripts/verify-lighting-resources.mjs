import assert from "node:assert/strict";
import {
  publishedLighting,
  retireLightingInputs,
} from "../src/lighting-resources.js";
const renderer = { backend: {} };
for (const n of [48, 64, 96]) {
  const first = publishedLighting(renderer, n);
  for (let i = 0; i < 12; i++)
    assert.equal(publishedLighting(renderer, n), first);
  assert.equal(first.target.width, n);
  assert.equal(first.target.height, (n * n) / 2);
  assert.equal(first.directions.image.data.byteLength, n ** 3 * 2);
}
assert.notEqual(
  publishedLighting({ backend: {} }, 96),
  publishedLighting(renderer, 96),
);
assert.throws(() => publishedLighting(renderer, 128), RangeError);
let release,
  disposed = 0;
const gpu = {
  backend: {
    device: {
      queue: { onSubmittedWorkDone: () => new Promise((r) => (release = r)) },
    },
  },
};
const retired = retireLightingInputs(gpu, [
  {
    dispose() {
      disposed++;
    },
  },
]);
assert.equal(disposed, 0, "private resources survive outstanding GPU commands");
release();
await retired;
assert.equal(disposed, 1);
await retireLightingInputs(renderer, [
  {
    dispose() {
      disposed++;
    },
  },
  null,
]);
assert.equal(disposed, 2);
console.log(
  "Lighting resources: stable identities, bounded resolutions, renderer isolation and deferred retirement passed",
);
