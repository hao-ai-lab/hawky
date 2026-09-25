/** Deliberately small PCM endpointing layer for a model that has no audio input. */
export class CueAudio {
  private pre: Buffer[] = [];
  private chunks: Buffer[] = [];
  private quiet = 0;
  private bytes = 0;
  private voiced = 0;
  get speaking() { return this.bytes > 0; }
  push(pcm: Buffer): { started: boolean; utterance?: Buffer } {
    let sum = 0;
    for (let n = 0; n < pcm.length; n += 2) sum += (pcm.readInt16LE(n) / 32768) ** 2;
    const voice = Math.sqrt(sum / (pcm.length / 2)) > 0.015;
    const started = voice && !this.speaking;
    if (started) { this.chunks = this.pre; this.bytes = this.pre.reduce((n, c) => n + c.length, 0); this.pre = []; }
    if (!voice && !this.speaking) { this.pre.push(pcm); while (this.pre.reduce((n, c) => n + c.length, 0) > 9600) this.pre.shift(); return { started }; }
    this.chunks.push(pcm); this.bytes += pcm.length;
    this.quiet = voice ? 0 : this.quiet + pcm.length;
    if (voice) this.voiced += pcm.length;
    return { started, ...((this.quiet >= 19200 || this.bytes >= 384000) ? { utterance: this.flush() } : {}) };
  }
  flush(): Buffer | undefined {
    const result = this.voiced >= 6400 ? Buffer.concat(this.chunks) : undefined;
    this.pre = []; this.chunks = []; this.bytes = this.quiet = this.voiced = 0;
    return result;
  }
}
export function pcmWav(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]);
}

/** Joy's optional TTS adapter: config/append/commit, binary PCM, response.done. */
export function joySpeech(url: string, text: string, voice: string, signal: AbortSignal,
  chunk: (pcm: Buffer) => void, socketFactory = (url: string, apiKey?: string) => apiKey ? new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } }) : new WebSocket(url), apiKey?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = socketFactory(url, apiKey); ws.binaryType = "arraybuffer";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      ws.close(); error ? reject(error) : resolve();
    };
    // Limit stalls, not reply duration: keep receiving while audio progresses.
    const resetIdleTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("JoyAI speech synthesis stopped producing audio for 30 seconds")), 30000);
    };
    resetIdleTimer();
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { finish(); return; }
    ws.addEventListener("open", () => {
      if (settled) return;
      resetIdleTimer();
      ws.send(JSON.stringify({ config: { voice, output_audio_format: "pcm16", sample_rate: 24000 } }));
      ws.send(JSON.stringify({ type: "input_text.append", text }));
      ws.send(JSON.stringify({ type: "input_text.commit" }));
    });
    ws.addEventListener("message", event => {
      if (settled) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          const pcm = Buffer.from(event.data);
          if (pcm.length % 2) throw new Error("JoyAI speech service returned an incomplete PCM sample");
          if (pcm.length) resetIdleTimer();
          chunk(pcm);
        } else {
          const e = JSON.parse(String(event.data));
          if (e.type === "error") throw new Error("JoyAI speech synthesis service failed");
          if (e.type === "response.done") finish();
        }
      } catch (e) { finish(e as Error); }
    });
    ws.addEventListener("error", () => finish(new Error("JoyAI speech service could not connect")));
    ws.addEventListener("close", () => { if (!settled) finish(new Error("JoyAI speech service closed before completion")); });
  });
}
