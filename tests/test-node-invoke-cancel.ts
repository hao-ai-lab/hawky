// =============================================================================
// Node Invoke Cancellation Tests
//
// Tests end-to-end cancellation of node invokes: AbortSignal propagation
// from gateway to node, process killing, cleanup, and edge cases.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { NodeRegistry } from "../src/gateway/node-registry.js";
import type { GatewayConnection } from "../src/gateway/connection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Events captured from sendEvent calls on the mock connection. */
interface CapturedEvent {
  event: string;
  payload: unknown;
}

function makeMockConnection(connId: string): GatewayConnection & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    connId,
    events,
    sendEvent(frame: { type: string; event: string; payload?: unknown }): boolean {
      events.push({ event: frame.event, payload: frame.payload });
      return true;
    },
    close() {},
  } as unknown as GatewayConnection & { events: CapturedEvent[] };
}

function registerNode(
  registry: NodeRegistry,
  conn: GatewayConnection,
  nodeId = "node-1",
  name = "test-mac",
): void {
  registry.register(conn, {
    nodeId,
    name,
    commands: ["system.run", "system.which", "screenshot"],
    platform: "darwin",
  });
}

/** Extract invoke ID from a captured node.invoke.request event. */
function getInvokeId(events: CapturedEvent[], index = 0): string {
  const reqs = events.filter((e) => e.event === "node.invoke.request");
  return (reqs[index].payload as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Tests: Gateway-level cancellation (NodeRegistry)
// ---------------------------------------------------------------------------

describe("Node invoke cancellation", () => {
  let registry: NodeRegistry;
  let conn: ReturnType<typeof makeMockConnection>;

  beforeEach(() => {
    registry = new NodeRegistry();
    conn = makeMockConnection("conn-1");
    registerNode(registry, conn);
  });

  test("cancelInvoke resolves pending promise with error", async () => {
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] });
    const invokeId = getInvokeId(conn.events);

    registry.cancelInvoke(invokeId);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cancelled");
  });

  test("cancelInvoke sends node.invoke.cancel event to node", () => {
    void registry.invoke("node-1", "system.run", { command: ["sleep", "60"] });
    const invokeId = getInvokeId(conn.events);

    registry.cancelInvoke(invokeId);

    const cancelEvent = conn.events.find((e) => e.event === "node.invoke.cancel");
    expect(cancelEvent).toBeDefined();
    expect((cancelEvent!.payload as { id: string }).id).toBe(invokeId);
  });

  test("cancelInvoke is no-op for unknown invoke ID", () => {
    registry.cancelInvoke("nonexistent-id");
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });

  test("cancelInvoke is no-op after invoke already completed", async () => {
    const promise = registry.invoke("node-1", "system.run", { command: ["echo", "hi"] });
    const invokeId = getInvokeId(conn.events);

    registry.handleInvokeResult({
      id: invokeId,
      nodeId: "node-1",
      ok: true,
      payloadJSON: JSON.stringify({ stdout: "hi", stderr: "", exitCode: 0 }),
    });

    const result = await promise;
    expect(result.ok).toBe(true);

    registry.cancelInvoke(invokeId);
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });

  test("AbortSignal triggers cancelInvoke automatically", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac.signal);

    ac.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cancelled");

    const cancelEvent = conn.events.find((e) => e.event === "node.invoke.cancel");
    expect(cancelEvent).toBeDefined();
  });

  test("pre-aborted signal returns immediately without sending request", async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cancelled");

    expect(conn.events.filter((e) => e.event === "node.invoke.request")).toHaveLength(0);
  });

  test("late result after cancel is silently ignored", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac.signal);
    const invokeId = getInvokeId(conn.events);

    ac.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cancelled");

    // Late result — should not throw
    registry.handleInvokeResult({
      id: invokeId,
      nodeId: "node-1",
      ok: true,
      payloadJSON: JSON.stringify({ stdout: "done", stderr: "", exitCode: 0 }),
    });
  });

  test("cancel does not affect other pending invokes", async () => {
    const ac1 = new AbortController();
    const promise1 = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac1.signal);
    const promise2 = registry.invoke("node-1", "system.run", { command: ["echo", "hi"] });

    ac1.abort();
    const result1 = await promise1;
    expect(result1.ok).toBe(false);
    expect(result1.error).toBe("Cancelled");

    const invoke2Id = getInvokeId(conn.events, 1);
    registry.handleInvokeResult({
      id: invoke2Id,
      nodeId: "node-1",
      ok: true,
      payloadJSON: JSON.stringify({ stdout: "hi", stderr: "", exitCode: 0 }),
    });

    const result2 = await promise2;
    expect(result2.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Signal listener cleanup
// ---------------------------------------------------------------------------

describe("Signal listener cleanup", () => {
  let registry: NodeRegistry;
  let conn: ReturnType<typeof makeMockConnection>;

  beforeEach(() => {
    registry = new NodeRegistry();
    conn = makeMockConnection("conn-1");
    registerNode(registry, conn);
  });

  test("signal listener removed after normal completion", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["echo", "hi"] }, undefined, ac.signal);
    const invokeId = getInvokeId(conn.events);

    registry.handleInvokeResult({
      id: invokeId,
      nodeId: "node-1",
      ok: true,
      payloadJSON: JSON.stringify({ stdout: "hi", stderr: "", exitCode: 0 }),
    });

    await promise;

    // Aborting after completion should NOT send a cancel event — listener was detached
    ac.abort();
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });

  test("signal listener removed after timeout", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, 10, ac.signal);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");

    // Aborting after timeout should NOT send a cancel event
    ac.abort();
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });

  test("signal listener removed after node disconnect", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac.signal);

    registry.unregister("conn-1");

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disconnected");

    // Aborting after disconnect should NOT send a cancel event
    ac.abort();
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });

  test("signal listener removed after node reconnect", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac.signal);

    // Reconnect replaces old connection
    const conn2 = makeMockConnection("conn-2");
    registerNode(registry, conn2);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reconnected");

    // Aborting after reconnect should NOT send a cancel event
    ac.abort();
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
    expect(conn2.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });

  test("signal listener removed after registry destroy", async () => {
    const ac = new AbortController();
    const promise = registry.invoke("node-1", "system.run", { command: ["sleep", "60"] }, undefined, ac.signal);

    registry.destroy();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("shutting down");

    // Aborting after destroy should NOT send a cancel event
    ac.abort();
    expect(conn.events.filter((e) => e.event === "node.invoke.cancel")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Node-side command cancellation (systemRun with real processes)
// ---------------------------------------------------------------------------

describe("systemRun cancellation", () => {
  // Import dispatchCommand to test real process cancellation
  const { dispatchCommand } = require("../src/node/commands.js");

  test("abort signal kills running process", async () => {
    const ac = new AbortController();
    const promise = dispatchCommand("system.run", { command: ["sleep", "30"], timeoutMs: 30_000 }, ac.signal);

    // Give process time to start
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    const result = await promise;
    // Should complete quickly (not wait 30s) with exit code 130 (cancelled)
    expect(result.exitCode).toBe(130);
  });

  test("pre-aborted signal kills process immediately", async () => {
    const ac = new AbortController();
    ac.abort();

    const start = Date.now();
    const result = await dispatchCommand("system.run", { command: ["sleep", "10"], timeoutMs: 10_000 }, ac.signal);
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(130);
    expect(elapsed).toBeLessThan(3000); // Should not wait for sleep
  });

  test("completed process is not affected by later abort", async () => {
    const ac = new AbortController();
    const result = await dispatchCommand("system.run", { command: ["echo", "hello"], timeoutMs: 5_000 }, ac.signal);

    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);

    // Abort after completion — should not crash
    ac.abort();
  });

  test("process tree killed on cancel (backgrounded children)", async () => {
    const ac = new AbortController();
    // Use a unique marker file so we can verify child cleanup without pgrep races
    const marker = `/tmp/hawky-tree-kill-test-${Date.now()}`;
    // Background child writes a marker file every 0.1s; if it survives cancel, the file will exist
    const promise = dispatchCommand(
      "system.run",
      {
        command: ["bash", "-c", `(while true; do touch ${marker}; sleep 0.1; done) & wait`],
        timeoutMs: 30_000,
      },
      ac.signal,
    );

    // Wait for bash to start and fork the child
    await new Promise((r) => setTimeout(r, 300));

    // Marker file should exist while the child is running
    const existsBefore = require("fs").existsSync(marker);
    expect(existsBefore).toBe(true);

    ac.abort();
    const result = await promise;
    expect(result.exitCode).toBe(130);

    // Remove the marker and wait — if child is still alive it would recreate it
    try { require("fs").unlinkSync(marker); } catch {}
    await new Promise((r) => setTimeout(r, 500));

    const existsAfter = require("fs").existsSync(marker);
    expect(existsAfter).toBe(false);
  });
});
