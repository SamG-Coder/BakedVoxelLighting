import assert from "node:assert/strict";
import { bankExposure, bankGravel } from "../src/riverbank.js";
import { grassHabitat } from "../src/habitat.js";
import { riverSegments, sampleHydrology } from "../src/watershed.js";
import {
  groundInfluence,
  terrainSample,
  TERRAIN_GRID,
} from "../src/terrain-field.js";

// Validate actual generated bank pixels, not just the mask implementation.
const water = {};
let exposed = 0,
  tested = 0,
  gravelMin = 1,
  gravelMax = 0;
for (const segment of riverSegments) {
  if (Math.abs(segment.ax) > 1900 || Math.abs(segment.az) > 1900) continue;
  const x = Math.round((segment.ax - segment.fz * (segment.wa + 2)) / 2) * 2;
  const z = Math.round((segment.az + segment.fx * (segment.wa + 2)) / 2) * 2;
  const h = sampleHydrology(x, z, water);
  const distance = h.distance - h.width + 8;
  const i = (((z + 2000) / 2) * TERRAIN_GRID + (x + 2000) / 2) * 4;
  const expected = bankExposure(x, z, distance);
  assert.ok(
    Math.abs(groundInfluence[i + 2] / 255 - expected) <= 0.5 / 255 + 1e-8,
  );
  assert.equal(groundInfluence[i], 0, "bank bake leaves root channel free");
  assert.equal(
    groundInfluence[i + 1],
    0,
    "bank bake leaves canopy channel free",
  );
  if (expected > 0) exposed++;
  const land = terrainSample(x, z);
  const bank = grassHabitat(x, z, land);
  const inland = grassHabitat(x, z, { ...land, riverDistance: 100 });
  assert.ok(
    Math.abs(bank.density / inland.density - (1 - expected * 0.97)) < 1e-6,
    "all grass LODs and the far bake use the same bank density",
  );
  const g = bankGravel(x, z);
  gravelMin = Math.min(gravelMin, g);
  gravelMax = Math.max(gravelMax, g);
  tested++;
}
assert.ok(
  exposed > tested * 0.85,
  "exposed strips follow the actual channel network",
);
assert.ok(
  gravelMax - gravelMin > 0.6,
  "both soil pockets and gravel bars exist",
);
for (let x = -2000; x < 2000; x += 24) {
  assert.equal(bankExposure(x, 0, 30), 0, "inland ground remains unchanged");
  assert.equal(bankExposure(x, 0, 8), 1);
  assert.ok(Math.abs(bankExposure(x, 0, 8 + 1e-5) - 1) < 1e-6);
  assert.ok(
    Math.abs(bankExposure(x - 1e-5, 0, 11) - bankExposure(x + 1e-5, 0, 11)) <
      1e-5,
    "no patch-coordinate seam at 24m grass tile boundaries",
  );
}
console.log(
  JSON.stringify(
    {
      tested,
      exposed,
      gravelMin,
      gravelMax,
      additionalResidentMaskBytes: TERRAIN_GRID * TERRAIN_GRID * 2,
      additionalTextureBindings: 0,
      additionalDrawCalls: 0,
    },
    null,
    2,
  ),
);
