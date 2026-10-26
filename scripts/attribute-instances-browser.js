import * as T from "three/webgpu";
import { AttributeInstances } from "../src/attribute-instances.js";
import { readPixels } from "../src/tsl-baking.js";
const out = document.querySelector("#result");
try {
  const renderer = new T.WebGPURenderer({
    forceWebGL: location.search.includes("webgl2"),
  });
  await renderer.init();
  renderer.backend.capabilities.getUniformBufferLimit = () => 0;
  const camera = new T.PerspectiveCamera(50, 1, 0.1, 100),
    scene = new T.Scene();
  camera.position.set(0, 2, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.add(new T.HemisphereLight(0xffffff, 0x334422, 2));
  const sun = new T.DirectionalLight(0xffffff, 3);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const target = new T.RenderTarget(128, 128);
  renderer.setRenderTarget(target);
  const make = () => new T.MeshStandardNodeMaterial({ roughness: 0.8 });
  const native = new T.InstancedMesh(
    new T.CylinderGeometry(0.2, 0.5, 3, 7),
    make(),
    2,
  );
  const dummy = new T.Object3D();
  for (let i = 0; i < 2; i++) {
    dummy.position.set(i * 2 - 1, 0, -i);
    dummy.rotation.set(0.1, i * 0.7, 0.2);
    dummy.scale.set(0.7, 1.1, 0.8);
    dummy.updateMatrix();
    native.setMatrixAt(i, dummy.matrix);
    native.setColorAt(i, new T.Color(i ? 0.1 : 0.6, 0.4, i ? 0.6 : 0.1));
  }
  const read = async (mesh) => {
    scene.add(mesh);
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    const data = await readPixels(
      renderer,
      target,
      0,
      0,
      128,
      128,
      new Uint8Array(128 * 128 * 4),
    );
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    canvas
      .getContext("2d")
      .putImageData(new ImageData(new Uint8ClampedArray(data), 128, 128), 0, 0);
    document.body.append(canvas);
    scene.remove(mesh);
    return data;
  };
  const reference = await read(native);
  const makeTile = () => {
    const mesh = new AttributeInstances(native.geometry.clone(), make(), 2);
    mesh.instanceMatrix.array.set(native.instanceMatrix.array);
    mesh.instanceColor.array.set(native.instanceColor.array);
    mesh.instanceMatrix.needsUpdate = mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  };
  const tile = makeTile(),
    result = await read(tile);
  const statesBefore = renderer._nodes.nodeBuilderCache.size;
  const second = makeTile();
  await read(second);
  const statesAfter = renderer._nodes.nodeBuilderCache.size;
  let changed = 0,
    maxDifference = 0;
  for (let i = 0; i < result.length; i++) {
    const d = Math.abs(result[i] - reference[i]);
    if (d) changed++;
    maxDifference = Math.max(maxDifference, d);
  }
  if (maxDifference > 1 || statesAfter !== statesBefore)
    throw Error(
      JSON.stringify({ changed, maxDifference, statesBefore, statesAfter }),
    );
  // Shared shader state must bind each draw's own matrix/colour attributes.
  native.instanceMatrix.array[12] += 0.8;
  native.instanceMatrix.needsUpdate = true;
  native.instanceColor.array[0] = 0.2;
  native.instanceColor.needsUpdate = true;
  native.count = 1;
  second.instanceMatrix.array.set(native.instanceMatrix.array);
  second.instanceMatrix.needsUpdate = true;
  second.instanceColor.array.set(native.instanceColor.array);
  second.instanceColor.needsUpdate = true;
  second.instanceCount = 1;
  second.computeBoundingSphere();
  native.computeBoundingSphere();
  const movedReference = await read(native),
    moved = await read(second);
  for (let i = 0; i < moved.length; i++)
    if (Math.abs(moved[i] - movedReference[i]) > 1)
      throw Error("Shared shader used another tile buffer");
  out.textContent = JSON.stringify({
    passed: true,
    changed,
    maxDifference,
    statesBefore,
    statesAfter,
  });
} catch (error) {
  out.textContent = JSON.stringify({
    passed: false,
    error: String(error),
    stack: error.stack,
  });
}
