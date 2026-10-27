import { generateTerrain } from "./terrain-generation.js";
self.onmessage = () => {
  try {
    const result = generateTerrain();
    self.postMessage(result, [
      result.heights.buffer,
      result.traffic.buffer,
      result.moisture.buffer,
      result.slopes.buffer,
      result.roadVerge.buffer,
    ]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
