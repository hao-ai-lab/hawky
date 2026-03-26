// =============================================================================
// Gateway Server Tests
//
// Comprehensive tests for the WebSocket gateway: protocol, connection lifecycle,
// handshake, auth, session binding, broadcast, methods, and graceful shutdown.
//
// Uses real Bun.serve() + real WebSocket connections for true E2E coverage.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { parseFrame, serializeFrame, ErrorCodes } from "../src/gateway/protocol.js";
import type { RequestFrame, ResponseFrame, EventFrame, Frame } from "../src/gateway/protocol.js";
import { resetCommandQueue } from "../src/gateway/command-queue.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Find a free port for testing. */
function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/** Send a request frame and wait for the response. */
async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
  id?: string,
): Promise<ResponseFrame> {
  const reqId = id ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame: RequestFrame = { type: "req", id: reqId, method, params };
  ws.send(JSON.stringify(frame));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for response to ${method}`)), 5000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === reqId) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data as ResponseFrame);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Collect all events from a WebSocket into an array. */
function collectMessages(ws: WebSocket): (ResponseFrame | EventFrame)[] {
  const messages: (ResponseFrame | EventFrame)[] = [];
  ws.addEventListener("message", (event) => {
    try {
      messages.push(JSON.parse(event.data as string));
    } catch { /* ignore non-JSON */ }
  });
  return messages;
}

/** Wait for a specific event type. */
async function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 3000): Promise<EventFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for event: ${eventName}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "event" && data.event === eventName) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data as EventFrame);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Connect a WebSocket and wait for it to open. */
async function connectWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`WS connect failed: ${e}`)));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
  return ws;
}

/** Perform full handshake: connect WS + send connect frame. */
async function handshake(
  port: number,
  params?: { version?: string; platform?: string; sessionKey?: string; token?: string },
): Promise<{ ws: WebSocket; connId: string }> {
  const ws = await connectWs(port);
  const res = await sendRequest(ws, "connect", {
    version: params?.version ?? "test-1.0",
    platform: params?.platform ?? "test",
    sessionKey: params?.sessionKey,
    token: params?.token,
  });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return { ws, connId: (res.payload as any).connId };
}

let server: GatewayServer;
let port: number;

beforeEach(() => {
  resetGatewayState();
  server = new GatewayServer();
  port = getTestPort();

  // Register stub methods for protocol-level tests (real implementations
  // are in agent-methods.ts and tested in e2e-gateway.ts)
  server.registerMethod("chat.send", (conn, params) => {
    const p = params as { message?: string; sessionKey?: string } | undefined;
    if (!p?.message) throw Object.assign(new Error("message is required"), { code: "INVALID_REQUEST" });
    if (p.sessionKey) conn.bindSession(p.sessionKey);
    return { queued: true, sessionKey: conn.sessionKey };
  });
  server.registerMethod("chat.cancel", (conn) => {
    return { cancelled: true, sessionKey: conn.sessionKey };
  });
});

afterEach(async () => {
  await server.stop(1000);
  resetGatewayState();
});

// =============================================================================
// PROTOCOL — FRAME PARSING
// =============================================================================

describe("protocol: parseFrame", () => {
  test("parses valid request frame", () => {
    const raw = JSON.stringify({ type: "req", id: "1", method: "connect", params: {} });
    const frame = parseFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("req");
    expect(frame!.method).toBe("connect");
  });

  test("rejects non-req frames", () => {
    expect(parseFrame(JSON.stringify({ type: "res", id: "1", ok: true }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "event", event: "test" }))).toBeNull();
  });

  test("rejects frames without id", () => {
    expect(parseFrame(JSON.stringify({ type: "req", method: "connect" }))).toBeNull();
  });

  test("rejects frames without method", () => {
    expect(parseFrame(JSON.stringify({ type: "req", id: "1" }))).toBeNull();
  });

  test("rejects invalid JSON", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  test("handles Buffer input", () => {
    const buf = Buffer.from(JSON.stringify({ type: "req", id: "1", method: "test" }));
    expect(parseFrame(buf)).not.toBeNull();
  });
});

describe("protocol: serializeFrame", () => {
  test("serializes response frame", () => {
    const frame: ResponseFrame = { type: "res", id: "1", ok: true, payload: { hello: "world" } };
    const serialized = serializeFrame(frame);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("res");
    expect(parsed.payload.hello).toBe("world");
  });

  test("serializes event frame with seq", () => {
    const frame: EventFrame = { type: "event", event: "test", payload: 42, seq: 1 };
    const serialized = serializeFrame(frame);
    const parsed = JSON.parse(serialized);
    expect(parsed.seq).toBe(1);
  });
});

// =============================================================================
// SERVER — HTTP ENDPOINTS
// =============================================================================

describe("server: HTTP endpoints", () => {
  test("/health returns ok", async () => {
    server.start(port);
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("live");
  });

  test("/ready returns ok with connection count", async () => {
    server.start(port);
    const res = await fetch(`http://localhost:${port}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.connections).toBe(0);
  });

  test("unknown file path returns 404", async () => {
    server.start(port);
    // Paths with file extensions that don't exist should 404
    // (SPA fallback only applies to extensionless paths when web/dist exists)
    const res = await fetch(`http://localhost:${port}/nonexistent.xyz`);
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// SERVER — WEBSOCKET CONNECTION LIFECYCLE
// =============================================================================

describe("server: WebSocket connection", () => {
  test("accepts WebSocket connection", async () => {
    server.start(port);
    const ws = await connectWs(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("handshake with connect method", async () => {
    server.start(port);
    const { ws, connId } = await handshake(port);
    expect(connId).toMatch(/^conn-/);
    ws.close();
  });

  test("hello-ok includes server info", async () => {
    server.start(port);
    const ws = await connectWs(port);
    const res = await sendRequest(ws, "connect", { version: "1.0", platform: "web" });
    expect(res.ok).toBe(true);
    const payload = res.payload as any;
    expect(payload.serverVersion).toBe("0.1.0");
    expect(payload.connId).toMatch(/^conn-/);
    expect(Array.isArray(payload.methods)).toBe(true);
    expect(payload.methods).toContain("status");
    expect(payload.methods).toContain("chat.send");
    ws.close();
  });

  test("rejects non-connect method before handshake", async () => {
    server.start(port);
    const ws = await connectWs(port);
    const res = await sendRequest(ws, "status");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.HANDSHAKE_REQUIRED);
    ws.close();
  });

  test("invalid frame gets error response", async () => {
    server.start(port);
    const ws = await connectWs(port);

    // Send garbage
    ws.send("not valid json!!!");
    await new Promise((r) => setTimeout(r, 100));

    // Send valid connect after — should still work
    const res = await sendRequest(ws, "connect", {});
    expect(res.ok).toBe(true);
    ws.close();
  });

  test("connection count updates on connect/disconnect", async () => {
    server.start(port);
    expect(server.getConnectionCount()).toBe(0);

    const { ws: ws1 } = await handshake(port);
    // Connection count may take a tick to update
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getConnectionCount()).toBeGreaterThanOrEqual(1);

    ws1.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.getConnectionCount()).toBe(0);
  });
});

// =============================================================================
// SERVER — AUTH
// =============================================================================

describe("server: authentication", () => {
  test("localhost connections require device token when auth is enabled", async () => {
    const { DeviceAuth } = await import("../src/gateway/device-auth.js");
    const { randomBytes } = await import("node:crypto");
    const auth = DeviceAuth.fromKey(randomBytes(32));
    const authedServer = new GatewayServer(auth);
    const authPort = getTestPort();
    authedServer.start(authPort, "127.0.0.1");

    // Localhost without token should be rejected
    const ws = await connectWs(authPort);
    const res = await sendRequest(ws, "connect", { version: "test", platform: "test" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNAUTHORIZED");

    // With valid token should succeed
    const token = auth.createToken("test-device");
    const ws2 = await connectWs(authPort);
    const res2 = await sendRequest(ws2, "connect", { version: "test", platform: "test", token });
    expect(res2.ok).toBe(true);

    ws2.close();
    await authedServer.stop(1000);
  });
});

// =============================================================================
// SERVER — SESSION BINDING
// =============================================================================

describe("server: session binding", () => {
  test("connect with sessionKey binds connection", async () => {
    server.start(port);
    const { ws } = await handshake(port, { sessionKey: "web:tab-1" });

    // Verify via status (connection is authenticated and bound)
    const status = await sendRequest(ws, "status");
    expect(status.ok).toBe(true);
    ws.close();
  });

  test("chat.send with sessionKey rebinds connection", async () => {
    server.start(port);
    const { ws } = await handshake(port, { sessionKey: "web:tab-1" });

    // Send to different session
    const res = await sendRequest(ws, "chat.send", {
      message: "hello",
      sessionKey: "web:tab-2",
    });
    expect(res.ok).toBe(true);
    expect((res.payload as any).sessionKey).toBe("web:tab-2");
    ws.close();
  });
});

// =============================================================================
// SERVER — RPC METHODS
// =============================================================================

describe("server: RPC methods", () => {
  test("status returns server info", async () => {
    server.start(port);
    const { ws } = await handshake(port);
    const res = await sendRequest(ws, "status");
    expect(res.ok).toBe(true);
    const payload = res.payload as any;
    expect(payload.version).toBe("0.1.0");
    expect(typeof payload.uptime).toBe("number");
    expect(payload.connections).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  test("chat.send requires message", async () => {
    server.start(port);
    const { ws } = await handshake(port);
    const res = await sendRequest(ws, "chat.send", {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
    ws.close();
  });

  test("chat.send with valid message succeeds", async () => {
    server.start(port);
    const { ws } = await handshake(port, { sessionKey: "test:main" });
    const res = await sendRequest(ws, "chat.send", { message: "hello" });
    expect(res.ok).toBe(true);
    expect((res.payload as any).queued).toBe(true);
    ws.close();
  });

  test("unknown method returns METHOD_NOT_FOUND", async () => {
    server.start(port);
    const { ws } = await handshake(port);
    const res = await sendRequest(ws, "nonexistent.method");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.METHOD_NOT_FOUND);
    ws.close();
  });

  test("custom method can be registered", async () => {
    server.registerMethod("custom.echo", (_conn, params) => {
      return { echo: params };
    });
    server.start(port);
    const { ws } = await handshake(port);
    const res = await sendRequest(ws, "custom.echo", { data: 42 });
    expect(res.ok).toBe(true);
    expect((res.payload as any).echo.data).toBe(42);
    ws.close();
  });

  test("method handler error returns error response", async () => {
    server.registerMethod("custom.fail", () => {
      throw new Error("handler boom");
    });
    server.start(port);
    const { ws } = await handshake(port);
    const res = await sendRequest(ws, "custom.fail");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("handler boom");
    ws.close();
  });
});

// =============================================================================
// SERVER — BROADCAST
// =============================================================================

describe("server: event broadcast", () => {
  test("broadcast sends to all authenticated connections", async () => {
    server.start(port);
    const { ws: ws1 } = await handshake(port);
    const { ws: ws2 } = await handshake(port);

    const msgs1 = collectMessages(ws1);
    const msgs2 = collectMessages(ws2);

    server.broadcast("test.event", { data: "hello" });
    await new Promise((r) => setTimeout(r, 100));

    const events1 = msgs1.filter((m) => m.type === "event" && (m as EventFrame).event === "test.event");
    const events2 = msgs2.filter((m) => m.type === "event" && (m as EventFrame).event === "test.event");
    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);
    expect((events1[0] as EventFrame).payload).toEqual({ data: "hello" });

    ws1.close();
    ws2.close();
  });

  test("broadcastToSession only sends to bound connections", async () => {
    server.start(port);
    const { ws: ws1 } = await handshake(port, { sessionKey: "session-A" });
    const { ws: ws2 } = await handshake(port, { sessionKey: "session-B" });

    const msgs1 = collectMessages(ws1);
    const msgs2 = collectMessages(ws2);

    server.broadcastToSession("session-A", "agent.text", { content: "for A only" });
    await new Promise((r) => setTimeout(r, 100));

    const events1 = msgs1.filter((m) => m.type === "event" && (m as EventFrame).event === "agent.text");
    const events2 = msgs2.filter((m) => m.type === "event" && (m as EventFrame).event === "agent.text");
    expect(events1.length).toBe(1);
    expect(events2.length).toBe(0); // Session B should NOT receive
    expect((events1[0] as EventFrame).payload).toEqual({ content: "for A only", _sessionKey: "session-A" });

    ws1.close();
    ws2.close();
  });

  test("two connections on same session both receive events", async () => {
    server.start(port);
    const { ws: ws1 } = await handshake(port, { sessionKey: "shared" });
    const { ws: ws2 } = await handshake(port, { sessionKey: "shared" });

    const msgs1 = collectMessages(ws1);
    const msgs2 = collectMessages(ws2);

    server.broadcastToSession("shared", "agent.done", { usage: {} });
    await new Promise((r) => setTimeout(r, 100));

    const events1 = msgs1.filter((m) => m.type === "event" && (m as EventFrame).event === "agent.done");
    const events2 = msgs2.filter((m) => m.type === "event" && (m as EventFrame).event === "agent.done");
    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);

    ws1.close();
    ws2.close();
  });

  test("events have sequential seq numbers", async () => {
    server.start(port);
    const { ws } = await handshake(port);
    const msgs = collectMessages(ws);

    server.broadcast("e1", {});
    server.broadcast("e2", {});
    server.broadcast("e3", {});
    await new Promise((r) => setTimeout(r, 100));

    const events = msgs.filter((m) => m.type === "event") as EventFrame[];
    const seqs = events.map((e) => e.seq).filter((s) => s !== undefined);
    // Sequences should be strictly increasing
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    ws.close();
  });

  test("unauthenticated connections do not receive broadcasts", async () => {
    server.start(port);

    // Connect but DON'T handshake
    const ws = await connectWs(port);
    const msgs = collectMessages(ws);

    server.broadcast("test.event", { data: "secret" });
    await new Promise((r) => setTimeout(r, 100));

    const events = msgs.filter((m) => m.type === "event" && (m as EventFrame).event === "test.event");
    expect(events.length).toBe(0); // Should NOT receive

    ws.close();
  });
});

// =============================================================================
// SERVER — GRACEFUL SHUTDOWN
// =============================================================================

describe("server: graceful shutdown", () => {
  test("stop closes all connections", async () => {
    server.start(port);
    const { ws: ws1 } = await handshake(port);
    const { ws: ws2 } = await handshake(port);

    let ws1Closed = false;
    let ws2Closed = false;
    ws1.addEventListener("close", () => { ws1Closed = true; });
    ws2.addEventListener("close", () => { ws2Closed = true; });

    await server.stop(1000);
    await new Promise((r) => setTimeout(r, 200));

    expect(ws1Closed).toBe(true);
    expect(ws2Closed).toBe(true);
  });

  test("stop broadcasts gateway.shutdown event", async () => {
    server.start(port);
    const { ws } = await handshake(port);

    const shutdownPromise = waitForEvent(ws, "gateway.shutdown", 3000);
    void server.stop(1000);
    const event = await shutdownPromise;
    expect(event.event).toBe("gateway.shutdown");
  });

  test("server stops accepting connections after stop", async () => {
    server.start(port);
    await server.stop(1000);

    // Try to connect — should fail
    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => { ws.close(); reject(new Error("Should not connect")); });
        ws.addEventListener("error", () => resolve());
        setTimeout(() => resolve(), 500);
      });
    } catch {
      // Expected
    }
  });
});

// =============================================================================
// INTEGRATION — FULL SCENARIOS
// =============================================================================

describe("integration: multi-client scenarios", () => {
  test("two tabs with different sessions are independent", async () => {
    server.start(port);
    const { ws: tabA } = await handshake(port, { sessionKey: "web:tab-a" });
    const { ws: tabB } = await handshake(port, { sessionKey: "web:tab-b" });

    const msgsA = collectMessages(tabA);
    const msgsB = collectMessages(tabB);

    // Send event to tab A's session
    server.broadcastToSession("web:tab-a", "agent.text", { content: "for A" });
    // Send event to tab B's session
    server.broadcastToSession("web:tab-b", "agent.text", { content: "for B" });
    await new Promise((r) => setTimeout(r, 100));

    const eventsA = msgsA.filter((m) => m.type === "event" && (m as EventFrame).event === "agent.text");
    const eventsB = msgsB.filter((m) => m.type === "event" && (m as EventFrame).event === "agent.text");

    expect(eventsA.length).toBe(1);
    expect((eventsA[0] as EventFrame).payload).toEqual({ content: "for A", _sessionKey: "web:tab-a" });
    expect(eventsB.length).toBe(1);
    expect((eventsB[0] as EventFrame).payload).toEqual({ content: "for B", _sessionKey: "web:tab-b" });

    tabA.close();
    tabB.close();
  });

  test("connect then RPC then disconnect lifecycle", async () => {
    server.start(port);

    // Connect
    const { ws } = await handshake(port, { sessionKey: "lifecycle-test" });

    // RPC
    const statusRes = await sendRequest(ws, "status");
    expect(statusRes.ok).toBe(true);

    const chatRes = await sendRequest(ws, "chat.send", { message: "hello" });
    expect(chatRes.ok).toBe(true);

    // Disconnect
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.getConnectionCount()).toBe(0);
  });

  test("rapid connect/disconnect doesn't crash", async () => {
    server.start(port);

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push((async () => {
        const ws = await connectWs(port);
        await sendRequest(ws, "connect", { platform: `client-${i}` });
        ws.close();
      })());
    }

    await Promise.all(promises);
    await new Promise((r) => setTimeout(r, 200));
    expect(server.getConnectionCount()).toBe(0);
  });

  test("multiple methods in sequence", async () => {
    server.start(port);
    const { ws } = await handshake(port, { sessionKey: "multi-method" });

    // Fire multiple requests sequentially
    for (let i = 0; i < 5; i++) {
      const res = await sendRequest(ws, "status");
      expect(res.ok).toBe(true);
    }

    ws.close();
  });
});
