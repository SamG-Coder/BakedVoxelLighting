import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import DataMap from "three/src/renderers/common/DataMap.js";
import OriginalBindings from "three/src/renderers/common/Bindings.js";
import OriginalUniforms from "three/src/renderers/common/UniformsGroup.js";
import { patchUniforms, patchRuntime } from "./patch-three-allocations.mjs";

async function patched(name, transform) {
  const url = new URL(
    `../node_modules/three/src/renderers/common/${name}.js`,
    import.meta.url,
  );
  let source = transform(
    (await readFile(url, "utf8")).replaceAll("\r\n", "\n"),
  );
  source = source.replace(
    /from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => `from ${JSON.stringify(new URL(path, url).href)}`,
  );
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )
  ).default;
}
const Bindings = OriginalBindings; // r187 supplies the binding allocation fix upstream.
const Uniforms = await patched("UniformsGroup", patchUniforms);

function bindingFixture(Type) {
  let conversions = 0;
  const id = {
    [Symbol.toPrimitive]() {
      conversions++;
      return 42;
    },
  };
  const texture = { id, version: 1 },
    textureData = { bindGroups: new Set(), generation: 1 };
  const binding = {
    isSampledTexture: true,
    texture,
    generation: 1,
    changed: false,
    update() {
      return this.changed;
    },
  };
  const sampler = {
    isSampler: true,
    samplerKey: 1,
    changed: false,
    update() {
      return this.changed;
    },
  };
  const backend = new DataMap(),
    trace = [],
    textures = { get: () => textureData };
  backend.updateBindings = (group, groups, key, version) =>
    trace.push([key, version]);
  textures.updateTexture = () => textureData.generation;
  textures.updateSampler = () => sampler.key;
  const manager = new Type(
    backend,
    { updateGroup: (b) => !b.skip },
    textures,
    {},
    {},
    {},
  );
  const group = { bindings: [binding, sampler] },
    groups = [group];
  const update = () => manager._update(group, groups);
  return {
    manager,
    group,
    backend,
    texture,
    textureData,
    binding,
    sampler,
    trace,
    update,
    conversions: () => conversions,
  };
}

test("unchanged draw bindings build no temporary cache strings after warmup", () => {
  const optimized = bindingFixture(Bindings);
  optimized.update();
  for (let frame = 0; frame < 10000; frame++) {
    optimized.update();
  }
  assert.equal(optimized.conversions(), 0);
});

test("texture generation, sampler changes, skipped groups and external textures retain binding keys", () => {
  const optimized = bindingFixture(Bindings);
  for (const f of [optimized]) {
    f.binding.changed = true;
    f.textureData.generation++;
    f.update();
    f.binding.changed = false;
    f.sampler.changed = true;
    f.sampler.key = 2;
    f.update();
    f.binding.skip = true;
    f.sampler.key = 3;
    f.update();
    f.binding.skip = false;
    f.backend.get(f.texture).externalTexture = {};
    f.sampler.key = 4;
    f.update();
    delete f.backend.get(f.texture).externalTexture;
    f.textureData.isDefaultTexture = true;
    f.sampler.key = 5;
    f.update();
  }
  assert.deepEqual(optimized.trace, [
    ["42", 1],
    ["42", 1],
    ["", 0],
    ["", 0],
    ["", 0],
  ]);
});

test("storage attribute replacement preserves mixed-resource key order", () => {
  const optimized = bindingFixture(Bindings);
  for (const f of [optimized]) {
    f.manager.attributes.update = () => {};
    f.manager.attributes.get = () => ({ generation: 0 });
    const storage = { isStorageBuffer: true, attribute: { id: 9 } };
    f.group.bindings.unshift(storage);
    f.update();
    storage.attribute = { id: 10 };
    f.update();
    f.binding.skip = true;
    f.sampler.changed = true;
    f.sampler.key = 2;
    f.update();
  }
  assert.deepEqual(optimized.trace, [
    ["9,42", 1],
    ["10,42", 1],
    ["10", 0],
  ]);
});

function uniformFixture(Type) {
  const group = new Type("test");
  for (const type of ["int", "uint", "float"])
    group.addUniform({
      isNumberUniform: true,
      boundary: 4,
      itemSize: 1,
      value: 0,
      getValue() {
        return this.value;
      },
      getType() {
        return type;
      },
    });
  // Allocate storage/layout before changing values, as the backend does.
  void group.buffer;
  return group;
}
test("changing integer uniforms reuse views and preserve exact bytes and update ranges", () => {
  const original = uniformFixture(OriginalUniforms),
    optimized = uniformFixture(Uniforms);
  const intView = optimized._getBufferForType("int"),
    uintView = optimized._getBufferForType("uint");
  const flags = optimized._addedIndices;
  for (let frame = 1; frame <= 10000; frame++) {
    for (const g of [original, optimized]) {
      g.uniforms[0].value = -frame;
      g.uniforms[1].value = 0xffffffff - frame;
      g.uniforms[2].value = frame / 8;
      g.update();
      g.addUniformUpdateRange(g.uniforms[0]); // duplicate changes remain deduplicated
    }
    assert.deepEqual(
      new Uint8Array(optimized.buffer.buffer),
      new Uint8Array(original.buffer.buffer),
    );
    assert.deepEqual(optimized.updateRanges, original.updateRanges);
    original.clearUpdateRanges();
    optimized.clearUpdateRanges();
    assert.equal(optimized._getBufferForType("int"), intView);
    assert.equal(optimized._getBufferForType("uint"), uintView);
    assert.equal(optimized._addedIndices, flags);
  }
  optimized.release();
  assert.equal(optimized._intView, null);
  assert.equal(optimized._uintView, null);
  assert.notEqual(optimized._getBufferForType("int").buffer, intView.buffer);
});

test("installed runtime patch is idempotent", async () => {
  const source = await readFile(
    new URL("../node_modules/three/build/three.webgpu.js", import.meta.url),
    "utf8",
  );
  assert.equal(patchRuntime(source), source);
  assert.ok(source.includes("// BakedVoxelLighting allocation patch v2"));
  assert.ok(
    source.includes("// BakedVoxelLighting asynchronous build budget v2"),
  );
});
