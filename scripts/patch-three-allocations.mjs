import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Reproducible, version-pinned changes to the runtime bundle used by both
// WebGPU and forceWebGL. No shader equations, bindings or update rates change.
const marker = "// BakedVoxelLighting allocation patch v1";
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(`Three allocation patch mismatch: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
export function patchBindings(source) {
  source = replaceOnce(
    source,
    "\t\tlet cacheKey = '';",
    `\t\tlet cacheKey = '';
\t\tconst groupData = this.get( bindGroup );
\t\tconst keyIds = groupData.allocationKeyIds || ( groupData.allocationKeyIds = new Array( bindGroup.bindings.length ) );
\t\tlet keyCount = 0;`,
  );
  source = replaceOnce(
    source,
    "cacheKey += attribute.id + ',';",
    "keyIds[ keyCount ++ ] = attribute.id;",
  );
  source = replaceOnce(
    source,
    "cacheKey += texture.id + ',';",
    "keyIds[ keyCount ++ ] = texture.id;",
  );
  source = replaceOnce(
    source,
    "\t\tif ( needsBindingsUpdate === true ) {",
    `\t\tif ( needsBindingsUpdate === true ) {

\t\t\t// A cache key is consumed only when bindings actually change.
\t\t\tif ( cacheBindings ) for ( let i = 0; i < keyCount; i ++ ) cacheKey += keyIds[ i ] + ',';`,
  );
  return source;
}
export function patchUniforms(source) {
  source = replaceOnce(
    source,
    "this._addedIndices = new Set();",
    "this._addedIndices = [];\n\t\tthis._intView = this._uintView = null;",
  );
  source = replaceOnce(
    source,
    "this._addedIndices.has( index )",
    "this._addedIndices[ index ] === true",
  );
  source = replaceOnce(
    source,
    "this._addedIndices.add( index );",
    "this._addedIndices[ index ] = true;",
  );
  source = replaceOnce(
    source,
    "this._addedIndices.clear();",
    "this._addedIndices.fill( false );",
  );
  source = replaceOnce(
    source,
    "\t\tsuper.release();\n\n\t\tthis._values = null;",
    "\t\tsuper.release();\n\n\t\tthis._intView = this._uintView = null;\n\t\tthis._values = null;",
  );
  source = replaceOnce(
    source,
    "return new Int32Array( this.buffer.buffer );",
    "return this._intView?.buffer === this.buffer.buffer ? this._intView : ( this._intView = new Int32Array( this.buffer.buffer ) );",
  );
  source = replaceOnce(
    source,
    "return new Uint32Array( this.buffer.buffer );",
    "return this._uintView?.buffer === this.buffer.buffer ? this._uintView : ( this._uintView = new Uint32Array( this.buffer.buffer ) );",
  );
  return source;
}
export function patchRuntime(source) {
  source = source.replaceAll("\r\n", "\n");
  if (source.startsWith(marker)) return source;
  const section = (header, patch) => {
    const start = source.indexOf(header);
    const end = source.indexOf("\n}\n", start) + 3;
    if (start < 0 || end < start) throw new Error(`Missing ${header}`);
    source =
      source.slice(0, start) +
      patch(source.slice(start, end)) +
      source.slice(end);
  };
  section("class Bindings extends DataMap {", patchBindings);
  section("class UniformsGroup extends UniformBuffer {", patchUniforms);
  return `${marker}\n${source}`;
}
async function main() {
  const root = new URL("../node_modules/three/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  if (pkg.version !== "0.186.1")
    throw new Error(`Revalidate allocation patches for Three ${pkg.version}`);
  const path = new URL("build/three.webgpu.js", root);
  const source = await readFile(path, "utf8");
  const result = patchRuntime(source);
  if (result !== source) await writeFile(path, result);
  console.log(
    "Three 0.186.1: lazy binding keys and reusable uniform storage installed.",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
