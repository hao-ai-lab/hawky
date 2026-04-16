// =============================================================================
// Node Screenshot Tool Integration Tests
//
// Tests that the nodes tool correctly returns ImageToolResult for screenshots.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { NodeRegistry } from "../src/gateway/node-registry.js";
import { GatewayConnection, resetConnectionCounter } from "../src/gateway/connection.js";
import { setNodeRegistryRef, nodesToolDefinition } from "../src/tools/nodes.js";
import type { ToolContext } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function createMockConnection(): GatewayConnection {
  const sentMessages: string[] = [];
  const mockSocket = {
    data: { connId: "" },
    send: (data: string) => { sentMessages.push(data); return data.length; },
    close: () => {},
    remoteAddress: "127.0.0.1",
  } as any;
  const conn = new GatewayConnection(mockSocket, "127.0.0.1");
  (conn as any).sentMessages = sentMessages;
  return conn;
}

function createContext(): ToolContext {
  return {
    abort_signal: new AbortController().signal,
    working_directory: "/tmp",
    permission_mode: "default",
    session_key: "test",
    emit: () => {},
  } as any;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Nodes Tool — Screenshot Integration", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    resetConnectionCounter();
    registry = new NodeRegistry();
    setNodeRegistryRef(registry);
  });

  test("screenshot invoke returns ImageToolResult", async () => {
    const conn = createMockConnection();
    registry.register(conn, {
      nodeId: "n1", name: "mac",
      commands: ["system.run", "screenshot"], platform: "darwin",
    });

    const promise = nodesToolDefinition.execute(
      { action: "invoke", command: "screenshot" } as any,
      createContext(),
    );

    // Simulate node returning screenshot
    const sent = (conn as any).sentMessages as string[];
    const event = JSON.parse(sent[0]);
    registry.handleInvokeResult({
      id: event.payload.id,
      nodeId: "n1",
      ok: true,
      payloadJSON: JSON.stringify({
        images: [{
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
          media_type: "image/jpeg",
          display: 1,
        }],
      }),
    });

    const result = await promise;
    expect(result.type).toBe("image");
    expect((result as any).base64).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ");
    expect((result as any).media_type).toBe("image/jpeg");
    expect(result.content).toContain("Screenshot");
  });

  test("device.info invoke returns text JSON", async () => {
    const conn = createMockConnection();
    registry.register(conn, {
      nodeId: "n1", name: "mac",
      commands: ["device.info"], platform: "darwin",
    });

    const promise = nodesToolDefinition.execute(
      { action: "invoke", command: "device.info" } as any,
      createContext(),
    );

    const sent = (conn as any).sentMessages as string[];
    const event = JSON.parse(sent[0]);
    registry.handleInvokeResult({
      id: event.payload.id,
      nodeId: "n1",
      ok: true,
      payloadJSON: JSON.stringify({
        hostname: "work-mac", platform: "darwin", os: "macOS",
        osVersion: "15.0", cpu: "Apple M2", cpuCores: 8,
        memoryTotal: "16.0 GB", memoryFree: "8.2 GB",
      }),
    });

    const result = await promise;
    expect(result.type).toBe("text");
    expect(result.content).toContain("Captured at");
    expect(result.content).toContain("work-mac");
    expect(result.content).toContain("macOS");
  });

  test("frontmost.app invoke returns text JSON", async () => {
    const conn = createMockConnection();
    registry.register(conn, {
      nodeId: "n1", name: "mac",
      commands: ["frontmost.app"], platform: "darwin",
    });

    const promise = nodesToolDefinition.execute(
      { action: "invoke", command: "frontmost.app" } as any,
      createContext(),
    );

    const sent = (conn as any).sentMessages as string[];
    const event = JSON.parse(sent[0]);
    registry.handleInvokeResult({
      id: event.payload.id,
      nodeId: "n1",
      ok: true,
      payloadJSON: JSON.stringify({ app: "Safari", title: "GitHub" }),
    });

    const result = await promise;
    expect(result.type).toBe("text");
    expect(result.content).toContain("Captured at");
    expect(result.content).toContain("Safari");
  });
});
