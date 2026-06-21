// =============================================================================
// Test: LatentHeartbeatService (M8 §3.2)
// Run: bun test tests/test-latent-heartbeat.ts
// Covers: executeTickNow() calls tick() + updates status.lastRunAt;
//   in-flight guard skips concurrent executeTick while one is awaiting;
//   stop() clears the timer; enabled:false → start() no-ops.
// No real wall-clock waits — uses deferred promises and executeTickNow().
// =============================================================================

import { describe, test, expect } from "bun:test";
import { LatentHeartbeatService } from "../src/ambient/latent-heartbeat.js";
import type { LatentService } from "../src/ambient/latent-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deferred promise: lets a test hold a tick mid-flight. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Build a fake LatentService stub. tickFn controls what tick() does. */
function makeStub(tickFn?: () => Promise<void>): { stub: LatentService; calls: number[] } {
  const calls: number[] = [];
  const stub = {
    tick: async () => {
      calls.push(Date.now());
      if (tickFn) await tickFn();
    },
  } as unknown as LatentService;
  return { stub, calls };
}

/** Build a LatentHeartbeatService with a long interval so no real timer fires. */
function makeHeartbeat(opts?: {
  tickFn?: () => Promise<void>;
  enabled?: boolean;
}): {
  heartbeat: LatentHeartbeatService;
  calls: number[];
} {
  const { stub, calls } = makeStub(opts?.tickFn);
  const heartbeat = new LatentHeartbeatService({
    latentService: stub,
    intervalMs: 999_999, // Won't fire in tests
    enabled: opts?.enabled ?? true,
  });
  return { heartbeat, calls };
}

// ---------------------------------------------------------------------------
// executeTickNow() calls tick() once + updates status.lastRunAt
// ---------------------------------------------------------------------------

describe("LatentHeartbeatService — executeTickNow()", () => {
  test("calls latentService.tick() exactly once and updates lastRunAt", async () => {
    const { heartbeat, calls } = makeHeartbeat();

    const before = Date.now();
    await heartbeat.executeTickNow();
    const after = Date.now();

    expect(calls.length).toBe(1);
    const status = heartbeat.getStatus();
    expect(status.lastRunAt).not.toBeNull();
    expect(status.lastRunAt!).toBeGreaterThanOrEqual(before);
    expect(status.lastRunAt!).toBeLessThanOrEqual(after);
  });

  test("status.running is false after tick completes", async () => {
    const { heartbeat } = makeHeartbeat();
    await heartbeat.executeTickNow();
    expect(heartbeat.getStatus().running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-flight guard: skips concurrent executeTick while one is awaiting
// ---------------------------------------------------------------------------

describe("LatentHeartbeatService — in-flight guard", () => {
  test("second executeTick call is skipped while first is still awaiting", async () => {
    const gate = deferred();
    let tickCount = 0;

    const { heartbeat } = makeHeartbeat({
      tickFn: async () => {
        tickCount++;
        await gate.promise; // Hold mid-flight
      },
    });

    // Fire first tick (not awaited yet — it's stuck at gate)
    const first = heartbeat.executeTickNow();

    // Fire second tick immediately (should be skipped by inFlight guard)
    await heartbeat.executeTickNow();

    // Resolve the gate to let first tick complete
    gate.resolve();
    await first;

    // tick() was only called once despite two executeTickNow() calls
    expect(tickCount).toBe(1);
  });

  test("after first tick completes, a subsequent tick runs", async () => {
    const { heartbeat, calls } = makeHeartbeat();

    await heartbeat.executeTickNow();
    await heartbeat.executeTickNow();

    // Both should have run since first completed before second started
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// stop() clears the timer
// ---------------------------------------------------------------------------

describe("LatentHeartbeatService — stop()", () => {
  test("stop() sets nextRunAt to null and marks stopped", async () => {
    const { heartbeat } = makeHeartbeat();
    heartbeat.start();

    const statusAfterStart = heartbeat.getStatus();
    expect(statusAfterStart.nextRunAt).not.toBeNull();

    heartbeat.stop();

    const statusAfterStop = heartbeat.getStatus();
    expect(statusAfterStop.nextRunAt).toBeNull();
  });

  test("stop() can be called multiple times without error", () => {
    const { heartbeat } = makeHeartbeat();
    heartbeat.start();
    heartbeat.stop();
    heartbeat.stop(); // Should not throw
  });
});

// ---------------------------------------------------------------------------
// enabled: false → start() no-ops
// ---------------------------------------------------------------------------

describe("LatentHeartbeatService — enabled:false", () => {
  test("start() on disabled heartbeat does not arm an interval", () => {
    const { heartbeat } = makeHeartbeat({ enabled: false });
    heartbeat.start();

    const status = heartbeat.getStatus();
    // nextRunAt stays null because no interval was armed
    expect(status.nextRunAt).toBeNull();
    expect(status.enabled).toBe(false);
  });

  test("start() on disabled heartbeat arms no timer (nextRunAt null, no tick scheduled)", () => {
    const { heartbeat, calls } = makeHeartbeat({ enabled: false });
    heartbeat.start();

    // start() bailed before armInterval(), so no timer is scheduled.
    const status = heartbeat.getStatus();
    expect(status.nextRunAt).toBeNull();
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hardening (codex review r1: double-arm leak + stop guard)
// ---------------------------------------------------------------------------

describe("LatentHeartbeatService — lifecycle hardening", () => {
  test("double start() then stop() leaves a clean stopped state (no leaked timer)", async () => {
    const { heartbeat, calls } = makeHeartbeat();
    heartbeat.start();
    heartbeat.start(); // re-arm must clear the first timer, not leak it
    heartbeat.stop();

    expect(heartbeat.getStatus().nextRunAt).toBeNull();
    // stopped guard: a queued/manual tick after stop must not run
    await heartbeat.executeTickNow();
    expect(calls.length).toBe(0);
  });

  test("stopped guard prevents execution after stop()", async () => {
    const { heartbeat, calls } = makeHeartbeat();
    heartbeat.start();
    heartbeat.stop();

    await heartbeat.executeTickNow();
    expect(calls.length).toBe(0);
    expect(heartbeat.getStatus().nextRunAt).toBeNull();
  });

  test("stop() during an in-flight tick: no re-schedule, no re-entry", async () => {
    const gate = deferred();
    let tickCount = 0;
    const { heartbeat } = makeHeartbeat({
      tickFn: async () => {
        tickCount++;
        await gate.promise;
      },
    });

    const inflight = heartbeat.executeTickNow(); // stuck at gate (inFlight)
    heartbeat.stop(); // lands mid-flight
    gate.resolve();
    await inflight;

    // finally must NOT re-schedule because stop() landed during the tick
    expect(heartbeat.getStatus().nextRunAt).toBeNull();
    // a subsequent tick is refused by the stopped guard
    await heartbeat.executeTickNow();
    expect(tickCount).toBe(1);
  });

  test("a tick that throws resets running/inFlight so the next tick can run", async () => {
    let n = 0;
    const { heartbeat, calls } = makeHeartbeat({
      tickFn: async () => {
        n++;
        if (n === 1) throw new Error("boom"); // first tick fails
      },
    });

    // First tick throws but is caught (non-fatal); state resets in finally
    await heartbeat.executeTickNow();
    expect(heartbeat.getStatus().running).toBe(false);

    // Second tick runs normally (inFlight was reset despite the throw)
    await heartbeat.executeTickNow();
    expect(calls.length).toBe(2); // both ticks entered tick()
  });

  test("stop() then start() while a tick is in flight does not overlap ticks", async () => {
    const gate = deferred();
    let tickCount = 0;
    const { heartbeat } = makeHeartbeat({
      tickFn: async () => {
        tickCount++;
        await gate.promise;
      },
    });

    const inflight = heartbeat.executeTickNow(); // inFlight=true, awaiting gate
    heartbeat.stop(); // must NOT clear inFlight while the tick is still running
    heartbeat.start(); // stopped=false again
    // The old tick is still in flight → the inFlight guard must block a new run.
    await heartbeat.executeTickNow();
    expect(tickCount).toBe(1);

    gate.resolve();
    await inflight; // old tick finishes; its finally resets inFlight

    // Now a fresh tick is allowed.
    await heartbeat.executeTickNow();
    expect(tickCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getStatus() returns a copy
// ---------------------------------------------------------------------------

describe("LatentHeartbeatService — getStatus()", () => {
  test("getStatus() returns a snapshot, not the live reference", async () => {
    const { heartbeat } = makeHeartbeat();
    const s1 = heartbeat.getStatus();
    await heartbeat.executeTickNow();
    const s2 = heartbeat.getStatus();

    // s1 was captured before the tick; s2 after — lastRunAt should differ
    expect(s1.lastRunAt).toBeNull();
    expect(s2.lastRunAt).not.toBeNull();
  });
});
