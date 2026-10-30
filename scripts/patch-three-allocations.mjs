import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { patchTRAA } from "./patch-three-temporal.mjs";

// Reproducible, version-pinned changes to the runtime bundle used by both
// WebGPU and forceWebGL. No shader equations, bindings or update rates change.
const marker = "// BakedVoxelLighting allocation patch v2";
const yieldMarker = "// BakedVoxelLighting asynchronous build budget v2";
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(`Three allocation patch mismatch: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
export function patchUniforms(source) {
  source = replaceOnce(
    source,
    "clone._addedIndices = new Set();",
    "clone._addedIndices = [];",
  );
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
export function patchAsyncBuilder(source) {
  // Only the async method changes. Keep synchronous builds and shader content
  // identical; allow the host to account CPU work on both sides of every await.
  const start = source.indexOf("\tasync buildAsync( yieldFn = yieldToMain ) {");
  const end = source.indexOf("\n\t}\n", start) + 4;
  if (start < 0 || end < start)
    throw new Error("Missing NodeBuilder.buildAsync");
  let method = source.slice(start, end);
  method = replaceOnce(
    method,
    "yieldFn = yieldToMain",
    "yieldFn = ( pause ) => pause || yieldToMain()",
  );
  method = replaceOnce(
    method,
    "\t\tthis.prebuild();",
    `\t\tconst budgetYield = this.renderer.nodeBuildBudgetYield;
\t\tlet started = budgetYield ? performance.now() : 0;
\t\tthis.prebuild();`,
  );
  method = replaceOnce(
    method,
    "\t\t\t\tawait yieldFn();",
    `\t\t\t\tawait yieldFn( budgetYield?.( performance.now() - started ) || null );
\t\t\t\tif ( budgetYield ) started = performance.now();`,
  );
  method = replaceOnce(
    method,
    "\t\treturn this;",
    `\t\tconst pause = budgetYield?.( performance.now() - started );
\t\tif ( pause ) await yieldFn( pause );
\t\treturn this;`,
  );
  return source.slice(0, start) + method + source.slice(end);
}
export function patchCompileYield(source) {
  // r187 temporarily restores render state while awaiting compilation. The host
  // frame-budget pause must pass through that same save/restore boundary.
  source = replaceOnce(
    source,
    "const yieldPreCompile = async () => {",
    "const yieldPreCompile = async ( budgetPause = null ) => {",
  );
  source = replaceOnce(
    source,
    "if ( scheduler.needsYield() === false ) return;",
    "if ( budgetPause === null && scheduler.needsYield() === false ) return;",
  );
  source = replaceOnce(
    source,
    "await scheduler.yield();\n\n\t\t\tthis._beginPreCompile( activePrecompilationState );",
    "await ( budgetPause || scheduler.yield() );\n\n\t\t\tthis._beginPreCompile( activePrecompilationState );",
  );
  return source;
}
export function patchRuntime(source) {
  source = source.replaceAll("\r\n", "\n");
  const section = (header, patch) => {
    const start = source.indexOf(header);
    const end = source.indexOf("\n}\n", start) + 3;
    if (start < 0 || end < start) throw new Error(`Missing ${header}`);
    source =
      source.slice(0, start) +
      patch(source.slice(start, end)) +
      source.slice(end);
  };
  if (!source.includes(marker)) {
    // r187 now avoids unchanged binding-key allocations upstream.
    section("class UniformsGroup extends UniformBuffer {", patchUniforms);
    source = `${marker}\n${source}`;
  }
  if (!source.includes(yieldMarker)) {
    source = patchCompileYield(patchAsyncBuilder(source));
    source = `${yieldMarker}\n${source}`;
  }
  return source;
}
async function main() {
  const root = new URL("../node_modules/three/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  if (pkg.version !== "0.187.0")
    throw new Error(`Revalidate allocation patches for Three ${pkg.version}`);
  const path = new URL("build/three.webgpu.js", root);
  const source = await readFile(path, "utf8");
  const result = patchRuntime(source);
  if (result !== source) await writeFile(path, result);
  const temporalPath = new URL("examples/jsm/tsl/display/TRAANode.js", root);
  const temporalSource = await readFile(temporalPath, "utf8");
  const temporalResult = patchTRAA(temporalSource);
  if (temporalResult !== temporalSource)
    await writeFile(temporalPath, temporalResult);
  console.log(
    "Three 0.187.0: allocation, shader budget and native temporal history patches installed.",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
