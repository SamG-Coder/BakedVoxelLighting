import * as T from "three/webgpu";
import * as N from "three/tsl";
import { nativeFunction } from "./native-kernels.js";

import {
  GrassInteractionField,
  GRASS_FIELD_STEP,
  GRASS_FIELD_SIZE,
} from "./grass-interaction-field.js";
// The grass field uses uniform buffers, avoiding another sampled texture binding.
const field = new GrassInteractionField();
const grass = Array.from(
  { length: GRASS_FIELD_SIZE ** 2 },
  () => new T.Vector4(),
);
const oldGrass = grass.map((v) => v.clone());
const grassNode = N.uniformArray(grass),
  oldGrassNode = N.uniformArray(oldGrass);
const water = Array.from({ length: 4 }, () => new T.Vector4(0, 0, 0, -1000));
const oldWater = water.map((v) => v.clone());
const waterNode = N.uniformArray(water),
  oldWaterNode = N.uniformArray(oldWater);
const centre = N.uniform(new T.Vector2());
const enabled = N.uniform(0);
let waterSlot = 0,
  lastWater = -1000,
  lastTime = 0;
let velocityX = 0,
  velocityZ = 0,
  lastX = 0,
  lastZ = 0,
  started = false,
  wasWet = false;
let waterTravel = 0;
export const walkEffectStats = {
  active: false,
  grassContacts: 0,
  waterSteps: 0,
  fieldCells: grass.length,
};
export function updateWalkEffects(active, x, feetY, z, time, wet, waterLevel) {
  enabled.value = active ? 1 : 0;
  walkEffectStats.active = active;
  for (let i = 0; i < 4; i++) oldWater[i].copy(water[i]);
  if (!active) {
    field.reset();
    started = wasWet = false;
    velocityX = velocityZ = waterTravel = 0;
    for (let i = 0; i < 4; i++) water[i].w = -1000;
    return;
  }
  const dt = started
    ? Math.max(0.001, Math.min(0.05, time - lastTime))
    : 1 / 60;
  const moved = started ? Math.hypot(x - lastX, z - lastZ) : 0;
  // Teleports start a clean field instead of injecting an enormous impulse.
  if (moved > 5) {
    field.reset();
    velocityX = velocityZ = 0;
  }
  const blend = 1 - Math.exp(-dt * 18);
  velocityX +=
    ((started && moved < 5 ? (x - lastX) / dt : 0) - velocityX) * blend;
  velocityZ +=
    ((started && moved < 5 ? (z - lastZ) / dt : 0) - velocityZ) * blend;
  field.update(x, z, velocityX, velocityZ, dt);
  centre.value.set(x, z);
  for (let i = 0; i < grass.length; i++) {
    grass[i].fromArray(field.data, i * 4);
    oldGrass[i].fromArray(field.previous, i * 4);
  }
  if (moved > 0.001) walkEffectStats.grassContacts++;
  waterTravel += moved < 5 ? moved : 0;
  if (wet && (!wasWet || (waterTravel > 0.65 && time - lastWater > 0.3))) {
    water[waterSlot].set(x, waterLevel, z, time);
    waterSlot = (waterSlot + 1) % 4;
    lastWater = time;
    waterTravel = 0;
    walkEffectStats.waterSteps++;
  }
  if (!wet) waterTravel = 0;
  lastTime = time;
  lastX = x;
  lastZ = z;
  started = true;
  wasWet = wet;
}

const ripple = nativeFunction(
  `vec3 footRipple(vec3 p,vec4 contact,float time){float t=time-contact.w;if(t<0.||t>2.4||abs(p.y-contact.y)>.65)return vec3(0.);vec2 d=p.xz-contact.xz;float r=length(d);if(r>4.)return vec3(0.);float q=r-t*1.35;float env=.012*exp(-q*q*7.)*(1.-smoothstep(.2,2.4,t))*smoothstep(0.,.07,t);float phase=q*14.;float h=sin(phase)*env;float slope=(14.*cos(phase)-14.*q*sin(phase))*env;return vec3(d.x/max(r,.08)*slope,h,d.y/max(r,.08)*slope);}`,
  `fn footRipple(p:vec3f,contact:vec4f,time:f32)->vec3f{let t=time-contact.w;if(t<0.||t>2.4||abs(p.y-contact.y)>.65){return vec3f(0.);}let d=p.xz-contact.xz;let r=length(d);if(r>4.){return vec3f(0.);}let q=r-t*1.35;let env=.012*exp(-q*q*7.)*(1.-smoothstep(.2,2.4,t))*smoothstep(0.,.07,t);let phase=q*14.;let h=sin(phase)*env;let slope=(14.*cos(phase)-14.*q*sin(phase))*env;return vec3f(d.x/max(r,.08)*slope,h,d.y/max(r,.08)*slope);}`,
);

export function grassContactOffset(
  anchor,
  matrix,
  uvY,
  time,
  previous = false,
) {
  return N.Fn(() => {
    const offset = N.vec3(0).toVar();
    N.If(
      enabled.greaterThan(0).and(N.distance(anchor.xz, centre).lessThan(5.4)),
      () => {
        const grid = anchor.xz.div(GRASS_FIELD_STEP),
          cell = N.floor(grid),
          blend = N.fract(grid);
        const nodes = previous ? oldGrassNode : grassNode;
        const at = (dx, dz) => {
          const x = N.mod(N.mod(cell.x.add(dx), 32).add(32), 32);
          const z = N.mod(N.mod(cell.y.add(dz), 32).add(32), 32);
          return nodes.element(N.int(x.add(z.mul(32)))).xyz;
        };
        offset.assign(
          N.mix(
            N.mix(at(0, 0), at(1, 0), blend.x),
            N.mix(at(0, 1), at(1, 1), blend.x),
            blend.y,
          ),
        );
      },
    );
    const x = matrix.element(0).xyz,
      y = matrix.element(1).xyz,
      z = matrix.element(2).xyz;
    return N.vec3(
      offset.dot(x).div(N.max(x.dot(x), 0.001)),
      offset.dot(y).div(N.max(y.dot(y), 0.001)),
      offset.dot(z).div(N.max(z.dot(z), 0.001)),
    ).mul(uvY.mul(uvY));
  })();
}
export function waterContactOffset(position, time, previous = false) {
  return N.Fn(() => {
    const result = N.vec3(0).toVar();
    N.If(enabled.greaterThan(0), () => {
      for (let i = 0; i < 4; i++)
        result.addAssign(
          ripple({
            p: position,
            contact: (previous ? oldWaterNode : waterNode).element(i),
            time,
          }),
        );
    });
    return result;
  })();
}
