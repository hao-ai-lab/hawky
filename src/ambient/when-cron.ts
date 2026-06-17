// =============================================================================
// when-cron.ts — TimerWhenCronService: in-process one-shot scheduling via
// setTimeout (implements WhenCronService from arm-when.ts).
//
// Key semantics:
// - scheduleAt ALWAYS fires the callback on a future macrotask, never
//   synchronously (even for past/now times), so armIntention has reached
//   "armed" before the fire runs.
// - cancel(id) is idempotent; cancelAll() stops all pending timers.
// =============================================================================

import type { WhenCronService } from "./arm-when.js";

export type TimerHandle = ReturnType<typeof setTimeout>;
export type TimerFactory = (callback: () => void, delayMs: number) => TimerHandle;
export type ClearFn = (handle: TimerHandle) => void;

const defaultTimerFactory: TimerFactory = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  (handle as { unref?: () => void }).unref?.();
  return handle;
};

const defaultClearFn: ClearFn = (handle) => clearTimeout(handle);

export class TimerWhenCronService implements WhenCronService {
  private readonly timerFactory: TimerFactory;
  private readonly clearFn: ClearFn;
  private readonly _handles = new Map<string, TimerHandle>();

  constructor(timerFactory: TimerFactory = defaultTimerFactory, clearFn: ClearFn = defaultClearFn) {
    this.timerFactory = timerFactory;
    this.clearFn = clearFn;
  }

  scheduleAt(id: string, isoTime: string, callback: () => void): void {
    // Cancel any existing job for this id (idempotent re-arm).
    this.cancel(id);

    const fireAtMs = Date.parse(isoTime);
    const nowMs = Date.now();
    // Unparseable / past / now → fire on the next macrotask (delay 0).
    const delay = Number.isNaN(fireAtMs) ? 0 : Math.max(0, fireAtMs - nowMs);

    const handle = this.timerFactory(() => {
      this._handles.delete(id);
      callback();
    }, delay);
    this._handles.set(id, handle);
  }

  cancel(id: string): void {
    const handle = this._handles.get(id);
    if (handle !== undefined) {
      this.clearFn(handle);
      this._handles.delete(id);
    }
  }

  cancelAll(): void {
    for (const handle of this._handles.values()) {
      this.clearFn(handle);
    }
    this._handles.clear();
  }
}
