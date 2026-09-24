import type { StreamEvent, StreamInput } from "../../../../../src/live/stream-contracts";
import type { ConversationTurn } from "../../../../../src/live/contracts";
import { PcmMedia } from "../pcm-media";

export function streamPrompt(context: string, bridge: boolean, runtime: string) {
  return `You are Hawk, a concise, attentive live assistant. Use incoming audio and images when relevant.
Wait silently on connection and reconnect. Restored history is context, not a new request. Never greet or recap simply because history was restored.
Listen to corrections and incomplete phrases. Ask briefly when uncertain. Never claim a task has started or succeeded without a real tool receipt.
${bridge ? `Your backend is ${runtime}. Use session_send_message for durable work, files, searches, or longer reasoning. Independent tasks can run concurrently; continue_task explicitly resumes an existing task. Results arrive automatically, so never poll. Cancel only when the user asks; a speech interruption does not cancel work.` : "No backend tools are available. Do not promise external actions."}
Only advertised tools are available. Camera understanding does not imply face recognition, face saving, reminders, or access to local files without a tool.
Keep ordinary replies brief.
${context}`;
}

/** Shared browser bridge for PCM providers. The gateway owns provider protocols. */
export class GatewayStreamProvider {
  readonly id = crypto.randomUUID();
  private media: PcmMedia;
  private ready = false;
  private stopped = false;
  private created = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private inFlight = 0;
  private playbackReceipts: Extract<StreamInput, { type: "playback" }>[] = [];
  private playbackInFlight = 0;
  private captureProblem = "";
  private closePromise?: Promise<void>;
  constructor(private o: {
    ownerSession: string; rpc: (method: string, p?: unknown) => Promise<unknown>;
    subscribe: (listener: (event: any) => void) => () => void;
    caption: (event: Extract<StreamEvent, { type: "caption" }>) => void;
    record: (type: string, data: Record<string, unknown>) => void;
    onError: (message: string) => void; warning: (message: string) => void; info?: (message: string) => void;
  }) {
    this.media = new PcmMedia({ audio: data => this.input({ type: "audio", data }),
      played: (id, played) => this.input({ type: "playback", id, played }), error: message => this.fail(message) });
    this.unsubscribe = o.subscribe(event => {
      const e = event.payload as StreamEvent & { connectionId?: string };
      if (event.event !== "live.stream.event" || e?.connectionId !== this.id || this.stopped) return;
      if (e.type === "caption") { o.caption(e); if (e.final) o.record("message.completed", { role: e.role, text: e.text, fragmentGroupId: e.id }); }
      if (e.type === "audio") this.media.play(e.id, e.data, e.rate);
      if (e.type === "interrupt") this.media.interrupt();
      if (e.type === "diagnostic") o.record("provider.diagnostic", e.detail);
      if (e.type === "info") { o.record("provider.info", { message: e.message }); o.info?.(e.message); }
      if (e.type === "warning") { o.record("provider.warning", { message: e.message }); o.warning(e.message); }
      if (e.type === "error") this.fail(e.message);
    });
  }
  async connect(stream: MediaStream, settings: { model: string; instructions: string; history: ConversationTurn[];
    runtime: string; bridge: boolean; voice?: string; gemini_api_key?: string }, mic: boolean, speaker: boolean) {
    this.media.mic(false); this.media.speaker(speaker);
    await this.o.rpc("live.stream.create", { ...settings, id: this.id, ownerSession: this.o.ownerSession });
    this.created = true;
    if (this.stopped) { await this.remoteClose(); return; }
    await this.media.attach(stream);
    if (this.stopped) return;
    this.ready = true;
    // Tell the provider which turn protocol to use before the first audio
    // packet or typed message can race connection startup.
    this.input({ type: "mic", enabled: mic });
    this.media.mic(mic);
    this.heartbeat = setInterval(() => {
      const health = this.media.health();
      this.o.record("media.health", { ...health, inFlight: this.inFlight,
        playbackReceiptsPending: this.playbackReceipts.length + this.playbackInFlight });
      const problem = !health.micEnabled ? "" : !health.track ? "Microphone track is missing."
        : health.track.readyState === "ended" ? "Microphone track has ended."
        : health.track.muted ? "The browser has muted microphone capture."
        : !health.track.enabled ? "Microphone track is disabled."
        : health.contextState !== "running" ? `Audio processing is ${health.contextState}.`
        : health.captureGapMs !== null && health.captureGapMs >= 5000 ? "Microphone capture has stopped producing audio packets." : "";
      if (problem !== this.captureProblem) {
        if (problem) {
          this.o.record("media.warning", { message: problem });
          this.o.warning(`${problem} Reconnect if speech is not getting through.`);
        } else if (this.captureProblem) this.o.record("media.recovered", {});
        this.captureProblem = problem;
      }
      void this.o.rpc("live.stream.heartbeat", this.scope()).then(result => {
        const diagnostics = (result as { diagnostics?: Record<string, unknown> } | undefined)?.diagnostics;
        if (!this.stopped && diagnostics) this.o.record("provider.health", diagnostics);
      }).catch(e => { if (!this.stopped) this.fail(String(e)); });
    }, 5000);
  }
  private fail(message: string) {
    if (this.stopped) return;
    this.o.record("provider.error", { message });
    // Stop callbacks before notifying the UI, which may also call close().
    void this.close();
    this.o.onError(message);
  }
  private scope() { return { id: this.id, ownerSession: this.o.ownerSession }; }
  private input(input: StreamInput) {
    if (!this.ready || this.stopped) return;
    if (input.type === "playback") {
      // Interrupting one answer can acknowledge dozens of chunks at once.
      // These tiny receipts must not trip the realtime media backlog limit.
      if (this.playbackReceipts.length + this.playbackInFlight >= 1024) {
        this.fail("Gateway playback acknowledgements are falling behind. Reconnect to continue."); return;
      }
      this.playbackReceipts.push(input); this.flushPlaybackReceipts(); return;
    }
    // Don't accumulate unbounded audio on a slow/disconnected gateway.
    if (this.inFlight >= 20) { this.fail("Gateway media connection is falling behind. Reconnect to continue."); return; }
    this.inFlight++;
    void this.o.rpc("live.stream.input", { ...this.scope(), input })
      .catch(e => { if (!this.stopped) this.fail(String(e)); }).finally(() => this.inFlight--);
  }
  private flushPlaybackReceipts() {
    // Bound RPC concurrency without delaying microphone packets behind receipts.
    while (!this.stopped && this.playbackInFlight < 4 && this.playbackReceipts.length) {
      const input = this.playbackReceipts.shift()!;
      this.playbackInFlight++;
      void this.o.rpc("live.stream.input", { ...this.scope(), input })
        .catch(e => { if (!this.stopped) this.fail(String(e)); })
        .finally(() => { this.playbackInFlight--; this.flushPlaybackReceipts(); });
    }
  }
  text(text: string) { this.input({ type: "text", text }); }
  image(data: string) { this.input({ type: "image", data: data.replace(/^data:image\/jpeg;base64,/, ""), at: Date.now() }); return this.ready && !this.stopped; }
  async attach(stream: MediaStream) { await this.media.attach(stream); }
  mic(enabled: boolean) { this.media.mic(enabled); this.input({ type: "mic", enabled }); }
  speaker(enabled: boolean) { this.media.speaker(enabled); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.ready = false;
    // Install the promise and terminal state before media teardown calls back.
    // Remote close releases its playback fence; shutdown needs no receipts.
    this.closePromise = Promise.resolve().then(() => this.remoteClose());
    this.playbackReceipts.length = 0;
    clearInterval(this.heartbeat); this.unsubscribe(); this.media.close();
    return this.closePromise;
  }
  private async remoteClose() { if (this.created) await this.o.rpc("live.stream.close", this.scope()).catch(() => {}); }
}
