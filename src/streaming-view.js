import { Frustum, Matrix4, Sphere } from "three/webgpu";
const frustum = new Frustum(),
  matrix = new Matrix4(),
  bounds = new Sphere();
let ready = false;
// Visibility changes priority, never residency or quality. Include a generous
// cluster radius so partially visible canopies and grass tiles count as visible.
export function updateStreamingView(camera) {
  matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(matrix, camera.coordinateSystem);
  ready = true;
}
export function prioritizeArea(center, priority, radius = 56) {
  if (!ready || !Number.isFinite(priority)) return priority;
  bounds.center.copy(center);
  bounds.radius = radius;
  return priority + (frustum.intersectsSphere(bounds) ? 0 : 2000);
}
