// =============================================================================
// Integration Tests: WS Permission Lifecycle
//
// Tests the permission resolver's internal lifecycle: timeout, cancel on
// disconnect, double-resolution safety, concurrent requests, etc.
// Uses a mock server (no real WebSocket) to focus on the resolver logic.
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import {
  createWsPermissionResolver,
  resolveWsPermission,
  cancelPendingPermissions,
  hasPendingPermission,
  resetWsPermissions,
} from "../../src/gateway/ws-permission.js";
import type { GatewayServer } from "../../src/gateway/server.js";

// =============================================================================
// Mock server that records broadcasts
// =============================================================================

interface BroadcastRecord {
  sessionKey: string;
  event: string;
  payload: Record<string, unknown>;
}

function createMockServer(): { server: GatewayServer; broadcasts: BroadcastRecord[] } {
  const broadcasts: BroadcastRecord[] = [];
  const server = {
    broadcastToSession(sessionKey: string, event: string, payload: Record<string, unknown>) {
      broadcasts.push({ sessionKey, event, payload });
    },
  } as unknown as GatewayServer;
  return { server, broadcasts };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  resetWsPermissions();
});

// =============================================================================
// Basic resolve
// =============================================================================

describe("ws-permission — resolve lifecycle", () => {
  test("ask broadcasts permission.request and waits for resolve", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    // Start permission request (don't await yet)
    const decisionPromise = resolver.ask("tu_1", "bash", { command: "echo hi" });

    // Should have broadcast
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].event).toBe("permission.request");
    expect(broadcasts[0].sessionKey).toBe("session-1");
    expect(broadcasts[0].payload.tool).toBe("bash");
    expect(broadcasts[0].payload.requestId).toBeTruthy();

    // Resolve it
    const requestId = broadcasts[0].payload.requestId as string;
    const resolved = resolveWsPermission(requestId, "allow_once");
    expect(resolved).toBe(true);

    const decision = await decisionPromise;
    expect(decision).toEqual({ decision: "allow_once" });
  });

  test("allow_always decision flows through", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    const decisionPromise = resolver.ask("tu_1", "write_file", { path: "/tmp/test" });
    const requestId = broadcasts[0].payload.requestId as string;
    resolveWsPermission(requestId, "allow_always");

    expect(await decisionPromise).toEqual({ decision: "allow_always" });
  });

  test("deny decision flows through", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    const decisionPromise = resolver.ask("tu_1", "bash", { command: "rm -rf /" });
    const requestId = broadcasts[0].payload.requestId as string;
    resolveWsPermission(requestId, "deny");

    expect(await decisionPromise).toEqual({ decision: "deny" });
  });
});

// =============================================================================
// No timeout — permissions stay pending indefinitely
// =============================================================================

describe("ws-permission — no timeout", () => {
  test("permission stays pending until explicitly resolved", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    const decisionPromise = resolver.ask("tu_1", "bash", { command: "echo hi" });

    // Wait 100ms — should still be pending (no auto-deny)
    await new Promise((r) => setTimeout(r, 100));
    expect(hasPendingPermission("session-1")).toBe(true);

    // Resolve manually
    const requestId = broadcasts[0].payload.requestId as string;
    resolveWsPermission(requestId, "allow_once");

    expect(await decisionPromise).toEqual({ decision: "allow_once" });
  });
});

// =============================================================================
// Cancel on disconnect
// =============================================================================

describe("ws-permission — cancel on disconnect", () => {
  test("cancelPendingPermissions auto-denies all pending for a session", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    // Start two permission requests
    const p1 = resolver.ask("tu_1", "bash", { command: "echo 1" });
    const p2 = resolver.ask("tu_2", "write_file", { path: "/tmp/test" });

    expect(hasPendingPermission("session-1")).toBe(true);

    // Client disconnects — cancel all
    const cancelled = cancelPendingPermissions("session-1");
    expect(cancelled).toBe(2);

    expect(await p1).toEqual({ decision: "deny" });
    expect(await p2).toEqual({ decision: "deny" });
    expect(hasPendingPermission("session-1")).toBe(false);
  });

  test("cancel only affects the specified session", async () => {
    const { server, broadcasts } = createMockServer();

    const resolver1 = createWsPermissionResolver("session-1", server);
    const resolver2 = createWsPermissionResolver("session-2", server);

    const p1 = resolver1.ask("tu_1", "bash", { command: "echo 1" });
    const p2 = resolver2.ask("tu_2", "bash", { command: "echo 2" });

    // Cancel only session-1
    cancelPendingPermissions("session-1");
    expect(await p1).toEqual({ decision: "deny" });

    // session-2 should still be pending
    expect(hasPendingPermission("session-2")).toBe(true);

    // Resolve session-2 normally
    const requestId2 = broadcasts.find((b) => b.sessionKey === "session-2")!.payload.requestId as string;
    resolveWsPermission(requestId2, "allow_once");
    expect(await p2).toEqual({ decision: "allow_once" });
  });

  test("cancel with no pending requests returns 0", () => {
    expect(cancelPendingPermissions("nonexistent-session")).toBe(0);
  });
});

// =============================================================================
// Double-resolution safety
// =============================================================================

describe("ws-permission — double-resolution safety", () => {
  test("second resolve returns false (request already handled)", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    const decisionPromise = resolver.ask("tu_1", "bash", { command: "echo" });
    const requestId = broadcasts[0].payload.requestId as string;

    // First resolve succeeds
    expect(resolveWsPermission(requestId, "allow_once")).toBe(true);
    // Second resolve fails (already consumed)
    expect(resolveWsPermission(requestId, "deny")).toBe(false);

    expect(await decisionPromise).toEqual({ decision: "allow_once" });
  });

  test("resolve after cancel returns false", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    const decisionPromise = resolver.ask("tu_1", "bash", { command: "echo" });
    const requestId = broadcasts[0].payload.requestId as string;

    cancelPendingPermissions("session-1");
    expect(await decisionPromise).toEqual({ decision: "deny" });

    // Now try to resolve — should fail
    expect(resolveWsPermission(requestId, "allow_once")).toBe(false);
  });
});

// =============================================================================
// hasPendingPermission
// =============================================================================

describe("ws-permission — hasPendingPermission", () => {
  test("returns false when no pending requests", () => {
    expect(hasPendingPermission("any-session")).toBe(false);
  });

  test("returns true when request is pending", () => {
    const { server } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);
    resolver.ask("tu_1", "bash", { command: "echo" });
    expect(hasPendingPermission("session-1")).toBe(true);

    // Cleanup
    cancelPendingPermissions("session-1");
  });

  test("returns false after request is resolved", async () => {
    const { server, broadcasts } = createMockServer();
    const resolver = createWsPermissionResolver("session-1", server);

    resolver.ask("tu_1", "bash", { command: "echo" });
    const requestId = broadcasts[0].payload.requestId as string;
    resolveWsPermission(requestId, "allow_once");

    expect(hasPendingPermission("session-1")).toBe(false);
  });
});
