// =============================================================================
// Node List RPC Tests
//
// Tests for the node.list RPC endpoint and nodes in gateway.status.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let server: GatewayServer;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
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

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Node List RPC", () => {
  beforeEach(async () => {
    resetGatewayState();
    server = new GatewayServer();
    // Register node.list method (mimics what index.ts does)
    server.registerMethod("node.list", () => ({
      nodes: server.nodeRegistry.listConnected().map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        platform: n.platform,
        commands: n.commands,
        connectedAt: n.connectedAt,
      })),
    }));
    server.start(0);
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop(1000);
  });

  test("returns empty list when no nodes connected", async () => {
    const ws = await connectWs();
    await rpc(ws, "connect", { version: "0.1.0", platform: "tui" });

    const result = await rpc(ws, "node.list");
    expect(result.nodes).toEqual([]);
    ws.close();
  });

  test("returns connected nodes", async () => {
    // Connect a node
    const nodeWs = await connectWs();
    await rpc(nodeWs, "connect", {
      version: "0.1.0", platform: "node-host", role: "node",
      node: { nodeId: "n1", name: "work-mac", commands: ["system.run", "system.which"] },
    });

    // Query from a client
    const clientWs = await connectWs();
    await rpc(clientWs, "connect", { version: "0.1.0", platform: "web" });

    const result = await rpc(clientWs, "node.list");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("work-mac");
    expect(result.nodes[0].commands).toContain("system.run");
    expect(result.nodes[0].connectedAt).toBeGreaterThan(0);

    nodeWs.close();
    clientWs.close();
  });

  test("returns multiple nodes", async () => {
    const ws1 = await connectWs();
    const ws2 = await connectWs();
    await rpc(ws1, "connect", {
      version: "0.1.0", platform: "node-host", role: "node",
      node: { nodeId: "n1", name: "work", commands: ["system.run"] },
    });
    await rpc(ws2, "connect", {
      version: "0.1.0", platform: "node-host", role: "node",
      node: { nodeId: "n2", name: "home", commands: ["system.run", "system.which"] },
    });

    const clientWs = await connectWs();
    await rpc(clientWs, "connect", { version: "0.1.0", platform: "web" });

    const result = await rpc(clientWs, "node.list");
    expect(result.nodes).toHaveLength(2);
    const names = result.nodes.map((n: any) => n.name).sort();
    expect(names).toEqual(["home", "work"]);

    ws1.close();
    ws2.close();
    clientWs.close();
  });

  test("reflects disconnect in node list", async () => {
    const nodeWs = await connectWs();
    await rpc(nodeWs, "connect", {
      version: "0.1.0", platform: "node-host", role: "node",
      node: { nodeId: "n1", name: "mac", commands: ["system.run"] },
    });

    const clientWs = await connectWs();
    await rpc(clientWs, "connect", { version: "0.1.0", platform: "web" });

    // Node connected
    let result = await rpc(clientWs, "node.list");
    expect(result.nodes).toHaveLength(1);

    // Disconnect node
    nodeWs.close();
    await new Promise((r) => setTimeout(r, 100));

    // Node gone
    result = await rpc(clientWs, "node.list");
    expect(result.nodes).toHaveLength(0);

    clientWs.close();
  });
});

describe("/ready endpoint", () => {
  beforeEach(async () => {
    resetGatewayState();
    server = new GatewayServer();
    server.start(0);
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop(1000);
  });

  test("returns ok status", async () => {
    const res = await fetch(`http://localhost:${port}/ready`);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.status).toBe("ready");
  });
});
