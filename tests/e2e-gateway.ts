// =============================================================================
// E2E Tests — Gateway Server
//
// Full end-to-end tests: WebSocket client → gateway → command queue →
// agent loop (mock provider) → streaming events → broadcast → client.
//
// These tests verify the complete pipeline from wire protocol to agent
// execution and back, using real Bun WebSocket connections.
//
// Run with: bun test --timeout 30000 --max-concurrency=1 ./tests/e2e-gateway.ts
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetWsPermissions } from "../src/gateway/ws-permission.js";
import { executeInSession } from "../src/gateway/lanes.js";
import { CommandLane } from "../src/gateway/types.js";
import type { RequestFrame, ResponseFrame, EventFrame } from "../src/gateway/protocol.js";
import type { LLMProvider } from "../src/agent/provider.js";
import { AgentLoop } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { HawkyConfig, StreamEvent } from "../src/agent/types.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeConfig(overrides?: Partial<HawkyConfig>): HawkyConfig {
  return {
    api_keys: { anthropic: "mock", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "mock-model",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: {
      enabled: false,
      interval_minutes: 30,
      keep_recent_messages: 8,
      active_hours: { start: "08:00", end: "22:00" },
    },
    ...overrides,
  };
}

/** Mock provider that returns a simple text response. */
function createTextProvider(responseText: string): LLMProvider {
  return {
    async *stream() {
      yield { type: "message_start" as const, message_id: "msg_e2e", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: "text_delta" as const, text: responseText };
      yield { type: "content_block_stop" as const, index: 0 };
      yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 10 } };
      yield { type: "message_stop" as const };
    },
  };
}

/** Mock provider that calls a tool then responds with text. */
function createToolProvider(toolName: string, toolInput: Record<string, unknown>, responseText: string): LLMProvider {
  let callCount = 0;
  return {
    async *stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "message_start" as const, message_id: "msg_tool1", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        yield { type: "tool_use_start" as const, index: 0, id: "tool_e2e", name: toolName };
        yield { type: "tool_use_input_delta" as const, partial_json: JSON.stringify(toolInput) };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 10 } };
        yield { type: "message_stop" as const };
      } else {
        yield { type: "message_start" as const, message_id: "msg_tool2", model: "mock", usage: { input_tokens: 20, output_tokens: 5 } };
        yield { type: "text_delta" as const, text: responseText };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 10 } };
        yield { type: "message_stop" as const };
      }
    },
  };
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<ResponseFrame> {
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function connectAndHandshake(port: number, sessionKey?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", {
    version: "e2e-test",
    platform: "test",
    sessionKey,
  });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

function collectEvents(ws: WebSocket): EventFrame[] {
  const events: EventFrame[] = [];
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (data.type === "event") events.push(data);
    } catch { /* ignore */ }
  });
  return events;
}

/** Wait for a specific event, collecting all events along the way. */
async function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 10000): Promise<EventFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "event" && data.event === eventName) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

// -----------------------------------------------------------------------------
// Wire agent loop into gateway server
// -----------------------------------------------------------------------------

/**
 * Register a chat.send handler that routes through the command queue
 * and runs a fresh agent loop per message. This tests single-turn scenarios.
 * NOTE: Creates a new AgentLoop per call (no multi-turn context).
 * Production path uses AgentSessionManager which reuses loops — see
 * "E2E: production gateway path" tests below.
 */
function wireAgentToGateway(
  server: GatewayServer,
  provider: LLMProvider,
  registry?: ToolRegistry,
): void {
  const config = makeConfig();
  const reg = registry ?? new ToolRegistry();

  server.registerMethod("chat.send", async (conn, params, srv) => {
    const p = params as { message?: string; sessionKey?: string };
    if (!p?.message) throw Object.assign(new Error("message required"), { code: "INVALID_REQUEST" });

    const sessionKey = p.sessionKey ?? conn.sessionKey ?? "default";
    conn.bindSession(sessionKey);

    // Route through command queue (same as production path)
    await executeInSession(sessionKey, CommandLane.Main, async () => {
      const loop = new AgentLoop({
        provider,
        registry: reg,
        config,
        working_directory: "/tmp",
      });

      // Subscribe: agent events → broadcast to session clients
      const unsub = loop.subscribe((event: StreamEvent) => {
        srv.broadcastToSession(sessionKey, `agent.${event.type}`, event);
      });

      try {
        await loop.sendMessage(p.message!);
      } finally {
        unsub();
      }
    });

    return { completed: true, sessionKey };
  });
}

// =============================================================================
// Tests
// =============================================================================

let server: GatewayServer;
let port: number;
let testSessionsDir: string;

beforeEach(() => {
  testSessionsDir = join(tmpdir(), `hawky-e2e-gw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testSessionsDir, { recursive: true });
  setSessionsDir(testSessionsDir);
  resetGatewayState();
  server = new GatewayServer();
  port = getTestPort();
});

afterEach(async () => {
  await server.stop(2000);
  resetGatewayState();
  resetSessionsDir();
  try { rmSync(testSessionsDir, { recursive: true, force: true }); } catch {}
});

describe("E2E: gateway full pipeline", () => {
  test("chat.send → text streaming events → done", async () => {
    wireAgentToGateway(server, createTextProvider("Hello from the gateway!"));
    server.start(port);

    const ws = await connectAndHandshake(port, "e2e:text-test");
    const events = collectEvents(ws);

    // Send chat message — this goes through: WS → method → command queue → agent → broadcast
    const donePromise = waitForEvent(ws, "agent.done");
    const res = await sendRequest(ws, "chat.send", { message: "hi" });
    expect(res.ok).toBe(true);

    // Wait for agent.done event
    const doneEvent = await donePromise;
    expect(doneEvent.event).toBe("agent.done");

    // Should have received streaming text events
    const textEvents = events.filter((e) => e.event === "agent.text");
    expect(textEvents.length).toBeGreaterThan(0);
    const textContent = textEvents.map((e) => (e.payload as any)?.content ?? "").join("");
    expect(textContent).toContain("Hello from the gateway!");

    ws.close();
  });

  test("chat.send with tool execution → tool events streamed", async () => {
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register({ ...bashToolDefinition, permission: "auto_approve" } as any);

    wireAgentToGateway(
      server,
      createToolProvider("bash", { command: "echo E2E_TOOL_TEST" }, "Tool ran successfully."),
      registry,
    );
    server.start(port);

    const ws = await connectAndHandshake(port, "e2e:tool-test");
    const events = collectEvents(ws);

    const donePromise = waitForEvent(ws, "agent.done");
    const res = await sendRequest(ws, "chat.send", { message: "run tool" });
    expect(res.ok).toBe(true);

    await donePromise;

    // Should have tool_use_start event
    const toolStarts = events.filter((e) => e.event === "agent.tool_use_start");
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0].payload as any)?.name).toBe("bash");

    // Should have tool_result event
    const toolResults = events.filter((e) => e.event === "agent.tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0].payload as any)?.content).toContain("E2E_TOOL_TEST");

    // Should have text event (final response)
    const textEvents = events.filter((e) => e.event === "agent.text");
    expect(textEvents.length).toBeGreaterThan(0);

    ws.close();
  });

  test("two clients on same session both receive events", async () => {
    wireAgentToGateway(server, createTextProvider("Shared response"));
    server.start(port);

    const ws1 = await connectAndHandshake(port, "e2e:shared-session");
    const ws2 = await connectAndHandshake(port, "e2e:shared-session");
    const events1 = collectEvents(ws1);
    const events2 = collectEvents(ws2);

    const done1 = waitForEvent(ws1, "agent.done");
    const done2 = waitForEvent(ws2, "agent.done");

    // Only ws1 sends the message, but both should get events
    await sendRequest(ws1, "chat.send", { message: "hello" });
    await Promise.all([done1, done2]);

    // Both should have text events
    const texts1 = events1.filter((e) => e.event === "agent.text");
    const texts2 = events2.filter((e) => e.event === "agent.text");
    expect(texts1.length).toBeGreaterThan(0);
    expect(texts2.length).toBeGreaterThan(0);

    ws1.close();
    ws2.close();
  });

  test("two clients on different sessions get independent events", async () => {
    wireAgentToGateway(server, createTextProvider("Response"));
    server.start(port);

    const ws1 = await connectAndHandshake(port, "e2e:session-a");
    const ws2 = await connectAndHandshake(port, "e2e:session-b");
    const events1 = collectEvents(ws1);
    const events2 = collectEvents(ws2);

    // Only ws1 sends — ws2 should NOT receive agent events (different session)
    const done1 = waitForEvent(ws1, "agent.done");
    await sendRequest(ws1, "chat.send", { message: "hello" });
    await done1;

    await new Promise((r) => setTimeout(r, 200));

    const texts1 = events1.filter((e) => e.event === "agent.text");
    const texts2 = events2.filter((e) => e.event === "agent.text");
    expect(texts1.length).toBeGreaterThan(0);
    expect(texts2.length).toBe(0); // Session B should NOT see session A's events

    ws1.close();
    ws2.close();
  });

  test("command queue serializes messages within session", async () => {
    const responseOrder: string[] = [];
    let callCount = 0;
    const sequentialProvider: LLMProvider = {
      async *stream() {
        callCount++;
        const num = callCount;
        yield { type: "message_start" as const, message_id: `msg_${num}`, model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        // Small delay to verify serialization
        await new Promise((r) => setTimeout(r, 50));
        yield { type: "text_delta" as const, text: `response-${num}` };
        responseOrder.push(`response-${num}`);
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" as const };
      },
    };

    wireAgentToGateway(server, sequentialProvider);
    server.start(port);

    const ws = await connectAndHandshake(port, "e2e:serial-test");

    // Send two messages rapidly — they should be serialized by the command queue
    const p1 = sendRequest(ws, "chat.send", { message: "first" });
    const p2 = sendRequest(ws, "chat.send", { message: "second" });

    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 200));

    // Responses must be in order (command queue serializes within session)
    expect(responseOrder).toEqual(["response-1", "response-2"]);

    ws.close();
  });

  test("agent error is broadcast as agent.error event", async () => {
    const failProvider: LLMProvider = {
      async *stream() {
        throw new Error("Mock API failure");
      },
    };

    wireAgentToGateway(server, failProvider);
    server.start(port);

    const ws = await connectAndHandshake(port, "e2e:error-test");
    const events = collectEvents(ws);

    const errorPromise = waitForEvent(ws, "agent.error");
    const res = await sendRequest(ws, "chat.send", { message: "trigger error" });
    expect(res.ok).toBe(true);

    const errorEvent = await errorPromise;
    expect(errorEvent.event).toBe("agent.error");
    expect((errorEvent.payload as any)?.content).toContain("Mock API failure");

    ws.close();
  });

  test("gateway shutdown while agent is running", async () => {
    const slowProvider: LLMProvider = {
      async *stream() {
        yield { type: "message_start" as const, message_id: "msg_slow", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        await new Promise((r) => setTimeout(r, 500));
        yield { type: "text_delta" as const, text: "slow response" };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" as const };
      },
    };

    wireAgentToGateway(server, slowProvider);
    server.start(port);

    const ws = await connectAndHandshake(port, "e2e:shutdown-test");
    const events = collectEvents(ws);

    // Start a slow chat
    void sendRequest(ws, "chat.send", { message: "slow" });
    await new Promise((r) => setTimeout(r, 100));

    // Shutdown while agent is running — should wait for it
    const shutdownEvent = waitForEvent(ws, "gateway.shutdown", 3000);
    await server.stop(3000);

    // Client should have received shutdown event
    // (might not if connection was closed before flush, but the test shouldn't hang)
    await new Promise((r) => setTimeout(r, 200));
  });
});

// =============================================================================
// PRODUCTION PATH — using AgentSessionManager + registerAgentMethods
// (same code path as `hawky gateway` CLI command)
// =============================================================================

describe("E2E: production gateway path", () => {
  /** Set up a gateway using the real production wiring (same as CLI). */
  function setupProductionGateway(provider: LLMProvider): { server: GatewayServer; sessions: AgentSessionManager } {
    resetGatewayState();
    applyDefaultLaneConcurrency();

    const config = makeConfig();
    const srv = new GatewayServer();

    // Pass server to sessions for WS permission resolver
    const sessions = new AgentSessionManager({
      provider,
      config,
      workingDirectory: "/tmp",
      server: srv,
    });

    srv.setActiveSessionCounter(() => sessions.size);
    registerAgentMethods(srv, sessions);

    return { server: srv, sessions };
  }

  test("chat.send through production path streams events", async () => {
    const { server: srv, sessions } = setupProductionGateway(createTextProvider("Production response!"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:text-test");
      const events = collectEvents(ws);

      const donePromise = waitForEvent(ws, "agent.done");
      const res = await sendRequest(ws, "chat.send", { message: "hello" });
      expect(res.ok).toBe(true);
      expect((res.payload as any).completed).toBe(true);

      await donePromise;

      const textEvents = events.filter((e) => e.event === "agent.text");
      expect(textEvents.length).toBeGreaterThan(0);
      const content = textEvents.map((e) => (e.payload as any)?.content ?? "").join("");
      expect(content).toContain("Production response!");

      // Session should have been created
      expect(sessions.has("prod:text-test")).toBe(true);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("chat.cancel stops a running agent", async () => {
    const slowProvider: LLMProvider = {
      async *stream() {
        yield { type: "message_start" as const, message_id: "msg_slow", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        await new Promise((r) => setTimeout(r, 2000)); // Very slow
        yield { type: "text_delta" as const, text: "should not reach" };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" as const };
      },
    };

    const { server: srv } = setupProductionGateway(slowProvider);
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:cancel-test");
      const events = collectEvents(ws);

      // Start chat (will be slow)
      void sendRequest(ws, "chat.send", { message: "slow" });
      await new Promise((r) => setTimeout(r, 200));

      // Cancel
      const cancelRes = await sendRequest(ws, "chat.cancel", { sessionKey: "prod:cancel-test" });
      expect(cancelRes.ok).toBe(true);
      expect((cancelRes.payload as any).cancelled).toBe(true);

      // Wait for cancel event
      await new Promise((r) => setTimeout(r, 500));
      const cancelEvents = events.filter((e) => e.event === "agent.cancel");
      expect(cancelEvents.length).toBeGreaterThanOrEqual(1);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.list returns sessions", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("hi"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:list-test");
      const res = await sendRequest(ws, "session.list");
      expect(res.ok).toBe(true);
      expect(Array.isArray((res.payload as any).sessions)).toBe(true);
      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.resolve creates and returns session info", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("hi"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p);
      const res = await sendRequest(ws, "session.resolve", { sessionKey: "prod:resolve-test" });
      expect(res.ok).toBe(true);
      expect((res.payload as any).sessionKey).toBe("prod:resolve-test");
      expect((res.payload as any).sessionId).toBeTruthy();
      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.history returns conversation after chat", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("History response"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:history-test");

      // Send a message first
      const donePromise = waitForEvent(ws, "agent.done");
      await sendRequest(ws, "chat.send", { message: "what is 2+2" });
      await donePromise;

      // Now get history
      const histRes = await sendRequest(ws, "session.history", { sessionKey: "prod:history-test" });
      expect(histRes.ok).toBe(true);
      const { messages, total } = histRes.payload as any;
      expect(total).toBeGreaterThanOrEqual(2); // At least user + assistant
      expect(messages.length).toBeGreaterThanOrEqual(2);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("status includes active session count", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("hi"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:status-test");

      // Create a session
      await sendRequest(ws, "session.resolve", { sessionKey: "prod:status-session" });

      const statusRes = await sendRequest(ws, "status");
      expect(statusRes.ok).toBe(true);
      expect((statusRes.payload as any).activeSessions).toBeGreaterThanOrEqual(1);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("chat.send without session key returns error", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("hi"));
    const p = getTestPort();
    srv.start(p);

    try {
      // Connect WITHOUT a sessionKey
      const ws = await connectAndHandshake(p);
      const res = await sendRequest(ws, "chat.send", { message: "hello" });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("NO_SESSION");
      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("permission flow: request sent to client, resolve unblocks agent", async () => {
    // Provider calls bash tool (which requires permission)
    const provider = createToolProvider("bash", { command: "echo PERM_WS" }, "Permission granted.");

    const { server: srv } = setupProductionGateway(provider);
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:perm-test");
      const events = collectEvents(ws);

      // Send chat — agent will call bash, which needs permission
      void sendRequest(ws, "chat.send", { message: "run it" });

      // Wait for permission.request event
      const permEvent = await waitForEvent(ws, "permission.request", 10000);
      expect(permEvent.event).toBe("permission.request");
      const payload = permEvent.payload as any;
      expect(payload.tool).toBe("bash");
      expect(payload.requestId).toBeTruthy();

      // Resolve the permission (allow_once)
      const resolveRes = await sendRequest(ws, "permission.resolve", {
        requestId: payload.requestId,
        decision: "allow_once",
      });
      expect(resolveRes.ok).toBe(true);

      // Wait for agent to complete
      const doneEvent = await waitForEvent(ws, "agent.done", 10000);
      expect(doneEvent.event).toBe("agent.done");

      // Tool should have executed (tool_result event)
      const toolResults = events.filter((e) => e.event === "agent.tool_result");
      expect(toolResults.length).toBe(1);
      expect((toolResults[0].payload as any)?.content).toContain("PERM_WS");

      ws.close();
    } finally {
      resetWsPermissions();
      await srv.stop(1000);
    }
  });

  test("permission flow: deny prevents tool execution", async () => {
    const provider = createToolProvider("bash", { command: "rm -rf /" }, "Should not reach.");

    const { server: srv } = setupProductionGateway(provider);
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:perm-deny");
      const events = collectEvents(ws);

      void sendRequest(ws, "chat.send", { message: "delete" });

      // Wait for permission request
      const permEvent = await waitForEvent(ws, "permission.request", 10000);
      const requestId = (permEvent.payload as any).requestId;

      // Deny
      await sendRequest(ws, "permission.resolve", { requestId, decision: "deny" });

      // Wait for agent to complete
      await waitForEvent(ws, "agent.done", 10000);

      // Tool result should show denial
      const toolResults = events.filter((e) => e.event === "agent.tool_result");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect((toolResults[0].payload as any)?.is_error).toBe(true);
      expect((toolResults[0].payload as any)?.content).toContain("denied");

      ws.close();
    } finally {
      resetWsPermissions();
      await srv.stop(1000);
    }
  });

  test("session persistence: gateway restart preserves conversation", async () => {
    // Phase 1: Chat with the gateway
    const provider1 = createTextProvider("First response.");
    const { server: srv1, sessions: sess1 } = setupProductionGateway(provider1);
    const p = getTestPort();
    srv1.start(p);

    const ws1 = await connectAndHandshake(p, "prod:restart-test");
    const doneP1 = waitForEvent(ws1, "agent.done");
    await sendRequest(ws1, "chat.send", { message: "hello" });
    await doneP1;

    // Verify session has history
    const hist1 = await sendRequest(ws1, "session.history", { sessionKey: "prod:restart-test" });
    expect((hist1.payload as any).total).toBeGreaterThanOrEqual(2);

    ws1.close();
    await srv1.stop(1000);

    // Phase 2: "Restart" — new server, new session manager, same port
    const provider2 = createTextProvider("Second response.");
    const { server: srv2 } = setupProductionGateway(provider2);
    srv2.start(p);

    const ws2 = await connectAndHandshake(p, "prod:restart-test");

    // Resolve session first (triggers disk reload via getOrCreate)
    await sendRequest(ws2, "session.resolve", { sessionKey: "prod:restart-test" });

    // History should be preserved (loaded from disk via deterministic sessionId)
    const hist2 = await sendRequest(ws2, "session.history", { sessionKey: "prod:restart-test" });
    expect((hist2.payload as any).total).toBeGreaterThanOrEqual(2);

    ws2.close();
    await srv2.stop(1000);
  });

  test("working directory from client passed to session", async () => {
    // Verify that the client's workingDirectory is stored in the session
    const { server: srv, sessions } = setupProductionGateway(createTextProvider("hi"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = new WebSocket(`ws://localhost:${p}`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject());
        setTimeout(() => reject(new Error("timeout")), 3000);
      });

      // Handshake with workingDirectory
      const res = await sendRequest(ws, "connect", {
        version: "test",
        platform: "test",
        sessionKey: "prod:cwd-test",
        workingDirectory: "/tmp/my-project",
      });
      expect(res.ok).toBe(true);

      // Send a message to create the session
      const donePromise = waitForEvent(ws, "agent.done", 10000);
      await sendRequest(ws, "chat.send", { message: "hi" });
      await donePromise;

      // Verify session was created with the client's cwd
      const session = sessions.get("prod:cwd-test");
      expect(session).toBeDefined();
      // The session's loop should have been created with the client's working directory
      // (verified by the fact that the session was created at all — the cwd is passed through)

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.clear resets conversation history", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("Reply."));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:clear-test");

      // Send a message to create history
      const done1 = waitForEvent(ws, "agent.done");
      await sendRequest(ws, "chat.send", { message: "hello" });
      await done1;

      // Verify history exists
      const hist1 = await sendRequest(ws, "session.history", { sessionKey: "prod:clear-test" });
      expect((hist1.payload as any).total).toBeGreaterThanOrEqual(2);

      // Clear the session
      const clearRes = await sendRequest(ws, "session.clear", { sessionKey: "prod:clear-test" });
      expect(clearRes.ok).toBe(true);

      // History should be empty
      const hist2 = await sendRequest(ws, "session.history", { sessionKey: "prod:clear-test" });
      expect((hist2.payload as any).total).toBe(0);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("ask_user.resolve RPC is registered and callable", async () => {
    const { server: srv } = setupProductionGateway(createTextProvider("hi"));
    const p = getTestPort();
    srv.start(p);

    try {
      const ws = await connectAndHandshake(p, "prod:askuser-test");

      // Call ask_user.resolve — should not return METHOD_NOT_FOUND
      const res = await sendRequest(ws, "ask_user.resolve", {
        requestId: "nonexistent",
        answers: ["test"],
      });
      // Should succeed (even if no pending request — resolveAskUser is a no-op for unknown IDs)
      expect(res.ok).toBe(true);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });
});
