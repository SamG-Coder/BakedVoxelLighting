function hash(x, z) {
  let n = Math.imul(x, 374761393) + Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
export function noise(x, z) {
  const a = Math.floor(x),
    b = Math.floor(z),
    u = x - a,
    v = z - b,
    s = u * u * (3 - 2 * u),
    t = v * v * (3 - 2 * v);
  return (
    (hash(a, b) * (1 - s) + hash(a + 1, b) * s) * (1 - t) +
    (hash(a, b + 1) * (1 - s) + hash(a + 1, b + 1) * s) * t
  );
}
export function fbm(x, z) {
  let a = 1,
    f = 0,
    sum = 0;
  for (let k = 0; k < 5; k++) {
    f += noise(x, z) * a;
    sum += a;
    a *= 0.48;
    x = x * 2.03 + 17;
    z = z * 2.03 - 13;
  }
  return f / sum;
}
