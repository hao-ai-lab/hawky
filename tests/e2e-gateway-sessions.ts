// =============================================================================
// Gateway Session Persistence Tests
//
// Tests session JSONL creation, resume, history, and corruption recovery
// through the gateway architecture. These replace the old TUI-local session
// tests (test-session-integration.tsx) which tested the same functionality
// through the in-process AgentLoop path.
//
// Each test creates a real GatewayServer + AgentSessionManager with mock
// providers, verifying the full pipeline: WebSocket → command queue →
// agent → session persistence → history retrieval.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetWsPermissions } from "../src/gateway/ws-permission.js";
import type { LLMProvider, LLMStreamEvent } from "../src/agent/provider.js";
import type { HawkyConfig } from "../src/agent/types.js";
import type { ResponseFrame, EventFrame } from "../src/gateway/protocol.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "mock", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "mock-model",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
  };
}

function createTextProvider(text: string): LLMProvider {
  return {
    async *stream() {
      yield { type: "message_start" as const, message_id: "msg_1", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: "text_delta" as const, text };
      yield { type: "content_block_stop" as const, index: 0 };
      yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 10 } };
      yield { type: "message_stop" as const };
    },
  };
}

function createToolThenTextProvider(toolName: string, toolInput: Record<string, unknown>, text: string): LLMProvider {
  let callCount = 0;
  return {
    async *stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "message_start" as const, message_id: "msg_t1", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        yield { type: "tool_use_start" as const, index: 0, id: "tool_1", name: toolName };
        yield { type: "tool_use_input_delta" as const, partial_json: JSON.stringify(toolInput) };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 10 } };
        yield { type: "message_stop" as const };
      } else {
        yield { type: "message_start" as const, message_id: "msg_t2", model: "mock", usage: { input_tokens: 20, output_tokens: 5 } };
        yield { type: "text_delta" as const, text };
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
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 30000);
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

async function connectAndHandshake(port: number, sessionKey?: string, workingDir?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", {
    version: "test", platform: "test", sessionKey,
    workingDirectory: workingDir,
  });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

let activeServer: GatewayServer | null = null;

function setupGateway(provider: LLMProvider): { server: GatewayServer; sessions: AgentSessionManager } {
  resetGatewayState();
  applyDefaultLaneConcurrency();
  const config = makeConfig();
  const srv = new GatewayServer();
  const sessions = new AgentSessionManager({ provider, config, workingDirectory: "/tmp", server: srv });
  srv.setActiveSessionCounter(() => sessions.size);
  registerAgentMethods(srv, sessions);
  activeServer = srv;
  return { server: srv, sessions };
}

function getSessionFiles(): string[] {
  if (!existsSync(testDir)) return [];
  const results: string[] = [];
  const scan = (dir: string) => {
    for (const entry of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) scan(require("node:path").join(dir, entry.name));
      else if (entry.name.endsWith(".jsonl")) results.push(require("node:path").join(dir, entry.name));
    }
  };
  scan(testDir);
  return results;
}

function readSessionLines(filePath: string): any[] {
  const resolved = filePath.startsWith("/") ? filePath : join(testDir, filePath);
  const content = readFileSync(resolved, "utf-8");
  return content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// Setup / Teardown
// -----------------------------------------------------------------------------

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-gw-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
});

afterEach(async () => {
  // Always stop the server to prevent dangling connections and unhandled rejections
  if (activeServer) {
    await activeServer.stop(1000);
    activeServer = null;
  }
  resetSessionsDir();
  resetWsPermissions();
  resetGatewayState();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// Session JSONL creation (replaces old "Session persistence — creation")
// =============================================================================

describe("Gateway session persistence — creation", () => {
  test("session JSONL file created on first message", async () => {
    const { server: srv } = setupGateway(createTextProvider("Hello!"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "create:test1");
      const doneP = waitForEvent(ws, "agent.done", 10000);
      await sendRequest(ws, "chat.send", { message: "hi" });
      await doneP;

      // Session file should exist with deterministic name
      const files = getSessionFiles();
      expect(files.length).toBeGreaterThanOrEqual(1);
      const sessionFile = files.find((f) => f.endsWith("test1.jsonl"));
      expect(sessionFile).toBeDefined();

      // Should have header + messages
      const lines = readSessionLines(sessionFile!);
      expect(lines[0].type).toBe("session");
      const msgLines = lines.filter((l: any) => l.type === "message");
      expect(msgLines.length).toBeGreaterThanOrEqual(2); // user + assistant

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session header contains model and working directory", async () => {
    const { server: srv } = setupGateway(createTextProvider("hi"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "create:header", "/tmp/my-project");
      const doneP = waitForEvent(ws, "agent.done", 10000);
      await sendRequest(ws, "chat.send", { message: "hello" });
      await doneP;

      const files = getSessionFiles();
      const sessionFile = files.find((f) => f.endsWith("header.jsonl"));
      expect(sessionFile).toBeDefined();

      const lines = readSessionLines(sessionFile!);
      const header = lines[0];
      expect(header.type).toBe("session");
      expect(header.model).toBe("mock-model");
      expect(header.working_directory).toBe("/tmp/my-project");

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });
});

// =============================================================================
// Session resume (replaces old "Session persistence — resume")
// =============================================================================

describe("Gateway session persistence — resume", () => {
  test("agent has context from previous session (history restored after restart)", async () => {
    // Phase 1: Chat with gateway
    const { server: srv1 } = setupGateway(createTextProvider("I'll remember ALPHA-7."));
    const port = getTestPort();
    srv1.start(port);

    const ws1 = await connectAndHandshake(port, "resume:context");
    const done1 = waitForEvent(ws1, "agent.done");
    await sendRequest(ws1, "chat.send", { message: "My secret code is ALPHA-7" });
    await done1;
    ws1.close();
    await srv1.stop(1000);

    // Phase 2: "Restart" gateway — session should reload from disk
    const { server: srv2, sessions: sess2 } = setupGateway(createTextProvider("Your code is ALPHA-7."));
    srv2.start(port);

    const ws2 = await connectAndHandshake(port, "resume:context");
    // Resolve session to trigger disk reload
    await sendRequest(ws2, "session.resolve", { sessionKey: "resume:context" });

    // Verify history was restored
    const histRes = await sendRequest(ws2, "session.history", { sessionKey: "resume:context" });
    const messages = (histRes.payload as any).messages;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // Find user message with ALPHA-7
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();

    ws2.close();
    await srv2.stop(1000);
  });

  test("new messages appended to existing session file", async () => {
    // Phase 1: First chat
    const { server: srv1 } = setupGateway(createTextProvider("First reply."));
    const port = getTestPort();
    srv1.start(port);

    const ws1 = await connectAndHandshake(port, "resume:append");
    const done1 = waitForEvent(ws1, "agent.done");
    await sendRequest(ws1, "chat.send", { message: "first message" });
    await done1;

    // Count messages in file
    const files1 = getSessionFiles();
    const file1 = files1.find((f) => f.endsWith("append.jsonl"))!;
    const lines1 = readSessionLines(file1);
    const msgCount1 = lines1.filter((l: any) => l.type === "message").length;

    ws1.close();
    await srv1.stop(1000);

    // Phase 2: Second chat — messages should be appended
    const { server: srv2 } = setupGateway(createTextProvider("Second reply."));
    srv2.start(port);

    const ws2 = await connectAndHandshake(port, "resume:append");
    await sendRequest(ws2, "session.resolve", { sessionKey: "resume:append" });
    const done2 = waitForEvent(ws2, "agent.done");
    await sendRequest(ws2, "chat.send", { message: "second message" });
    await done2;

    // Should have more messages now
    const lines2 = readSessionLines(file1);
    const msgCount2 = lines2.filter((l: any) => l.type === "message").length;
    expect(msgCount2).toBeGreaterThan(msgCount1);

    ws2.close();
    await srv2.stop(1000);
  });
});

// =============================================================================
// Permission over WebSocket (replaces old "Session persistence — permission cache")
// =============================================================================

describe("Gateway session persistence — permission flow", () => {
  test("permission request sent to client, approve executes tool", async () => {
    const provider = createToolThenTextProvider("bash", { command: "echo PERM_TEST" }, "Tool ran.");
    const { server: srv } = setupGateway(provider);
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "perm:approve");

      // Send message that triggers bash tool
      void sendRequest(ws, "chat.send", { message: "run it" });

      // Wait for permission request event
      const permEvent = await waitForEvent(ws, "permission.request");
      expect((permEvent.payload as any).tool).toBe("bash");

      // Approve
      await sendRequest(ws, "permission.resolve", {
        requestId: (permEvent.payload as any).requestId,
        decision: "allow_once",
      });

      // Wait for completion
      await waitForEvent(ws, "agent.done");

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("permission deny prevents tool execution", async () => {
    const provider = createToolThenTextProvider("bash", { command: "rm -rf /" }, "Denied.");
    const { server: srv } = setupGateway(provider);
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "perm:deny");
      const events: EventFrame[] = [];
      ws.addEventListener("message", (e) => {
        try { const d = JSON.parse(e.data as string); if (d.type === "event") events.push(d); } catch {}
      });

      void sendRequest(ws, "chat.send", { message: "delete" });
      const permEvent = await waitForEvent(ws, "permission.request");

      // Deny
      await sendRequest(ws, "permission.resolve", {
        requestId: (permEvent.payload as any).requestId,
        decision: "deny",
      });

      await waitForEvent(ws, "agent.done");

      // Tool result should show denial
      const toolResults = events.filter((e) => e.event === "agent.tool_result");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect((toolResults[0].payload as any)?.is_error).toBe(true);
      expect((toolResults[0].payload as any)?.content).toContain("denied");

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });
});

// =============================================================================
// Session history retrieval (replaces old "Session persistence — visual resume")
// =============================================================================

describe("Gateway session persistence — history retrieval", () => {
  test("session.history returns full conversation", async () => {
    const { server: srv } = setupGateway(createTextProvider("Reply here."));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "hist:full");
      const done = waitForEvent(ws, "agent.done");
      await sendRequest(ws, "chat.send", { message: "test message" });
      await done;

      const histRes = await sendRequest(ws, "session.history", { sessionKey: "hist:full" });
      expect(histRes.ok).toBe(true);
      const { messages, total } = histRes.payload as any;
      expect(total).toBeGreaterThanOrEqual(2);
      expect(messages[0].role).toBe("user");

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("new session has empty history", async () => {
    const { server: srv } = setupGateway(createTextProvider("hi"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "hist:empty");
      // Don't send any messages — just check history
      await sendRequest(ws, "session.resolve", { sessionKey: "hist:empty" });
      const histRes = await sendRequest(ws, "session.history", { sessionKey: "hist:empty" });
      expect(histRes.ok).toBe(true);
      expect((histRes.payload as any).total).toBe(0);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.appendMessages persists turns into history + message count (no agent run)", async () => {
    const { server: srv } = setupGateway(createTextProvider("unused"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "append:test");

      // Append a user + assistant turn directly — no chat.send / agent loop.
      const appendRes = await sendRequest(ws, "session.appendMessages", {
        sessionKey: "append:test",
        messages: [
          { role: "user", text: "What's the weather?" },
          { role: "assistant", text: "Sunny and 72." },
          { role: "system", text: "ignored" }, // non user/assistant → dropped
        ],
      });
      expect(appendRes.ok).toBe(true);
      expect((appendRes.payload as any).appended).toBe(2);

      // history reflects the appended turns
      const hist = await sendRequest(ws, "session.history", { sessionKey: "append:test" });
      const { messages, total } = hist.payload as any;
      expect(total).toBe(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");

      // session.list reflects the message count
      const list = await sendRequest(ws, "session.list", { limit: 50 });
      const entry = (list.payload as any).sessions.find((s: any) => s.id === "append/test" || s.id === "append:test");
      expect(entry?.messageCount).toBe(2);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.appendMessages rejects empty / invalid input", async () => {
    const { server: srv } = setupGateway(createTextProvider("x"));
    const port = getTestPort();
    srv.start(port);
    try {
      const ws = await connectAndHandshake(port, "append:bad");
      const noMsgs = await sendRequest(ws, "session.appendMessages", { sessionKey: "append:bad", messages: [] });
      expect(noMsgs.ok).toBe(false);
      const noKey = await sendRequest(ws, "session.appendMessages", { messages: [{ role: "user", text: "hi" }] });
      expect(noKey.ok).toBe(false);
      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.history paginates with beforeIndex cursor and reports hasMore", async () => {
    const { server: srv } = setupGateway(createTextProvider("ok"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "hist:paginate");

      // Send 3 turns to build up history (each turn = at least 2 backend messages)
      for (let i = 0; i < 3; i++) {
        const done = waitForEvent(ws, "agent.done");
        await sendRequest(ws, "chat.send", { message: `turn ${i}` });
        await done;
      }

      // Fetch newest 2 messages (no cursor = from the end)
      const page1 = (await sendRequest(ws, "session.history", {
        sessionKey: "hist:paginate",
        limit: 2,
      })).payload as any;
      expect(page1.messages.length).toBe(2);
      expect(page1.total).toBeGreaterThanOrEqual(6);
      expect(page1.hasMore).toBe(true);
      // Every message has an absolute index
      expect(typeof page1.messages[0].index).toBe("number");

      // Fetch the next older chunk using the oldest loaded index as the cursor
      const cursor = page1.messages[0].index;
      const page2 = (await sendRequest(ws, "session.history", {
        sessionKey: "hist:paginate",
        limit: 2,
        beforeIndex: cursor,
      })).payload as any;
      expect(page2.messages.length).toBe(2);
      // All page2 messages should have indexes strictly less than the cursor
      expect(page2.messages.every((m: any) => m.index < cursor)).toBe(true);

      // No overlap: user-message texts from page1 and page2 should not share any
      const userTextsIn = (p: any): string[] =>
        p.messages
          .filter((m: any) => m.role === "user")
          .flatMap((m: any) =>
            Array.isArray(m.content)
              ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text)
              : [String(m.content ?? "")],
          );
      const p1Users = userTextsIn(page1);
      const p2Users = userTextsIn(page2);
      expect(p1Users.some((t: string) => p2Users.includes(t))).toBe(false);

      // Fetch with beforeIndex=0 — no messages older than the very first
      const pageEnd = (await sendRequest(ws, "session.history", {
        sessionKey: "hist:paginate",
        limit: 100,
        beforeIndex: 0,
      })).payload as any;
      expect(pageEnd.messages.length).toBe(0);
      expect(pageEnd.hasMore).toBe(false);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.history cursor is stable under live message arrivals", async () => {
    const { server: srv } = setupGateway(createTextProvider("ok"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "hist:stable");

      // Build initial history (2 turns = 4 messages)
      for (let i = 0; i < 2; i++) {
        const done = waitForEvent(ws, "agent.done");
        await sendRequest(ws, "chat.send", { message: `turn ${i}` });
        await done;
      }

      // Load the last 2 — record the cursor (oldest loaded index)
      const first = (await sendRequest(ws, "session.history", {
        sessionKey: "hist:stable",
        limit: 2,
      })).payload as any;
      const cursor = first.messages[0].index;

      // A new turn arrives (simulates live streaming during browse)
      {
        const done = waitForEvent(ws, "agent.done");
        await sendRequest(ws, "chat.send", { message: "interleaved" });
        await done;
      }

      // Re-request with the same cursor — should still get the older batch,
      // no overlap with the previously loaded pair, no drift from new arrivals.
      const older = (await sendRequest(ws, "session.history", {
        sessionKey: "hist:stable",
        limit: 100,
        beforeIndex: cursor,
      })).payload as any;
      expect(older.messages.every((m: any) => m.index < cursor)).toBe(true);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });

  test("session.history hasMore=false when all messages fit in one page", async () => {
    const { server: srv } = setupGateway(createTextProvider("ok"));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "hist:small");
      const done = waitForEvent(ws, "agent.done");
      await sendRequest(ws, "chat.send", { message: "hi" });
      await done;

      const res = (await sendRequest(ws, "session.history", {
        sessionKey: "hist:small",
        limit: 100,
        offset: 0,
      })).payload as any;
      expect(res.hasMore).toBe(false);
      expect(res.total).toBe(res.messages.length);

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });
});

// =============================================================================
// Corruption recovery (replaces old "Session persistence — corruption recovery")
// =============================================================================

describe("Gateway session persistence — corruption recovery", () => {
  test("gateway handles corrupted session file gracefully", async () => {
    // Pre-create a corrupted session file with the deterministic name
    const sessionFile = join(testDir, "web", "corrupt-test.jsonl");
    mkdirSync(join(testDir, "web"), { recursive: true });
    const header = JSON.stringify({
      type: "session", version: 1, id: "web/corrupt-test",
      model: "mock", working_directory: "/tmp",
      created_at: new Date().toISOString(),
    });
    const validMsg = JSON.stringify({
      type: "message", timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: new Date().toISOString() },
    });
    // Write header + valid message + corrupted line
    writeFileSync(sessionFile, `${header}\n${validMsg}\n{corrupted json\n`, "utf-8");

    // Start gateway — should load session despite corruption
    const { server: srv } = setupGateway(createTextProvider("Recovered."));
    const port = getTestPort();
    srv.start(port);

    try {
      const ws = await connectAndHandshake(port, "web:corrupt-test");
      await sendRequest(ws, "session.resolve", { sessionKey: "web:corrupt-test" });

      // History should have the valid message (corrupted line skipped)
      const histRes = await sendRequest(ws, "session.history", { sessionKey: "web:corrupt-test" });
      expect(histRes.ok).toBe(true);
      expect((histRes.payload as any).total).toBeGreaterThanOrEqual(1);

      // Should still be able to chat
      const done = waitForEvent(ws, "agent.done");
      await sendRequest(ws, "chat.send", { message: "after corruption" });
      await done;

      ws.close();
    } finally {
      await srv.stop(1000);
    }
  });
});
