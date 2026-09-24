/** Two readers may run together. A writer owns the workspace exclusively.
 * Session keys are also exclusive: two turns never mutate one history at once.
 */
export class DelegationQueue {
  private active = new Map<string, boolean>();
  private waiting: Array<{ key: string; readOnly: boolean; signal: AbortSignal; start: () => void; abort: () => void; waiting?: (reason: string) => void }> = [];
  constructor(private limit = 2) {}
  run<T>(key: string, readOnly: boolean, signal: AbortSignal, work: () => Promise<T>, waiting?: (reason: string) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const item = { key, readOnly, signal, start: () => {}, abort: () => {}, waiting };
      item.abort = () => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) { this.waiting.splice(index, 1); reject(signal.reason ?? new Error("Cancelled")); this.drain(); }
      };
      item.start = () => {
        signal.removeEventListener("abort", item.abort);
        this.active.set(key, readOnly);
        Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => {
          this.active.delete(key); this.drain();
        });
      };
      if (signal.aborted) { reject(signal.reason); return; }
      this.waiting.push(item); signal.addEventListener("abort", item.abort, { once: true }); this.drain();
    });
  }
  private drain() {
    while (this.waiting.length && this.active.size < this.limit) {
      if ([...this.active.values()].some(readOnly => !readOnly)) break;
      // A follow-up waiting on its own conversation must not block unrelated
      // readers. Do not pass an earlier writer, to avoid writer starvation.
      const writer = this.waiting.findIndex(item => !item.readOnly);
      const boundary = writer < 0 ? this.waiting.length : writer === 0 ? 1 : writer;
      const index = this.waiting.findIndex((item, i) => i < boundary && !this.active.has(item.key) && (item.readOnly || !this.active.size));
      if (index < 0) break;
      const [next] = this.waiting.splice(index, 1); next.start();
    }
    for (const item of this.waiting) item.waiting?.(
      this.active.has(item.key) ? "Waiting for the previous turn in this task conversation" :
      [...this.active.values()].some(readOnly => !readOnly) || !item.readOnly ? "Waiting for exclusive workspace access" :
      this.active.size >= this.limit ? `All ${this.limit} task workers are busy` : "Waiting for an earlier workspace change",
    );
  }
}
