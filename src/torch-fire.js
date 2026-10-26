import * as T from "three/webgpu";
import * as N from "three/tsl";
import { fullscreen, texRef, readPixels } from "./tsl-baking.js";

// 3D Eulerian heat/fuel field, packed as Z slices for both graphics backends.
// Two render targets keep the same bounded simulation on WebGPU and WebGL2.
export function createTorchFire(renderer) {
  const nx = 32,
    ny = 48,
    nz = 24,
    columns = 6,
    rows = 4;
  const width = nx * columns,
    height = ny * rows,
    step = 1 / 60;
  const targets = [0, 1].map(
    () =>
      new T.RenderTarget(width, height, {
        depthBuffer: false,
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
      }),
  );
  const source = { field: { value: targets[0].texture } };
  const map = texRef(source, "field"),
    time = N.uniform(0);
  const sample = (p) => {
    const c = N.clamp(
      p,
      N.vec3(0.5 / nx, 0.5 / ny, 0.5 / nz),
      N.vec3(1 - 0.5 / nx, 1 - 0.5 / ny, 1 - 0.5 / nz),
    );
    const z = c.z.mul(nz).sub(0.5),
      slice = N.floor(z);
    const at = (k) =>
      map.sample(
        N.vec2(
          k.mod(columns).add(c.x).div(columns),
          N.floor(k.div(columns)).add(c.y).div(rows),
        ),
      );
    return N.mix(at(slice), at(N.min(slice.add(1), nz - 1)), N.fract(z));
  };
  // Render-target sampling uses top-down canonical UVs on both backends.
  const uv = N.uv().flipY(),
    tile = N.floor(uv.mul(N.vec2(columns, rows)));
  const p = N.vec3(
    N.fract(uv.mul(N.vec2(columns, rows))),
    tile.x.add(tile.y.mul(columns)).add(0.5).div(nz),
  );
  const previous = sample(p);
  const noiseP = p.mul(5).add(N.vec3(0, time.mul(-3.2), time.mul(0.8)));
  const turbulence = N.mx_noise_float(noiseP);
  const cross = N.mx_noise_float(noiseP.add(N.vec3(7, 13, 3)));
  const velocity = N.vec3(
    turbulence.mul(1.0),
    previous.r.mul(0.9).add(1.1),
    cross.mul(1.0),
  );
  const field = sample(p.sub(velocity.mul(step)));
  const fuel = N.max(0, field.g.sub(step * 1.4));
  const burn = N.min(field.g, step * 1.4);
  const heat = N.max(
    0,
    field.r
      .add(burn.mul(1.15))
      .sub(step * 0.7)
      .sub(p.y.mul(step * 0.3)),
  );
  const inlet = N.smoothstep(0.035, 0.11, p.y).mul(
    N.float(1).sub(N.smoothstep(0.24, 0.34, p.y)),
  );
  const radius = p.xz.sub(0.5).length();
  const spread = N.smoothstep(0.11, 0.17, radius).mul(
    N.float(1).sub(N.smoothstep(0.22, 0.29, radius)),
  );
  const sourceNoise = N.mx_noise_float(
    N.vec3(p.x.mul(16), time.mul(7.5), p.z.mul(16)),
  )
    .mul(0.55)
    .add(0.65);
  const injection = inlet.mul(spread).mul(sourceNoise);
  const border = N.smoothstep(0, 0.045, p.x)
    .mul(N.smoothstep(0, 0.045, p.z))
    .mul(N.float(1).sub(N.smoothstep(0.955, 1, p.x)))
    .mul(N.float(1).sub(N.smoothstep(0.955, 1, p.z)))
    .mul(N.float(1).sub(N.smoothstep(0.68, 1, p.y)));
  const plume = N.float(1).sub(
    N.smoothstep(0.16, 0.44, radius.add(p.y.mul(0.3))),
  );
  const nextHeat = N.max(heat, injection)
    .mul(border)
    .mul(
      N.exp(
        N.float(1)
          .sub(plume)
          .mul(-step * 3),
      ),
    )
    .clamp(0, 1);
  const nextFuel = N.max(fuel, injection).mul(border).clamp(0, 1);
  const simulation = fullscreen(
    N.vec4(
      nextHeat,
      nextFuel,
      N.smoothstep(0.12, 0.32, nextHeat)
        .mul(N.smoothstep(0.02, 0.1, p.y))
        .mul(N.float(1).sub(N.smoothstep(0.65, 0.9, nextHeat)))
        .mul(N.smoothstep(-0.3, 0.25, turbulence.add(cross.mul(0.4)))),
      1,
    ),
  );
  const energy = N.Fn(() => {
    const sum = N.float(0).toVar(),
      sx = N.float(0).toVar(),
      sy = N.float(0).toVar(),
      temperature = N.float(0).toVar();
    N.Loop(384, ({ i }) => {
      const p = N.vec3(
        N.float(i.mod(8)).add(0.5).div(8),
        N.float(i.div(8).mod(8)).add(0.5).div(8),
        N.float(i.div(64)).add(0.5).div(6),
      );
      const cell = sample(p),
        h = cell.r;
      const e = cell.b;
      sum.addAssign(e);
      sx.addAssign(e.mul(p.x));
      sy.addAssign(e.mul(p.y));
      temperature.addAssign(h.mul(e));
    });
    const divisor = N.max(sum, 0.0001);
    return N.vec4(
      sum.div(384),
      sx.div(divisor),
      sy.div(divisor),
      temperature.div(divisor),
    );
  })();
  const reduction = fullscreen(energy);
  const reduced = new T.RenderTarget(1, 1, { depthBuffer: false });
  const scene = new T.Scene(),
    camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mesh = new T.Mesh(new T.PlaneGeometry(2, 2), simulation);
  scene.add(mesh);
  const stats = {
    dimensions: [nx, ny, nz],
    steps: 0,
    readbacks: 0,
    pending: false,
    energy: 0.12,
    temperature: 0.6,
    centroid: [0.5, 0.3],
    errors: [],
  };
  let current = 0,
    accumulator = 0,
    last = null,
    lastRead = -1,
    ready = false;
  function draw(material, target) {
    mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }
  function tick() {
    time.value += step;
    draw(simulation, targets[1 - current]);
    current = 1 - current;
    source.field.value = targets[current].texture;
    stats.steps++;
  }
  return {
    sample,
    stats,
    async prepare() {
      const old = renderer.getRenderTarget();
      try {
        for (const target of targets) {
          renderer.setRenderTarget(target);
          renderer.clear();
        }
        mesh.material = simulation;
        await renderer.compileAsync(scene, camera);
        mesh.material = reduction;
        await renderer.compileAsync(scene, camera);
        for (let i = 0; i < 60; i++) tick();
        ready = true;
      } finally {
        renderer.setRenderTarget(old);
      }
    },
    advance(seconds, active) {
      const delta =
        last === null ? 0 : Math.max(0, Math.min(0.067, seconds - last));
      last = seconds;
      if (!ready || !active) {
        accumulator = 0;
        return;
      }
      accumulator += delta;
      const old = renderer.getRenderTarget();
      try {
        for (let i = 0; i < 4 && accumulator >= step; i++, accumulator -= step)
          tick();
        if (seconds - lastRead >= 0.1 && !stats.pending) {
          draw(reduction, reduced);
          lastRead = seconds;
          stats.pending = true;
          const bytes = new Uint8Array(4);
          readPixels(renderer, reduced, 0, 0, 1, 1, bytes)
            .then(() => {
              stats.energy = bytes[0] / 255;
              stats.centroid = [bytes[1] / 255, bytes[2] / 255];
              stats.temperature = bytes[3] / 255;
              stats.readbacks++;
            })
            .catch((e) => {
              if (stats.errors.length < 3) stats.errors.push(String(e));
            })
            .finally(() => {
              stats.pending = false;
            });
        }
      } finally {
        renderer.setRenderTarget(old);
      }
    },
  };
}
