import { GptLiveTranscript, type LiveCaption } from "../../../../../src/live/gpt-live-transcript";
import type { ConversationTurn } from "../../../../../src/live/contracts";
export function gptLivePrompt(context: string, bridge: boolean, runtime: string) {
  return `You are Hawk, a concise, attentive voice assistant. You hear audio; you cannot see a camera in this connection.
Wait silently at connection start, including reconnects. Prior messages are history, not a request to repeat old answers. Wait for new user speech.
Listen to corrections and incomplete phrases. Ask briefly when uncertain. Stop speaking when interrupted; that does not cancel backend work.
${bridge ? `Backend: ${runtime}. Delegate durable work, files, memory, careful reasoning, task status questions, explicit cancellations, and task corrections to the client backend. Keep talking naturally if the user speaks while work runs. Results arrive automatically; never poll or invent success.` : "The backend bridge is disabled. Explain that you cannot perform external actions."}
Keep ordinary replies short. Do not greet or recap simply because context was restored.
${context}`;
}
/** GPT-Live protocol only: no Realtime response.create or conversation.item.*. */
export class GptLiveProvider {
  id?: string;
  private ready = false;
  private interacted = false;
  private stopped = false;
  private started = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private closePromise?: Promise<void>;
  private transcript: GptLiveTranscript;
  constructor(private options: {
    ownerSession: string; dc: RTCDataChannel; rpc: (method: string, p?: unknown) => Promise<unknown>;
    caption: (c: LiveCaption) => void; archived: (c: LiveCaption) => void;
    onReady: () => void; onInteraction: () => void; onError: (message: string) => void;
  }) {
    this.transcript = new GptLiveTranscript(crypto.randomUUID(), options.caption, options.archived);
  }
  async connect(sdp: string, settings: { instructions: string; history: ConversationTurn[]; voice: string; runtime: string; bridge: boolean; byok_api_key?: string }) {
    const result = await this.options.rpc("live.gpt.create", { ...settings, model: "gpt-live-1", ownerSession: this.options.ownerSession, sdp }) as { id: string; sdp: string };
    this.id = result.id;
    if (this.stopped) { await this.remoteClose(); throw new Error("Connection was stopped"); }
    this.startupTimer = setTimeout(() => this.options.onError("GPT-Live did not become ready. Reconnect to try again."), 15000);
    if (this.started) this.activate();
    return result.sdp;
  }
  observe(e: any) {
    if (this.stopped) return;
    if (e.type === "session.started") { this.started = true; this.activate(); }
    if (e.type === "session.input_transcript.delta" && e.delta?.trim()) this.interact();
    // A continuous model may answer restored history despite the prompt. Enforce
    // quiet startup at the presentation boundary until there is fresh user input.
    if (e.type === "session.output_transcript.delta" && !this.interacted) return;
    if (this.transcript.accept(e)) {
      clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.transcript.flush(), 2000);
    }
    if (e.type === "error") this.options.onError(e.error?.message ?? "GPT-Live error");
    if (e.type === "session.closed") { this.ready = false; this.options.onError("GPT-Live session ended. Start again to resume this conversation."); }
  }
  private activate() {
    if (!this.id || this.ready || this.stopped) return;
    clearTimeout(this.startupTimer); this.ready = true;
    void this.options.rpc("live.gpt.ready", this.scope()).catch(e => this.options.onError(String(e)));
    this.heartbeat = setInterval(() => {
      void this.options.rpc("live.gpt.heartbeat", this.scope()).catch(e => this.options.onError(String(e)));
    }, 10000);
    this.options.onReady();
  }
  get awaitingUser() { return !this.interacted; }
  mic(enabled: boolean) {
    this.send({ type: enabled ? "session.input_audio.unmute" : "session.input_audio.mute", event_id: crypto.randomUUID() });
  }
  async text(text: string) {
    if (!this.ready || this.stopped) return;
    this.interact();
    await this.options.rpc("live.gpt.text", { ...this.scope(), text });
  }
  private interact() {
    if (this.interacted) return;
    this.interacted = true; this.options.onInteraction();
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.ready = false;
    clearTimeout(this.startupTimer); clearInterval(this.heartbeat); clearTimeout(this.flushTimer);
    this.transcript.flush();
    this.send({ type: "session.close" });
    return this.closePromise = this.remoteClose();
  }
  private async remoteClose() {
    if (this.id) await this.options.rpc("live.gpt.close", this.scope()).catch(() => {});
  }
  private scope() { return { id: this.id, ownerSession: this.options.ownerSession }; }
  private send(event: unknown) { if (this.options.dc.readyState === "open") this.options.dc.send(JSON.stringify(event)); }
}
