// =============================================================================
// Nodes Tool Tests
//
// Tests for the unified agent tool that discovers and invokes node hosts.
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
  } as any;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Nodes Tool", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    resetConnectionCounter();
    registry = new NodeRegistry();
    setNodeRegistryRef(registry);
  });

  // ---------------------------------------------------------------------------
  // Status action
  // ---------------------------------------------------------------------------

  describe("status", () => {
    test("returns no nodes message when empty", async () => {
      const result = await nodesToolDefinition.execute(
        { action: "status" } as any,
        createContext(),
      );
      expect(result.content).toContain("No node hosts connected");
    });

    test("lists connected nodes", async () => {
      const conn = createMockConnection();
      registry.register(conn, {
        nodeId: "node-1",
        name: "work-mac",
        commands: ["system.run", "system.which"],
        platform: "darwin",
      });

      const result = await nodesToolDefinition.execute(
        { action: "status" } as any,
        createContext(),
      );
      const data = JSON.parse(result.content as string);
      expect(data.count).toBe(1);
      expect(data.nodes[0].name).toBe("work-mac");
      expect(data.nodes[0].commands).toContain("system.run");
    });

    test("lists multiple nodes", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      registry.register(conn1, {
        nodeId: "node-1", name: "work-mac",
        commands: ["system.run"], platform: "darwin",
      });
      registry.register(conn2, {
        nodeId: "node-2", name: "home-mac",
        commands: ["system.run", "system.which"], platform: "darwin",
      });

      const result = await nodesToolDefinition.execute(
        { action: "status" } as any,
        createContext(),
      );
      const data = JSON.parse(result.content as string);
      expect(data.count).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Invoke action
  // ---------------------------------------------------------------------------

  describe("invoke", () => {
    test("returns error for missing command", async () => {
      const result = await nodesToolDefinition.execute(
        { action: "invoke" } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("Missing 'command'");
    });

    test("returns error when no nodes connected", async () => {
      const result = await nodesToolDefinition.execute(
        { action: "invoke", command: "system.run", params: { command: ["ls"] } } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("No node hosts connected");
    });

    test("auto-selects single node", async () => {
      const conn = createMockConnection();
      registry.register(conn, {
        nodeId: "node-1", name: "work-mac",
        commands: ["system.run"], platform: "darwin",
      });

      // Start invoke (will send event to mock connection)
      const invokePromise = nodesToolDefinition.execute(
        { action: "invoke", command: "system.run", params: { command: ["ls"] } } as any,
        createContext(),
      );

      // Extract request ID and resolve
      const sent = (conn as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "node-1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "file.txt", stderr: "", exitCode: 0 }),
      });

      const result = await invokePromise;
      expect(result.type).toBe("text");
      expect(result.content).toContain("Captured at");
      expect(result.content).toContain("file.txt");
    });

    test("requires node param when multiple nodes connected", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      registry.register(conn1, {
        nodeId: "n1", name: "work-mac", commands: ["system.run"], platform: "darwin",
      });
      registry.register(conn2, {
        nodeId: "n2", name: "home-mac", commands: ["system.run"], platform: "darwin",
      });

      const result = await nodesToolDefinition.execute(
        { action: "invoke", command: "system.run", params: { command: ["ls"] } } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("Multiple nodes");
      expect(result.content).toContain("work-mac");
    });

    test("resolves node by name", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      registry.register(conn1, {
        nodeId: "n1", name: "work-mac", commands: ["system.run"], platform: "darwin",
      });
      registry.register(conn2, {
        nodeId: "n2", name: "home-mac", commands: ["system.run"], platform: "darwin",
      });

      const invokePromise = nodesToolDefinition.execute(
        { action: "invoke", node: "work-mac", command: "system.run", params: { command: ["ls"] } } as any,
        createContext(),
      );

      // Resolve the invoke
      const sent = (conn1 as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "n1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }),
      });

      const result = await invokePromise;
      expect(result.type).toBe("text");
    });

    test("returns error for invoke failure", async () => {
      const conn = createMockConnection();
      registry.register(conn, {
        nodeId: "n1", name: "mac", commands: ["system.run"], platform: "darwin",
      });

      const invokePromise = nodesToolDefinition.execute(
        { action: "invoke", command: "system.run", params: { command: ["bad"] } } as any,
        createContext(),
      );

      const sent = (conn as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "n1",
        ok: false,
        error: "Command failed",
      });

      const result = await invokePromise;
      expect(result.type).toBe("error");
      expect(result.content).toContain("Command failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown action
  // ---------------------------------------------------------------------------

  describe("unknown action", () => {
    test("returns error for unknown action", async () => {
      const result = await nodesToolDefinition.execute(
        { action: "reboot" } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("Unknown action");
    });
  });
});
