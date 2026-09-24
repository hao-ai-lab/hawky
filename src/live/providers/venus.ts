import type { StreamAdapter, StreamInput, StreamOptions, StreamTaskUpdate } from "../stream-contracts.js";
import { setTimeout as delay } from "node:timers/promises";
import { venusPrefill } from "./venus-protocol.js";
import { VenusSession } from "./venus-session.js";

export interface VenusConfig { url: string; apiKey?: string }
/** Native Realtime-Venus ServingPort, with the lightweight token decoding proxy. */
export class VenusAdapter implements StreamAdapter {
  private abort = new AbortController();
  private incarnation?: number;
  private seq = 0;
  private audioTime = 0;
  private stopped = false;
  private interacted = false;
  private pending: Array<{ text: string; id: string; user?: string; at?: number }> = [];
  private session: VenusSession;
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
  private audioPackets = 0;
  private imagePackets = 0;
  private outputSteps = 0;
  private listenSteps = 0;
  private audioChunks = 0;
  private lastOutputAt?: number;
  private inputDbfs: number | null = null;
  private prefill?: { id: string; count: number; text: string; fence: number };
  constructor(private o: StreamOptions, private config: VenusConfig, private http = fetch) {
    this.session = new VenusSession({ ...o, emit: e => { if (e.type === "audio") this.audioChunks++; o.emit(e); } },
      (generation, prefix, workId) => this.enqueue(async () => {
        const r = await this.request(`/sessions/${this.o.id}/playback_ack`, { ...this.scope(), utterance_id: generation,
          cumulative_played_chunks: prefix, at_ms: Date.now(), caused_by_work_id: workId ?? null });
        if (r.retry) throw new Error("Venus rejected playback acknowledgement");
      }));
  }
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
    this.o.emit({ type: "info", message: "Venus voice starts with fresh context. To use saved conversation context, type your first message. Venus does not provide a microphone transcript." });
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
      if (r.retry) throw new Error("Venus rejected media input"); this.audioPackets++;
      this.session.evidence.audioAccepted(r.input_seq ?? this.seq, start, end, all.toString("base64")); });
  }
  input(i: StreamInput) {
    if (this.stopped) return;
    if (i.type === "mic") this.mic = i.enabled;
    if (i.type === "audio") {
      this.mic = true; const bytes = Buffer.from(i.data, "base64");
      // Venus has no input transcript event. RMS is only a quiet-start gate;
      // it is not archived as speech or used to infer a task.
      let energy = 0; for (let n = 0; n < bytes.length; n += 2) energy += (bytes.readInt16LE(n) / 32768) ** 2;
      const rms = Math.sqrt(energy / Math.max(1, bytes.length / 2));
      const voiced = rms > 0.02;
      this.inputDbfs = Math.round(20 * Math.log10(Math.max(1e-8, rms)));
      if (voiced && !this.interacted) { this.interacted = true; this.contextInstalled = true; }
      this.acceptAudio(bytes);
    }
    if (i.type === "image") this.enqueue(async () => {
      const r = await this.request(`/sessions/${this.o.id}/video_frame`, { ...this.scope(), event_seq: ++this.seq, captured_at_ms: i.at, data: i.data, mime_type: "image/jpeg" });
      if (r.retry) throw new Error("Venus rejected image input");
      this.lastImageInput = r.input_seq;
      this.imagePackets++;
      this.session.evidence.imageAccepted(r.input_seq ?? this.seq, i.at, i.data);
    });
    if (i.type === "text") {
      this.interacted = true;
      if (this.firstContext) { this.pending.unshift({ text: this.firstContext, id: crypto.randomUUID() }); this.firstContext = ""; }
      this.o.emit({ type: "caption", id: crypto.randomUUID(), role: "user", text: i.text, final: true });
      this.pending.push({ id: crypto.randomUUID(), text: `New user message: ${i.text}`, user: i.text, at: Date.now() });
    }
    if (i.type === "playback") this.session.playback(i.id, i.played);
  }
  taskUpdate(task: StreamTaskUpdate, restored = false) { this.session.taskUpdate(task, restored); }

  context(text: string, announce: boolean) {
    if (!announce && this.firstContext) { this.firstContext += `\n${text}`; return; }
    this.pending.push({ text: `${announce ? "Backend task update" : "Quiet context update"}: ${text}`, id: crypto.randomUUID() });
  }
  private async output() {
    while (!this.stopped) {
      let installedTyped = false;
      if (this.session.idle && !this.session.playbackPending && this.interacted && this.pending.length) {
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
          if (!r.retry) {
            for (const p of this.pending.splice(0, note.count)) if (p.user) this.session.evidence.text("user", p.user, p.at!, this.consumedInput);
            this.prefill = undefined; this.contextInstalled = true; installedTyped = true;
          }
        }
      }
      // A backend reply has its own identity and attempt. Never combine it with
      // a typed turn, another result, or a queued/running task receipt.
      const reply = !installedTyped && !this.pending.length && this.interacted ? this.session.nextReply() : undefined;
      if (reply) {
        await this.inputQueue;
        if (this.stopped) return;
        if (this.session.isCurrent(reply)) {
          const applied = await this.request(`/sessions/${this.o.id}/prefill`, { ...this.scope(),
            work_id: reply.task.task_id, attempt_id: reply.attempt, text_list: [reply.text], visibility: "private", resume_generation: true });
          if (!applied.retry) this.session.admittedReply(reply, applied.generation_id);
        }
      }
      const started = Date.now();
      const s = await this.request(`/sessions/${this.o.id}/output?incarnation=${this.incarnation}&timeout_s=1`);
      if (s.retry) continue;
      this.outputSteps++; this.lastOutputAt = Date.now();
      if (s.text_delta?.includes("<|listen|>")) this.listenSteps++;
      this.consumedInput = Math.max(this.consumedInput, s.input_seq_cutoff ?? 0);
      this.session.output(s, this.contextInstalled);
      // ServingPort can synthesize missing one-second audio units on backend
      // resume. Keep that clock in real time, including speech, so generation
      // cannot run far ahead of the user's next utterance. Media input stays live.
      if (!s.turn_finished) await delay(Math.max(0, 1000 - (Date.now() - started)), undefined, { signal: this.abort.signal });
    }
  }

  private async closeRemote() {
    if (this.incarnation !== undefined) await this.request(`/sessions/${this.o.id}?incarnation=${this.incarnation}&reason=hawk_close`, undefined, "DELETE", true).catch(() => {});
  }
  diagnostics() {
    return { provider: "venus", audioPackets: this.audioPackets, imagePackets: this.imagePackets,
      outputSteps: this.outputSteps, listenSteps: this.listenSteps, audioChunks: this.audioChunks,
      ...this.session.diagnostics(), inputDbfs: this.inputDbfs, queuedInputs: this.queued,
      consumedInput: this.consumedInput, outputGapMs: this.lastOutputAt ? Date.now() - this.lastOutputAt : null,
      awaitingUser: !this.interacted, pendingContext: this.pending.length };
  }
  async close() {
    if (this.stopped) return;
    this.session.close();
    this.stopped = true; clearInterval(this.silence); this.abort.abort();
    this.pending = []; this.audio = []; await this.closeRemote();
  }
}
