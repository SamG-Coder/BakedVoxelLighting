import * as T from "three/webgpu";
import * as N from "three/tsl";
import { ref, terrainNode } from "../tsl-baking.js";
import { skyColour } from "../native-kernels.js";
import { cloudData, cloudAt, CLOUD_SHADOW_STRENGTH } from "../clouds.js";
import { SEA_LEVEL, TERRAIN_SIZE } from "../terrain-math.js";
import { TERRAIN_GRID, terrainPixels } from "../terrain-field.js";
import { createOceanSimulation } from "./ocean-compute.js";
import { createShoreField, shoreWaves } from "./shore-waves.js";

export const oceanStats = {
  enabled: false,
  seaLevel: SEA_LEVEL,
  triangles: 0,
  simulation: null,
};

// World-anchored geometry clipmap. Each level is a (GRID x GRID)-cell square
// whose origin snaps to twice its own cell size, so every vertex sits on a
// fixed world lattice and never slides across the wave field as the camera
// moves. Level l+1 doubles the cell size; its hole (the area of level l) lies
// on its own lattice lines and is discarded exactly.
const GRID = 128;
const LEVELS = 10;
const BASE_CELL = 0.25;
function clipmapGrid() {
  const n = GRID + 1;
  const positions = new Float32Array(n * n * 3);
  const index = [];
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const i = (z * n + x) * 3;
      positions[i] = x - GRID / 2;
      positions[i + 2] = z - GRID / 2;
    }
  for (let z = 0; z < GRID; z++)
    for (let x = 0; x < GRID; x++) {
      const a = z * n + x,
        b = a + 1,
        c = a + n,
        d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

export function createOcean(renderer, scene, U, options = {}) {
  const simulation = createOceanSimulation(renderer, options);
  const sizes = simulation.sizes;
  const sun = ref(U, "liveSunDirection", "vec3").normalize();
  const daylight = ref(U, "daylight");
  const half = TERRAIN_SIZE / 2;

  // Nearshore swell over the real seabed: refraction, shoaling, breaking, swash.
  const shore = createShoreField(
    terrainPixels,
    TERRAIN_GRID,
    TERRAIN_SIZE,
    4,
    SEA_LEVEL,
  );
  const waves = shoreWaves(U, shore);
  // The terrain reads the same field for wet sand.
  U.shoreField = { value: shore.texture };
  U.shoreWaves = waves;
  const displacementMaps = simulation.displacement.map((t) => N.texture(t));
  const slopeMaps = simulation.derivatives.map((t) => N.texture(t));

  const material = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: true,
    side: T.FrontSide,
  });
  material.name = "Ocean";
  material.fog = false;
  material.userData.shading = { water: true };

  const ground = (xz) => terrainNode(U.terrainField.value, xz, TERRAIN_GRID).r;
  const inside = (xz) =>
    N.abs(xz.x)
      .lessThan(half - 2)
      .and(N.abs(xz.y).lessThan(half - 2));
  const bottom = (xz) =>
    N.select(inside(xz), ground(xz), N.float(SEA_LEVEL - 160));
  // Still-water depth; open sea outside the resident heightfield.
  const stillDepth = (xz) => N.float(SEA_LEVEL).sub(bottom(xz));
  // Depth-limited breaking also caps the deep-water spectrum in the shallows
  // (Hs <= gamma h); the shore field carries the shoaled swell there.
  const depthLimit = (h) => N.clamp(h.mul(0.78 / 1.35), 0, 1);
  // Per-level values, bound per draw.
  const cell = N.uniform(1).onObjectUpdate(
    ({ object }) => object.userData.oceanCell,
  );
  const levelOrigin = N.uniform(new T.Vector2()).onObjectUpdate(
    ({ object }) => object.userData.oceanOrigin,
  );
  const hole = N.uniform(new T.Vector4()).onObjectUpdate(
    ({ object }) => object.userData.oceanHole,
  );
  // CDLOD geomorph: towards the outer edge, odd lattice vertices slide onto
  // their even neighbours, so the edge matches the next (coarser) level.
  const lattice = N.positionLocal.xz;
  const edge = N.max(N.abs(lattice.x), N.abs(lattice.y)).div(GRID / 2);
  const morph = N.smoothstep(0.72, 1, edge);
  const morphed = lattice.sub(N.fract(lattice.mul(0.5)).mul(2).mul(morph));
  const world = levelOrigin.add(morphed.mul(cell));
  // Displacement mip follows the (morphed) vertex spacing; no camera-distance
  // terms, so a fixed world point always receives the same displacement.
  const vertexDepth = stillDepth(world);
  const limit = depthLimit(vertexDepth);
  let offset = N.vec3(0);
  for (let c = 0; c < sizes.length; c++) {
    const lod = N.max(0, N.log2(cell.mul(morph.add(1)).div(sizes[c] / 128)));
    offset = offset.add(
      displacementMaps[c]
        .sample(world.div(sizes[c]))
        .level(lod)
        .xyz.mul(c < 2 ? limit : 1),
    );
  }
  const shoreState = waves.state(world, vertexDepth);
  const crowd = waves.horizontal(world, shoreState, 2);
  // Bores and the swash film need fine geometry. Fade them radially (a smooth
  // world-space function, so no clipmap-level squares appear); near the
  // camera every level is fine enough. Shading carries the detail further out.
  const shoreDistance = N.length(world.sub(N.cameraPosition.xz));
  const resolvedWave = N.float(1).sub(N.smoothstep(260, 620, shoreDistance));
  const resolvedSwash = N.float(1).sub(N.smoothstep(70, 170, shoreDistance));
  const shoreEta = N.mix(
    shoreState.wave.mul(resolvedWave),
    shoreState.swash.mul(resolvedSwash),
    shoreState.shoreline,
  );
  offset = offset.add(
    N.vec3(crowd.x, shoreEta, crowd.y).mul(
      N.vec3(resolvedWave, 1, resolvedWave),
    ),
  );
  const worldVarying = N.varying(world, "vOceanWorld");
  const heightVarying = N.varying(offset.y, "vOceanHeight");
  // A trough cannot fall below the seabed it travels over: wherever there is
  // still water, keep at least a thin film above the bed (otherwise shallow
  // flats flash out of the sea as sand islands with foam rims).
  const surfaceY = N.select(
    vertexDepth.greaterThan(0),
    N.max(offset.y, vertexDepth.negate().add(0.06)),
    offset.y,
  );
  material.positionNode = N.vec3(
    world.x.add(offset.x),
    surfaceY.add(SEA_LEVEL),
    world.y.add(offset.z),
  );

  // Pixel shading is a port of ClearWater 6.1 shade_pixel_pc (src/water.cu):
  // refract the view ray at the wave surface, trace it to the actual seabed,
  // light the bed with the caustic photon map, attenuate per channel along the
  // refracted view path plus the sunlight path down, add water in-scattering,
  // then Fresnel-mix with the reflected sky and add the sun highlight.
  // The bed radiance is the rendered terrain under the water surface.
  const caustics = N.texture(simulation.caustics);
  const fragment = N.Fn(() => {
    const xz = worldVarying;
    // The finer level owns this square.
    N.If(
      xz.x
        .greaterThan(hole.x)
        .and(xz.x.lessThan(hole.z))
        .and(xz.y.greaterThan(hole.y))
        .and(xz.y.lessThan(hole.w)),
      () => N.Discard(),
    );
    const p = N.positionWorld;
    const toEye = N.cameraPosition.sub(p);
    const t = N.length(toEye);
    const ray = toEye.negate().div(t);
    const weights = [
      N.float(1),
      N.float(1).sub(N.smoothstep(1200, 3600, t)),
      N.float(1).sub(N.smoothstep(60, 320, t)),
    ];
    const still = stillDepth(xz);
    const limit = depthLimit(still);
    const slope = N.vec4(0).toVar();
    for (let c = 0; c < sizes.length; c++)
      slope.addAssign(
        slopeMaps[c]
          .sample(xz.div(sizes[c]))
          .mul(weights[c])
          .mul(c < 2 ? limit : 1),
      );
    // Nearshore swell slope by finite differences of the same surface.
    // Finite-difference step follows the pixel footprint so distant
    // shore-wave normals are filtered instead of aliasing into sparkle.
    const e = N.max(0.35, t.mul(0.004));
    const here = waves.state(xz, still);
    const ex = waves.state(
      xz.add(N.vec2(e, 0)),
      stillDepth(xz.add(N.vec2(e, 0))),
    );
    const ez = waves.state(
      xz.add(N.vec2(0, e)),
      stillDepth(xz.add(N.vec2(0, e))),
    );
    // Clamped: across the swash sheet's edge the surface steps below the sand,
    // and an unbounded difference there draws a bright glassy rim.
    const shoreSlope = N.clamp(
      N.vec2(ex.eta.sub(here.eta), ez.eta.sub(here.eta)).div(e),
      -0.45,
      0.45,
    );
    // Normal of the displaced (choppy) height field.
    const stretchX = N.max(N.float(1).add(slope.z), 0.2),
      stretchZ = N.max(N.float(1).add(slope.w), 0.2);
    const rawNormal = N.normalize(
      N.vec3(
        slope.x.div(stretchX).add(shoreSlope.x).negate(),
        1,
        slope.y.div(stretchZ).add(shoreSlope.y).negate(),
      ),
    );
    // Unresolved slope variance: flatten the mean normal with distance so the
    // far sea reads as a smooth sheen rather than per-pixel glitter.
    const n = N.normalize(
      N.mix(rawNormal, N.vec3(0, 1, 0), N.smoothstep(250, 3200, t).mul(0.65)),
    );
    const viewCosine = n.dot(ray);
    const nv = N.max(0.02, viewCosine.negate());
    const grazing = N.float(1).sub(N.clamp(nv, 0, 1));
    const grazing2 = grazing.mul(grazing);
    // Roughness-aware Schlick: unresolved slope variance (distance) and wind
    // chop keep the grazing reflectance below a mirror's, so the deep blue
    // body shows instead of pale horizon sky everywhere.
    const roughness = N.float(0.14).add(N.smoothstep(30, 1800, t).mul(0.46));
    const baseFresnel = N.float(0.02037).add(
      N.max(N.float(1).sub(roughness), 0.02037)
        .sub(0.02037)
        .mul(grazing2)
        .mul(grazing2)
        .mul(grazing),
    );
    // A sheet a few cm thick over rippled sand is optically rough: its mirror
    // reflection weakens as it thins instead of reading as a sheet of glass.
    const sheet = N.smoothstep(0.03, 0.45, p.y.sub(bottom(xz)));
    const fresnel = baseFresnel.mul(N.mix(0.45, 1, sheet));
    const reflection = ray.sub(n.mul(viewCosine.mul(2))).toVar();
    reflection.y.assign(N.max(reflection.y, 0.01));
    const reflected = skyColour({
      ray: reflection.normalize(),
      sun,
      cloud: cloudData(U, p, reflection.normalize()),
      daylight,
    });

    // Refracted ray to the seabed: ClearWater's fixed-point bottom search.
    // Water column under this surface point (thin over the swash).
    const depth = N.max(p.y.sub(bottom(xz)), 0.02);
    const transmitted = N.refract(ray, n, 0.7502);
    // Steep shoaling faces refract rays nearly horizontally; bound the
    // bottom search (ClearWater's assumes gentle open-ocean slopes) so it
    // cannot jump across many depths and stripe the seabed and caustics.
    const vertical = N.min(-0.3, transmitted.y);
    const travel = depth.div(vertical.negate()).toVar();
    const bed = p.xz.add(transmitted.xz.mul(travel)).toVar();
    N.Loop(4, () => {
      travel.assign(bottom(bed).sub(p.y).div(vertical));
      bed.assign(p.xz.add(transmitted.xz.mul(travel)));
    });
    travel.assign(N.clamp(travel, 0, depth.mul(3).add(0.5)));
    const bedPoint = N.vec3(bed.x, p.y.add(vertical.mul(travel)), bed.y);

    // Bed radiance: the terrain already rendered at the bed point's pixel.
    const clip = N.cameraProjectionMatrix.mul(
      N.cameraViewMatrix.mul(N.vec4(bedPoint, 1)),
    );
    const bedUV = clip.xy.div(clip.w).mul(N.vec2(0.5, -0.5)).add(0.5);
    const onScreen = bedUV.x
      .greaterThan(0.001)
      .and(bedUV.x.lessThan(0.999))
      .and(bedUV.y.greaterThan(0.001))
      .and(bedUV.y.lessThan(0.999))
      .and(clip.w.greaterThan(0));
    const bedColour = N.viewportSharedTexture(
      N.select(onScreen, bedUV, N.screenUV),
    ).rgb;

    const causticDetail = N.float(1).div(t.mul(t).mul(0.0008).add(1));
    const shadow = N.float(1).sub(
      cloudAt(U, p, sun).mul(CLOUD_SHADOW_STRENGTH),
    );
    const ca = N.mix(
      N.vec3(1),
      caustics.sample(bed.div(simulation.causticSize)).rgb,
      causticDetail
        .mul(shadow)
        .mul(N.smoothstep(0.08, 1.2, depth))
        .mul(0.85),
    ).mul(N.float(0.32).add(shadow.mul(0.68)));
    // Light travels down through the water before returning along the view.
    const opticalDistance = travel.add(depth.div(0.86));
    // Surf-zone water is turbid: breaking stirs sand and air into the column,
    // so the bed disappears between crests instead of showing through.
    const turbid = N.max(
      N.smoothstep(0.05, 0.5, here.breaking).mul(
        N.float(1).sub(N.smoothstep(2.5, 6, depth)),
      ),
      here.shoreline.mul(0.55),
    ).mul(0.85);
    const atten = N.exp(
      N.mix(N.vec3(0.19, 0.09, 0.055), N.vec3(1.7, 1.45, 1.25), turbid)
        .mul(opticalDistance)
        .negate(),
    );
    const day = N.float(0.015).add(
      N.float(0.985).mul(N.smoothstep(-0.08, 0.3, sun.y)),
    );
    // ClearWater scales the whole transmitted term by daylight because its bed
    // is albedo. The rendered bed is already lit, so only in-scatter is scaled.
    const lit = bedColour
      .mul(ca.mul(0.95).add(0.12))
      .mul(atten)
      .add(
        N.mix(N.vec3(0.008, 0.042, 0.075), N.vec3(0.085, 0.105, 0.088), turbid)
          .mul(N.float(1).sub(atten))
          .mul(day),
      );
    // Sunlight scattered through thin, backlit crests (the green glow of a
    // wave face seen against the sun).
    const flatRay = N.normalize(N.vec3(ray.x, 0, ray.z));
    const flatSun = N.normalize(N.vec3(sun.x, 0, sun.z));
    const backlit = N.pow(N.max(flatRay.dot(flatSun), 0), 3);
    const thickness = N.clamp(heightVarying.add(0.15), 0, 1.4);
    const crestGlow = N.vec3(0.03, 0.24, 0.19)
      .mul(ref(U, "sunColour", "vec3"))
      .mul(backlit)
      .mul(thickness)
      .mul(N.float(0.4).add(N.max(n.dot(ray.negate()), 0).mul(0.6)))
      .mul(N.max(sun.y, 0).add(0.15))
      .mul(shadow)
      .mul(day);
    const col = N.mix(lit.add(crestGlow), reflected, fresnel).toVar();

    // Sun highlight, sharpened by ClearWater's pixel-footprint rule.
    const footprint = t.div(N.screenSize.y);
    const halfv = sun.sub(ray).normalize();
    // Toksvig-style: unresolved slope variance widens and dims the glint
    // with distance, so far water shows a smooth sun path, not sparkle.
    const variance = N.smoothstep(60, 1600, t);
    const glintNormal = N.normalize(
      N.mix(n, N.vec3(0, 1, 0), variance.mul(0.75)),
    );
    const specPower = N.mix(
      N.mix(320, 90, variance),
      8000,
      N.float(1).div(footprint.mul(footprint).mul(800).add(1)),
    );
    const spec = N.pow(N.max(0, glintNormal.dot(halfv)), specPower)
      .mul(3.5)
      .mul(specPower.div(8000));
    col.addAssign(
      N.vec3(1, 0.89, 0.68)
        .mul(spec)
        .mul(shadow)
        .mul(N.smoothstep(-0.02, 0.08, sun.y)),
    );
    // Whitewater. Coverage comes from the physics (breaking bores, the swash
    // front); a bubble/lace texture is eroded by that coverage, so dense foam
    // is solid and decaying foam breaks into lace instead of fading as a veil.
    const drift = N.time.mul(0.18);
    // Flow-mapped foam: the texture is carried shorewards with the waves
    // (two offset phases cross-faded, so it never stretches without bound).
    const flow = waves.propagation(xz, here, N.max(0.5, e.mul(2)));
    // Residual foam drifts slowly shorewards; it does not race at wave speed.
    const speed = N.float(0.55);
    const period = 6;
    const foamAt = (q) => {
      // Foam streaks run along the swell's travel direction.
      const along = N.vec2(0.996, -0.09),
        across = N.vec2(0.09, 0.996);
      const streak = N.vec2(q.dot(along).mul(0.55), q.dot(across).mul(0.16));
      const lace = N.mx_fractal_noise_float(
        N.vec3(streak, drift),
        4,
        2.05,
        0.55,
        0.5,
      ).add(0.5);
      const bubbles = N.float(1).sub(
        N.clamp(
          N.mx_worley_noise_float(N.vec3(q.mul(1.2), drift.mul(2))),
          0,
          1,
        ),
      );
      return N.clamp(lace.mul(0.78).add(bubbles.mul(0.22)), 0, 1);
    };
    const phaseA = N.fract(N.time.div(period)),
      phaseB = N.fract(N.time.div(period).add(0.5));
    const foamA = foamAt(
      xz.sub(flow.direction.mul(speed.mul(phaseA).mul(period))).add(7.3),
    );
    const foamB = foamAt(
      xz.sub(flow.direction.mul(speed.mul(phaseB).mul(period))).sub(4.1),
    );
    const foamTexture = N.mix(foamA, foamB, N.abs(phaseA.mul(2).sub(1)));
    const film = p.y.sub(bottom(xz));
    // Only the advancing edge of the swash sheet foams (strongest on uprush).
    const uprush = N.float(1).sub(N.smoothstep(0.1, 0.16, here.psi));
    const swashFront = here.shoreline
      // Foam rides the leading ~10 cm (in height) of the run-up front.
      .mul(
        N.float(1).sub(N.smoothstep(0, 0.3, here.front.sub(here.groundLevel))),
      )
      .mul(N.step(here.groundLevel, here.front))
      .mul(N.smoothstep(0.02, 0.2, here.runup))
      .mul(N.mix(0.55, 1.15, uprush))
      // Residual lace left on the draining sheet.
      .add(here.shoreline.mul(0.28).mul(N.step(here.groundLevel, here.front)));
    // Capped so even dense whitewater keeps texture; eroded into lace below.
    const coverage = N.clamp(waves.foam(here).add(swashFront), 0, 0.92);
    const foam = N.clamp(
      coverage.mul(0.95).sub(N.float(1).sub(foamTexture)).mul(2.4),
      0,
      1,
    );
    const sunlight = ref(U, "sunColour", "vec3")
      .mul(N.max(n.dot(sun), 0))
      .mul(shadow);
    const skylight = N.vec3(0.32, 0.4, 0.5).mul(daylight);
    // Thicker foam is brighter; thin foam lets the water show through.
    const foamColour = N.mix(
      N.vec3(0.62, 0.7, 0.72),
      N.vec3(0.93, 0.95, 0.95),
      foamTexture,
    ).mul(sunlight.add(skylight));
    col.assign(N.mix(col, foamColour, foam.mul(0.94)));
    return N.vec4(col, 1);
  })();
  material.colorNode = fragment.rgb;
  material.opacityNode = fragment.a;

  const geometry = clipmapGrid();
  const levels = [];
  const group = new T.Group();
  group.name = "Ocean";
  for (let l = 0; l < LEVELS; l++) {
    const mesh = new T.Mesh(geometry, material);
    mesh.name = `Ocean level ${l}`;
    mesh.frustumCulled = false;
    // Transparent queue: the opaque seabed is rendered (and copied for the
    // bed radiance) first. The surface writes depth for the atmosphere pass.
    mesh.renderOrder = 1;
    mesh.userData.oceanCell = BASE_CELL * 2 ** l;
    mesh.userData.oceanOrigin = new T.Vector2();
    mesh.userData.oceanHole = new T.Vector4(1, 1, -1, -1);
    levels.push(mesh);
    group.add(mesh);
  }
  scene.add(group);
  const mesh = group;

  Object.assign(oceanStats, {
    enabled: true,
    triangles: (geometry.index.count / 3) * LEVELS,
    clipmap: { levels: LEVELS, grid: GRID, baseCell: BASE_CELL },
    simulation: simulation.stats,
  });

  return {
    mesh,
    simulation,
    caustics: simulation.caustics,
    causticSize: simulation.causticSize,
    update(camera, seconds, sunDirection) {
      let previous = null;
      for (const level of levels) {
        const cellSize = level.userData.oceanCell,
          snap = cellSize * 2;
        level.userData.oceanOrigin.set(
          Math.round(camera.position.x / snap) * snap,
          Math.round(camera.position.z / snap) * snap,
        );
        if (previous) {
          const extent = (previous.userData.oceanCell * GRID) / 2,
            p = previous.userData.oceanOrigin;
          level.userData.oceanHole.set(
            p.x - extent,
            p.y - extent,
            p.x + extent,
            p.y + extent,
          );
        }
        previous = level;
      }
      simulation.update(seconds, sunDirection);
    },
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      material.dispose();
      simulation.dispose();
    },
  };
}
