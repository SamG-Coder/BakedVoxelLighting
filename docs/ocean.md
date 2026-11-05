# Ocean and coast

WebGPU only. The deep-water simulation follows ClearWater 6.1
(SamG-Coder/ClearWater6.1, `src/water.cu`) and runs as handwritten WGSL compute
on the renderer's own `GPUDevice` (`src/ocean/ocean-compute.js`).

## Deep water

- Three band-limited 128 x 128 FFT cascades (389 m, 61.3 m, 9.7 m), wind sea
  plus onshore swell, normalised to a significant wave height.
- Per frame, one compute pass: spectrum evaluation fused with the row IFFT in
  workgroup memory, the column IFFT in place, displacement/slope resolve,
  mip reductions and a dispersive caustic photon map.
- Surface geometry is a world-anchored clipmap (10 levels, 0.25 m to 128 m
  cells, CDLOD geomorphing). Vertices sit on fixed world lattices, so the
  water never slides as the camera moves.
- Pixel shading ports ClearWater's `shade_pixel_pc`: refract the view ray,
  trace it to the seabed, apply caustics and per-channel Beer-Lambert
  absorption along the refracted and sunlight paths, add in-scattering, then
  Fresnel-mix with the reflected sky and add the footprint-scaled sun glint.
  The bed radiance is the terrain already rendered beneath the surface.

## Nearshore waves (`src/ocean/shore-field.js`, `shore-waves.js`)

Linear ray theory over the actual seabed, computed once at load (~0.2 s):

- Dispersion `w^2 = g k tanh(k h)` (Fenton-McKee explicit form) for a 9 s swell.
- Refraction: the eikonal `|grad phase| = k(h)`, solved by fast sweeping from a
  deep-water plane wave through water only, then extended up the beach.
  Crests bend parallel to the depth contours and shorten in the shallows;
  sheltered lagoons receive no swell.
- Shoaling: `H = H0 sqrt(cg0 / cg)`.
- Depth-limited breaking at `H > 0.78 h` (solitary-wave breaker index; Bosboom &
  Stive, *Coastal Dynamics* 5.2.5). Broken waves become bores (steep front,
  long back) with foam on the face and trailing behind. The deep-water FFT
  swell is capped by the same limit in the shallows.
- Swash: each bore runs up the beach to the Stockdon et al. (2006) run-up
  `R2 = 1.1 (0.35 b sqrt(H0 L0) + 0.5 sqrt(H0 L0 (0.563 b^2 + 0.004)))` from the
  local beach slope, then drains. The sand stays wet and glossy while covered,
  dries over ~5 s after the backwash, and stays damp below the run-up limit.

Wave height and breaking are smoothed over ~20 m of reached water and capped
by the Miche steepness limit `H <= 0.142 L tanh(kh)`, so crests stay continuous
instead of rising over every seabed pit. On the beach the swash zone rises
and falls as one water level (the shoreline moves along height contours); the
sheet is continuous (`min(front, ground + film)`, film >= 6 cm), so its edge is
the smooth intersection with the sand. Run-up is flood-filled from the sea, so
isolated hollows stay dry. Whitewater coverage comes from the physics and
erodes a lace/bubble texture streaked along the swell direction; the swash
front carries a foam line. Backlit crests glow green (scattered sunlight), and
distant glints widen with unresolved slope variance (smooth sun path).

The beach itself is wave-planed in terrain generation (heights within ~6 m of
sea level blend to a 12 m blur), carries ripples and grain, and cliffs use
triplanar rock with sedimentary strata.

The phase is stored as a unit phasor so filtering never blends a real phase
with "no wave". Bores and swash geometry fade radially (260-620 m and
70-170 m) where the clipmap cannot resolve them; shading carries them further.

Limitations: a height field, so no overturning lips or spray; no wave-induced
currents, set-up gradients or diffraction around headlands beyond what the
first-arrival eikonal implies; wave sets are a noise envelope, not a spectral
group model.
