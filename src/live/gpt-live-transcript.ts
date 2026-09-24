import type { ConversationTurn } from "./contracts.js";
export interface LiveFragment { event_id: string; type: string; delta: string; start_ms: number; end_ms: number }
export interface LiveCaption extends ConversationTurn { id: string; startMs: number; endMs: number }
/** Timestamp fragments are evidence, not completed turns. Group only for display
 * and bounded persistence. Silence/flush never implies a model turn is finished.
 */
export class GptLiveTranscript {
  private seen = new Set<string>();
  private pending = new Map<string, LiveCaption>();
  private recent: LiveCaption[] = [];
  revision = 0;
  userRevision = 0;
  constructor(private prefix: string, private changed: (caption: LiveCaption) => void,
    private committed: (caption: LiveCaption) => void) {}
  accept(e: LiveFragment): boolean {
    const role = e.type === "session.input_transcript.delta" ? "user" : e.type === "session.output_transcript.delta" ? "assistant" : undefined;
    if (!role || !e.event_id || this.seen.has(e.event_id) || typeof e.delta !== "string" || !Number.isFinite(e.start_ms) || !Number.isFinite(e.end_ms)) return false;
    this.seen.add(e.event_id); this.revision++;
    if (role === "user") this.userRevision++;
    let item = this.pending.get(role);
    if (item && (e.start_ms - item.endMs > 1500 || item.text.length >= 2000 || e.start_ms < item.startMs)) {
      this.commit(role); item = undefined;
    }
    if (!item) {
      item = { id: `${this.prefix}:${e.event_id}`, role, text: "", startMs: e.start_ms, endMs: e.end_ms };
      this.pending.set(role, item); this.recent.push(item);
      this.recent = this.recent.slice(-80);
    }
    item.text += e.delta; item.endMs = Math.max(item.endMs, e.end_ms);
    this.changed({ ...item });
    return true;
  }
  snapshot(): ConversationTurn[] {
    return this.recent.slice().sort((a,b) => a.startMs - b.startMs).map(({ role, text }) => ({ role, text }));
  }
  flush() { for (const role of [...this.pending.keys()]) this.commit(role); }
  private commit(role: string) {
    const item = this.pending.get(role); this.pending.delete(role);
    if (item?.text.trim()) this.committed({ ...item });
  }
}
