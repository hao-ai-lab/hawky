import type { StreamEvent } from "../stream-contracts.js";
import { joySpeech } from "./joyai-speech.js";

/** Speech drains independently of vision. Keep only the newest unsaid observation. */
export class JoyPlayback {
  private active?: AbortController;
  private receipts = new Set<string>();
  private replies: string[] = [];
  private observation?: string;
  private closed = false;
  private warned = false;

  constructor(private url: string | undefined, private voice: string,
    private emit: (event: StreamEvent) => void, private synthesize = joySpeech) {}

  enqueue(text: string, priority: boolean) {
    if (this.closed || !this.url) return;
    if (priority) {
      this.observation = undefined;
      if (this.replies.length >= 8) {
        this.emit({ type: "warning", message: "Spoken replies are behind. The latest reply is available in the transcript." });
        return;
      }
      this.replies.push(text);
    } else this.observation = text;
    this.pump();
  }

  acknowledge(id: string) { this.receipts.delete(id); this.pump(); }

  interrupt() {
    const active = this.active;
    this.active = undefined;
    this.replies = []; this.observation = undefined; this.receipts.clear();
    active?.abort();
  }

  close() { this.closed = true; this.interrupt(); }

  diagnostics() {
    return { synthesizing: !!this.active, playbackReceipts: this.receipts.size,
      queuedReplies: this.replies.length, pendingObservation: this.observation !== undefined };
  }

  private pump() {
    if (this.closed || this.active || this.receipts.size || !this.url) return;
    const text = this.replies.shift() ?? this.observation;
    if (!text) return;
    if (text === this.observation) this.observation = undefined;
    const controller = new AbortController(); this.active = controller;
    // Setting active before entering the async function also covers synchronous
    // synthesis failures and playback acknowledgements delivered from emit().
    void (async () => {
      try {
        await this.synthesize(this.url!, text, this.voice, controller.signal, pcm => {
          if (this.closed || controller.signal.aborted || this.active !== controller) return;
          for (let n = 0; n < pcm.length; n += 12000) {
            if (this.closed || controller.signal.aborted) break;
            const id = crypto.randomUUID(); this.receipts.add(id);
            this.emit({ type: "audio", id, data: pcm.subarray(n, n + 12000).toString("base64"), rate: 24000 });
          }
        });
        if (!controller.signal.aborted) this.warned = false;
      } catch (e) {
        if (!this.closed && !controller.signal.aborted && !this.warned) {
          this.warned = true;
          this.emit({ type: "warning", message: `Text reply is available; ${(e as Error).message}` });
        }
      } finally {
        if (this.active === controller) { this.active = undefined; this.pump(); }
      }
    })();
  }
}
