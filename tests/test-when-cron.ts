// =============================================================================
// test-when-cron.ts — TimerWhenCronService unit tests.
// Uses injected fake timer factory + clearFn so no real wall-clock waits occur.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { TimerWhenCronService, MAX_TIMER_DELAY_MS } from "../src/ambient/when-cron.js";
import type { TimerFactory, ClearFn, TimerHandle } from "../src/ambient/when-cron.js";

// ---------------------------------------------------------------------------
// Fake timer infrastructure
// ---------------------------------------------------------------------------

type FakeHandle = { id: number; delayMs: number; callback: () => void; cancelled: boolean };

function makeFakeTimers() {
  let nextId = 1;
  const handles = new Map<number, FakeHandle>();

  const factory: TimerFactory = (callback, delayMs) => {
    const id = nextId++;
    handles.set(id, { id, delayMs, callback, cancelled: false });
    return id as unknown as TimerHandle;
  };

  const clearFn: ClearFn = (handle) => {
    const id = handle as unknown as number;
    const h = handles.get(id);
    if (h) h.cancelled = true;
  };

  return {
    factory,
    clearFn,
    /** Fire all non-cancelled pending handles (in insertion order). */
    fireAll(): number {
      let fired = 0;
      for (const [id, h] of [...handles]) {
        if (!h.cancelled) {
          handles.delete(id);
          h.callback();
          fired++;
        }
      }
      return fired;
    },
    pendingCount(): number {
      return [...handles.values()].filter((h) => !h.cancelled).length;
    },
    pendingDelays(): number[] {
      return [...handles.values()].filter((h) => !h.cancelled).map((h) => h.delayMs);
    },
    handles,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TimerWhenCronService — scheduleAt with at", () => {
  test("schedules a job at the correct future time (positive delay)", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);
    const nowMs = Date.now();
    const fireAt = new Date(nowMs + 5_000).toISOString();

    svc.scheduleAt("job1", fireAt, () => {});

    const delays = fake.pendingDelays();
    expect(delays).toHaveLength(1);
    // Allow a few ms of drift.
    expect(delays[0]).toBeGreaterThanOrEqual(4_990);
    expect(delays[0]).toBeLessThanOrEqual(5_010);
  });

  test("past/now `at` schedules with delay=0 (not synchronous)", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);
    const pastAt = new Date(Date.now() - 1_000).toISOString();

    let fired = false;
    svc.scheduleAt("past", pastAt, () => { fired = true; });

    // Must have scheduled (not fired synchronously).
    expect(fired).toBe(false);
    expect(fake.pendingDelays()).toHaveLength(1);
    expect(fake.pendingDelays()[0]).toBe(0);
  });

  test("fires callback after scheduled delay", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);
    const nowMs = Date.now();
    const fireAt = new Date(nowMs + 5_000).toISOString();

    let fired = false;
    svc.scheduleAt("job2", fireAt, () => { fired = true; });

    expect(fired).toBe(false);
    fake.fireAll();
    expect(fired).toBe(true);
  });
});

describe("TimerWhenCronService — cancel", () => {
  test("cancel(id) prevents the callback from firing", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);

    let fired = false;
    svc.scheduleAt("to-cancel", new Date(Date.now() + 1_000).toISOString(), () => { fired = true; });
    svc.cancel("to-cancel");

    fake.fireAll();
    expect(fired).toBe(false);
  });

  test("cancel is idempotent — cancelling twice does not throw", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);

    svc.scheduleAt("idempotent", new Date(Date.now() + 1_000).toISOString(), () => {});
    svc.cancel("idempotent");
    expect(() => svc.cancel("idempotent")).not.toThrow();
  });

  test("cancel of unknown id does not throw", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);
    expect(() => svc.cancel("nonexistent")).not.toThrow();
  });
});

describe("TimerWhenCronService — cancelAll", () => {
  test("cancelAll() stops all pending callbacks", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);
    const nowMs = Date.now();

    let firedA = false, firedB = false;
    svc.scheduleAt("a", new Date(nowMs + 1_000).toISOString(), () => { firedA = true; });
    svc.scheduleAt("b", new Date(nowMs + 2_000).toISOString(), () => { firedB = true; });

    svc.cancelAll();
    fake.fireAll();

    expect(firedA).toBe(false);
    expect(firedB).toBe(false);
  });
});

describe("TimerWhenCronService — long-horizon chunking (>32-bit setTimeout ceiling)", () => {
  const DAY = 86_400_000;

  test("a reminder >24.8 days out caps the first timer instead of overflowing", () => {
    const fake = makeFakeTimers();
    let now = 0;
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn, () => now);

    let fired = false;
    // 60 days out — with the old code this delay (~5.18e9 ms) is coerced to 1ms
    // by setTimeout and would fire almost immediately.
    svc.scheduleAt("far", new Date(now + 60 * DAY).toISOString(), () => { fired = true; });

    const delays = fake.pendingDelays();
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(MAX_TIMER_DELAY_MS); // capped, not ~5.18e9 and not 1

    // Firing the first chunk must NOT invoke the callback — it re-arms.
    fake.fireAll();
    expect(fired).toBe(false);
    expect(fake.pendingCount()).toBe(1);
    expect(fake.pendingDelays()[0]).toBe(MAX_TIMER_DELAY_MS);
  });

  test("re-arms across chunks and fires exactly once at the true due time", () => {
    const fake = makeFakeTimers();
    let now = 0;
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn, () => now);
    const target = 60 * DAY; // 5_184_000_000 ms ≈ 2.4 chunks

    let fireCount = 0;
    svc.scheduleAt("far", new Date(target).toISOString(), () => { fireCount++; });

    // Chunk 1: full cap, not final.
    expect(fake.pendingDelays()[0]).toBe(MAX_TIMER_DELAY_MS);
    now += MAX_TIMER_DELAY_MS;
    fake.fireAll();
    expect(fireCount).toBe(0);

    // Chunk 2: still > cap remaining, another full cap.
    expect(fake.pendingDelays()[0]).toBe(MAX_TIMER_DELAY_MS);
    now += MAX_TIMER_DELAY_MS;
    fake.fireAll();
    expect(fireCount).toBe(0);

    // Chunk 3: remainder fits — final chunk, delay ≤ cap.
    const finalDelay = fake.pendingDelays()[0];
    expect(finalDelay).toBe(target - 2 * MAX_TIMER_DELAY_MS);
    expect(finalDelay).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    now = target;
    fake.fireAll();
    expect(fireCount).toBe(1);
  });

  test("cancel during an intermediate chunk stops the re-arm chain", () => {
    const fake = makeFakeTimers();
    let now = 0;
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn, () => now);

    let fired = false;
    svc.scheduleAt("far", new Date(now + 60 * DAY).toISOString(), () => { fired = true; });

    // Advance + fire the first chunk so it re-arms, then cancel mid-chain.
    now += MAX_TIMER_DELAY_MS;
    fake.fireAll();
    svc.cancel("far");

    now += 60 * DAY;
    fake.fireAll();
    expect(fired).toBe(false);
    expect(fake.pendingCount()).toBe(0);
  });
});

describe("TimerWhenCronService — idempotent re-arm", () => {
  test("scheduleAt with same id twice cancels the first and schedules the second", () => {
    const fake = makeFakeTimers();
    const svc = new TimerWhenCronService(fake.factory, fake.clearFn);
    const nowMs = Date.now();

    let fireCount = 0;
    svc.scheduleAt("dup", new Date(nowMs + 1_000).toISOString(), () => { fireCount++; });
    svc.scheduleAt("dup", new Date(nowMs + 2_000).toISOString(), () => { fireCount++; });

    // Only one active job (second replaced first; first is cancelled).
    expect(fake.pendingCount()).toBe(1);
    fake.fireAll();
    expect(fireCount).toBe(1);
  });
});
