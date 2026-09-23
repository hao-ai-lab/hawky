export type RestoredTurn = { role: "user" | "assistant"; text: string };
type Event = Record<string, any>;
type TurnDetection = Record<string, unknown> | null;

/** Configure quietly -> restore acknowledged items -> enable live interaction.
 * The caller keeps mic tracks disabled until onReady. No new response is requested.
 * https://developers.openai.com/api/docs/guides/realtime-conversations
 */
export class RealtimeStartup {
  private stage: "configuring" | "replaying" | "activating" | "ready" | "failed" | "cancelled" = "configuring";
  private pending = new Set<string>();
  private itemIds: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private startedAt = Date.now();

  constructor(private options: {
    session: Event;
    turnDetection: TurnDetection;
    messages: RestoredTurn[];
    send: (event: Event) => boolean;
    record: (type: string, data: Event) => void;
    onReady: () => void;
    onFailure: (message: string) => void;
    timeoutMs?: number;
  }) {}

  start() {
    this.timer = setTimeout(() => this.fail("Timed out restoring the conversation. Tap Start to retry."), this.options.timeoutMs ?? 10_000);
    this.options.record("context.restore_started", { messages: this.options.messages });
    const session = this.options.session;
    this.send({ type: "session.update", session: {
      ...session,
      audio: { ...session.audio, input: { ...session.audio?.input, turn_detection: null } },
    } });
  }

  observe(event: Event) {
    if (["ready", "failed", "cancelled"].includes(this.stage)) return;
    if (event.type === "error") {
      this.fail(`Could not restore the conversation: ${event.error?.message ?? "provider rejected startup"}. Tap Start to retry.`);
      return;
    }
    if (event.type === "session.updated") {
      const detection = event.session?.audio?.input?.turn_detection;
      if (this.stage === "configuring" && detection === null) this.replay();
      else if (this.stage === "activating" && matchesDetection(detection, this.options.turnDetection)) {
        this.stage = "ready";
        clearTimeout(this.timer);
        this.options.record("context.ready", { restoredMessageCount: this.options.messages.length, elapsedMs: Date.now() - this.startedAt });
        this.options.onReady();
      }
      return;
    }
    if (this.stage === "replaying" && ["conversation.item.added", "conversation.item.created"].includes(event.type)) {
      if (!this.pending.delete(event.item?.id)) return;
      this.options.record("context.item_accepted", { itemId: event.item.id, serverEventId: event.event_id });
      if (this.pending.size === 0) this.activate();
    }
  }

  cancel() {
    if (!["ready", "failed", "cancelled"].includes(this.stage)) {
      this.options.record("context.restore_cancelled", { stage: this.stage, pendingItems: this.pending.size });
    }
    clearTimeout(this.timer);
    this.stage = "cancelled";
  }

  private replay() {
    this.stage = "replaying";
    this.itemIds = this.options.messages.map(() => crypto.randomUUID().replace(/-/g, ""));
    this.pending = new Set(this.itemIds);
    if (this.pending.size === 0) { this.activate(); return; }
    for (let i = 0; i < this.options.messages.length; i++) {
      const turn = this.options.messages[i];
      if (!this.send({ type: "conversation.item.create", item: {
        id: this.itemIds[i], type: "message", role: turn.role,
        content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.text }],
      } })) return;
    }
  }

  private activate() {
    this.stage = "activating";
    // Unlike restore_started, this means every replayed item was accepted.
    this.options.record("context.restored", { messages: this.options.messages, itemIds: this.itemIds });
    this.send({ type: "session.update", session: {
      type: "realtime", audio: { input: { turn_detection: this.options.turnDetection } },
    } });
  }

  private send(event: Event): boolean {
    try {
      if (this.options.send({ ...event, event_id: `startup_${crypto.randomUUID().replace(/-/g, "")}` })) return true;
      this.fail("Connection closed while restoring the conversation. Tap Start to retry.");
    } catch (error) {
      this.fail(`Could not restore the conversation: ${String(error)}. Tap Start to retry.`);
    }
    return false;
  }

  private fail(message: string) {
    if (["ready", "failed", "cancelled"].includes(this.stage)) return;
    this.options.record("context.restore_failed", { stage: this.stage, pendingItems: this.pending.size, message });
    this.stage = "failed";
    clearTimeout(this.timer);
    this.options.onFailure(message);
  }
}

function matchesDetection(actual: unknown, expected: TurnDetection): boolean {
  if (expected === null) return actual === null;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => (actual as Event)[key] === value);
}
