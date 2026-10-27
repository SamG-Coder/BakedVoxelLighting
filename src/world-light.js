import * as T from "three/webgpu";
import * as N from "three/tsl";
import { fullscreen, readPixels, texRef } from "./tsl-baking.js";
import { uploadTextures } from "./gpu-uploads.js";

const runtimeFields = new WeakMap();
// Shared render-scoped data. The previous implementation introduced an
// object-scoped sun ReferenceNode for every material and calculated the same
// azimuth with atan/mod/floor in every horizon lookup.
export function horizonSunParameters(sun, out) {
  const index = (Math.atan2(sun.x, sun.z) / (Math.PI / 4) + 8) % 8;
  const a = Math.floor(index);
  out.set(
    a + 1,
    ((a + 1) % 8) + 1,
    index - a,
    sun.y / Math.max(Math.hypot(sun.x, sun.z), 0.001),
  );
  return out;
}
function runtimeField(U) {
  let field = runtimeFields.get(U);
  if (!field) {
    const value = new T.Vector4();
    const sun = N.uniform(value)
      .setGroup(N.renderGroup)
      .onRenderUpdate(() =>
        horizonSunParameters(U.liveSunDirection.value, value),
      );
    field = { map: texRef(U, "mossEnvironment"), sun };
    runtimeFields.set(U, field);
  }
  return field;
}

// A resident 256² world field and eight directional horizon tiles. 2.25 MiB,
// independent of streamed fine voxels. Bake once per world; relight at runtime.
export async function prepareWorldLight(renderer, cache, U, identity) {
  const key = "world-horizons-v1:" + identity;
  let record = await cache.get(key);
  const size = 256,
    tiles = 9;
  if (!record) {
    const terrain = N.texture(U.terrainField.value);
    const shelter = N.texture(U.rootField.value);
    const habitat = N.texture(U.mossEnvironment.value);
    const target = new T.RenderTarget(size * tiles, size, {
      depthBuffer: false,
    });
    const fragment = N.Fn(() => {
      const uv = N.uv().flipY();
      const tile = N.floor(uv.x.mul(tiles));
      const q = N.vec2(N.fract(uv.x.mul(tiles)), uv.y);
      // Terrain is a 2001² unfiltered float field; explicit texel access works
      // on baseline adapters without float32-filterable.
      const cell = N.ivec2(N.clamp(q.mul(2000), 0, 2000));
      const ground = terrain.load(cell).r;
      const angle = tile.sub(1).mul(Math.PI / 4);
      const direction = N.vec2(N.sin(angle), N.cos(angle));
      const horizon = N.vec2(0).toVar();
      const distances = N.vec2(2048).toVar();
      N.Loop(24, ({ i }) => {
        const distance = N.float(i).add(1).pow(1.72).mul(4);
        const at = q.add(direction.mul(distance.div(4000)));
        N.If(
          at.greaterThanEqual(0).all().and(at.lessThanEqual(1).all()),
          () => {
            const h = terrain.load(N.ivec2(N.clamp(at.mul(2000), 0, 2000))).r;
            const crown = N.sqrt(shelter.sample(at).g).mul(18);
            const slopes = N.max(
              N.vec2(h, h.add(crown)).sub(ground.add(2)).div(distance),
              0,
            );
            distances.assign(
              N.mix(
                distances,
                N.vec2(distance),
                N.greaterThan(slopes, horizon),
              ),
            );
            horizon.assign(N.max(horizon, slopes));
          },
        );
      });
      const h = habitat.sample(q);
      return N.select(
        tile.lessThan(0.5),
        N.vec4(h.rg, ground.add(512).div(2048), N.exp(h.g.mul(-1.8))),
        N.vec4(N.atan(horizon).div(Math.PI / 2), distances.div(2048)),
      );
    })();
    const quad = new T.QuadMesh(fullscreen(fragment));
    const previous = renderer.getRenderTarget();
    try {
      await renderer.compileAsync(quad, quad.camera);
      renderer.setRenderTarget(target);
      quad.render(renderer);
      const data = new Uint8Array(size * size * tiles * 4);
      await readPixels(renderer, target, 0, 0, size * tiles, size, data);
      record = { data };
      await cache.put(key, record);
    } finally {
      renderer.setRenderTarget(previous);
      quad.material.dispose();
      target.dispose();
    }
  }
  const texture = new T.DataTexture(record.data, size * tiles, size);
  texture.minFilter = texture.magFilter = T.LinearFilter;
  texture.needsUpdate = true;
  await uploadTextures(renderer, [texture]);
  // Replaces the habitat binding: no extra sampler on the terrain material.
  U.mossEnvironment.value.dispose();
  U.mossEnvironment.value = texture;
  return { size, directions: 8, bytes: record.data.byteLength, key };
}

export function worldHabitat(U, p) {
  const q = N.clamp(p.xz.add(2000).div(4000), 0.5 / 256, 1 - 0.5 / 256);
  return runtimeField(U)
    .map.sample(N.vec2(q.x.div(9), q.y))
    .level(0);
}

export function worldSunVisibility(U, p, habitat = worldHabitat(U, p)) {
  const q = N.clamp(p.xz.add(2000).div(4000), 0.5 / 256, 1 - 0.5 / 256);
  const { map, sun } = runtimeField(U);
  const first = map.sample(N.vec2(q.x.add(sun.x).div(9), q.y)).level(0);
  const second = map.sample(N.vec2(q.x.add(sun.y).div(9), q.y)).level(0);
  const horizon = N.mix(first, second, sun.z);
  const height = p.y.sub(habitat.b.mul(2048).sub(512)).sub(2);
  const slope = N.tan(horizon.rg.mul(Math.PI / 2)).sub(
    height.div(N.max(horizon.ba.mul(2048), 8)),
  );
  const elevation = sun.w;
  const terrain = N.smoothstep(
    slope.x.sub(0.025),
    slope.x.add(0.025),
    elevation,
  );
  const canopy = N.smoothstep(slope.y.sub(0.1), slope.y.add(0.1), elevation);
  // Coarse crowns are porous. Fine local voxel and raster shadows add detail.
  return terrain.mul(N.mix(0.45, 1, canopy));
}
