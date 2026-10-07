/* Microphone PCM is resampled from the actual device rate into 20 ms, 16 kHz frames. */
class SidekickPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pending = new Float32Array(0);
    this.position = 0;
    this.frame = new Int16Array(320);
    this.frameIndex = 0;
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0].length) return true;
    const length = channels[0].length;
    const merged = new Float32Array(this.pending.length + length);
    merged.set(this.pending);
    for (let i = 0; i < length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] || 0;
      merged[this.pending.length + i] = mono / channels.length;
    }
    while (this.position + 1 < merged.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample = merged[index] + (merged[index + 1] - merged[index]) * fraction;
      const clipped = Math.max(-1, Math.min(1, sample));
      this.frame[this.frameIndex++] = clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
      this.position += this.ratio;
      if (this.frameIndex === 320) {
        const buffer = this.frame.buffer;
        this.port.postMessage(buffer, [buffer]);
        this.frame = new Int16Array(320);
        this.frameIndex = 0;
      }
    }
    const consumed = Math.min(Math.floor(this.position), merged.length);
    this.pending = merged.slice(consumed);
    this.position -= consumed;
    /* Never play the microphone back through the speakers. */
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor('sidekick-pcm', SidekickPCMProcessor);
