type Reply = { tool_choice?: "none"; output_modalities?: string[]; instructions?: string; metadata?: Record<string, string> };
type Intent = { id: string; reply: Reply };
/** Coordinates explicit replies with server VAD, generation and audio playback.
 * The provider can start a reply before response.created reaches us, so a local
 * busy flag is only an optimization; correlated busy errors requeue the intent.
 */
export class RealtimeResponses {
  private pending: Intent[] = [];
  private requested: { eventId: string; intents: Intent[] } | null = null;
  private active = new Set<string>();
  private owned = new Map<string, Intent[]>();
  private invalidTasks = new Set<string>();
  private invalidResponses = new Set<string>();
  private playingResponse?: string;
  private userSpeaking = false;
  private playing = false;
  private silent = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private serial = 0;
  private retryUntil = 0;
  constructor(private send: (event: unknown) => boolean,
    private record: (type: string, data: unknown) => void = () => {}) {}

  request(reply: Reply, id = `intent-${++this.serial}`) {
    if (this.pending.some(i => i.id === id) || this.requested?.intents.some(i => i.id === id)) return;
    this.pending.push({ id, reply });
    this.record("response.queued", { id });
    this.schedule();
  }
  setSilent(value: boolean) { this.silent = value; this.schedule(); }
  invalidateTask(id: string) {
    this.invalidTasks.add(id);
    this.pending = this.pending.filter(i => i.reply.metadata?.task_id !== id);
    for (const [responseId, intents] of this.owned) {
      if (intents.some(i => i.reply.metadata?.task_id === id)) this.cancelSuperseded(responseId, intents);
    }
  }
  private cancelSuperseded(responseId: string, intents: Intent[]) {
    this.invalidResponses.add(responseId);
    if (this.active.has(responseId)) this.send({ type: "response.cancel", response_id: responseId });
    if (this.playingResponse === responseId) this.send({ type: "output_audio_buffer.clear" });
    // Keep unrelated results that were coalesced into the same response.
    this.pending.unshift(...intents.filter(i => !this.invalidTasks.has(i.reply.metadata?.task_id ?? "")));
    this.owned.delete(responseId);
    this.record("response.superseded", { responseId });
    this.schedule();
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, Math.max(80, this.retryUntil - Date.now()));
  }
  private flush() {
    if (this.silent || this.userSpeaking || this.playing || this.active.size || this.requested || !this.pending.length) return;
    const intents = this.pending.splice(0, 3);
    const eventId = `hawk-response-${++this.serial}`;
    const instructions = intents.map(i => i.reply.instructions).filter(Boolean).join("\n");
    const taskIds = intents.map(i => i.reply.metadata?.task_id).filter(Boolean);
    const response = { ...intents.at(-1)!.reply,
      ...(instructions ? { instructions } : {}),
      // Coalescing cannot accidentally re-enable tools on a status/result reply.
      ...(intents.some(i => i.reply.tool_choice === "none") ? { tool_choice: "none" as const } : {}),
      metadata: { hawk_request: eventId, ...(taskIds.length ? { task_ids: taskIds.join(",") } : {}) } };
    // Reserve synchronously before sending, even if a fixture acknowledges inline.
    this.requested = { eventId, intents };
    if (!this.send({ type: "response.create", event_id: eventId, response })) {
      this.requested = null; this.pending.unshift(...intents);
      return;
    }
    this.record("response.requested", { eventId, intentIds: intents.map(i => i.id), taskIds });
  }
  /** Returns true only for errors owned and recovered by this coordinator. */
  observe(event: any): boolean {
    const type = event.type;
    if (type === "input_audio_buffer.speech_started") this.userSpeaking = true;
    if (type === "input_audio_buffer.speech_stopped") { this.userSpeaking = false; this.retryUntil = Date.now() + 250; }
    if (type === "output_audio_buffer.started") {
      this.playing = true; this.playingResponse = event.response_id;
      if (this.invalidResponses.has(event.response_id)) this.send({ type: "output_audio_buffer.clear" });
    }
    if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
      this.playing = false; this.playingResponse = undefined; this.owned.delete(event.response_id);
    }
    if (type === "response.created") {
      if (event.response?.id) this.active.add(event.response.id);
      if (this.requested && event.response?.metadata?.hawk_request === this.requested.eventId) {
        const intents = this.requested.intents; this.requested = null;
        this.owned.set(event.response.id, intents);
        if (intents.some(i => this.invalidTasks.has(i.reply.metadata?.task_id ?? ""))) this.cancelSuperseded(event.response.id, intents);
      }
    }
    if (type === "response.done" || type === "response.completed") {
      this.active.delete(event.response?.id);
      if (event.response?.status !== "completed" || event.response?.output_modalities?.includes("text")) this.owned.delete(event.response?.id);
      if (event.response?.metadata?.hawk_request === this.requested?.eventId) this.requested = null;
    }
    if (type === "error" && this.requested && event.error?.event_id === this.requested.eventId) {
      const busy = event.error?.code === "conversation_already_has_active_response" || /already has an active response/i.test(event.error?.message ?? "");
      const request = this.requested;
      this.requested = null;
      if (busy) {
        this.pending.unshift(...request.intents.filter(i => !this.invalidTasks.has(i.reply.metadata?.task_id ?? "")));
        this.retryUntil = Date.now() + 250;
        this.record("response.retry", { eventId: request.eventId, error: event.error });
        this.schedule();
        return true;
      }
    }
    if (/^(response\.(created|done|completed)|input_audio_buffer\.speech_|output_audio_buffer\.)/.test(type)) {
      this.record("response.lifecycle", { type, responseId: event.response?.id ?? event.response_id, status: event.response?.status, metadata: event.response?.metadata });
      this.schedule();
    }
    return false;
  }
  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.pending = []; this.requested = null; this.active.clear(); this.owned.clear(); this.invalidTasks.clear(); this.invalidResponses.clear(); this.playingResponse = undefined;
    this.userSpeaking = false; this.playing = false; this.silent = false; this.retryUntil = 0;
  }
}
