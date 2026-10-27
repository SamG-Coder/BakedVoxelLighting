import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { shareAtlasBase } from "../src/atlas-storage.js";

const workerSource = await readFile(
  new URL("../src/atlas-worker.js", import.meta.url),
  "utf8",
);
for (const mossPayload of [false, true]) {
  const record = {
    w: 24,
    h: 8,
    views: 3,
    cutoff: 82,
    mossPayload,
    data: new Uint8Array(24 * 8 * 4),
    normals: new Uint8Array(24 * 8 * 4),
  };
  for (let i = 0; i < record.data.length; i++) {
    record.data[i] = (i * 31 + 17) % 256;
    record.normals[i] = (i * 13 + 99) % 256;
  }
  const before = structuredClone(record);
  let levels;
  const self = {
    postMessage: (message) => {
      levels = message.levels;
    },
  };
  vm.runInNewContext(workerSource, { self, Uint8Array, Float32Array, Math });
  self.onmessage({ data: { id: 1, record: structuredClone(record) } });
  assert.deepEqual(levels[0].data, before.data);
  assert.deepEqual(levels[0].normals, before.normals);
  record.mips = levels;
  const allLevels = structuredClone(levels);
  const oldData = record.data,
    oldNormals = record.normals;
  shareAtlasBase(record);
  assert.notEqual(record.data, oldData);
  assert.notEqual(record.normals, oldNormals);
  assert.equal(record.data, record.mips[0].data);
  assert.equal(record.normals, record.mips[0].normals);
  assert.deepEqual(record.data, oldData);
  assert.deepEqual(record.normals, oldNormals);
  for (let i = 0; i < levels.length; i++) {
    assert.deepEqual(levels[i].data, allLevels[i].data);
    assert.deepEqual(levels[i].normals, allLevels[i].normals);
  }
  // IndexedDB uses structured cloning: new records preserve the aliases.
  const stored = structuredClone(record);
  assert.equal(stored.data, stored.mips[0].data);
  assert.equal(stored.normals, stored.mips[0].normals);
  assert.equal(shareAtlasBase(record), record);
}
assert.throws(
  () => shareAtlasBase({ w: 8, h: 8, mips: [{ width: 4, height: 4 }] }),
  /dimensions/,
);
console.log(
  "Atlas storage: exact base pixels, all mip bytes, moss payload, legacy deduplication and structured-clone aliases passed.",
);
