import * as T from "three/webgpu";
import * as N from "three/tsl";
import { ResidentPointShadow } from "../src/prepared-shadows.js";
import { readPixels } from "../src/tsl-baking.js";
const output = document.querySelector("#result"),
  errors = [];
const log = console.error;
console.error = (...a) => {
  errors.push(a.map(String).join(" "));
  log(...a);
};
try {
  const backend = new URLSearchParams(location.search).get("backend"),
    renderer = new T.WebGPURenderer({ forceWebGL: backend === "webgl2" });
  await renderer.init();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  const scene = new T.Scene(),
    camera = new T.PerspectiveCamera(60, 1, 0.1, 30),
    target = new T.RenderTarget(96, 96);
  const light = new T.PointLight(0xffffff, 100, 20);
  light.position.set(1, 3, 1);
  light.castShadow = true;
  light.shadow.mapSize.set(256, 256);
  light.shadow.shadowNode = new ResidentPointShadow(light);
  scene.add(light, new T.AmbientLight(0xffffff, 0.1));
  const floor = new T.Mesh(
    new T.PlaneGeometry(15, 15),
    new T.MeshStandardNodeMaterial({ color: 0x8b9954, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const group = new T.Group();
  group.position.set(0.2, 0, -0.3);
  scene.add(group);
  const box = new T.Mesh(
    new T.BoxGeometry(0.7, 2, 0.7),
    new T.MeshStandardNodeMaterial({ color: 0x825031 }),
  );
  box.position.y = 1;
  box.castShadow = true;
  group.add(box);
  const leafMaterial = new T.MeshStandardNodeMaterial({
    color: 0x228844,
    side: T.DoubleSide,
    alphaTest: 0.5,
  });
  leafMaterial.maskNode = N.sin(N.uv().x.mul(24))
    .mul(N.sin(N.uv().y.mul(24)))
    .greaterThan(0);
  const wind = N.uniform(0);
  leafMaterial.positionNode = N.positionLocal.add(
    N.vec3(N.sin(N.positionLocal.y.mul(3).add(wind)).mul(0.15), 0, 0),
  );
  const leaf = new T.Mesh(new T.PlaneGeometry(2, 2, 6, 6), leafMaterial);
  leaf.position.set(-0.7, 1.5, 0);
  leaf.castShadow = true;
  group.add(leaf);
  const hidden = new T.Group();
  hidden.visible = false;
  const hiddenBox = box.clone();
  hiddenBox.position.x = 2;
  hidden.add(hiddenBox);
  scene.add(hidden);
  for (let i = 0; i < 20; i++) {
    const nonCaster = new T.Mesh(
      new T.BoxGeometry(0.2, 0.2, 0.2),
      floor.material,
    );
    nonCaster.position.set(i * 0.2 - 2, 0.1, 2);
    scene.add(nonCaster);
  }
  const checks = [];
  const roots = scene.children;
  for (let view = 0; view < 4; view++) {
    camera.position.set(4 * Math.cos(view), 3, 4 * Math.sin(view));
    camera.lookAt(0, 0.6, 0);
    light.position.x = 1 + view * 0.2;
    wind.value = view * 0.7;
    group.rotation.y = view * 0.2;
    leaf.visible = view !== 2;
    const shots = [],
      draws = [];
    for (const use of [false, true]) {
      light.shadow.shadowNode.useCasterList = use;
      renderer.setRenderTarget(target);
      await renderer.compileAsync(scene, camera);
      renderer.render(scene, camera);
      renderer.info.reset();
      renderer.render(scene, camera);
      draws.push(renderer.info.render.drawCalls);
      renderer.setRenderTarget(null);
      shots.push(
        await readPixels(
          renderer,
          target,
          0,
          0,
          96,
          96,
          new Uint8Array(96 * 96 * 4),
        ),
      );
      if (scene.children !== roots)
        throw Error("Scene roots were not restored");
    }
    let changed = 0,
      maxDelta = 0;
    for (let i = 0; i < shots[0].length; i++) {
      const delta = Math.abs(shots[0][i] - shots[1][i]);
      if (delta) changed++;
      maxDelta = Math.max(maxDelta, delta);
    }
    if (changed || draws[0] !== draws[1])
      throw Error(JSON.stringify({ view, changed, maxDelta, draws }));
    checks.push({ view, changed, maxDelta, draws });
  }
  if (renderer.backend.device)
    await renderer.backend.device.queue.onSubmittedWorkDone();
  await new Promise((r) => setTimeout(r, 100));
  if (errors.length) throw Error(errors.join("\n"));
  output.textContent = JSON.stringify({
    passed: true,
    backend,
    checks,
    errors,
  });
} catch (e) {
  output.textContent = JSON.stringify({
    passed: false,
    error: String(e),
    errors,
  });
}
