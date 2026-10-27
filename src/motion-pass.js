// Decide while building the shader, not per vertex or per frame. Shadow,
// reflection and surface-bake passes do not consume previous-frame positions.
export function needsMotionVectors(builder) {
  return builder.renderer.getMRT()?.has("velocity") === true;
}
