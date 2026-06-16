// =============================================================================
// Tests: voice-session read-only guards + chat-poster session-lane wrapping
//
//   #3  chat.send on a `voice:*` session must be rejected — these sessions
//       hold ASR-sourced user-role messages with no assistant replies
//       between them, so a real chat turn would break user/assistant
//       alternation at the Anthropic API.
//
//   #2  chat-poster mutates `session.loop.history` / `appendMessage` —
//       both operations must be serialized through the session lane so
//       concurrent asr.final events + concurrent chat turns don't race
//       on shared state.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionsDir, resetSessionsDir, SessionManager } from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetGatewayState } from "../src/gateway/server.js";
import { registerChatPoster } from "../src/consumers/chat-poster/index.js";
import { getBus, resetBus } from "../src/bus/index.js";
import type { AsrFinalEvent } from "../src/consumers/asr/events.js";

// -----------------------------------------------------------------------------
// Minimal mock gateway — just enough for registerAgentMethods + chat-poster.
// -----------------------------------------------------------------------------

function makeMockServer() {
  const methods: Record<string, Function> = {};
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const srv: any = {
    registerMethod(name: string, handler: Function) { methods[name] = handler; },
    call(name: string, conn: any, params: any) {
      return methods[name](conn, params, srv);
    },
    broadcast(event: string, payload: unknown) { broadcasts.push({ event, payload }); },
    broadcastToSession() {},
    getConnections() { return new Map(); },
  };
  return { srv, broadcasts, methods };
}

let testDir: string;
const mockConn = { connId: "conn-test", sessionKey: null, workingDirectory: "/tmp", bindSession() {} };

function createSessionFile(key: string, sessionsDir: string): void {
  const sessionId = key.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  const sm = new SessionManager(sessionId, sessionsDir);
  sm.initSession("test-model", "/tmp");
}

beforeEach(() => {
  resetGatewayState();
  resetBus();
  applyDefaultLaneConcurrency();
  testDir = join(tmpdir(), `hawky-voice-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sessionsDir = join(testDir, "sessions");
  const wsDir = join(testDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  setWorkspaceDir(wsDir);
  writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n");
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// #3 — chat.send guard on voice: sessions
// -----------------------------------------------------------------------------

describe("chat.send rejects voice:* sessions", () => {
  function makeSessions(srv: any) {
    const mockProvider = {
      async *stream() {
        yield { type: "message_start" as const, message_id: "m", model: "t", usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: "message_stop" as const };
      },
    };
    return new AgentSessionManager({
      provider: mockProvider as any,
      config: { model: "t", api_key: "t", max_tokens: 1, max_iterations: 1, max_tool_result_chars: 1 } as any,
      workingDirectory: "/tmp",
      server: srv,
    });
  }

  test("throws INVALID_REQUEST with a friendly message", async () => {
    const { srv } = makeMockServer();
    const sessions = makeSessions(srv);
    registerAgentMethods(srv, sessions, { model: "t", api_key: "t", max_tokens: 1, max_iterations: 1, max_tool_result_chars: 1 } as any);
    createSessionFile("voice:abcdef123456", join(testDir, "sessions"));

    let caught: any;
    try {
      await srv.call("chat.send", mockConn, { message: "hi", sessionKey: "voice:abcdef123456" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("INVALID_REQUEST");
    expect(String(caught.message)).toContain("voice:");
    expect(String(caught.message).toLowerCase()).toContain("read-only");
  });

  test("accepts regular session keys", async () => {
    const { srv } = makeMockServer();
    const sessions = makeSessions(srv);
    registerAgentMethods(srv, sessions, { model: "t", api_key: "t", max_tokens: 1, max_iterations: 1, max_tool_result_chars: 1 } as any);
    createSessionFile("web:general", join(testDir, "sessions"));

    let caught: any;
    try {
      await srv.call("chat.send", mockConn, { message: "hi", sessionKey: "web:general" });
    } catch (err) {
      caught = err;
    }
    if (caught) {
      expect(String(caught.message).toLowerCase()).not.toContain("read-only voice archive");
    }
  });
});

// -----------------------------------------------------------------------------
// #2 — chat-poster wraps its history mutation in the session lane
// -----------------------------------------------------------------------------

describe("chat-poster is session-lane serialized", () => {
  test("concurrent asr.final events produce correctly-ordered appends", async () => {
    const { srv, broadcasts } = makeMockServer();
    const mockProvider = {
      async *stream() {
        yield { type: "message_start" as const, message_id: "m", model: "t", usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: "message_stop" as const };
      },
    };
    const sessions = new AgentSessionManager({
      provider: mockProvider as any,
      config: { model: "t", api_key: "t", max_tokens: 1, max_iterations: 1, max_tool_result_chars: 1 } as any,
      workingDirectory: "/tmp",
      server: srv,
    });

    const unsub = registerChatPoster({
      sessions,
      server: srv,
      config: {
        enabled: true,
        session_id_override: "voice:test-lane",
        prefix: "🎙 ",
        include_confidence: false,
        // Disable defaults so the test text isn't dropped as silence.
        silence_denylist: [],
        min_confidence: 0,
        min_duration_ms: 0,
        // Force a flush per event so we observe two distinct lane operations.
        max_items: 1,
        debounce_ms: 1,
      },
    });

    createSessionFile("voice:test-lane", join(testDir, "sessions"));

    const mk = (id: string, text: string): AsrFinalEvent => ({
      media_id: id,
      backend: "mock",
      model: "mock-1",
      text,
      segments: [{ t0_ms: 0, t1_ms: 1000, text }],
      lang: "en",
      transcribe_wallclock_ms: 200,
      media_duration_ms: 1000,
      node_id: "test",
      captured_start_iso: new Date().toISOString(),
    });

    getBus().publish("asr.final", mk("m1", "hello one"));
    // Yield so the first event's max_items=1 flush fires before the second arrives.
    await new Promise((r) => setTimeout(r, 20));
    getBus().publish("asr.final", mk("m2", "hello two"));

    await new Promise((r) => setTimeout(r, 50));

    const session = sessions.getOrCreate("voice:test-lane");
    const history = session.loop.getHistory();
    expect(history.length).toBe(2);
    expect((history[0].content as any)[0].text).toContain("hello one");
    expect((history[1].content as any)[0].text).toContain("hello two");

    const updates = broadcasts.filter((b) => b.event === "session.updated");
    expect(updates.length).toBe(2);

    unsub();
  });
});
