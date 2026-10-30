self.onmessage = ({ data: { id, layers } }) => {
  try {
    const levels = layers[0].map((level, mip) => {
      const { width, height } = level,
        stride = width * height * 4;
      const data = new Uint8Array(stride * layers.length);
      const normals = new Uint8Array(data.length);
      for (let layer = 0; layer < layers.length; layer++) {
        const source = layers[layer][mip];
        if (source.width !== width || source.height !== height)
          throw Error("Terrain layer dimensions differ");
        data.set(source.data, layer * stride);
        normals.set(source.normals, layer * stride);
        for (let i = 0; i < stride; i += 4) {
          // No authored height exists in these textures. A bounded luminance
          // micro-height proxy breaks up the blend, without moving geometry.
          data[layer * stride + i + 3] = Math.round(
            source.data[i] * 0.2126 +
              source.data[i + 1] * 0.7152 +
              source.data[i + 2] * 0.0722,
          );
          normals[layer * stride + i + 3] = layer === 0 ? 245 : 225;
        }
      }
      return { width, height, depth: layers.length, data, normals };
    });
    self.postMessage(
      { id, result: levels },
      levels.flatMap((l) => [l.data.buffer, l.normals.buffer]),
    );
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
