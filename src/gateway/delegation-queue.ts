/** Two readers may run together. A writer owns the workspace exclusively.
 * Session keys are also exclusive: two turns never mutate one history at once.
 */
export class DelegationQueue {
  private active = new Map<string, boolean>();
  private waiting: Array<{ key: string; readOnly: boolean; signal: AbortSignal; start: () => void; abort: () => void }> = [];
  constructor(private limit = 2) {}
  run<T>(key: string, readOnly: boolean, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const item = { key, readOnly, signal, start: () => {}, abort: () => {} };
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
      const next = this.waiting[0];
      if (this.active.has(next.key)) return;
      if (this.active.size && (!next.readOnly || [...this.active.values()].some(readOnly => !readOnly))) return;
      this.waiting.shift(); next.start();
    }
  }
}
