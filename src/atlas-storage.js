// The mip baker keeps level zero unchanged. Use that canonical pixel storage
// for CPU consumers and DataTexture.image too, including older IndexedDB bakes
// that serialized separate copies. All lower mip levels remain intact.
export function shareAtlasBase(record) {
  const base = record.mips?.[0];
  if (!base || base.width !== record.w || base.height !== record.h)
    throw new Error("Atlas base mip dimensions do not match the capture");
  record.data = base.data;
  record.normals = base.normals;
  return record;
}
