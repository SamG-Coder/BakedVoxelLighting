import { AtmosphereSynth } from "./ambience-synth.js";
class AtmosphereProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.synth = new AtmosphereSynth(sampleRate);
    this.channels = new Array(10);
    this.port.onmessage = ({ data }) => {
      if (data.type === "bird")
        this.synth.trigger(
          data.slot,
          data.kind,
          data.pitch,
          data.duration,
          data.seed,
        );
      else if (data.type === "environment")
        for (let i = 0; i < 4; i++) this.synth.target[i + 6] = data.levels[i];
    };
  }
  process(inputs, outputs) {
    for (let i = 0; i < 10; i++) this.channels[i] = outputs[i][0];
    this.synth.process(this.channels);
    return true;
  }
}
registerProcessor("woodland-atmosphere", AtmosphereProcessor);
