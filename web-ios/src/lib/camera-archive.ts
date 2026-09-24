/**
 * Browser side: copy already-sent camera frames to the Hawky gateway, then
 * correlate provider acknowledgements with those frames. This class does not
 * capture images, set frame rate, or decide what enters the model's context.
 *
 * One instance belongs to one realtime connection. Uploads use that instance's
 * pinned sessionKey/runId even if the user switches conversations meanwhile.
 * "Background" means asynchronous promises on the browser thread, NOT a worker:
 * JSON serialization still runs synchronously and uploads use network bandwidth.
 */
type Rpc = (method: string, params: unknown) => Promise<unknown>;
type Frame = { frameId: string; capturedAt: string; image: string; itemId?: string; sentAt?: string };
// `bytes` estimates payload characters (base64 is ASCII), not total JS heap use.
type Upload = { method: string; payload: Record<string, unknown>; bytes: number };

/**
 * Bounded, best-effort upload queue. Page closure can lose pending frames.
 * No IndexedDB outbox or delivery guarantee: bounded memory/live responsiveness
 * take priority over complete archival during a slow or unavailable backend.
 */
export class CameraArchive {
  private queue: Upload[] = [];
  private pending = new Map<string, { itemId: string; at: number }>();
  // pending tracks provider replies; queue tracks gateway uploads. Their
  // completion is independent: API acceptance can precede the JPEG disk write.
  private active = false;
  private warned = false;
  private dropped = false;
  private cancelled = false;

  constructor(private rpc: Rpc, private sessionKey: string, private runId: string,
    private warn: (message: string) => void, readonly liveSessionId?: string) {}

  /** New recordings share one typed JSONL log; old clients keep their old RPCs. */
  record(type: string, data: Record<string, unknown>, id = crypto.randomUUID()) {
    if (!this.liveSessionId) return;
    const event = { id, type, data, timestamp: new Date().toISOString(), connectionId: this.runId };
    this.upload("realtime.archive.append", { event }, JSON.stringify(event).length);
  }

  markInterruptedDelivery() { this.dropped = true; }

  async drain(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.active || this.queue.length) {
      if (Date.now() >= deadline) { this.cancelled = true; this.warning(); return false; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return !this.dropped;
  }

  async end(complete: boolean) {
    await this.rpc("realtime.archive.append", { sessionKey: this.sessionKey, liveSessionId: this.liveSessionId,
      event: { id: "session-end", type: "session.ended", timestamp: new Date().toISOString(), connectionId: this.runId, data: { complete } } });
  }

  enqueue(frame: Frame) {
    if (frame.image.length > 1_400_000) { this.warning(); return; }
    const payload = this.liveSessionId ? { image: frame.image, event: {
      id: `image:${frame.frameId}`, type: "image.sent", timestamp: frame.capturedAt, connectionId: this.runId,
      data: { frameId: frame.frameId, itemId: frame.itemId, sentAt: frame.sentAt },
    } } : frame;
    if (this.upload(this.liveSessionId ? "realtime.archive.image" : "session.archiveCameraFrame", payload, frame.image.length) && frame.itemId) {
      // Bound correlation state when a provider never acknowledges an image.
      // Expiry is checked on enqueue (no timer). Entries older than five minutes
      // or beyond 512 are forgotten; their saved frames stay unconfirmed.
      for (const [id, pending] of this.pending) {
        if (Date.now() - pending.at > 300_000) this.pending.delete(id);
      }
      if (this.pending.size >= 512) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(frame.frameId, { itemId: frame.itemId, at: Date.now() });
    }
  }

  observe(event: Record<string, any>) {
    let frameId: string | undefined;
    const accepted = event.type === "conversation.item.created" || event.type === "conversation.item.added";
    if (accepted && typeof event.item?.id === "string") {
      // Success echoes the item ID. The top-level server event_id is a NEW ID.
      // Linear lookup allocates/scans at most 512 entries; fine at current
      // snapshot cadence, but a reverse map would suit much higher event rates.
      frameId = [...this.pending].find(([, p]) => p.itemId === event.item.id)?.[0];
    } else if (event.type === "error" && typeof event.error?.event_id === "string") {
      // Errors point back to our original request in error.event_id, not the
      // top-level event_id. Ignore errors unrelated to known camera frames.
      frameId = event.error.event_id;
    }
    if (!frameId || typeof event.event_id !== "string") return;
    const frame = this.pending.get(frameId);
    if (!frame) return;
    const payload = { frameId, itemId: frame.itemId, serverEventId: event.event_id,
      // Browser receive time includes transport/event-loop delay. It is NOT
      // pure model processing latency. capturedAt/sentAt use the same clock.
      receivedAt: new Date().toISOString(), status: accepted ? "accepted" : "rejected", eventType: event.type,
      ...(!accepted ? { errorMessage: String(event.error?.message ?? "").slice(0, 2000) } : {}) };
    const receipt = this.liveSessionId ? { event: { id: `receipt:${event.event_id}`,
      type: accepted ? "image.accepted" : "image.rejected", timestamp: payload.receivedAt,
      connectionId: this.runId, data: payload } } : payload;
    if (this.upload(this.liveSessionId ? "realtime.archive.receipt" : "session.archiveCameraReceipt", receipt, JSON.stringify(receipt).length)) this.pending.delete(frameId);
    // Keep only the first matched acceptance/rejection. A second success event
    // for the same item does not create another receipt. Failed receipt uploads
    // are handled by the queue; they are not reconstructed from provider history.
  }

  private upload(method: string, payload: Record<string, unknown>, bytes: number) {
    if (this.cancelled) { this.warning(); return false; }
    // Caps are per connection instance: 64 uploads (images AND receipts), about
    // 8 MB of counted payload. Actual heap is higher due to strings, serialized
    // RPC copies and transport buffers. Old runs can still be draining too.
    // On overflow drop the NEW upload and warn once; never block camera capture.
    if (this.queue.length >= 64 || this.queue.reduce((n, f) => n + f.bytes, bytes) > 8_000_000) {
      this.warning();
      return false;
    }
    this.queue.push({ method, payload, bytes });
    void this.flush();
    return true;
  }

  private warning() {
    this.dropped = true;
    if (this.warned) return;
    this.warned = true;
    this.warn("Some session records could not be archived. The live conversation can continue.");
  }

  private async flush() {
    // One gateway RPC in flight per instance preserves frame-before-receipt
    // ordering. It also means a slow upload delays everything behind it.
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        if (this.cancelled) { this.queue = []; break; }
        const frame = this.queue[0];
        let saved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.rpc(frame.method, {
              ...frame.payload, sessionKey: this.sessionKey, runId: this.runId,
              ...(this.liveSessionId ? { liveSessionId: this.liveSessionId } : {}),
            });
            saved = true;
            break;
          } catch {
            if (this.cancelled) break;
            // Three total attempts, with 0.5s then 1s backoff. RPC wait time is
            // additional: with the client's 30s timeout, one upload could occupy
            // the queue for roughly 91.5s. Stable IDs make uncertain retries safe.
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
        if (!saved) this.warning();
        // After exhausting retries, discard this upload and let later ones run.
        this.queue.shift();
      }
    } finally {
      this.active = false;
    }
  }
}
