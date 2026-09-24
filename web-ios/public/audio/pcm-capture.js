// AudioWorklet: bounded 100 ms PCM16 packets at 16 kHz. Fractional source
// position survives render quanta; never independently round each 128 frames.
class HawkCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; this.packet = []; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.samples.push(...input);
    const step = sampleRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const lo = Math.floor(this.position), f = this.position - lo;
      const value = this.samples[lo] * (1 - f) + this.samples[lo + 1] * f;
      this.packet.push(Math.max(-32768, Math.min(32767, Math.round(value * 32768))));
      this.position += step;
      if (this.packet.length === 1600) {
        const bytes = new ArrayBuffer(3200), view = new DataView(bytes);
        this.packet.forEach((value, i) => view.setInt16(i * 2, value, true));
        this.port.postMessage(bytes, [bytes]); this.packet = [];
      }
    }
    const consumed = Math.floor(this.position);
    this.samples.splice(0, consumed); this.position -= consumed;
    return true;
  }
}
registerProcessor('hawk-pcm-capture', HawkCapture);
