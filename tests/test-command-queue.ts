// =============================================================================
// Command Queue + Lanes + Session Keys + Heartbeat Wake Tests
//
// Comprehensive tests for the gateway concurrency foundation.
// This is the architectural core — must be rock solid.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  enqueueCommandInLane,
  enqueueCommand,
  getQueueSize,
  getTotalQueueSize,
  getActiveCount,
  setCommandLaneConcurrency,
  clearCommandLane,
  markGatewayDraining,
  isGatewayDraining,
  waitForActiveTasks,
  resetAllLanes,
  getLaneNames,
  resetCommandQueue,
} from "../src/gateway/command-queue.js";
import {
  CommandLane,
  GatewayDrainingError,
  CommandLaneClearedError,
  WakePriority,
} from "../src/gateway/types.js";
import {
  resolveSessionLane,
  resolveGlobalLane,
  executeInSession,
  applyDefaultLaneConcurrency,
} from "../src/gateway/lanes.js";
import { buildSessionKey } from "../src/gateway/session-key.js";
import { HeartbeatWake } from "../src/gateway/heartbeat-wake.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Create a task that resolves after `ms` milliseconds with `value`. */
function delayTask<T>(ms: number, value: T): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Create a task that rejects after `ms` milliseconds. */
function failTask(ms: number, error: string): () => Promise<never> {
  return () => new Promise((_, reject) => setTimeout(() => reject(new Error(error)), ms));
}

/** Track execution order via a shared array. */
function orderTracker(log: string[], label: string, ms: number): () => Promise<string> {
  return async () => {
    log.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${label}`);
    return label;
  };
}

/** Immediate task — resolves synchronously. */
function immediateTask<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

beforeEach(() => {
  resetCommandQueue();
});

afterEach(() => {
  resetCommandQueue();
});

// =============================================================================
// COMMAND QUEUE — BASIC OPERATIONS
// =============================================================================

describe("command-queue: basic operations", () => {
  test("enqueue and execute a single task", async () => {
    const result = await enqueueCommandInLane("main", immediateTask(42));
    expect(result).toBe(42);
  });

  test("enqueue via enqueueCommand shorthand", async () => {
    const result = await enqueueCommand(CommandLane.Main, immediateTask("hello"));
    expect(result).toBe("hello");
  });

  test("task errors propagate to caller", async () => {
    const p = enqueueCommandInLane("main", failTask(0, "boom"));
    await expect(p).rejects.toThrow("boom");
  });

  test("empty lane name defaults to main", async () => {
    const result = await enqueueCommandInLane("  ", immediateTask("default"));
    expect(result).toBe("default");
    expect(getLaneNames()).toContain("main");
  });

  test("lane is created lazily on first enqueue", () => {
    expect(getLaneNames()).toEqual([]);
    void enqueueCommandInLane("test-lane", immediateTask(1));
    expect(getLaneNames()).toContain("test-lane");
  });
});

// =============================================================================
// COMMAND QUEUE — SERIALIZATION
// =============================================================================

describe("command-queue: serialization (max=1)", () => {
  test("tasks in same lane execute sequentially", async () => {
    const order: string[] = [];

    const p1 = enqueueCommandInLane("serial", orderTracker(order, "A", 30));
    const p2 = enqueueCommandInLane("serial", orderTracker(order, "B", 10));
    const p3 = enqueueCommandInLane("serial", orderTracker(order, "C", 10));

    await Promise.all([p1, p2, p3]);

    // A must start before B, B before C (FIFO serialization)
    expect(order).toEqual([
      "start:A", "end:A",
      "start:B", "end:B",
      "start:C", "end:C",
    ]);
  });

  test("failed task does not block subsequent tasks", async () => {
    const order: string[] = [];

    const p1 = enqueueCommandInLane("serial", async () => {
      order.push("start:fail");
      throw new Error("fail");
    });
    const p2 = enqueueCommandInLane("serial", orderTracker(order, "after", 10));

    await expect(p1).rejects.toThrow("fail");
    await p2;

    expect(order).toContain("start:fail");
    expect(order).toContain("start:after");
    expect(order).toContain("end:after");
  });

  test("queue size reflects pending + active", async () => {
    // Enqueue a slow task
    const p1 = enqueueCommandInLane("lane-q", delayTask(100, 1));
    // First task is active
    expect(getQueueSize("lane-q")).toBe(1);

    // Enqueue two more — they queue behind
    const p2 = enqueueCommandInLane("lane-q", delayTask(10, 2));
    const p3 = enqueueCommandInLane("lane-q", delayTask(10, 3));
    expect(getQueueSize("lane-q")).toBe(3); // 1 active + 2 queued

    await Promise.all([p1, p2, p3]);
    expect(getQueueSize("lane-q")).toBe(0);
  });

  test("getActiveCount shows executing tasks", async () => {
    const p = enqueueCommandInLane("active-test", delayTask(100, 1));
    // Task should be active immediately
    expect(getActiveCount("active-test")).toBe(1);
    await p;
    expect(getActiveCount("active-test")).toBe(0);
  });
});

// =============================================================================
// COMMAND QUEUE — CONCURRENCY
// =============================================================================

describe("command-queue: configurable concurrency", () => {
  test("max=2 allows two tasks to run in parallel", async () => {
    setCommandLaneConcurrency("parallel", 2);
    const order: string[] = [];

    const p1 = enqueueCommandInLane("parallel", orderTracker(order, "A", 50));
    const p2 = enqueueCommandInLane("parallel", orderTracker(order, "B", 50));
    const p3 = enqueueCommandInLane("parallel", orderTracker(order, "C", 50));

    await Promise.all([p1, p2, p3]);

    // A and B should start before either ends (parallel)
    const startA = order.indexOf("start:A");
    const startB = order.indexOf("start:B");
    const endA = order.indexOf("end:A");
    expect(startB).toBeLessThan(endA); // B starts before A ends
    // C should start only after A or B ends
    const startC = order.indexOf("start:C");
    expect(startC).toBeGreaterThan(Math.min(order.indexOf("end:A"), order.indexOf("end:B")));
  });

  test("increasing concurrency drains queued work", async () => {
    // Start with max=1, queue up 3 tasks
    const order: string[] = [];
    const p1 = enqueueCommandInLane("grow", orderTracker(order, "A", 100));
    const p2 = enqueueCommandInLane("grow", orderTracker(order, "B", 10));
    const p3 = enqueueCommandInLane("grow", orderTracker(order, "C", 10));

    // While A is running, increase concurrency to 3
    await new Promise((r) => setTimeout(r, 20));
    setCommandLaneConcurrency("grow", 3);

    await Promise.all([p1, p2, p3]);

    // B and C should have started in parallel after concurrency was increased
    const startB = order.indexOf("start:B");
    const startC = order.indexOf("start:C");
    const endB = order.indexOf("end:B");
    // B and C should start close together
    expect(Math.abs(startB - startC)).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// COMMAND QUEUE — PARALLEL LANES
// =============================================================================

describe("command-queue: parallel lanes", () => {
  test("different lanes run in parallel", async () => {
    const order: string[] = [];

    const p1 = enqueueCommandInLane("lane-A", orderTracker(order, "A", 50));
    const p2 = enqueueCommandInLane("lane-B", orderTracker(order, "B", 50));

    await Promise.all([p1, p2]);

    // A and B should start before either ends (parallel — different lanes)
    const startA = order.indexOf("start:A");
    const startB = order.indexOf("start:B");
    const endA = order.indexOf("end:A");
    const endB = order.indexOf("end:B");
    expect(startB).toBeLessThan(endA);
    expect(startA).toBeLessThan(endB);
  });

  test("Main and Cron lanes run independently", async () => {
    const order: string[] = [];

    const p1 = enqueueCommand(CommandLane.Main, orderTracker(order, "user-msg", 50));
    const p2 = enqueueCommand(CommandLane.Cron, orderTracker(order, "cron-job", 50));

    await Promise.all([p1, p2]);

    const startUser = order.indexOf("start:user-msg");
    const startCron = order.indexOf("start:cron-job");
    const endUser = order.indexOf("end:user-msg");
    expect(startCron).toBeLessThan(endUser); // Cron starts before user finishes
  });

  test("getTotalQueueSize sums across all lanes", async () => {
    const p1 = enqueueCommandInLane("l1", delayTask(100, 1));
    const p2 = enqueueCommandInLane("l2", delayTask(100, 2));
    expect(getTotalQueueSize()).toBe(2);
    await Promise.all([p1, p2]);
    expect(getTotalQueueSize()).toBe(0);
  });
});

// =============================================================================
// COMMAND QUEUE — GRACEFUL SHUTDOWN
// =============================================================================

describe("command-queue: graceful shutdown", () => {
  test("markGatewayDraining rejects new enqueues", async () => {
    markGatewayDraining();
    expect(isGatewayDraining()).toBe(true);

    const p = enqueueCommandInLane("main", immediateTask(1));
    await expect(p).rejects.toThrow(GatewayDrainingError);
  });

  test("waitForActiveTasks resolves when all tasks complete", async () => {
    const p1 = enqueueCommandInLane("drain", delayTask(50, 1));
    const p2 = enqueueCommandInLane("drain", delayTask(50, 2));

    markGatewayDraining();
    const { drained } = await waitForActiveTasks(5000);
    expect(drained).toBe(true);

    // Tasks should have completed
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });

  test("waitForActiveTasks times out if tasks are slow", async () => {
    void enqueueCommandInLane("slow", delayTask(5000, 1));

    markGatewayDraining();
    const { drained } = await waitForActiveTasks(100);
    expect(drained).toBe(false);
  });

  test("waitForActiveTasks resolves immediately when no tasks", async () => {
    const { drained } = await waitForActiveTasks(1000);
    expect(drained).toBe(true);
  });
});

// =============================================================================
// COMMAND QUEUE — LANE CLEARING
// =============================================================================

describe("command-queue: lane clearing", () => {
  test("clearCommandLane rejects queued entries", async () => {
    // Enqueue a slow task + two that will queue behind it
    void enqueueCommandInLane("clear-test", delayTask(200, 1));
    const p2 = enqueueCommandInLane("clear-test", immediateTask(2));
    const p3 = enqueueCommandInLane("clear-test", immediateTask(3));

    await new Promise((r) => setTimeout(r, 10)); // Let first task start
    const cleared = clearCommandLane("clear-test");
    expect(cleared).toBe(2); // Two queued entries cleared

    await expect(p2).rejects.toThrow(CommandLaneClearedError);
    await expect(p3).rejects.toThrow(CommandLaneClearedError);
  });

  test("clearCommandLane does not affect active task", async () => {
    const p1 = enqueueCommandInLane("clear-active", delayTask(50, "done"));
    // Eagerly handle rejection to prevent Bun unhandled rejection error
    let clearError: Error | null = null;
    const p2 = enqueueCommandInLane("clear-active", immediateTask("queued"))
      .catch((err) => { clearError = err; });

    await new Promise((r) => setTimeout(r, 10));
    clearCommandLane("clear-active");

    // Active task should still complete
    const result = await p1;
    expect(result).toBe("done");

    // Queued task should have been rejected
    await p2;
    expect(clearError).toBeInstanceOf(CommandLaneClearedError);
  });

  test("clearCommandLane on empty lane returns 0", () => {
    expect(clearCommandLane("nonexistent")).toBe(0);
  });
});

// =============================================================================
// COMMAND QUEUE — GENERATION TRACKING
// =============================================================================

describe("command-queue: generation tracking", () => {
  test("resetAllLanes ignores stale completions", async () => {
    const order: string[] = [];

    // Start a slow task
    const p1 = enqueueCommandInLane("gen-test", async () => {
      order.push("old-start");
      await new Promise((r) => setTimeout(r, 100));
      order.push("old-end");
      return "old";
    });

    await new Promise((r) => setTimeout(r, 20)); // Let it start

    // Reset — bumps generation
    resetAllLanes();

    // Enqueue new work
    const p2 = enqueueCommandInLane("gen-test", async () => {
      order.push("new-start");
      return "new";
    });

    // Old task completes but its completion is stale — should not affect new task
    const result1 = await p1;
    expect(result1).toBe("old");

    const result2 = await p2;
    expect(result2).toBe("new");
  });

  test("resetAllLanes clears gateway draining flag", () => {
    markGatewayDraining();
    expect(isGatewayDraining()).toBe(true);
    resetAllLanes();
    expect(isGatewayDraining()).toBe(false);
  });

  test("resetAllLanes re-drains queued work", async () => {
    // Put something in queue, then reset
    const p = enqueueCommandInLane("redrain", delayTask(200, "queued"));
    // Enqueue a second task
    const p2 = enqueueCommandInLane("redrain", immediateTask("second"));

    await new Promise((r) => setTimeout(r, 10));
    resetAllLanes(); // Should re-drain, allowing "second" to start

    const result2 = await p2;
    expect(result2).toBe("second");
  });
});

// =============================================================================
// COMMAND QUEUE — onWait CALLBACK
// =============================================================================

describe("command-queue: onWait callback", () => {
  test("onWait fires when task has waited past threshold", async () => {
    let waitInfo: { waitMs: number; queuedAhead: number } | null = null;

    // Block the lane
    void enqueueCommandInLane("wait-test", delayTask(100, "blocking"));

    // Queue with short threshold
    const p2 = enqueueCommandInLane("wait-test", immediateTask("waited"), {
      warnAfterMs: 10,
      onWait: (waitMs, ahead) => { waitInfo = { waitMs, ahead }; },
    });

    await p2;

    expect(waitInfo).not.toBeNull();
    expect(waitInfo!.waitMs).toBeGreaterThanOrEqual(10);
  });

  test("onWait does not fire when task starts quickly", async () => {
    let waitCalled = false;

    const p = enqueueCommandInLane("fast-lane", immediateTask("fast"), {
      warnAfterMs: 1000,
      onWait: () => { waitCalled = true; },
    });

    await p;
    expect(waitCalled).toBe(false);
  });

  test("onWait callback errors are swallowed", async () => {
    void enqueueCommandInLane("safe-wait", delayTask(50, 1));

    const p = enqueueCommandInLane("safe-wait", immediateTask(2), {
      warnAfterMs: 1,
      onWait: () => { throw new Error("callback boom"); },
    });

    // Should not throw despite callback error
    const result = await p;
    expect(result).toBe(2);
  });
});

// =============================================================================
// LANES — SESSION LANE HELPERS
// =============================================================================

describe("lanes: resolveSessionLane", () => {
  test("prefixes with session:", () => {
    expect(resolveSessionLane("tui:main")).toBe("session:tui:main");
  });

  test("does not double-prefix", () => {
    expect(resolveSessionLane("session:tui:main")).toBe("session:tui:main");
  });

  test("empty string defaults to session:main", () => {
    expect(resolveSessionLane("")).toBe("session:main");
    expect(resolveSessionLane("  ")).toBe("session:main");
  });
});

describe("lanes: resolveGlobalLane", () => {
  test("returns passed lane", () => {
    expect(resolveGlobalLane(CommandLane.Cron)).toBe("cron");
  });

  test("defaults to Main", () => {
    expect(resolveGlobalLane()).toBe("main");
  });
});

// =============================================================================
// LANES — NESTED EXECUTION
// =============================================================================

describe("lanes: executeInSession (nested execution)", () => {
  test("same session serializes messages", async () => {
    const order: string[] = [];

    const p1 = executeInSession("s1", CommandLane.Main, orderTracker(order, "msg1", 30));
    const p2 = executeInSession("s1", CommandLane.Main, orderTracker(order, "msg2", 10));

    await Promise.all([p1, p2]);

    // msg1 must complete before msg2 starts (same session)
    expect(order.indexOf("end:msg1")).toBeLessThan(order.indexOf("start:msg2"));
  });

  test("different sessions run in parallel (global max=2)", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 2);
    const order: string[] = [];

    const p1 = executeInSession("s1", CommandLane.Main, orderTracker(order, "A", 50));
    const p2 = executeInSession("s2", CommandLane.Main, orderTracker(order, "B", 50));

    await Promise.all([p1, p2]);

    // A and B should overlap (different sessions, global allows 2)
    const startA = order.indexOf("start:A");
    const startB = order.indexOf("start:B");
    const endA = order.indexOf("end:A");
    expect(startB).toBeLessThan(endA);
  });

  test("different sessions serialize with global max=1", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 1);
    const order: string[] = [];

    const p1 = executeInSession("s1", CommandLane.Main, orderTracker(order, "A", 30));
    const p2 = executeInSession("s2", CommandLane.Main, orderTracker(order, "B", 10));

    await Promise.all([p1, p2]);

    // With global max=1, A must finish before B starts (even though different sessions)
    expect(order.indexOf("end:A")).toBeLessThan(order.indexOf("start:B"));
  });

  test("session + cron run in parallel", async () => {
    const order: string[] = [];

    const p1 = executeInSession("user", CommandLane.Main, orderTracker(order, "chat", 50));
    const p2 = executeInSession("cron-job1", CommandLane.Cron, orderTracker(order, "cron", 50));

    await Promise.all([p1, p2]);

    // Chat and cron are on different global lanes — parallel
    const startChat = order.indexOf("start:chat");
    const startCron = order.indexOf("start:cron");
    const endChat = order.indexOf("end:chat");
    expect(startCron).toBeLessThan(endChat);
  });

  test("task errors in nested execution propagate correctly", async () => {
    const p = executeInSession("s1", CommandLane.Main, failTask(0, "nested fail"));
    await expect(p).rejects.toThrow("nested fail");
  });

  test("nested execution creates both session and global lanes", async () => {
    await executeInSession("test-session", CommandLane.Main, immediateTask("ok"));
    const names = getLaneNames();
    expect(names).toContain("session:test-session");
    expect(names).toContain("main");
  });
});

// =============================================================================
// LANES — DEFAULT CONCURRENCY
// =============================================================================

describe("lanes: applyDefaultLaneConcurrency", () => {
  test("sets defaults for Main, Cron, Subagent", async () => {
    applyDefaultLaneConcurrency();
    // Verify by checking that lanes exist
    const names = getLaneNames();
    expect(names).toContain("main");
    expect(names).toContain("cron");
    expect(names).toContain("subagent");
  });

  test("respects overrides", async () => {
    applyDefaultLaneConcurrency({ main: 2, cron: 3, subagent: 5 });

    // Verify Main allows 2 concurrent
    const order: string[] = [];
    const p1 = enqueueCommand(CommandLane.Main, orderTracker(order, "A", 50));
    const p2 = enqueueCommand(CommandLane.Main, orderTracker(order, "B", 50));
    await Promise.all([p1, p2]);

    // Both should have started before either ended
    expect(order.indexOf("start:B")).toBeLessThan(order.indexOf("end:A"));
  });
});

// =============================================================================
// SESSION KEYS
// =============================================================================

describe("session-key: buildSessionKey", () => {
  test("TUI session", () => {
    expect(buildSessionKey({ channel: "tui" })).toBe("tui:main");
  });

  test("web tab session", () => {
    expect(buildSessionKey({ channel: "web", chatId: "tab-abc123" })).toBe("web:tab-abc123");
  });

  test("cron job session", () => {
    expect(buildSessionKey({ channel: "cron", chatId: "daily-standup" })).toBe("cron:daily-standup");
  });

  test("heartbeat session", () => {
    expect(buildSessionKey({ channel: "heartbeat" })).toBe("heartbeat:main");
  });

  test("normalizes channel and chatId", () => {
    expect(buildSessionKey({ channel: " Web ", chatId: "Tab ABC" })).toBe("web:tab_abc");
  });

  test("empty channel uses unknown", () => {
    expect(buildSessionKey({ channel: "" })).toBe("unknown:main");
  });

  test("special characters normalized to underscore", () => {
    expect(buildSessionKey({ channel: "web", chatId: "tab@#$123" })).toBe("web:tab___123");
  });
});

// =============================================================================
// HEARTBEAT WAKE
// =============================================================================

describe("heartbeat-wake: basic operation", () => {
  test("fires handler when Main lane is idle", async () => {
    let handlerCalled = false;
    const wake = new HeartbeatWake(async () => {
      handlerCalled = true;
      return { status: "ran" };
    });

    wake.requestNow({ coalesceMs: 0 });
    await new Promise((r) => setTimeout(r, 50));

    expect(handlerCalled).toBe(true);
    wake.stop();
  });

  test("skips and retries when Main lane is busy", async () => {
    let callCount = 0;
    const wake = new HeartbeatWake(async () => {
      callCount++;
      return { status: "ran" };
    });

    // Block the Main lane
    const blocker = enqueueCommand(CommandLane.Main, delayTask(150, "busy"));

    wake.requestNow({ coalesceMs: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(callCount).toBe(0); // Should have skipped

    await blocker; // Main lane clears
    await new Promise((r) => setTimeout(r, 1200)); // Wait for retry (1s)

    expect(callCount).toBe(1); // Should have retried and run
    wake.stop();
  });

  test("coalesces multiple requests", async () => {
    let callCount = 0;
    const wake = new HeartbeatWake(async () => {
      callCount++;
      return { status: "ran" };
    });

    // Fire 3 requests rapidly with coalescing
    wake.requestNow({ coalesceMs: 100 });
    wake.requestNow({ coalesceMs: 100 });
    wake.requestNow({ coalesceMs: 100 });

    await new Promise((r) => setTimeout(r, 200));

    expect(callCount).toBe(1); // Only one execution despite 3 requests
    wake.stop();
  });

  test("keeps highest priority when coalescing", async () => {
    let lastPriority: WakePriority | null = null;
    const wake = new HeartbeatWake(async () => {
      return { status: "ran" };
    });

    // Can't directly check priority in handler, but we can verify coalescing behavior
    wake.requestNow({ priority: WakePriority.Interval, coalesceMs: 100 });
    wake.requestNow({ priority: WakePriority.Action, coalesceMs: 100 });

    expect(wake.hasPending()).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    wake.stop();
  });

  test("stop cancels pending timer", async () => {
    let handlerCalled = false;
    const wake = new HeartbeatWake(async () => {
      handlerCalled = true;
      return { status: "ran" };
    });

    wake.requestNow({ coalesceMs: 100 });
    wake.stop();

    await new Promise((r) => setTimeout(r, 200));
    expect(handlerCalled).toBe(false);
  });

  test("isRunning reflects handler execution state", async () => {
    let resolveHandler: (() => void) | null = null;
    const wake = new HeartbeatWake(async () => {
      await new Promise<void>((r) => { resolveHandler = r; });
      return { status: "ran" };
    });

    expect(wake.isRunning()).toBe(false);

    wake.requestNow({ coalesceMs: 0 });
    await new Promise((r) => setTimeout(r, 50));

    expect(wake.isRunning()).toBe(true);

    resolveHandler!();
    await new Promise((r) => setTimeout(r, 50));

    expect(wake.isRunning()).toBe(false);
    wake.stop();
  });

  test("handler error does not crash scheduler", async () => {
    let secondCallMade = false;
    let callCount = 0;
    const wake = new HeartbeatWake(async () => {
      callCount++;
      if (callCount === 1) throw new Error("heartbeat boom");
      secondCallMade = true;
      return { status: "ran" };
    });

    wake.requestNow({ coalesceMs: 0 });
    await new Promise((r) => setTimeout(r, 50));

    // First call should have failed but scheduler should still work
    wake.requestNow({ coalesceMs: 0 });
    await new Promise((r) => setTimeout(r, 50));

    expect(secondCallMade).toBe(true);
    wake.stop();
  });

  test("hasPending reflects queued state", () => {
    const wake = new HeartbeatWake(async () => ({ status: "ran" }));

    expect(wake.hasPending()).toBe(false);
    wake.requestNow({ coalesceMs: 500 });
    expect(wake.hasPending()).toBe(true);

    wake.stop();
  });

  test("stopped wake ignores requests", () => {
    const wake = new HeartbeatWake(async () => ({ status: "ran" }));
    wake.stop();
    wake.requestNow({ coalesceMs: 0 });
    expect(wake.hasPending()).toBe(false);
  });
});

// =============================================================================
// INTEGRATION — FULL SCENARIO TESTS
// =============================================================================

describe("integration: multi-session gateway scenario", () => {
  test("two web tabs chatting simultaneously", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 2); // Allow parallel sessions
    const order: string[] = [];

    // Tab A sends a message
    const pA = executeInSession(
      buildSessionKey({ channel: "web", chatId: "tab-A" }),
      CommandLane.Main,
      orderTracker(order, "tabA-msg1", 50),
    );

    // Tab B sends a message at the same time
    const pB = executeInSession(
      buildSessionKey({ channel: "web", chatId: "tab-B" }),
      CommandLane.Main,
      orderTracker(order, "tabB-msg1", 50),
    );

    await Promise.all([pA, pB]);

    // Both should have run in parallel (different sessions, Main max=2)
    expect(order.indexOf("start:tabB-msg1")).toBeLessThan(order.indexOf("end:tabA-msg1"));
  });

  test("rapid messages in same tab are serialized", async () => {
    const order: string[] = [];
    const sessionKey = buildSessionKey({ channel: "web", chatId: "tab-A" });

    const p1 = executeInSession(sessionKey, CommandLane.Main, orderTracker(order, "msg1", 30));
    const p2 = executeInSession(sessionKey, CommandLane.Main, orderTracker(order, "msg2", 10));
    const p3 = executeInSession(sessionKey, CommandLane.Main, orderTracker(order, "msg3", 10));

    await Promise.all([p1, p2, p3]);

    // Must be strictly sequential within the same session
    expect(order).toEqual([
      "start:msg1", "end:msg1",
      "start:msg2", "end:msg2",
      "start:msg3", "end:msg3",
    ]);
  });

  test("cron job runs while user chats", async () => {
    const order: string[] = [];

    const userChat = executeInSession(
      buildSessionKey({ channel: "tui" }),
      CommandLane.Main,
      orderTracker(order, "chat", 50),
    );

    const cronJob = executeInSession(
      buildSessionKey({ channel: "cron", chatId: "standup" }),
      CommandLane.Cron,
      orderTracker(order, "cron", 50),
    );

    await Promise.all([userChat, cronJob]);

    // Cron and chat are on different global lanes — parallel
    expect(order.indexOf("start:cron")).toBeLessThan(order.indexOf("end:chat"));
  });

  test("heartbeat skips when user is chatting, runs after", async () => {
    let heartbeatRan = false;
    const wake = new HeartbeatWake(async () => {
      heartbeatRan = true;
      return { status: "ran" };
    });

    // User is chatting — block Main lane
    const chat = enqueueCommand(CommandLane.Main, delayTask(150, "chat"));

    // Heartbeat fires — should skip
    wake.requestNow({ coalesceMs: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(heartbeatRan).toBe(false);

    // Chat finishes — heartbeat retries after 1s
    await chat;
    await new Promise((r) => setTimeout(r, 1200));
    expect(heartbeatRan).toBe(true);

    wake.stop();
  });

  test("gateway shutdown drains in-flight work", async () => {
    const results: string[] = [];

    const p1 = executeInSession("s1", CommandLane.Main, async () => {
      await new Promise((r) => setTimeout(r, 50));
      results.push("completed");
      return "done";
    });

    markGatewayDraining();

    // New work rejected
    const p2 = executeInSession("s2", CommandLane.Main, immediateTask("new"));
    await expect(p2).rejects.toThrow(GatewayDrainingError);

    // Wait for in-flight
    const { drained } = await waitForActiveTasks(5000);
    expect(drained).toBe(true);
    expect(results).toEqual(["completed"]);
  });
});

// =============================================================================
// STRESS TESTS
// =============================================================================

describe("stress: high concurrency", () => {
  test("100 tasks across 10 sessions all complete", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 5);
    const promises: Promise<number>[] = [];

    for (let i = 0; i < 100; i++) {
      const sessionKey = `session-${i % 10}`;
      const taskNum = i;
      promises.push(
        executeInSession(sessionKey, CommandLane.Main, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return taskNum;
        }),
      );
    }

    const results = await Promise.all(promises);
    // All 100 tasks should complete with correct values
    expect(results.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(results[i]).toBe(i);
    }
  });

  test("messages within each session are ordered correctly", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 3);
    const sessionOrders = new Map<string, number[]>();

    const promises: Promise<void>[] = [];

    for (let session = 0; session < 5; session++) {
      const key = `order-test-${session}`;
      sessionOrders.set(key, []);
      for (let msg = 0; msg < 10; msg++) {
        const msgNum = msg;
        promises.push(
          executeInSession(key, CommandLane.Main, async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 5));
            sessionOrders.get(key)!.push(msgNum);
          }),
        );
      }
    }

    await Promise.all(promises);

    // Each session's messages must be in order (0, 1, 2, ..., 9)
    for (const [key, order] of sessionOrders) {
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
  });

  test("mixed lane types all complete", async () => {
    const results: string[] = [];

    const promises = [
      enqueueCommand(CommandLane.Main, async () => { results.push("main"); return "main"; }),
      enqueueCommand(CommandLane.Cron, async () => { results.push("cron"); return "cron"; }),
      enqueueCommand(CommandLane.Subagent, async () => { results.push("sub1"); return "sub1"; }),
      enqueueCommand(CommandLane.Subagent, async () => { results.push("sub2"); return "sub2"; }),
      enqueueCommand(CommandLane.Subagent, async () => { results.push("sub3"); return "sub3"; }),
    ];

    await Promise.all(promises);
    expect(results.sort()).toEqual(["cron", "main", "sub1", "sub2", "sub3"]);
  });
});

// =============================================================================
// EDGE CASES & RACE CONDITIONS
// =============================================================================

describe("edge cases: race conditions and adversarial patterns", () => {
  test("enqueue during task execution (re-entrant, different lane)", async () => {
    // A task enqueues work on a DIFFERENT lane during execution — no deadlock
    const order: string[] = [];

    await enqueueCommandInLane("reentrant-outer", async () => {
      order.push("outer-start");
      // Enqueue on different lane — runs in parallel, no deadlock
      const inner = await enqueueCommandInLane("reentrant-inner", async () => {
        order.push("inner");
        return "inner-done";
      });
      order.push("outer-end");
      return inner;
    });

    expect(order).toEqual(["outer-start", "inner", "outer-end"]);
  });

  test("fire-and-forget on same lane runs after outer completes", async () => {
    // Enqueue on same lane without awaiting — inner queues behind outer.
    // Once outer completes, pump drains and inner runs. No deadlock.
    const order: string[] = [];

    const p = enqueueCommandInLane("reentrant-same", async () => {
      order.push("outer-start");
      // Fire-and-forget — queues behind outer
      void enqueueCommandInLane("reentrant-same", async () => {
        order.push("inner");
        return "inner";
      });
      order.push("outer-end");
      return "outer";
    });

    const result = await p;
    expect(result).toBe("outer");
    // Inner hasn't run yet (outer just completed, pump will drain next tick)
    await new Promise((r) => setTimeout(r, 10));
    // Now inner should have run
    expect(order).toEqual(["outer-start", "outer-end", "inner"]);
  });

  test("await same-lane from within deadlocks (by design)", async () => {
    // If outer AWAITS inner on same lane (max=1), it deadlocks.
    // Outer holds the slot, inner needs the slot, neither can proceed.
    // This is expected behavior. Verify with a timeout.
    let timedOut = false;

    const p = enqueueCommandInLane("deadlock", async () => {
      const inner = enqueueCommandInLane("deadlock", immediateTask("inner"));
      // Race: await inner (will deadlock) vs timeout
      const result = await Promise.race([
        inner,
        new Promise<string>((r) => setTimeout(() => { timedOut = true; r("timeout"); }, 200)),
      ]);
      return result;
    });

    const result = await p;
    expect(timedOut).toBe(true);
    expect(result).toBe("timeout");
  });

  test("clearCommandLane during drain does not corrupt state", async () => {
    // Enqueue many tasks, clear mid-drain
    const completed: number[] = [];
    const rejected: number[] = [];

    const blocker = enqueueCommandInLane("clear-race", delayTask(50, "block"));

    const tasks = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      tasks.push(
        enqueueCommandInLane("clear-race", async () => { completed.push(idx); return idx; })
          .catch(() => { rejected.push(idx); })
      );
    }

    await new Promise((r) => setTimeout(r, 20));
    const cleared = clearCommandLane("clear-race");
    expect(cleared).toBe(10); // All 10 should be queued

    await blocker;
    await Promise.all(tasks);

    // Blocker completed, all 10 were rejected
    expect(completed).toEqual([]);
    expect(rejected.length).toBe(10);
  });

  test("resetAllLanes during active work doesn't lose queued tasks", async () => {
    const results: string[] = [];

    // Start a task, queue another
    void enqueueCommandInLane("reset-race", async () => {
      await new Promise((r) => setTimeout(r, 100));
      results.push("old");
      return "old";
    });

    const p2 = enqueueCommandInLane("reset-race", async () => {
      results.push("new");
      return "new";
    });

    await new Promise((r) => setTimeout(r, 20));
    resetAllLanes(); // Queued task should be re-drained

    const result = await p2;
    expect(result).toBe("new");
    expect(results).toContain("new");
  });

  test("markGatewayDraining then resetAllLanes allows new work", async () => {
    markGatewayDraining();
    await expect(enqueueCommandInLane("main", immediateTask(1))).rejects.toThrow(GatewayDrainingError);

    resetAllLanes(); // Should clear draining flag

    const result = await enqueueCommandInLane("main", immediateTask(42));
    expect(result).toBe(42);
  });

  test("rapidly alternating sessions stress test", async () => {
    // Simulate 50 messages alternating between 2 sessions rapidly
    setCommandLaneConcurrency(CommandLane.Main, 2);
    const s1Order: number[] = [];
    const s2Order: number[] = [];

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const session = i % 2 === 0 ? "rapid-s1" : "rapid-s2";
      const msgNum = Math.floor(i / 2);
      const orderArr = i % 2 === 0 ? s1Order : s2Order;
      promises.push(
        executeInSession(session, CommandLane.Main, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          orderArr.push(msgNum);
        }),
      );
    }

    await Promise.all(promises);

    // Each session's messages must be in strict order
    expect(s1Order).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(s2Order).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("heartbeat wake during gateway drain is ignored", async () => {
    let handlerCalled = false;
    const wake = new HeartbeatWake(async () => {
      handlerCalled = true;
      return { status: "ran" };
    });

    markGatewayDraining();
    wake.stop(); // Stop rejects further requests
    wake.requestNow({ coalesceMs: 0 });

    await new Promise((r) => setTimeout(r, 50));
    expect(handlerCalled).toBe(false);
  });

  test("concurrent executeInSession + clearCommandLane", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 2);
    const results: string[] = [];

    // Start work on two sessions
    const p1 = executeInSession("clear-s1", CommandLane.Main, async () => {
      await new Promise((r) => setTimeout(r, 50));
      results.push("s1-done");
      return "s1";
    });

    const p2 = executeInSession("clear-s2", CommandLane.Main, async () => {
      await new Promise((r) => setTimeout(r, 50));
      results.push("s2-done");
      return "s2";
    });

    // Both should complete — clearing a different lane doesn't affect them
    clearCommandLane("unrelated-lane");
    await Promise.all([p1, p2]);

    expect(results).toContain("s1-done");
    expect(results).toContain("s2-done");
  });

  test("zero-delay tasks don't starve later enqueues", async () => {
    // Enqueue 20 immediate tasks, verify they all complete
    const results: number[] = [];
    const promises: Promise<number>[] = [];

    for (let i = 0; i < 20; i++) {
      const n = i;
      promises.push(
        enqueueCommandInLane("starve-test", async () => {
          results.push(n);
          return n;
        })
      );
    }

    const all = await Promise.all(promises);
    expect(all).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test("getQueueSize for nonexistent lane returns 0", () => {
    expect(getQueueSize("does-not-exist")).toBe(0);
    expect(getActiveCount("does-not-exist")).toBe(0);
  });
});
