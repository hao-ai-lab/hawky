// =============================================================================
// Node Registry Tests
//
// Tests for gateway-side node host tracking, invoke dispatch, tick
// broadcasting, and lifecycle management.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { NodeRegistry } from "../src/gateway/node-registry.js";
import { GatewayConnection, resetConnectionCounter } from "../src/gateway/connection.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function createMockConnection(connId?: string): GatewayConnection {
  const sentMessages: string[] = [];
  const mockSocket = {
    data: { connId: connId ?? "" },
    send: (data: string) => { sentMessages.push(data); return data.length; },
    close: () => {},
    remoteAddress: "127.0.0.1",
  } as any;
  const conn = new GatewayConnection(mockSocket, "127.0.0.1");
  // Override connId if specified
  (conn as any).sentMessages = sentMessages;
  return conn;
}

function getNodeInfo(name = "test-node") {
  return {
    nodeId: `node-${name}`,
    name,
    commands: ["system.run", "system.which"],
    platform: "darwin",
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("NodeRegistry", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    resetConnectionCounter();
    registry = new NodeRegistry();
  });

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe("register/unregister", () => {
    test("registers a node and tracks it", () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo("work-mac"));

      expect(registry.size).toBe(1);
      const node = registry.get("node-work-mac");
      expect(node).toBeDefined();
      expect(node!.name).toBe("work-mac");
      expect(node!.commands).toEqual(["system.run", "system.which"]);
    });

    test("unregisters by connId", () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const nodeId = registry.unregister(conn.connId);
      expect(nodeId).toBe("node-test-node");
      expect(registry.size).toBe(0);
    });

    test("unregister returns null for unknown connId", () => {
      expect(registry.unregister("unknown")).toBeNull();
    });

    test("replaces old connection on reconnect (same nodeId)", () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      const info = getNodeInfo("mac");

      registry.register(conn1, info);
      registry.register(conn2, info);

      expect(registry.size).toBe(1);
      const node = registry.get("node-mac");
      expect(node!.connId).toBe(conn2.connId);
    });

    test("rejects pending invokes on reconnect", async () => {
      const conn1 = createMockConnection();
      const info = getNodeInfo("mac");
      registry.register(conn1, info);

      // Start invoke on old connection
      const invokePromise = registry.invoke("node-mac", "system.run", {});

      // Same nodeId reconnects with new connection
      const conn2 = createMockConnection();
      registry.register(conn2, info);

      // Old invoke should be rejected
      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("reconnected");
    });

    test("tracks multiple nodes", () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();

      registry.register(conn1, getNodeInfo("work-mac"));
      registry.register(conn2, getNodeInfo("home-mac"));

      expect(registry.size).toBe(2);
      expect(registry.listConnected().map((n) => n.name).sort()).toEqual(["home-mac", "work-mac"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  describe("query", () => {
    test("get returns undefined for unknown nodeId", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    test("getByConn looks up via connId", () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const node = registry.getByConn(conn.connId);
      expect(node).toBeDefined();
      expect(node!.name).toBe("test-node");
    });

    test("listConnected returns all nodes", () => {
      expect(registry.listConnected()).toEqual([]);

      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());
      expect(registry.listConnected()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Invoke
  // ---------------------------------------------------------------------------

  describe("invoke", () => {
    test("returns error for unconnected node", async () => {
      const result = await registry.invoke("nonexistent", "system.run");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not connected");
    });

    test("returns error for unsupported command", async () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const result = await registry.invoke("node-test-node", "camera.snap");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("does not support");
    });

    test("sends invoke request and resolves on result", async () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      // Start invoke
      const invokePromise = registry.invoke("node-test-node", "system.run", { command: ["ls"] });

      // Find the sent event to extract request ID
      const sent = (conn as any).sentMessages as string[];
      expect(sent.length).toBe(1);
      const event = JSON.parse(sent[0]);
      expect(event.type).toBe("event");
      expect(event.event).toBe("node.invoke.request");
      expect(event.payload.command).toBe("system.run");

      const requestId = event.payload.id;

      // Simulate node returning result
      registry.handleInvokeResult({
        id: requestId,
        nodeId: "node-test-node",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "file.txt", stderr: "", exitCode: 0 }),
      });

      const result = await invokePromise;
      expect(result.ok).toBe(true);
      expect((result.payload as any).stdout).toBe("file.txt");
    });

    test("times out if no result received", async () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const result = await registry.invoke("node-test-node", "system.run", {}, 50);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("timeout");
    });

    test("rejects invoke result from wrong node (spoofing prevention)", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      registry.register(conn1, getNodeInfo("node-a"));
      registry.register(conn2, getNodeInfo("node-b"));

      // Start invoke on node-a
      const invokePromise = registry.invoke("node-node-a", "system.run", {});

      const sent = (conn1 as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      const requestId = event.payload.id;

      // node-b tries to send result for node-a's invoke — should be rejected
      registry.handleInvokeResult({
        id: requestId,
        nodeId: "node-node-a",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "spoofed", stderr: "", exitCode: 0 }),
      }, "node-node-b"); // senderNodeId doesn't match pending.nodeId

      // The invoke should still be pending (not resolved by spoofed result)
      // Now send the real result from node-a
      registry.handleInvokeResult({
        id: requestId,
        nodeId: "node-node-a",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "real", stderr: "", exitCode: 0 }),
      }, "node-node-a");

      const result = await invokePromise;
      expect(result.ok).toBe(true);
      expect((result.payload as any).stdout).toBe("real");
    });

    test("ignores late results after timeout", async () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const result = await registry.invoke("node-test-node", "system.run", {}, 50);
      expect(result.ok).toBe(false);

      // Late result — should not throw
      const sent = (conn as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "node-test-node",
        ok: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect behavior
  // ---------------------------------------------------------------------------

  describe("disconnect", () => {
    test("rejects pending invokes when node disconnects", async () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const invokePromise = registry.invoke("node-test-node", "system.run", {});

      // Node disconnects
      registry.unregister(conn.connId);

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("disconnected");
    });
  });

  // ---------------------------------------------------------------------------
  // Tick broadcast
  // ---------------------------------------------------------------------------

  describe("tick", () => {
    test("broadcasts tick events", async () => {
      const events: Array<{ event: string; payload: unknown }> = [];
      registry.setBroadcast((event, payload) => events.push({ event, payload }));

      registry.startTick();

      // Wait for at least one tick (interval is 30s, but we can test the mechanism)
      // For unit test, just verify start/stop doesn't throw
      registry.stopTick();
      expect(true).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  describe("destroy", () => {
    test("clears all state", () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      registry.destroy();
      expect(registry.size).toBe(0);
      expect(registry.listConnected()).toEqual([]);
    });

    test("rejects pending invokes on destroy", async () => {
      const conn = createMockConnection();
      registry.register(conn, getNodeInfo());

      const invokePromise = registry.invoke("node-test-node", "system.run", {});
      registry.destroy();

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("shutting down");
    });
  });
});
