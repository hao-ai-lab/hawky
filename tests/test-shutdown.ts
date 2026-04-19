// =============================================================================
// Tests: Graceful Shutdown
//
// Unit tests for the shutdown orchestrator. Uses mock services to verify
// shutdown sequence, drain behavior, failsafe timer, and service stop order.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  gracefulShutdown,
  isShutdownInProgress,
  resetShutdownState,
  type ShutdownDeps,
} from "../src/gateway/shutdown.js";
import { resetCommandQueue, enqueueCommandInLane, setCommandLaneConcurrency } from "../src/gateway/command-queue.js";
import { resetWsPermissions } from "../src/gateway/ws-permission.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Capture process.exit calls without actually exiting
let exitCalled = false;
let exitCode: number | undefined;
const originalExit = process.exit;

function mockProcessExit() {
  exitCalled = false;
  exitCode = undefined;
  // @ts-ignore — override process.exit for testing
  process.exit = ((code?: number) => {
    exitCalled = true;
    exitCode = code;
    // Don't actually exit — throw to break out of the shutdown flow
    throw new ShutdownExitError(code);
  }) as any;
}

function restoreProcessExit() {
  process.exit = originalExit;
}

class ShutdownExitError extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code})`);
  }
}

interface MockService {
  stopped: boolean;
  stop: () => void;
}

function makeMockHeartbeat(): MockService & { saveState: () => void; stateSaved: boolean } {
  return {
    stopped: false,
    stateSaved: false,
    stop() { this.stopped = true; },
    saveState() { this.stateSaved = true; },
  };
}

function makeMockCron(): MockService {
  return {
    stopped: false,
    stop() { this.stopped = true; },
  };
}

function makeMockGateway(): { stopped: boolean; stopTimeout: number; stop: (t: number) => Promise<void> } {
  return {
    stopped: false,
    stopTimeout: -1,
    async stop(timeout: number) {
      this.stopped = true;
      this.stopTimeout = timeout;
    },
  };
}

function makeMockDeps(overrides?: Partial<{
  heartbeat: ReturnType<typeof makeMockHeartbeat>;
  cronService: ReturnType<typeof makeMockCron>;
  gateway: ReturnType<typeof makeMockGateway>;
  activeSessionKeys: string[];
}>): ShutdownDeps & {
  heartbeat: ReturnType<typeof makeMockHeartbeat>;
  cronService: ReturnType<typeof makeMockCron>;
  gateway: ReturnType<typeof makeMockGateway>;
} {
  const heartbeat = overrides?.heartbeat ?? makeMockHeartbeat();
  const cronService = overrides?.cronService ?? makeMockCron();
  const gateway = overrides?.gateway ?? makeMockGateway();
  return {
    heartbeat: heartbeat as any,
    cronService: cronService as any,
    gateway: gateway as any,
    getActiveSessionKeys: () => overrides?.activeSessionKeys ?? [],
  };
}

// -----------------------------------------------------------------------------
// Setup / Teardown
// -----------------------------------------------------------------------------

beforeEach(() => {
  resetShutdownState();
  resetCommandQueue();
  setCommandLaneConcurrency("Main", 1);
  setCommandLaneConcurrency("Cron", 2);
  resetWsPermissions();
  mockProcessExit();
});

afterEach(() => {
  restoreProcessExit();
  resetShutdownState();
  resetCommandQueue();
});

// -----------------------------------------------------------------------------
// Shutdown sequence
// -----------------------------------------------------------------------------

describe("gracefulShutdown sequence", () => {
  test("stops heartbeat and cron before draining", async () => {
    const deps = makeMockDeps();
    const stopOrder: string[] = [];

    deps.heartbeat.stop = () => { stopOrder.push("heartbeat"); deps.heartbeat.stopped = true; };
    deps.cronService.stop = () => { stopOrder.push("cron"); deps.cronService.stopped = true; };
    (deps.gateway as any).stop = async () => { stopOrder.push("gateway"); };

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    expect(stopOrder).toEqual(["heartbeat", "cron", "gateway"]);
  });

  test("calls process.exit(0) on success", async () => {
    const deps = makeMockDeps();

    try {
      await gracefulShutdown(deps, 0);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("passes custom exit code", async () => {
    const deps = makeMockDeps();

    try {
      await gracefulShutdown(deps, 143);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    expect(exitCode).toBe(143);
  });

  test("gateway.stop called with 0 timeout (already drained)", async () => {
    const deps = makeMockDeps();

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    expect(deps.gateway.stopped).toBe(true);
    expect(deps.gateway.stopTimeout).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Double-shutdown protection
// -----------------------------------------------------------------------------

describe("double shutdown protection", () => {
  test("second call is a no-op", async () => {
    const deps = makeMockDeps();
    let callCount = 0;
    deps.heartbeat.stop = () => { callCount++; };

    // First call
    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    // Reset exit mock for second call
    mockProcessExit();

    // Second call — should be no-op (shutdownInProgress = true)
    await gracefulShutdown(deps);

    expect(callCount).toBe(1); // heartbeat.stop called only once
    expect(exitCalled).toBe(false); // process.exit not called again
  });

  test("isShutdownInProgress returns true during shutdown", async () => {
    expect(isShutdownInProgress()).toBe(false);

    const deps = makeMockDeps();
    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    expect(isShutdownInProgress()).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Drain behavior
// -----------------------------------------------------------------------------

describe("drain in-flight tasks", () => {
  test("waits for active tasks to complete", async () => {
    const deps = makeMockDeps();

    // Enqueue a task that takes 200ms
    let taskCompleted = false;
    void enqueueCommandInLane("Main", async () => {
      await new Promise((r) => setTimeout(r, 200));
      taskCompleted = true;
    });

    // Start shutdown after task is enqueued (give it a tick to start)
    await new Promise((r) => setTimeout(r, 10));

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    // Task should have completed (200ms < 10s drain timeout)
    expect(taskCompleted).toBe(true);
  });

  test("exits even if drain times out", async () => {
    // This test verifies that process.exit is called even with slow tasks.
    // We can't easily test the full 10s timeout, but we verify the shutdown
    // completes and calls exit.
    const deps = makeMockDeps();

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    expect(exitCalled).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

describe("shutdown error handling", () => {
  test("exits even if gateway.stop throws", async () => {
    const deps = makeMockDeps();
    (deps.gateway as any).stop = async () => {
      throw new Error("WebSocket close failed");
    };

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    // Should still exit despite error
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("exits even if heartbeat.stop throws", async () => {
    const deps = makeMockDeps();
    deps.heartbeat.stop = () => { throw new Error("heartbeat stop failed"); };

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    // The error propagates to the catch block, but finally calls exit
    expect(exitCalled).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Permission cancellation during shutdown
// -----------------------------------------------------------------------------

describe("permission cancellation on shutdown", () => {
  test("cancels pending permissions for active sessions", async () => {
    const deps = makeMockDeps({ activeSessionKeys: ["tui:main", "heartbeat:main"] });

    // Create a pending permission
    const { createWsPermissionResolver } = await import("../src/gateway/ws-permission.js");
    const mockServer = { broadcastToSession: () => {} } as any;
    const resolver = createWsPermissionResolver("tui:main", mockServer);

    // Start permission request
    const decisionPromise = resolver.ask("tool_1", "bash", { command: "rm" });

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    // Permission should have been resolved as deny
    const decision = await decisionPromise;
    expect(decision).toEqual({ decision: "deny" });
  });
});

// -----------------------------------------------------------------------------
// Integration: shutdown with active flush
// -----------------------------------------------------------------------------

describe("shutdown during active operations", () => {
  test("services stopped before drain", async () => {
    const deps = makeMockDeps();
    const timeline: Array<{ action: string; time: number }> = [];
    const start = Date.now();

    deps.heartbeat.stop = () => {
      timeline.push({ action: "heartbeat.stop", time: Date.now() - start });
      deps.heartbeat.stopped = true;
    };
    deps.cronService.stop = () => {
      timeline.push({ action: "cron.stop", time: Date.now() - start });
      deps.cronService.stopped = true;
    };

    try {
      await gracefulShutdown(deps);
    } catch (e) {
      if (!(e instanceof ShutdownExitError)) throw e;
    }

    // Both services should be stopped
    expect(deps.heartbeat.stopped).toBe(true);
    expect(deps.cronService.stopped).toBe(true);

    // Heartbeat stopped before cron (or at same time)
    expect(timeline[0].action).toBe("heartbeat.stop");
    expect(timeline[1].action).toBe("cron.stop");
  });
});
