import * as T from "three/webgpu";
// Grain is generated in wood coordinates: pale sapwood surrounds darker heartwood,
// with uneven annual rings on end grain and long fibres on split faces.
export function woodInteriorTexture() {
  const size = 512,
    data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x % 256) / 256,
        v = y / size;
      let shade;
      if (x < 256) {
        const a = (u - 0.5) * 2.5,
          b = (v - 0.5) * 2.5,
          angle = Math.atan2(b, a);
        const r =
          Math.hypot(a, b) *
          (1 + 0.025 * Math.sin(angle * 7) + 0.013 * Math.sin(angle * 13));
        const rings = Math.pow(
          0.5 + 0.5 * Math.sin(r * 155 + Math.sin(r * 19) * 2),
          10,
        );
        shade = 0.75 + 0.14 * Math.min(1, r) - 0.15 * rings;
        if (Math.sin(angle * 37 + r * 2) > 0.998 && r > 0.45) shade -= 0.13;
      } else {
        const grain = Math.sin(u * 265 + Math.sin(v * 13 + u * 12) * 1.4);
        shade =
          0.79 +
          0.055 * grain +
          0.035 * Math.sin(u * 712 + v * 9) -
          0.06 * Math.pow(0.5 + 0.5 * Math.sin(u * 48 + v * 2), 12);
      }
      const noise = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      shade += (noise - Math.floor(noise) - 0.5) * 0.045;
      const i = (x + y * size) * 4;
      data[i] = Math.min(255, 255 * shade);
      data[i + 1] = Math.min(255, 205 * shade);
      data[i + 2] = Math.min(255, 139 * shade);
      data[i + 3] = 255;
    }
  const texture = new T.DataTexture(data, size, size);
  texture.colorSpace = T.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.magFilter = T.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
