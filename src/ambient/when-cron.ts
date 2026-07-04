// =============================================================================
// when-cron.ts — TimerWhenCronService: in-process one-shot scheduling via
// setTimeout (implements WhenCronService from arm-when.ts).
//
// Key semantics:
// - scheduleAt ALWAYS fires the callback on a future macrotask, never
//   synchronously (even for past/now times), so armIntention has reached
//   "armed" before the fire runs.
// - Long horizons are chunked: setTimeout's delay is a 32-bit int (~24.8 day
//   ceiling), so scheduleAt caps each timer and re-arms the remainder until the
//   true due time instead of overflowing to an immediate fire.
// - cancel(id) is idempotent; cancelAll() stops all pending timers.
// =============================================================================

import type { WhenCronService } from "./arm-when.js";

export type TimerHandle = ReturnType<typeof setTimeout>;
export type TimerFactory = (callback: () => void, delayMs: number) => TimerHandle;
export type ClearFn = (handle: TimerHandle) => void;
export type NowFn = () => number;

// setTimeout stores its delay in a 32-bit signed int; anything larger is
// silently coerced to 1ms by Node (with a TimeoutOverflowWarning), so a timer
// armed more than ~24.8 days out would fire almost immediately. Cap each timer
// at this ceiling and re-arm the remainder until the real due time.
export const MAX_TIMER_DELAY_MS = 2_147_483_647; // 2^31 - 1 ≈ 24.8 days

const defaultTimerFactory: TimerFactory = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  (handle as { unref?: () => void }).unref?.();
  return handle;
};

const defaultClearFn: ClearFn = (handle) => clearTimeout(handle);

export class TimerWhenCronService implements WhenCronService {
  private readonly timerFactory: TimerFactory;
  private readonly clearFn: ClearFn;
  private readonly now: NowFn;
  private readonly _handles = new Map<string, TimerHandle>();

  constructor(
    timerFactory: TimerFactory = defaultTimerFactory,
    clearFn: ClearFn = defaultClearFn,
    now: NowFn = () => Date.now(),
  ) {
    this.timerFactory = timerFactory;
    this.clearFn = clearFn;
    this.now = now;
  }

  scheduleAt(id: string, isoTime: string, callback: () => void): void {
    // Cancel any existing job for this id (idempotent re-arm).
    this.cancel(id);

    const fireAtMs = Date.parse(isoTime);
    // Unparseable / past / now → fire on the next macrotask (targetMs = now).
    const targetMs = Number.isNaN(fireAtMs) ? this.now() : fireAtMs;
    this._armChunk(id, targetMs, callback);
  }

  /**
   * Arm a single timer chunk toward `targetMs`. If the remaining time exceeds
   * the 32-bit setTimeout ceiling, arm a capped chunk that re-arms itself on
   * expiry; otherwise arm the final chunk that invokes the callback.
   */
  private _armChunk(id: string, targetMs: number, callback: () => void): void {
    const remaining = Math.max(0, targetMs - this.now());
    const isFinal = remaining <= MAX_TIMER_DELAY_MS;
    const delay = isFinal ? remaining : MAX_TIMER_DELAY_MS;

    const handle = this.timerFactory(() => {
      if (isFinal) {
        this._handles.delete(id);
        callback();
      } else {
        // Intermediate chunk elapsed — re-arm for the remaining time.
        this._armChunk(id, targetMs, callback);
      }
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
