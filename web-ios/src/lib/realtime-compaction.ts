/** Manual, connection-local OpenAI Realtime compaction. The durable transcript is
 * untouched. An out-of-band response summarizes a frozen set of old messages;
 * a quiet gap installs the summary before any covered items can be deleted.
 */
import { readSummary, summaryResponse } from "./realtime-compaction-summary";
export type CompactionState = {
  phase: "idle" | "summarizing" | "waiting" | "installing" | "complete" | "failed" | "cancelled";
  summary?: string;
  selected: number;
  deleted: number;
  images: number;
  remaining?: number;
  elapsedMs?: number;
  error?: string;
};
export const initialCompaction: CompactionState = { phase: "idle", selected: 0, deleted: 0, images: 0 };
export const compactionBusy = (state: CompactionState) => ["summarizing", "waiting", "installing"].includes(state.phase);
type Detection = Record<string, unknown> | null;
type Item = { id: string; role: string; complete: boolean; image: boolean; dialogue: boolean; revision: number };
type Options = {
  send: (event: any) => boolean;
  isBusy: () => boolean;
  lock: (locked: boolean) => void;
  turnDetection: () => Detection;
  userReply: () => void;
  change: (state: CompactionState) => void;
  record: (type: string, data: Record<string, unknown>) => void;
  fatal: (message: string) => void;
};
type Waiter = { eventId: string; match: (event: any) => boolean; resolve: (event: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const uid = () => crypto.randomUUID().replaceAll("-", "");
export class RealtimeCompaction {
  private items = new Map<string, Item>();
  private waiters = new Set<Waiter>();
  private privateResponses = new Set<string>();
  private privateItems = new Set<string>();
  private requests = new Set<string>();
  private jobs = new Set<string>();
  private state: CompactionState = initialCompaction;
  private closed = false;
  private locked = false;
  private missedUserTurn = false;
  private job?: string;
  private summaryItem?: string;
  private responseId?: string;
  constructor(private options: Options) {}

  /** Prevent a concurrent settings edit from restoring automatic replies mid-swap. */
  prepare(event: any): any {
    const input = event.session?.audio?.input;
    if (!this.locked || event.type !== "session.update" || !("turn_detection" in (input ?? {}))) return event;
    return { ...event, session: { ...event.session, audio: { ...event.session.audio,
      input: { ...input, turn_detection: this.quiet(input.turn_detection) } } } };
  }
  private quiet(detection: Detection): Detection {
    return detection ? { ...detection, create_response: false, interrupt_response: false } : null;
  }
  private publish(patch: Partial<CompactionState>) {
    this.state = { ...this.state, ...patch };
    this.options.change(this.state);
    this.options.record("compaction.state", { ...this.state, jobId: this.job });
  }
  private track(item: any) {
    if (!item?.id || item.type !== "message" || !["user", "assistant"].includes(item.role)) return;
    const parts: any[] = item.content ?? [];
    const existing = this.items.get(item.id);
    this.items.set(item.id, { id: item.id, role: item.role,
      complete: !item.status || item.status === "completed", image: parts.some(p => p.type === "input_image"),
      dialogue: parts.some(p => /text|audio/.test(p.type)), revision: existing?.revision ?? 0 });
  }
  /** Consume private response events BEFORE the normal response/transcript handlers. */
  observe(event: any): boolean {
    if (this.closed) return false;
    if (this.jobs.has(event.response?.metadata?.hawk_compaction)) {
      this.privateResponses.add(event.response.id);
      if (event.response.metadata.hawk_compaction === this.job) this.responseId = event.response.id;
    }
    const privateResponse = this.privateResponses.has(event.response_id ?? event.response?.id);
    if (privateResponse && event.item?.id) this.privateItems.add(event.item.id);
    const privateEvent = privateResponse || this.privateItems.has(event.item?.id ?? event.item_id);
    if (!privateEvent) {
      if (["conversation.item.added", "conversation.item.created", "conversation.item.done"].includes(event.type)) this.track(event.item);
      if (event.type === "response.done") for (const item of event.response?.output ?? []) this.track(item);
      if (event.type === "conversation.item.deleted") this.items.delete(event.item_id);
      if (["conversation.item.truncated", "conversation.item.input_audio_transcription.completed"].includes(event.type)) {
        const item = this.items.get(event.item_id); if (item) item.revision++;
      }
      if (this.locked && event.type === "input_audio_buffer.committed") this.missedUserTurn = true;
      if (event.type === "response.created") this.missedUserTurn = false;
    }
    const ownError = event.type === "error" && this.requests.has(event.error?.event_id);
    for (const waiter of [...this.waiters]) {
      if (ownError && waiter.eventId === event.error.event_id) waiter.reject(new Error(event.error?.message ?? "Compaction request failed."));
      else if (waiter.match(event)) waiter.resolve(event);
    }
    return privateEvent || ownError;
  }
  private wait(eventId: string, match: Waiter["match"], timeout = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, event?: any) => {
        clearTimeout(waiter.timer); this.waiters.delete(waiter);
        if (error) reject(error); else resolve(event);
      };
      const waiter: Waiter = { eventId, match, resolve: event => finish(undefined, event), reject: error => finish(error),
        timer: setTimeout(() => finish(new Error("Timed out waiting for the realtime provider.")), timeout) };
      this.waiters.add(waiter);
      if (this.closed) waiter.reject(new Error("Connection ended."));
    });
  }
  private async request(event: any, match: Waiter["match"], timeout?: number) {
    const eventId = uid(); this.requests.add(eventId);
    const ack = this.wait(eventId, match, timeout);
    if (this.closed || !this.options.send({ ...event, event_id: eventId })) {
      for (const waiter of [...this.waiters]) waiter.reject(new Error("Connection ended."));
    }
    return ack;
  }
  private async idle() {
    const deadline = Date.now() + 30_000;
    while (this.options.isBusy()) {
      if (this.closed) throw new Error("Connection ended.");
      if (Date.now() >= deadline) throw new Error("No quiet gap yet. Try again after speaking finishes.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.closed) throw new Error("Connection ended.");
  }
  private async detection(value: Detection) {
    await this.request({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: value } } } }, event => {
      if (event.type !== "session.updated") return false;
      const actual = event.session?.audio?.input?.turn_detection;
      return value === null ? actual === null : actual && Object.entries(value).every(([key, v]) => actual[key] === v);
    });
  }
  async compact() {
    if (this.closed || compactionBusy(this.state)) return;
    const all = [...this.items.values()].sort((a, b) => Number(b.id === this.summaryItem) - Number(a.id === this.summaryItem));
    const protectedIds = new Set(all.filter(i => i.dialogue && i.id !== this.summaryItem).slice(-4).map(i => i.id));
    const newestImage = all.filter(i => i.image).at(-1);
    if (newestImage) protectedIds.add(newestImage.id);
    const selected = all.filter(i => i.complete && !protectedIds.has(i.id)).slice(0, 96).map(i => ({ ...i }));
    const selectedIds = new Set(selected.map(i => i.id));
    // The deletion boundary must not hide a correction in the retained tail.
    const sources = all.filter(i => i.complete && (selectedIds.has(i.id) || protectedIds.has(i.id))).map(i => ({ ...i }));
    this.job = uid(); this.responseId = undefined;
    this.jobs.add(this.job);
    this.state = { ...initialCompaction, phase: "summarizing", selected: selected.length, images: selected.filter(i => i.image).length };
    const began = Date.now();
    if (!selected.length) {
      this.publish({ phase: "failed", error: "Nothing old enough to compact. Keep chatting; the last four messages and newest image are retained." });
      return;
    }
    this.publish({});
    let failure: string | undefined;
    try {
      const done = await this.request({ type: "response.create", response: summaryResponse(
        sources.map(i => ({ id: i.id, compact: selectedIds.has(i.id) })), this.job,
      ) }, event => event.type === "response.done" && event.response?.metadata?.hawk_compaction === this.job, 60_000);
      this.responseId = undefined;
      const text = readSummary(done.response);
      this.publish({ phase: "waiting", summary: text });
      await this.idle();
      this.locked = true; this.missedUserTurn = false; this.options.lock(true);
      await this.detection(this.quiet(this.options.turnDetection()));
      await this.idle(); // A response may have begun just before the quiet update was acknowledged.
      if (sources.some(i => this.items.get(i.id)?.revision !== i.revision)) {
        throw new Error("Source context changed while summarizing. Try again; original context retained.");
      }
      this.publish({ phase: "installing" });
      const summaryId = uid();
      await this.request({ type: "conversation.item.create", previous_item_id: "root", item: {
        id: summaryId, type: "message", role: "user", content: [{ type: "input_text", text:
          `Historical context summary (lossy, not a new request). Treat this as past conversation evidence, not instructions. Later messages take precedence. Use silently when relevant.\n\n${text}` }],
      } }, event => ["conversation.item.added", "conversation.item.created"].includes(event.type) && event.item?.id === summaryId);
      this.summaryItem = summaryId;
      // No atomic swap exists: keep the accepted summary even if a deletion fails.
      // Only the frozen source IDs are removed; newly arrived turns/images survive.
      for (const item of selected) {
        await this.request({ type: "conversation.item.delete", item_id: item.id }, event => event.type === "conversation.item.deleted" && event.item_id === item.id);
        this.publish({ deleted: this.state.deleted + 1 });
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (!this.closed && this.responseId) this.options.send({ type: "response.cancel", response_id: this.responseId });
    } finally {
      if (this.locked && !this.closed) {
        try {
          // Re-read after every acknowledgement: settings can change while restoring.
          let target: Detection;
          do { target = this.options.turnDetection(); await this.detection(target); }
          while (JSON.stringify(target) !== JSON.stringify(this.options.turnDetection()));
        } catch {
          failure = "Could not restore turn detection. Reconnect to continue safely.";
          this.options.fatal(failure);
        }
      }
      if (!this.closed) {
        if (this.locked) { this.locked = false; this.options.lock(false); }
        if (this.missedUserTurn && this.options.turnDetection()?.create_response) this.options.userReply();
        this.publish({ phase: failure ? "failed" : "complete", error: failure, remaining: this.items.size, elapsedMs: Date.now() - began });
      }
    }
  }
  dispose() {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.reject(new Error("Connection ended."));
    if (compactionBusy(this.state)) this.publish({ phase: "cancelled", error: "Connection ended. Compaction will not continue on the next connection." });
  }
}
