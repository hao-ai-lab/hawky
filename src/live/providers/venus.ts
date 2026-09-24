import type { StreamAdapter, StreamInput, StreamOptions } from "../stream-contracts.js";
import { setTimeout as delay } from "node:timers/promises";
import { VenusText, venusPrefill } from "./venus-protocol.js";

export interface VenusConfig { url: string; apiKey?: string }
/** Native Realtime-Venus ServingPort, with the lightweight token decoding proxy. */
export class VenusAdapter implements StreamAdapter {
  private abort = new AbortController();
  private incarnation?: number;
  private seq = 0;
  private audioTime = 0;
  private stopped = false;
  private interacted = false;
  private generation = "";
  private parser = new VenusText();
  private text = "";
  private finished = true;
  private pending: Array<{ text: string; id: string }> = [];
  private playback = new Map<string, { generation: string; seq: number }>();
  private acknowledgements = new Map<string, { prefix: number; played: Set<number> }>();
  private audio: Buffer[] = [];
  private audioBytes = 0;
  private inputQueue = Promise.resolve();
  private queued = 0;
  private silence?: ReturnType<typeof setInterval>;
  private mic = false;
  private firstContext = "";
  private contextInstalled = false;
  private lastImageInput = 0;
  private consumedInput = 0;
  private prefill?: { id: string; count: number; text: string; fence: number };
  constructor(private o: StreamOptions, private config: VenusConfig, private http = fetch) {}
  private async request(path: string, body?: unknown, method = "POST", closing = false) {
    const r = await this.http(`${this.config.url.replace(/\/$/, "")}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
      signal: closing ? AbortSignal.timeout(5000) : AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (r.status === 408 || r.status === 409) return { retry: true, status: r.status };
    if (!r.ok) throw new Error(`Venus ${path.split("/").at(-1)} failed (HTTP ${r.status})`);
    return await r.json() as any;
  }
  private scope() { return { session_id: this.o.id, incarnation: this.incarnation }; }
  async start() {
    const health = await this.request("/hawk/health", undefined, "GET");
    if (health.protocol !== "hawk-venus/1") throw new Error("Use Hawk's Venus decoding bridge, not the demo web port");
    const s = await this.request("/sessions", { session_id: this.o.id, model: "Realtime-Venus-Omni", protocol_version: "realtime-venus-harness/2" });
    if (s.retry) throw new Error("Venus is busy with another session. Close it before connecting Hawk.");
    this.incarnation = s.incarnation;
    if (this.stopped) { await this.closeRemote(); return; }
    this.firstContext = `${this.o.instructions}\nThis is a Venus connection. Use the native delegation control tokens around a precise task when backend help is needed. Do not use JSON function calls. Backend results arrive privately. Do not repeat restored context or speak before new input.\nRestored conversation:\n${this.o.history.map(t => `${t.role}: ${t.text}`).join("\n")}`;
    // ServingPort cannot install quiet context: prefill always resumes a
    // backend turn. Pair it with a typed question, never a voice-start signal
    // (which can otherwise hide the native answer or leave a listening turn).
    this.o.emit({ type: "warning", message: "Venus voice uses the model host's prompt. Saved Hawk text context is restored with your first typed message; microphone-only reconnects start fresh." });
    this.silence = setInterval(() => { if (!this.mic && !this.stopped) { try { this.acceptAudio(Buffer.alloc(3200)); } catch (e) { this.o.emit({ type: "error", message: String(e) }); } } }, 100);
    void this.output().catch(e => { if (!this.stopped) this.o.emit({ type: "error", message: e.message }); });
  }
  private enqueue(fn: () => Promise<void>) {
    if (this.queued >= 30) throw new Error("Venus input backlog exceeded 30 packets; reconnect to recover");
    this.queued++;
    this.inputQueue = this.inputQueue.then(async () => { if (!this.stopped) await fn(); })
      .catch(e => { if (!this.stopped) this.o.emit({ type: "error", message: e.message }); }).finally(() => this.queued--);
  }
  private acceptAudio(bytes: Buffer) {
    this.audio.push(bytes); this.audioBytes += bytes.length;
    if (this.audioBytes < 32000) return;
    const all = Buffer.concat(this.audio); this.audio = []; this.audioBytes = 0;
    const duration = all.length / 32;
    const start = Math.max(this.audioTime, Date.now() - duration); const end = this.audioTime = start + duration;
    this.enqueue(async () => { const r = await this.request(`/sessions/${this.o.id}/audio`, { ...this.scope(), event_seq: ++this.seq,
      start_ms: start, end_ms: end, data: all.toString("base64"), format: "pcm_s16le", sample_rate_hz: 16000, channels: 1, sample_width_bytes: 2 });
      if (r.retry) throw new Error("Venus rejected media input"); });
  }
  input(i: StreamInput) {
    if (this.stopped) return;
    if (i.type === "mic") this.mic = i.enabled;
    if (i.type === "audio") {
      this.mic = true; const bytes = Buffer.from(i.data, "base64");
      // Venus has no input transcript event. RMS is only a quiet-start gate;
      // it is not archived as speech or used to infer a task.
      let energy = 0; for (let n = 0; n < bytes.length; n += 2) energy += (bytes.readInt16LE(n) / 32768) ** 2;
      const voiced = Math.sqrt(energy / (bytes.length / 2)) > 0.02;
      if (voiced && !this.interacted) { this.interacted = true; this.contextInstalled = true; }
      this.acceptAudio(bytes);
    }
    if (i.type === "image") this.enqueue(async () => {
      const r = await this.request(`/sessions/${this.o.id}/video_frame`, { ...this.scope(), event_seq: ++this.seq, captured_at_ms: i.at, data: i.data, mime_type: "image/jpeg" });
      if (r.retry) throw new Error("Venus rejected image input");
      this.lastImageInput = r.input_seq;
    });
    if (i.type === "text") {
      this.interacted = true;
      if (this.firstContext) { this.pending.unshift({ text: this.firstContext, id: crypto.randomUUID() }); this.firstContext = ""; }
      this.o.emit({ type: "caption", id: crypto.randomUUID(), role: "user", text: i.text, final: true });
      this.pending.push({ id: crypto.randomUUID(), text: `New user message: ${i.text}` });
    }
    if (i.type === "playback") {
      const chunk = this.playback.get(i.id); this.playback.delete(i.id);
      // Only actual playback is acknowledged. Never fabricate cumulative
      // progress after mute/interruption (the model server doesn't require it).
      if (chunk && i.played) {
        const ack = this.acknowledgements.get(chunk.generation);
        if (!ack) return;
        ack.played.add(chunk.seq); const previous = ack.prefix;
        while (ack.played.delete(ack.prefix + 1)) ack.prefix++;
        const prefix = ack.prefix;
        if (prefix > previous) this.enqueue(async () => { await this.request(`/sessions/${this.o.id}/playback_ack`, { ...this.scope(), utterance_id: chunk.generation,
          cumulative_played_chunks: prefix, at_ms: Date.now(), caused_by_work_id: null }); });
      }
    }
  }
  context(text: string, announce: boolean) {
    if (!announce && this.firstContext) { this.firstContext += `\n${text}`; return; }
    this.pending.push({ text: `${announce ? "Backend task update" : "Quiet context update"}: ${text}`, id: crypto.randomUUID() });
  }
  private async output() {
    while (!this.stopped) {
      if (this.finished && !this.playback.size && this.interacted && this.pending.length) {
        await this.inputQueue;
        if (this.stopped) return;
        // Install restored history and the fresh question together. A separate
        // prefill would cause Venus to answer the restoration itself.
        const note = this.prefill ??= { id: this.pending[0].id, count: this.pending.length, text: this.pending.map(n => n.text).join("\n"), fence: this.lastImageInput };
        // ServingPort prefill generates before consuming pending media. Drain
        // output until the frame/audio captured with this request is in the KV.
        if (this.consumedInput >= note.fence) {
        const r = await this.request(`/sessions/${this.o.id}/prefill`, { ...this.scope(), work_id: note.id, attempt_id: note.id,
          text_list: [venusPrefill(note.text)], visibility: "private", resume_generation: true });
        if (!r.retry) { this.pending.splice(0, note.count); this.prefill = undefined; this.finished = false; this.contextInstalled = true; }
        }
      }
      const s = await this.request(`/sessions/${this.o.id}/output?incarnation=${this.incarnation}&timeout_s=1`);
      if (s.retry) continue;
      this.consumedInput = Math.max(this.consumedInput, s.input_seq_cutoff ?? 0);
      if (s.generation_id !== this.generation) {
        this.generation = s.generation_id; this.parser = new VenusText(); this.text = "";
        this.acknowledgements.set(this.generation, { prefix: 0, played: new Set() });
        for (const id of this.acknowledgements.keys()) if (id !== this.generation && ![...this.playback.values()].some(p => p.generation === id)) this.acknowledgements.delete(id);
      }
      if (typeof s.text_delta !== "string") throw new Error("Venus bridge did not decode output tokens");
      const parsed = this.parser.feed(s.text_delta); this.finished = s.turn_finished === true;
      if (parsed.visible && this.contextInstalled) { this.text += parsed.visible; this.o.emit({ type: "caption", id: this.generation, role: "assistant", text: this.text, final: false }); }
      if (parsed.request && this.o.bridge && this.contextInstalled) {
        // Natural-language Venus delegation has no execution-mode guarantee.
        // Use the safe serial worker; UI controls still cancel/revise the task.
        void this.o.tool(this.generation, "session_send_message", { message: parsed.request, execution: "serial" })
          .then(receipt => this.context(JSON.stringify(receipt), true))
          .catch(e => this.context(`Delegation failed: ${String(e)}`, true));
      }
      if (s.audio && !parsed.mute && this.contextInstalled) {
        const id = `${this.generation}:${s.audio_chunk_seq}`;
        this.playback.set(id, { generation: this.generation, seq: s.audio_chunk_seq });
        this.o.emit({ type: "audio", id, data: s.audio.data, rate: s.audio.sample_rate_hz });
      }
      if (this.finished) {
        if (this.text.trim()) this.o.emit({ type: "caption", id: this.generation, role: "assistant", text: this.text, final: true });
        if (this.parser.finish().malformed) this.o.emit({ type: "warning", message: "Venus emitted an incomplete delegation; no task was dispatched." });
      }
      // Backend resume may emit listening units using synthesized silence even
      // without a new input bucket. Do not spin those units faster than time.
      if (!s.audio && !this.finished) await delay(1000, undefined, { signal: this.abort.signal });
    }
  }
  private async closeRemote() {
    if (this.incarnation !== undefined) await this.request(`/sessions/${this.o.id}?incarnation=${this.incarnation}&reason=hawk_close`, undefined, "DELETE", true).catch(() => {});
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.silence); this.abort.abort();
    this.pending = []; this.audio = []; this.playback.clear(); await this.closeRemote();
  }
}
