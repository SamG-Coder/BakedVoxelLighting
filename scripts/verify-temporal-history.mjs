import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PerspectiveCamera, Color, Texture } from "three/webgpu";
import TRAANode from "three/addons/tsl/display/TRAANode.js";
import { patchTRAA } from "./patch-three-temporal.mjs";

const source = await readFile(
  new URL(
    "../node_modules/three/examples/jsm/tsl/display/TRAANode.js",
    import.meta.url,
  ),
  "utf8",
);
assert.equal(patchTRAA(source), source, "postinstall is idempotent");
const camera = new PerspectiveCamera();
const beauty = {
  isRTTNode: true,
  renderTarget: { texture: { width: 64, height: 32 } },
};
const depth = { value: new Texture() };
const node = new TRAANode(beauty, depth, {}, camera);
node._historyNode = { value: null }; // setup() normally creates this shader binding.
const targets = new Set([node._historyRenderTarget, node._resolveRenderTarget]);
const depthOwner = node._historyDepthTexture.renderTarget;
let active = null,
  output = null,
  draws = 0,
  seeds = 0,
  depths = 0,
  reset = true;
const renderer = {
  toneMapping: 0,
  toneMappingExposure: 1,
  outputColorSpace: "",
  autoClear: true,
  getRenderTarget: () => active,
  setRenderTarget: (t) => {
    active = t;
  },
  getActiveCubeFace: () => 0,
  getActiveMipmapLevel: () => 0,
  getRenderObjectFunction: () => null,
  setRenderObjectFunction() {},
  getPixelRatio: () => 1,
  setPixelRatio() {},
  getMRT: () => null,
  setMRT() {},
  getClearColor: (c) => c.copy(new Color(0)),
  getClearAlpha: () => 1,
  setClearColor() {},
  getScissorTest: () => false,
  setScissorTest() {},
  getDrawingBufferSize: (v) =>
    v.set(
      beauty.renderTarget.texture.width,
      beauty.renderTarget.texture.height,
    ),
  initRenderTarget: (t) => assert.ok(targets.has(t)),
  copyTextureToTexture(from, to) {
    if (from === depth.value) {
      assert.equal(to, node._historyDepthTexture);
      depths++;
    } else {
      assert.equal(
        from,
        beauty.renderTarget.texture,
        "never copy resolved colour into history",
      );
      assert.equal(to, node._historyRenderTarget.texture);
      seeds++;
    }
  },
  render() {
    assert.ok(targets.has(active), "reuse both allocated render targets");
    assert.notEqual(
      node._historyNode.value,
      active.texture,
      "never sample the write target",
    );
    if (!reset)
      assert.equal(node._historyNode.value, output, "read the previous frame");
    assert.equal(
      node._textureNode.value,
      active.texture,
      "present this frame, not previous history",
    );
    assert.equal(node._historyValid.value, reset ? 0 : 1);
    output = active.texture;
    draws++;
  },
};
for (let i = 0; i < 200; i++) {
  reset = i === 0 || i === 41 || i === 93;
  if (i === 41) {
    beauty.renderTarget.texture.width = 96;
    beauty.renderTarget.texture.height = 48;
  }
  if (i === 93) node.resetHistory(); // camera cut/time jump, no resize
  node.updateBefore({ renderer });
  assert.equal(active, null, "restore the incoming render target");
  assert.equal(
    node._historyDepthTexture.renderTarget,
    depthOwner,
    "stable depth ownership",
  );
}
assert.equal(draws, 200);
assert.equal(depths, 200);
assert.equal(seeds, 3, "seed only startup, resize and explicit reset");
assert.equal(targets.size, 2);
node._velocityNode = { setProjectionMatrix() {} };
for (let i = 0; i < 64; i++) {
  node.setViewOffset(1280, 800);
  assert.equal(camera.view.fullWidth, 1280);
  assert.equal(camera.view.fullHeight, 800);
  assert.ok(
    Math.abs(camera.view.offsetX) <= 0.5 &&
      Math.abs(camera.view.offsetY) <= 0.5,
  );
  node.clearViewOffset();
  assert.equal(camera.view.enabled, false);
}
let releases = 0;
for (const t of targets) t.addEventListener("dispose", () => releases++);
node.dispose();
assert.equal(releases, 2, "dispose both retained targets once");
console.log(
  "TRAA history: 200 frames reuse two targets, no colour history copies, correct previous frame, resize/cut resets, stable depth ownership, jitter and disposal passed.",
);
