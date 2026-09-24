import { createHash } from "node:crypto";
import type { StreamCapture, StreamDelivery, StreamOptions, StreamTaskUpdate } from "../stream-contracts.js";
import { VenusText, venusReply } from "./venus-protocol.js";

const LOOKBACK_MS = 30_000;
const terminal = (task: StreamTaskUpdate) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
const stableId = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 40);

/** Bounded causal evidence. Only accepted media and actually played speech enter
 * snapshots; transcript rendering and later playback cannot rewrite a capture. */
export class VenusEvidence {
  private audio: StreamCapture["audio"] = [];
  private images: StreamCapture["images"] = [];
  private turns: Array<{ at: number; sequence: number; role: "user" | "assistant"; text: string }> = [];
  audioAccepted(sequence: number, start: number, end: number, data: string) {
    this.audio.push({ sequence, start, end, data });
    this.audio = this.audio.filter(a => a.end >= end - LOOKBACK_MS).slice(-32);
  }
  imageAccepted(sequence: number, at: number, data: string) {
    this.images.push({ sequence, at, data });
    // Keep at most 8 bounded JPEGs, independent of capture cadence.
    this.images = this.images.filter(i => i.at >= at - LOOKBACK_MS).slice(-8);
  }
  text(role: "user" | "assistant", text: string, at: number, sequence: number) {
    if (!text.trim()) return;
    this.turns.push({ role, text, at, sequence }); this.turns = this.turns.slice(-40);
  }
  freeze(at: number, inputSequence: number): StreamCapture {
    const since = at - LOOKBACK_MS;
    return {
      at, inputSequence,
      history: this.turns.filter(t => t.at <= at && t.at >= since && t.sequence <= inputSequence)
        .slice(-12).map(({ role, text }) => ({ role, text })),
      images: this.images.filter(i => i.at <= at && i.at >= since && i.sequence <= inputSequence).map(i => ({ ...i })),
      audio: this.audio.filter(a => a.start < at && a.end > since && a.sequence <= inputSequence).map(a => {
        const start = Math.max(since, a.start), end = Math.min(at, a.end);
        const bytes = Buffer.from(a.data, "base64");
        return { sequence: a.sequence, start, end,
          data: bytes.subarray(Math.floor((start - a.start) * 16) * 2, Math.floor((end - a.start) * 16) * 2).toString("base64") };
      }),
    };
  }
  clear() { this.audio = []; this.images = []; this.turns = []; }
}

export interface VenusOutput {
  generation_id: string; generation_epoch?: number; step_seq?: number;
  at_ms?: number; input_seq_cutoff?: number; text_delta: string; turn_finished?: boolean;
  audio?: { data: string; sample_rate_hz: number }; audio_chunk_seq?: number;
}
export interface VenusReply {
  task: StreamTaskUpdate; id: string; attempt: string; text: string;
  generation?: string; invalid: boolean;
}
interface Generation {
  id: string; parser: VenusText; text: string; audioText: string; step: number;
  capture?: StreamCapture; committed: boolean; finished: boolean;
  chunks: Array<{ id: string; text: string; sequence: number; native: number; played?: boolean }>;
  ack: number; reply?: VenusReply; interrupted: boolean;
}

/** Venus-specific lifecycle. The model server owns KV/Thinker/Talker state;
 * this controller owns capture, result admission and delivery receipts. */
export class VenusSession {
  readonly evidence = new VenusEvidence();
  private generations = new Map<string, Generation>();
  private current?: Generation;
  private tasks = new Map<string, StreamTaskUpdate>();
  private replies: VenusReply[] = [];
  private admitted?: VenusReply;
  private chunks = new Map<string, Generation>();
  private closed = false;
  private terminalSeen = new Set<string>();
  private epochFloor = -1;
  mode: "listening" | "speaking" | "ended" = "listening";
  delegationRequests = 0;
  constructor(private options: StreamOptions,
    private acknowledge: (generation: string, prefix: number, workId?: string) => void) {}

  get playbackPending() { return this.chunks.size; }
  get readyReplies() { return this.replies.length; }
  get idle() { return (!this.admitted || this.current?.reply === this.admitted) && (!this.current || this.current.finished); }

  /** Queued/running receipts are not backend answers. Restored, partially spoken
   * results stay unconfirmed rather than replaying automatically. */
  taskUpdate(task: StreamTaskUpdate, restored = false) {
    if (this.closed || !this.options.bridge) return;
    const previous = this.tasks.get(task.task_id);
    if (previous?.validity === "superseded") return;
    if (previous && terminal(previous) && !terminal(task) && task.validity !== "superseded") return;
    this.tasks.set(task.task_id, { ...task });
    if (task.validity === "superseded" || task.status === "cancelling") {
      for (const r of this.replies) if (r.task.task_id === task.task_id) r.invalid = true;
      this.replies = this.replies.filter(r => r.task.task_id !== task.task_id);
      if (this.admitted?.task.task_id === task.task_id) {
        this.admitted.invalid = true;
        this.options.emit({ type: "interrupt" });
        for (const g of this.generations.values()) if (g.reply === this.admitted) this.interrupt(g);
      }
      return;
    }
    if (!terminal(task) || this.terminalSeen.has(task.task_id)) return;
    this.terminalSeen.add(task.task_id);
    if (restored && task.delivery && task.delivery !== "pending") {
      if (["injected", "generated"].includes(task.delivery) && task.deliveryResponseId)
        this.options.delivery?.(task.task_id, task.deliveryResponseId, "interrupted");
      return;
    }
    const text = task.status === "completed" ? task.result?.trim() || "The task finished without a text result."
      : task.status === "cancelled" ? "The task was cancelled."
      : `The task could not complete. ${task.error || "The backend did not return a result."}`;
    const id = stableId(`${task.task_id}:result:${task.completedAt ?? "terminal"}`);
    this.replies.push({ task: { ...task }, id, attempt: crypto.randomUUID(), text: venusReply(text), invalid: false });
  }
  nextReply() {
    if (this.closed || !this.idle || this.playbackPending || this.admitted) return;
    return this.replies[0];
  }
  isCurrent(reply: VenusReply) { return !this.closed && !reply.invalid && this.replies[0] === reply; }
  admittedReply(reply: VenusReply, generation?: string) {
    this.replies = this.replies.filter(r => r !== reply);
    reply.generation = generation; this.admitted = reply;
    this.report(reply, "injected");
  }
  private report(reply: VenusReply, state: StreamDelivery) {
    this.options.delivery?.(reply.task.task_id, reply.attempt, state);
    this.options.emit({ type: "diagnostic", detail: { event: `venus.delivery.${state}`, taskId: reply.task.task_id, feedbackId: reply.id, responseId: reply.attempt } });
  }
  private generation(step: VenusOutput) {
    const id = step.generation_id;
    let g = this.generations.get(id);
    if (!g) {
      if (this.current && !this.current.finished) throw new Error("Venus changed generation before its boundary");
      const reply = this.admitted && (!this.admitted.generation || this.admitted.generation === id) ? this.admitted : undefined;
      if (reply) reply.generation = id;
      g = { id, parser: new VenusText(), text: "", audioText: "", step: 0, committed: false, finished: false, chunks: [], ack: 0, reply, interrupted: false };
      this.generations.set(id, g);
      this.current = g;
      // Retain a bounded replay tombstone, never evict in-flight playback.
      for (const [key, old] of this.generations) {
        if (this.generations.size <= 128) break;
        if (old !== g && old.finished && old.chunks.every(c => c.played !== undefined)) this.generations.delete(key);
      }
    }
    return g;
  }
  output(step: VenusOutput, admitted: boolean) {
    if (this.closed) return;
    if (step.generation_epoch !== undefined && step.generation_epoch < this.epochFloor) return;
    if (typeof step.text_delta !== "string") throw new Error("Venus bridge did not decode output tokens");
    const g = this.generation(step);
    if (g.finished || step.step_seq !== undefined && step.step_seq <= g.step) return;
    if (step.step_seq !== undefined && step.step_seq !== g.step + 1) throw new Error("Venus output sequence has a gap");
    g.step = step.step_seq ?? g.step + 1;
    const parsed = g.parser.feed(step.text_delta);
    this.mode = g.parser.mode;
    if (parsed.captureAbandoned) g.capture = undefined;
    if (parsed.captureStarted && !g.capture) g.capture = this.evidence.freeze(step.at_ms ?? Date.now(), step.input_seq_cutoff ?? 0);
    if (parsed.request && !g.committed && admitted && this.options.bridge) {
      g.committed = true; this.delegationRequests++;
      const requestId = stableId(`${this.options.id}:${g.id}:delegate`);
      const request = parsed.request;
      const capture = g.capture ?? this.evidence.freeze(step.at_ms ?? Date.now(), step.input_seq_cutoff ?? 0);
      // Stable, store-safe identity; native generation IDs contain ':' and are
      // not valid Hawk task IDs. Captured context is never model-supplied JSON.
      const task = (async () => this.options.delegate
        ? this.options.delegate(requestId, request, capture)
        : this.options.tool(requestId, "session_send_message", { message: request, execution: "serial" }))();
      void task.then(t => { if (t && typeof t === "object" && "task_id" in t) this.taskUpdate(t as StreamTaskUpdate); })
        .catch(e => { if (!this.closed) this.options.emit({ type: "warning", message: `Venus delegation failed: ${String(e)}` }); });
      g.capture = undefined;
    }
    if (parsed.invalid) g.capture = undefined;
    const allowed = admitted && !g.reply?.invalid;
    if (parsed.visible && allowed) {
      g.text += parsed.visible; g.audioText += parsed.visible;
      this.options.emit({ type: "caption", id: g.id, role: "assistant", text: g.text, final: false });
    }
    if (step.audio && !parsed.mute && allowed) {
      const id = `${g.id}:${step.audio_chunk_seq}`;
      const chunk = { id, text: g.audioText, sequence: step.input_seq_cutoff ?? 0, native: step.audio_chunk_seq ?? g.chunks.length + 1 };
      g.audioText = ""; g.chunks.push(chunk); this.chunks.set(id, g);
      this.options.emit({ type: "audio", id, data: step.audio.data, rate: step.audio.sample_rate_hz });
    }
    // Muted native audio cannot later become part of a played speech snapshot.
    if (step.audio && (parsed.mute || !allowed)) g.audioText = "";
    if (step.turn_finished) {
      g.finished = true;
      if (step.generation_epoch !== undefined) this.epochFloor = step.generation_epoch + 1;
      if (g.text.trim() && allowed) this.options.emit({ type: "caption", id: g.id, role: "assistant", text: g.text, final: true });
      if (g.parser.finish().malformed) this.options.emit({ type: "warning", message: "Venus emitted an incomplete delegation; no task was dispatched." });
      g.capture = undefined;
      if (g.reply && !g.interrupted && !g.reply.invalid) this.report(g.reply, "generated");
      this.settle(g);
    }
  }
  playback(id: string, played: boolean, at = Date.now()) {
    const g = this.chunks.get(id); if (!g || this.closed) return;
    this.chunks.delete(id);
    const c = g.chunks.find(c => c.id === id)!;
    c.played = played;
    if (played) this.evidence.text("assistant", c.text, at, c.sequence);
    else this.interrupt(g);
    const previous = g.ack;
    while (g.chunks[g.ack]?.played === true && g.chunks[g.ack].native === g.ack + 1) g.ack++;
    if (g.ack > previous) this.acknowledge(g.id, g.ack, g.reply?.task.task_id);
    this.settle(g);
  }
  private interrupt(g: Generation) {
    if (g.interrupted) return;
    g.interrupted = true;
    if (g.reply) this.report(g.reply, "interrupted");
  }
  private settle(g: Generation) {
    if (!g.finished || g.chunks.some(c => c.played === undefined)) return;
    if (g.reply && !g.reply.invalid && !g.interrupted && g.chunks.length && g.chunks.every(c => c.played)) this.report(g.reply, "played");
    if (g.reply === this.admitted) this.admitted = undefined;
  }
  close() {
    if (this.closed) return;
    for (const g of this.generations.values()) if (g.reply && (!g.finished || g.chunks.some(c => c.played === undefined))) this.interrupt(g);
    if (this.admitted && ![...this.generations.values()].some(g => g.reply === this.admitted)) this.report(this.admitted, "interrupted");
    this.closed = true; this.replies = []; this.generations.clear(); this.chunks.clear(); this.tasks.clear(); this.evidence.clear();
  }
  diagnostics() { return { mode: this.mode, generation: this.current?.id, readyReplies: this.readyReplies,
    playbackPending: this.playbackPending, delegationRequests: this.delegationRequests }; }
}
