export function encodePcm(bytes: ArrayBuffer) {
  let text = ""; for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}
export function decodePcm(data: string): Float32Array {
  const binary = atob(data);
  if (binary.length % 2) throw new Error("Incomplete PCM sample");
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
}
/** Browser media only; provider JSON, tools and transcripts live elsewhere. */
export class PcmMedia {
  private context = new AudioContext();
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private gain = this.context.createGain();
  private next = 0;
  private sources = new Map<string, AudioBufferSourceNode>();
  private stopped = false;
  private enabled = true;
  private audible = true;
  constructor(private o: { audio: (data: string) => void; played: (id: string, played: boolean) => void; error: (message: string) => void }) {
    this.gain.connect(this.context.destination);
    void this.context.resume().catch(() => {});
  }
  async attach(stream: MediaStream) {
    this.source?.disconnect(); this.capture?.disconnect(); this.sink?.disconnect();
    this.source = undefined; this.capture = undefined;
    if (!stream.getAudioTracks().length || this.stopped) return;
    await this.context.audioWorklet.addModule("/audio/pcm-capture.js");
    if (this.stopped) return;
    this.capture = new AudioWorkletNode(this.context, "hawk-pcm-capture");
    this.capture.port.onmessage = event => { if (this.enabled && !this.stopped) this.o.audio(encodePcm(event.data)); };
    this.source = this.context.createMediaStreamSource(stream);
    // Silent sink keeps capture scheduled without feeding the microphone back.
    this.sink = this.context.createGain(); this.sink.gain.value = 0;
    this.source.connect(this.capture); this.capture.connect(this.sink); this.sink.connect(this.context.destination);
  }
  mic(enabled: boolean) { this.enabled = enabled; }
  speaker(enabled: boolean) {
    this.audible = enabled; this.gain.gain.value = enabled ? 1 : 0;
    if (!enabled) this.interrupt();
  }
  play(id: string, data: string, rate: number) {
    if (this.stopped || !this.audible) { this.o.played(id, false); return; }
    if (![16000, 22050, 24000, 44100, 48000].includes(rate)) { this.o.error("Unsupported provider audio sample rate"); return; }
    if (this.next - this.context.currentTime > 20) { this.o.error("Audio playback fell more than 20 seconds behind. Reconnect to recover."); return; }
    try {
      const pcm = decodePcm(data), buffer = this.context.createBuffer(1, pcm.length, rate);
      buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
      this.sources.set(id, source);
      source.onended = () => { if (this.sources.delete(id)) this.o.played(id, true); source.disconnect(); };
      const start = Math.max(this.context.currentTime, this.next);
      source.start(start); this.next = start + buffer.duration;
    } catch { this.o.error("Provider returned invalid PCM audio"); }
  }
  interrupt() {
    for (const [id, source] of this.sources) { source.onended = null; source.stop(); source.disconnect(); this.o.played(id, false); }
    this.sources.clear(); this.next = this.context.currentTime;
  }
  close() {
    this.stopped = true; this.interrupt(); this.source?.disconnect(); this.capture?.disconnect(); this.sink?.disconnect();
    void this.context.close().catch(() => {});
  }
}
