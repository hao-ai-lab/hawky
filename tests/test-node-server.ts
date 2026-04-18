// =============================================================================
// Node Server Integration Tests
//
// Tests for gateway-side handling of node host connections: handshake routing,
// role validation, node registration on connect/disconnect, tick broadcast,
// and invoke result authorization.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let server: GatewayServer;
let port: number;

function getWsUrl(): string {
  return `ws://localhost:${port}`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl());
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("Connection failed")));
  });
}

function rpc(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `test-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);

    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        if (data.ok) resolve(data.payload);
        else reject(new Error(data.error?.message ?? "RPC error"));
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Event timeout: ${eventName}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "event" && data.event === eventName) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data.payload);
      }
    };
    ws.addEventListener("message", handler);
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Node Server Integration", () => {
  beforeEach(async () => {
    resetGatewayState();
    server = new GatewayServer();
    // Use port 0 to get a random available port
    server.start(0);
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop(1000);
  });

  // ---------------------------------------------------------------------------
  // Handshake routing
  // ---------------------------------------------------------------------------

  describe("handshake", () => {
    test("client role connects normally", async () => {
      const ws = await connectWs();
      const hello = await rpc(ws, "connect", {
        version: "0.1.0",
        platform: "tui",
        sessionKey: "test:main",
      });
      expect(hello.connId).toBeTruthy();
      expect(hello.serverVersion).toBe("0.1.0");
      ws.close();
    });

    test("node role registers in node registry", async () => {
      const ws = await connectWs();
      await rpc(ws, "connect", {
        version: "0.1.0",
        platform: "node-host",
        role: "node",
        node: {
          nodeId: "test-node-1",
          name: "test-mac",
          commands: ["system.run", "system.which"],
        },
      });

      expect(server.nodeRegistry.size).toBe(1);
      const node = server.nodeRegistry.get("test-node-1");
      expect(node).toBeDefined();
      expect(node!.name).toBe("test-mac");
      ws.close();
    });

    test("node role without metadata is rejected", async () => {
      const ws = await connectWs();
      try {
        await rpc(ws, "connect", {
          version: "0.1.0",
          platform: "node-host",
          role: "node",
          // Missing node metadata
        });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect((err as Error).message).toContain("node.nodeId");
      }
    });

    test("node role with incomplete metadata is rejected", async () => {
      const ws = await connectWs();
      try {
        await rpc(ws, "connect", {
          version: "0.1.0",
          platform: "node-host",
          role: "node",
          node: { nodeId: "x" }, // Missing name
        });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toContain("node.nodeId");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Node disconnect
  // ---------------------------------------------------------------------------

  describe("disconnect", () => {
    test("node unregisters on disconnect", async () => {
      const ws = await connectWs();
      await rpc(ws, "connect", {
        version: "0.1.0",
        platform: "node-host",
        role: "node",
        node: { nodeId: "n1", name: "mac", commands: ["system.run"] },
      });
      expect(server.nodeRegistry.size).toBe(1);

      ws.close();
      // Wait for close to propagate
      await new Promise((r) => setTimeout(r, 100));
      expect(server.nodeRegistry.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tick broadcast
  // ---------------------------------------------------------------------------

  describe("tick", () => {
    test("node receives tick events", async () => {
      const ws = await connectWs();
      await rpc(ws, "connect", {
        version: "0.1.0",
        platform: "node-host",
        role: "node",
        node: { nodeId: "n1", name: "mac", commands: ["system.run"] },
      });

      // Manually trigger a tick broadcast (the 30s interval is too long for tests)
      server.broadcast("tick", { ts: Date.now(), intervalMs: 30000 });

      const payload = await waitForEvent(ws, "tick", 2000);
      expect(payload.ts).toBeTruthy();
      expect(payload.intervalMs).toBe(30000);
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Invoke flow (end-to-end via WebSocket)
  // ---------------------------------------------------------------------------

  describe("invoke flow", () => {
    test("gateway sends invoke request and node returns result", async () => {
      const ws = await connectWs();
      await rpc(ws, "connect", {
        version: "0.1.0",
        platform: "node-host",
        role: "node",
        node: { nodeId: "n1", name: "mac", commands: ["system.run"] },
      });

      // Start invoke from registry side
      const invokePromise = server.nodeRegistry.invoke("n1", "system.run", { command: ["ls"] });

      // Node receives invoke request event
      const request = await waitForEvent(ws, "node.invoke.request", 2000);
      expect(request.command).toBe("system.run");
      expect(request.id).toBeTruthy();

      // Node sends result back via RPC
      await rpc(ws, "node.invoke.result", {
        id: request.id,
        nodeId: "n1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "file.txt", stderr: "", exitCode: 0 }),
      });

      const result = await invokePromise;
      expect(result.ok).toBe(true);
      expect((result.payload as any).stdout).toBe("file.txt");
      ws.close();
    });

    test("client cannot send invoke results", async () => {
      const ws = await connectWs();
      await rpc(ws, "connect", {
        version: "0.1.0",
        platform: "tui",
        sessionKey: "test:main",
      });

      try {
        await rpc(ws, "node.invoke.result", {
          id: "fake-id",
          nodeId: "fake",
          ok: true,
        });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toContain("Only node hosts");
      }
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple nodes
  // ---------------------------------------------------------------------------

  describe("multiple nodes", () => {
    test("tracks multiple simultaneous nodes", async () => {
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      await rpc(ws1, "connect", {
        version: "0.1.0", platform: "node-host", role: "node",
        node: { nodeId: "n1", name: "work-mac", commands: ["system.run"] },
      });
      await rpc(ws2, "connect", {
        version: "0.1.0", platform: "node-host", role: "node",
        node: { nodeId: "n2", name: "home-mac", commands: ["system.run", "system.which"] },
      });

      expect(server.nodeRegistry.size).toBe(2);
      const names = server.nodeRegistry.listConnected().map((n) => n.name).sort();
      expect(names).toEqual(["home-mac", "work-mac"]);

      ws1.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(server.nodeRegistry.size).toBe(1);
      expect(server.nodeRegistry.get("n2")!.name).toBe("home-mac");

      ws2.close();
    });
  });
});
