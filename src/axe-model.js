import * as T from "three/webgpu";

// A real solid head and oval, swept handle. The cutting edge is also the
// reference used by the swing collision, rather than an unrelated screen prop.
import { axeHeadGeometry } from "./axe-geometry.js";
function surface(kind, pending) {
  const name = kind === "wood" ? "ash-handle" : "forged-head";
  let loaded, failed;
  pending.push(
    new Promise((resolve, reject) => {
      loaded = resolve;
      failed = reject;
    }),
  );
  const tex = new T.TextureLoader().load(
    `${import.meta.env.BASE_URL}assets/axe/${name}.png`,
    loaded,
    undefined,
    failed,
  );
  tex.colorSpace = T.SRGBColorSpace;
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
export function makeAxe() {
  const group = new T.Group();
  const pending = [];
  group.name = "Forged forest axe";
  const wood = new T.MeshStandardMaterial({
    map: surface("wood", pending),
    roughness: 0.68,
  });
  const iron = new T.MeshStandardMaterial({
    map: surface("iron", pending),
    color: new T.Color().setRGB(4.0, 4.0, 4.0),
    metalness: 0.45,
    roughness: 0.48,
  });
  const edge = new T.MeshStandardMaterial({
    color: 0xa8afb2,
    metalness: 0.72,
    roughness: 0.24,
  });
  const faces = [];
  for (let i = 0; i < 6; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d"),
      grad = ctx.createLinearGradient(0, 0, 0, 32);
    grad.addColorStop(0, i === 3 ? "#474236" : "#abb7c2");
    grad.addColorStop(0.48, "#6b766e");
    grad.addColorStop(1, "#484237");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    faces.push(canvas);
  }
  const environment = new T.CubeTexture(faces);
  environment.colorSpace = T.SRGBColorSpace;
  environment.needsUpdate = true;
  iron.envMap = edge.envMap = environment;
  iron.envMapIntensity = edge.envMapIntensity = 0.65;
  group.userData.metalMaterials = [iron, edge];
  const position = [],
    normal = [],
    uv = [],
    index = [];
  const rings = 32,
    sides = 12;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings,
      y = t * 0.81 - 0.1;
    const cx = 0.025 * Math.sin(t * Math.PI * 1.5) + 0.02 * t;
    const swell =
      1 + 0.35 * Math.exp(-(((t - 0.05) / 0.09) ** 2)) + 0.22 * t * t;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      position.push(
        cx + Math.cos(a) * 0.023 * swell,
        y,
        Math.sin(a) * 0.016 * swell,
      );
      normal.push(Math.cos(a), 0, Math.sin(a));
      uv.push(i / sides, j / rings);
      if (j < rings && i < sides) {
        const n = j * (sides + 1) + i;
        index.push(
          n,
          n + sides + 1,
          n + 1,
          n + 1,
          n + sides + 1,
          n + sides + 2,
        );
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new T.Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  group.add(new T.Mesh(g, wood));
  group.add(new T.Mesh(axeHeadGeometry(), [iron, edge]));
  // Oval haft end and wedged eye, visible on the top of the head.
  const cap = new T.Mesh(new T.CylinderGeometry(0.022, 0.024, 0.012, 12), wood);
  cap.scale.z = 0.68;
  cap.position.set(-0.01, 0.713, 0);
  group.add(cap);
  const wedge = new T.Mesh(new T.BoxGeometry(0.032, 0.014, 0.003), iron);
  wedge.position.set(-0.01, 0.719, 0);
  group.add(wedge);
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = true;
    }
  });
  group.userData.ready = Promise.all(pending);
  return group;
}
