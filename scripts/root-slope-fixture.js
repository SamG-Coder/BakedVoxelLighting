import * as T from "three/webgpu";
import * as N from "three/tsl";
import { growPlant } from "/src/growth.js";
import { rootConformPosition } from "/src/root-conform.js";
import {
  AttributeInstances,
  attributeInstanceMatrix,
} from "/src/attribute-instances.js";
const report = document.querySelector("#report");
window.addEventListener(
  "error",
  (e) => (report.textContent += "\nERROR " + e.message),
);
const oldError = console.error;
console.error = (...a) => {
  report.textContent += "\nERROR " + a.join(" ");
  oldError(...a);
};
const gl = new URLSearchParams(location.search).get("backend") === "webgl2";
const renderer = new T.WebGPURenderer({ antialias: true, forceWebGL: gl });
await renderer.init();
renderer.setSize(1100, 760);
document.body.append(renderer.domElement);
const scene = new T.Scene();
scene.background = new T.Color("#acbdcb");
const camera = new T.PerspectiveCamera(42, 1100 / 760, 0.1, 100);
camera.position.set(4, 2.2, 6);
camera.lookAt(0, 0.45, 0);
scene.add(new T.HemisphereLight(0xc5e0ff, 0x515332, 2));
const sun = new T.DirectionalLight(0xffe6c0, 3);
sun.position.set(-4, 5, 5);
scene.add(sun);
const grid = 2001,
  data = new Float32Array(grid * grid * 4);
const height = (x, z) =>
  -0.65 * x + 0.16 * Math.sin(z * 1.5) + 0.1 * Math.sin(x * 2);
for (let z = 0; z < grid; z++)
  for (let x = 0; x < grid; x++)
    data[(z * grid + x) * 4] = height(x * 2 - 2000, z * 2 - 2000);
const field = new T.DataTexture(data, grid, grid, T.RGBAFormat, T.FloatType);
field.needsUpdate = true;
// Match bilinear terrain samples rather than compare the shader to a different surface.
function ground(x, z) {
  let gx = (x + 2000) / 2,
    gz = (z + 2000) / 2,
    ix = Math.floor(gx),
    iz = Math.floor(gz),
    u = gx - ix,
    v = gz - iz;
  const at = (a, b) => data[((iz + b) * grid + ix + a) * 4];
  return (
    (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) +
    (at(0, 1) * (1 - u) + at(1, 1) * u) * v
  );
}
const geo = new T.PlaneGeometry(16, 16, 128, 128);
geo.rotateX(-Math.PI / 2);
const pos = geo.attributes.position;
for (let i = 0; i < pos.count; i++)
  pos.setY(i, ground(pos.getX(i), pos.getZ(i)));
geo.computeVertexNormals();
scene.add(
  new T.Mesh(
    geo,
    new T.MeshStandardNodeMaterial({ color: 0x727c42, roughness: 1 }),
  ),
);
const plant = growPlant(10075, 2, false, 2),
  levels = [plant.high, plant.low, plant.farWood];
const material = new T.MeshStandardNodeMaterial({
  color: 0x8a674b,
  roughness: 1,
});
const fitted = rootConformPosition(field, grid, attributeInstanceMatrix);
material.positionNode = fitted;
let transformed = false,
  level = 0,
  mesh;
function make() {
  if (mesh) {
    scene.remove(mesh);
    mesh.dispose();
  }
  mesh = new AttributeInstances(levels[level], material, 1, true);
  const pose = new T.Object3D();
  if (transformed) {
    pose.position.set(1.3, ground(1.3, 0.7), 0.7);
    pose.rotation.y = 1.1;
    pose.scale.setScalar(1.4);
  }
  pose.updateMatrix();
  camera.position
    .copy(pose.position)
    .add(new T.Vector3(5, 3, 8).multiplyScalar(pose.scale.x));
  camera.lookAt(
    pose.position.x,
    pose.position.y + 0.3 * pose.scale.x,
    pose.position.z,
  );
  mesh.setMatrixAt(0, pose.matrix);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  report.textContent = `${gl ? "WebGL2" : "WebGPU"} | wood L${level} | terrain fitting ${material.positionNode ? "on" : "off"} | transformed ${transformed}`;
}
make();
document.querySelector("#toggle").onclick = () => {
  material.positionNode = material.positionNode ? null : fitted;
  material.needsUpdate = true;
  make();
};
document.querySelector("#lod").onclick = () => {
  level = (level + 1) % 3;
  make();
};
renderer.setAnimationLoop(() => renderer.render(scene, camera));
const transform = document.createElement("button");
transform.textContent = "Rotate / scale / translate";
document.body.insertBefore(transform, renderer.domElement);
transform.onclick = () => {
  transformed = !transformed;
  make();
};
