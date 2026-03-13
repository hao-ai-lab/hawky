// =============================================================================
// Bash Node Routing Tests
//
// Tests for bash tool host="node" parameter routing to node hosts.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { NodeRegistry } from "../src/gateway/node-registry.js";
import { GatewayConnection, resetConnectionCounter } from "../src/gateway/connection.js";
import { setBashNodeRegistry } from "../src/tools/bash.js";
import { bashToolDefinition } from "../src/tools/bash.js";
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

describe("Bash Node Routing", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    resetConnectionCounter();
    registry = new NodeRegistry();
    setBashNodeRegistry(registry);
  });

  describe("host='node' routing", () => {
    test("returns error when no nodes connected", async () => {
      const result = await bashToolDefinition.execute(
        { command: "ls", host: "node" } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("No node hosts connected");
    });

    test("auto-selects single node", async () => {
      const conn = createMockConnection();
      registry.register(conn, {
        nodeId: "n1", name: "work-mac",
        commands: ["system.run"], platform: "darwin",
      });

      const promise = bashToolDefinition.execute(
        { command: "echo hello", host: "node" } as any,
        createContext(),
      );

      // Node receives invoke request
      const sent = (conn as any).sentMessages as string[];
      expect(sent.length).toBe(1);
      const event = JSON.parse(sent[0]);
      expect(event.event).toBe("node.invoke.request");
      expect(event.payload.command).toBe("system.run");

      // Parse paramsJSON to verify command
      const params = JSON.parse(event.payload.paramsJSON);
      expect(params.command).toEqual(["bash", "-c", "echo hello"]);

      // Resolve with result
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "n1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "hello", stderr: "", exitCode: 0 }),
      });

      const result = await promise;
      expect(result.type).toBe("text");
      expect(result.content).toBe("hello");
    });

    test("requires node param when multiple nodes connected", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      registry.register(conn1, { nodeId: "n1", name: "work", commands: ["system.run"], platform: "darwin" });
      registry.register(conn2, { nodeId: "n2", name: "home", commands: ["system.run"], platform: "darwin" });

      const result = await bashToolDefinition.execute(
        { command: "ls", host: "node" } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("Multiple nodes");
      expect(result.content).toContain("work");
    });

    test("resolves node by name", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      registry.register(conn1, { nodeId: "n1", name: "work", commands: ["system.run"], platform: "darwin" });
      registry.register(conn2, { nodeId: "n2", name: "home", commands: ["system.run"], platform: "darwin" });

      const promise = bashToolDefinition.execute(
        { command: "pwd", host: "node", node: "work" } as any,
        createContext(),
      );

      // Should route to conn1 (work)
      const sent = (conn1 as any).sentMessages as string[];
      expect(sent.length).toBe(1);
      const event = JSON.parse(sent[0]);

      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "n1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "/Users/example", stderr: "", exitCode: 0 }),
      });

      const result = await promise;
      expect(result.type).toBe("text");
      expect(result.content).toBe("/Users/example");
      expect((result as any).metadata?.node).toBe("work");
    });

    test("returns error for unknown node name", async () => {
      const conn = createMockConnection();
      registry.register(conn, { nodeId: "n1", name: "work", commands: ["system.run"], platform: "darwin" });

      const result = await bashToolDefinition.execute(
        { command: "ls", host: "node", node: "nonexistent" } as any,
        createContext(),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("not found");
    });

    test("handles node invoke failure", async () => {
      const conn = createMockConnection();
      registry.register(conn, { nodeId: "n1", name: "mac", commands: ["system.run"], platform: "darwin" });

      const promise = bashToolDefinition.execute(
        { command: "bad-cmd", host: "node" } as any,
        createContext(),
      );

      const sent = (conn as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "n1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "", stderr: "command not found", exitCode: 127 }),
      });

      const result = await promise;
      expect(result.type).toBe("error");
      expect(result.content).toContain("failed");
      expect(result.content).toContain("exit code 127");
    });

    test("handles timed out command on node", async () => {
      const conn = createMockConnection();
      registry.register(conn, { nodeId: "n1", name: "mac", commands: ["system.run"], platform: "darwin" });

      const promise = bashToolDefinition.execute(
        { command: "sleep 100", host: "node" } as any,
        createContext(),
      );

      const sent = (conn as any).sentMessages as string[];
      const event = JSON.parse(sent[0]);
      registry.handleInvokeResult({
        id: event.payload.id,
        nodeId: "n1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "", stderr: "", exitCode: 124, timedOut: true }),
      });

      const result = await promise;
      expect(result.type).toBe("error");
      expect(result.content).toContain("timed out");
    });
  });

  describe("host='auto' and host='gateway'", () => {
    test("local execution with host='auto' (default)", async () => {
      const result = await bashToolDefinition.execute(
        { command: "echo local" } as any,
        createContext(),
      );
      expect(result.type).toBe("text");
      expect(result.content).toContain("local");
    });

    test("local execution with host='gateway'", async () => {
      const result = await bashToolDefinition.execute(
        { command: "echo gateway" , host: "gateway" } as any,
        createContext(),
      );
      expect(result.type).toBe("text");
      expect(result.content).toContain("gateway");
    });
  });
});
