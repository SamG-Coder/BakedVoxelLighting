import assert from "node:assert/strict";
import * as T from "three/webgpu";
import { collectShadowRoots } from "../src/prepared-shadows.js";
const scene = new T.Scene(),
  group = new T.Group(),
  hidden = new T.Group();
scene.add(group, hidden);
hidden.visible = false;
const caster = new T.Mesh(),
  ignored = new T.Mesh(),
  child = new T.Mesh();
caster.castShadow = true;
child.castShadow = true;
caster.add(child);
group.add(caster, ignored);
const hiddenCaster = new T.Mesh();
hiddenCaster.castShadow = true;
hidden.add(hiddenCaster);
const original = [...scene.children],
  roots = [];
assert.deepEqual(collectShadowRoots(scene, roots), [caster]);
assert.equal(caster.parent, group);
assert.deepEqual(scene.children, original);
group.renderOrder = 2;
assert.deepEqual(collectShadowRoots(scene, roots), [group]);
group.renderOrder = 0;
const lod = new T.LOD();
scene.add(lod);
assert.deepEqual(collectShadowRoots(scene, roots), [caster, lod]);
caster.visible = false;
assert.deepEqual(collectShadowRoots(scene, roots), [lod]);
console.log(
  "Shadow traversal preserves hidden parents, caster subtrees, ordering, LOD containers and original parenting",
);
