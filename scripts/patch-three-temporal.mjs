// Version-pinned native-resolution TRAA changes. Applied by postinstall, not
// an untracked node_modules edit. Keep upstream clipping/reprojection intact.
const marker = "// BakedVoxelLighting native temporal history v1";
function replace(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(`Three TRAA patch mismatch: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}
export function patchTRAA(source) {
  source = source.replaceAll("\r\n", "\n");
  if (source.includes(marker)) return source;
  source = replace(
    source,
    "\t\tthis._historyRenderTarget.texture.name = 'TRAANode.history';",
    `\t\tthis._historyRenderTarget.texture.name = 'TRAANode.history';
\t\t// Depth has one stable owner even as the two colour targets alternate.
\t\tthis._historyDepthTexture = this._historyRenderTarget.depthTexture;
\t\tthis._historyValid = uniform( 0 );
\t\tthis._historyReset = true;
\t\tthis.currentFrameWeight = 0.05;
\t\tthis.reactiveNode = null;`,
  );
  const start = source.indexOf("\t\tconst viewOffset = {");
  const end = source.indexOf("\n\t}\n", start);
  if (start < 0 || end < start) throw new Error("Missing TRAA view offset");
  source =
    source.slice(0, start) +
    `\t\tconst jitterOffset = _haltonOffsets[ this._jitterIndex ];
\t\tthis.camera.setViewOffset( width, height,
\t\t\tjitterOffset[ 0 ] - 0.5, jitterOffset[ 1 ] - 0.5, width, height );
` +
    source.slice(end);
  source = replace(
    source,
    "\tupdateBefore( frame ) {",
    `\tresetHistory() {
\t\tthis._historyReset = true;
\t}

\tupdateBefore( frame ) {`,
  );
  source = replace(
    source,
    "\t\tconst needsRestart = this._historyRenderTarget.width !== width || this._historyRenderTarget.height !== height;",
    `\t\t// Previous resolve becomes history; reuse the other target for this frame.
\t\tconst next = this._historyRenderTarget;
\t\tthis._historyRenderTarget = this._resolveRenderTarget;
\t\tthis._resolveRenderTarget = next;
\t\tthis._historyNode.value = this._historyRenderTarget.texture;
\t\tthis._textureNode.value = this._resolveRenderTarget.texture;
\t\tconst needsRestart = this._historyReset || this._historyRenderTarget.width !== width || this._historyRenderTarget.height !== height;
\t\tthis._historyValid.value = needsRestart ? 0 : 1;
\t\tthis._historyReset = false;`,
  );
  source = replace(
    source,
    "\t\trenderer.copyTextureToTexture( this._resolveRenderTarget.texture, this._historyRenderTarget.texture );",
    "\t\t// No full-frame colour copy: the next frame reads this resolve target.",
  );
  // Do not redirect the constructor assignment: it records the original owner.
  source = replace(
    source,
    "renderer.copyTextureToTexture( currentDepth, this._historyRenderTarget.depthTexture );",
    "renderer.copyTextureToTexture( currentDepth, this._historyDepthTexture );",
  );
  source = replace(
    source,
    "this._previousDepthNode.value = this._historyRenderTarget.depthTexture;",
    "this._previousDepthNode.value = this._historyDepthTexture;",
  );
  source = replace(
    source,
    "this._historyRenderTarget.depthTexture.type = FloatType;",
    "this._historyDepthTexture.type = FloatType;",
  );
  source = replace(
    source,
    "const historyNode = texture( this._historyRenderTarget.texture );",
    "const historyNode = this._historyNode = texture( this._historyRenderTarget.texture );",
  );
  source = replace(
    source,
    "const currentWeight = float( 0.05 ).toVar(); // A minimum weight",
    `const currentWeight = float( this.currentFrameWeight ).toVar();
\t\t\tif ( this.reactiveNode !== null ) currentWeight.assign( max( currentWeight, this.reactiveNode ) );`,
  );
  source = replace(
    source,
    "hasValidHistory.select( currentWeight.add( motionFactor ).saturate(), 1 )",
    "hasValidHistory.and( this._historyValid.greaterThan( 0.5 ) ).select( currentWeight.add( motionFactor ).saturate(), 1 )",
  );
  return marker + "\n" + source;
}
