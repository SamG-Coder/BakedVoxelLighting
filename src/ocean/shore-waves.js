import * as T from "three/webgpu";
import * as N from "three/tsl";
import { ref, terrainNode } from "../tsl-baking.js";
import { TERRAIN_GRID } from "../terrain-field.js";
import { computeShoreField, SHORE_SWELL } from "./shore-field.js";

// GPU-side evaluation of the precomputed nearshore swell (see shore-field.js).
// Shared by the ocean surface (waves, swash, foam) and the terrain (wet sand),
// so the water's edge and the darkened sand always agree.

const BORE_FRONT = 0.13; // fraction of a wavelength occupied by a bore face
const UPRUSH = 0.12; // fraction of a swash cycle spent running up the beach

export function createShoreField(heights, N_, size, stride, sea) {
  const field = computeShoreField(heights, N_, size, stride, sea);
  const texture = new T.DataTexture(
    field.data,
    field.grid,
    field.grid,
    T.RGBAFormat,
    T.FloatType,
  );
  texture.minFilter = texture.magFilter = T.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = "Shore swell field";
  return { ...field, texture };
}

export function shoreWaves(U, shore) {
  const time = ref(U, "time");
  const sample = (xz) => terrainNode(shore.texture, xz, shore.grid);
  // Stockdon et al. (2006) R2 run-up from the local beach slope, measured on
  // the same terrain heightfield the sand is rendered from.
  const { period, height: H0 } = SHORE_SWELL;
  const L0 = (9.81 * period * period) / (2 * Math.PI);
  const ground = (xz) => terrainNode(U.terrainField.value, xz, TERRAIN_GRID).r;
  const sampleRunup = (xz) => {
    const e = 3;
    const gx = ground(xz.add(N.vec2(e, 0))).sub(ground(xz.sub(N.vec2(e, 0))));
    const gz = ground(xz.add(N.vec2(0, e))).sub(ground(xz.sub(N.vec2(0, e))));
    const beta = N.clamp(
      N.vec2(gx, gz)
        .length()
        .div(2 * e),
      0.01,
      0.2,
    );
    const setup = beta.mul(0.35 * Math.sqrt(H0 * L0));
    const swash = N.sqrt(beta.mul(beta).mul(0.563).add(0.004)).mul(
      Math.sqrt(H0 * L0),
    );
    return setup.add(swash.mul(0.5)).mul(1.1);
  };
  const TAU = Math.PI * 2;

  /**
   * Water state at xz for still-water depth h (negative on land).
   * psi: 0 at a crest, increasing shorewards.
   */
  function state(xz, h) {
    const s = sample(xz);
    // Filtered unit phasor: its length fades to 0 where swell never arrives.
    const reach = N.clamp(N.length(s.xy), 0, 1);
    const phase = N.atan(s.y, s.x);
    const theta = phase.sub(time.mul(shore.omega));
    const psi = N.fract(theta.div(TAU));
    // Wave sets: crest heights vary along each crest and from set to set.
    const envelope = N.float(0.74).add(
      N.mx_noise_float(N.vec3(xz.mul(0.006), time.mul(0.11))).mul(0.42),
    );
    const a = s.z.mul(envelope).mul(N.smoothstep(0.6, 0.95, reach));
    const breaking = N.select(h.greaterThan(0), s.w, N.float(0));
    // Shoaling crest: trochoidal (sharp crest, flat trough via the
    // horizontal crowding applied in the vertex stage).
    const gerstner = a.mul(N.cos(psi.mul(TAU)));
    // Broken wave: a bore, steep front face then a long gentle back.
    const bore = a.mul(
      N.select(
        psi.lessThan(BORE_FRONT),
        N.float(1).sub(N.smoothstep(0, BORE_FRONT, psi).mul(2)),
        psi
          .sub(BORE_FRONT)
          .div(1 - BORE_FRONT)
          .mul(2)
          .sub(1),
      ),
    );
    const wave = N.mix(gerstner, bore, breaking);
    // Swash: each bore runs up the beach to the local Stockdon run-up R,
    // quickly, then drains back over the rest of the cycle.
    // On land, channel w holds the connected run-up mask from the field.
    const landMask = N.select(
      h.lessThan(0),
      N.smoothstep(0.3, 0.8, s.w),
      N.float(1),
    );
    const runup = sampleRunup(xz)
      .mul(N.smoothstep(0.6, 0.95, reach))
      .mul(landMask);
    const swashShape = N.select(
      psi.lessThan(UPRUSH),
      N.float(1).sub(psi.div(UPRUSH)),
      N.pow(psi.sub(UPRUSH).div(1 - UPRUSH), 1.6),
    );
    // Height the run-up front has reached on the beach face right now.
    const front = runup.mul(swashShape.mul(1.1).sub(0.1));
    // Swash is a thin sheet sliding up the beach behind that front (thicker
    // near the still-water line), never a raised body of water.
    const groundLevel = h.negate();
    // At least ~6 cm: the rendered terrain mesh and the 2 m heightfield
    // differ by a few centimetres, and a thinner sheet flickers along them.
    const film = N.mix(
      0.16,
      0.06,
      N.clamp(groundLevel.div(N.max(runup, 0.05)), 0, 1),
    );
    // Continuous everywhere: where the front has not reached, the level lies
    // below the sand and is hidden by it, so the visible waterline is the smooth
    // contour where this level meets the beach (no jump, no sawtooth edge).
    const swash = N.min(front, groundLevel.add(film));
    const shoreline = N.float(1).sub(N.smoothstep(-0.05, 0.25, h));
    // Backwash is continuous water: near the shore the surface never drops
    // below the swash sheet, so no dry strip opens between sea and sheet.
    const eta = N.mix(wave, N.max(wave, swash), shoreline);
    return {
      s,
      psi,
      a,
      breaking,
      wave,
      swash,
      eta,
      runup,
      shoreline,
      theta,
      front,
      groundLevel,
    };
  }

  /** Local propagation direction and wavenumber from the phasor field. */
  function propagation(xz, st, step) {
    // Phase gradient from neighbouring phasors (wrap-free angle difference).
    const s0 = st.s.xy,
      sx = sample(xz.add(N.vec2(step, 0))).xy,
      sz = sample(xz.add(N.vec2(0, step))).xy;
    const angle = (a, b) =>
      N.atan(a.x.mul(b.y).sub(a.y.mul(b.x)), a.x.mul(b.x).add(a.y.mul(b.y)));
    const gradient = N.vec2(angle(s0, sx), angle(s0, sz)).div(step);
    const k = N.max(gradient.length(), 1e-4);
    return { direction: gradient.div(k), k };
  }

  /**
   * Horizontal displacement (vertex stage): crest crowding for shoaling waves,
   * and a forward lean of the crest as it starts to break, which steepens the
   * face towards vertical (as close to a plunging lip as a height field gets).
   */
  function horizontal(xz, st, step) {
    const { direction, k } = propagation(xz, st, step);
    const crowd = N.min(st.a, N.float(0.8).div(k))
      .mul(N.float(1).sub(st.breaking.mul(0.5)))
      .mul(N.sin(st.psi.mul(TAU)).negate());
    const onset = N.smoothstep(0.08, 0.4, st.breaking).mul(
      N.float(1).sub(N.smoothstep(0.75, 1, st.breaking)),
    );
    const nearCrest = N.min(st.psi, N.float(1).sub(st.psi));
    const lean = onset
      .mul(st.a)
      .mul(1.3)
      .mul(N.exp(nearCrest.div(0.07).pow(2).negate()));
    return direction.mul(crowd.add(lean));
  }

  /** Breaking foam: on bore faces, trailing behind broken crests. */
  function foam(st) {
    const face = N.smoothstep(0, 0.025, st.psi).mul(
      N.float(1).sub(N.smoothstep(0.07, 0.17, st.psi)),
    );
    const trail = N.exp(N.float(1).sub(st.psi).mul(-4));
    return st.breaking
      .mul(face.mul(0.95).add(trail.mul(0.7)))
      .mul(N.smoothstep(0.04, 0.25, st.a));
  }

  /**
   * Sand wetness: 1 while covered by swash, then drying over a few seconds
   * after the backwash uncovers it; permanently damp below the run-up limit.
   */
  function wetness(xz, elevation) {
    const st = state(xz, elevation.negate());
    const R = N.max(st.runup, 1e-3);
    const q = N.clamp(elevation.div(R).add(0.1).div(1.1), 0, 1);
    // Phase at which the draining swash uncovers this height (psi decreases
    // with time at a fixed point).
    const uncovered = N.float(UPRUSH).add(N.pow(q, 1 / 1.6).mul(1 - UPRUSH));
    const level = st.runup.mul(
      N.select(
        st.psi.lessThan(UPRUSH),
        N.float(1).sub(st.psi.div(UPRUSH)),
        N.pow(st.psi.sub(UPRUSH).div(1 - UPRUSH), 1.6),
      )
        .mul(1.1)
        .sub(0.1),
    );
    const submerged = level.greaterThan(elevation);
    const sinceSeconds = N.max(uncovered.sub(st.psi), 0).mul(
      SHORE_SWELL.period,
    );
    const drying = N.exp(sinceSeconds.div(-5));
    const reached = N.float(1).sub(N.smoothstep(0.75, 1.15, elevation.div(R)));
    const damp = reached.mul(0.45);
    const active = N.select(submerged, N.float(1), N.max(drying, damp));
    return N.select(st.runup.greaterThan(0.01), active.mul(reached), 0);
  }

  return { state, horizontal, propagation, foam, wetness, sample };
}
