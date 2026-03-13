// =============================================================================
// Tests: Agent-Initiated Turn
//
// Unit tests for triggerAgentTurn — the common execution pattern extracted
// from heartbeat and cron.
// =============================================================================

import { describe, test, expect, beforeAll } from "bun:test";
import { triggerAgentTurn, deliverToSession, sanitizeDeliveredText } from "../src/gateway/agent-turn.js";
import { CommandLane } from "../src/gateway/types.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";

// Must initialize lane concurrency before any executeInSession call
beforeAll(() => {
  applyDefaultLaneConcurrency();
});

// -----------------------------------------------------------------------------
// Mock factories
// -----------------------------------------------------------------------------

type SubscribeCallback = (event: any) => void;

function makeMockSession(opts?: {
  sendMessageFn?: (msg: string, o: any) => Promise<void>;
  initialHistory?: any[];
}) {
  const appendedMessages: any[] = [];
  const history: any[] = opts?.initialHistory ?? [];
  let subscriber: SubscribeCallback | null = null;

  return {
    sessionKey: "",
    createdAt: Date.now(),
    loop: {
      subscribe(fn: SubscribeCallback) {
        subscriber = fn;
        return () => { subscriber = null; };
      },
      async sendMessage(msg: string, o: any) {
        if (opts?.sendMessageFn) {
          await opts.sendMessageFn(msg, o);
          return;
        }
        // Simulate: push user message + assistant response to history
        history.push({ role: "user", content: msg });
        history.push({ role: "assistant", content: [{ type: "text", text: "Agent response" }] });
        // Emit text event for summary capture
        subscriber?.({ type: "text", content: "Agent response" });
        subscriber?.({ type: "done" });
      },
      getHistory() { return history; },
      setHistory() {},
    },
    registry: {},
    sessionManager: {
      appendMessage(msg: any) { appendedMessages.push(msg); },
      rewriteMessages() {},
    },
    _appendedMessages: appendedMessages,
    _emitEvent(event: any) { subscriber?.(event); },
  };
}

function makeMockSessionManager(session?: ReturnType<typeof makeMockSession>) {
  const mockSession = session ?? makeMockSession();
  return {
    getOrCreate(sessionKey: string) {
      mockSession.sessionKey = sessionKey;
      return mockSession;
    },
    _session: mockSession,
  };
}

function makeMockServer() {
  const sessionBroadcasts: Array<{ sessionKey: string; event: string; payload: any }> = [];
  return {
    broadcast() {},
    broadcastToSession(sessionKey: string, event: string, payload?: any) {
      sessionBroadcasts.push({ sessionKey, event, payload });
    },
    registerMethod() {},
    start() {},
    stop() { return Promise.resolve(); },
    getConnections() { return new Map(); },
    getConnectionCount() { return 0; },
    getPort() { return 4242; },
    getActiveSessionCount() { return 0; },
    setActiveSessionCounter() {},
    nodeRegistry: { listConnected: () => [] },
    _sessionBroadcasts: sessionBroadcasts,
  };
}

// -----------------------------------------------------------------------------
// Basic execution
// -----------------------------------------------------------------------------

describe("triggerAgentTurn", () => {
  test("creates session and runs agent turn", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    const result = await triggerAgentTurn(
      {
        sessionKey: "web:general",
        message: "Hello from test",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result.status).toBe("completed");
    expect(session.sessionKey).toBe("web:general");
  });

  test("passes message to sendMessage with headless=true by default", async () => {
    let capturedMsg = "";
    let capturedOpts: any = {};
    const session = makeMockSession({
      sendMessageFn: async (msg, o) => {
        capturedMsg = msg;
        capturedOpts = o;
      },
    });
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Run heartbeat tasks",
        lane: CommandLane.Main,
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(capturedMsg).toBe("Run heartbeat tasks");
    expect(capturedOpts.headless).toBe(true);
  });

  test("respects headless=false when specified", async () => {
    let capturedOpts: any = {};
    const session = makeMockSession({
      sendMessageFn: async (_msg, o) => { capturedOpts = o; },
    });
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
        headless: false,
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(capturedOpts.headless).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Summary capture
  // ---------------------------------------------------------------------------

  test("captures text events into summary", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    const result = await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result.summary).toBe("Agent response");
  });

  test("truncates summary at 500 chars", async () => {
    const longText = "x".repeat(600);
    const session = makeMockSession({
      sendMessageFn: async () => {
        // Emit a long text event via the subscriber
        (session as any)._emitEvent({ type: "text", content: longText });
      },
    });
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    const result = await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result.summary.length).toBe(503); // 500 + "..."
    expect(result.summary.endsWith("...")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // History persistence
  // ---------------------------------------------------------------------------

  test("persists new messages to disk", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    // sendMessage pushes 2 messages (user + assistant)
    expect(session._appendedMessages.length).toBe(2);
    expect(session._appendedMessages[0].role).toBe("user");
    expect(session._appendedMessages[1].role).toBe("assistant");
  });

  test("does not re-persist pre-existing history", async () => {
    const existingMsg = { role: "user", content: "old message" };
    const session = makeMockSession({ initialHistory: [existingMsg] });
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    // Only the 2 NEW messages are persisted, not the pre-existing one
    expect(session._appendedMessages.length).toBe(2);
    expect(session._appendedMessages[0].role).toBe("user");
  });

  // ---------------------------------------------------------------------------
  // Event broadcasting
  // ---------------------------------------------------------------------------

  test("broadcasts stream events to session", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    await triggerAgentTurn(
      {
        sessionKey: "web:general",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    // Should have broadcast text + done events
    const textBroadcasts = server._sessionBroadcasts.filter(
      (b) => b.event === "agent.text",
    );
    expect(textBroadcasts.length).toBeGreaterThanOrEqual(1);
    expect(textBroadcasts[0].sessionKey).toBe("web:general");
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("returns error status when sendMessage throws", async () => {
    const session = makeMockSession({
      sendMessageFn: async () => { throw new Error("API rate limit exceeded"); },
    });
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    const result = await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("API rate limit exceeded");
    expect(result.summary).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Duration tracking
  // ---------------------------------------------------------------------------

  test("tracks duration in milliseconds", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    const result = await triggerAgentTurn(
      {
        sessionKey: "test:session",
        message: "Hello",
        lane: CommandLane.Main,
        origin: "test",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

});

// =============================================================================
// deliverToSession — direct assistant message insertion (Approach B)
// =============================================================================

describe("deliverToSession", () => {
  test("inserts assistant message into existing session", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    // Mark session as existing
    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    const result = deliverToSession(
      {
        sessionKey: "web:general",
        text: "You have 3 urgent emails",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result).toBe(true);
    // Message should be persisted
    // Wait for lane-serialized delivery to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(session._appendedMessages.length).toBe(1);
    expect(session._appendedMessages[0].role).toBe("assistant");
    // Text includes formatted header + original content
    expect(session._appendedMessages[0].content[0].text).toContain("You have 3 urgent emails");
    expect(session._appendedMessages[0].content[0].text).toContain("**heartbeat**");
  });

  test("returns false for session that doesn't exist anywhere", () => {
    const sessions = {
      has: () => false,
      get: () => undefined,
      getOrCreate: () => ({}),
    };
    const server = makeMockServer();

    const result = deliverToSession(
      {
        sessionKey: "web:nonexistent-channel",
        text: "Hello",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    // Session doesn't exist in memory or on disk → skip
    expect(result).toBe(false);
  });

  test("succeeds for session that exists in memory", () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    // has() returns true = session is in memory
    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    const result = deliverToSession(
      {
        sessionKey: "web:general",
        text: "Heartbeat findings",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    expect(result).toBe(true);
  });

  test("broadcasts text and done events to WebSocket", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    deliverToSession(
      {
        sessionKey: "web:general",
        text: "Update from heartbeat",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    await new Promise((r) => setTimeout(r, 50));
    const textEvents = server._sessionBroadcasts.filter((b) => b.event === "agent.text");
    const doneEvents = server._sessionBroadcasts.filter((b) => b.event === "agent.done");
    expect(textEvents.length).toBe(1);
    expect(textEvents[0].payload.content).toContain("Update from heartbeat");
    expect(doneEvents.length).toBe(1);
  });

  test("updates in-memory history via setHistory", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();
    let historySet = false;
    session.loop.setHistory = () => { historySet = true; };

    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    deliverToSession(
      {
        sessionKey: "web:general",
        text: "Hello",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(historySet).toBe(true);
  });

  test("no fake user message — only assistant role", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();

    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    deliverToSession(
      {
        sessionKey: "web:general",
        text: "Heartbeat findings",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    await new Promise((r) => setTimeout(r, 50));
    // Only one message, and it's assistant — no user bubble
    expect(session._appendedMessages.length).toBe(1);
    expect(session._appendedMessages[0].role).toBe("assistant");
    // No user-role message anywhere
    const userMsgs = session._appendedMessages.filter((m: any) => m.role === "user");
    expect(userMsgs.length).toBe(0);
  });
});

// =============================================================================
// HeartbeatConfig delivery_target resolution
// =============================================================================

describe("HeartbeatConfig delivery_target", () => {
  const { HeartbeatService } = require("../src/gateway/heartbeat.js") as typeof import("../src/gateway/heartbeat.js");

  function makeHbConfig(overrides: Record<string, any> = {}) {
    return {
      api_keys: { anthropic: "test", brave_search: "", openai: "" },
      api_base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      max_iterations: 40,
      max_tool_result_chars: 30_000,
      workspace_dir: "/tmp",
      gateway_port: 4242,
      heartbeat: {
        enabled: true,
        interval_minutes: 30,
        keep_recent_messages: 8,
        active_hours: { start: "08:00", end: "22:00" },
        ...overrides,
      },
    } as any;
  }

  test("defaults to \"web:general\"", () => {
    const config = HeartbeatService.resolveConfig(makeHbConfig());
    expect(config.deliveryTarget).toBe("web:general");
  });

  test("respects explicit delivery_target from config", () => {
    const config = HeartbeatService.resolveConfig(
      makeHbConfig({ delivery_target: "web:project-x" }),
    );
    expect(config.deliveryTarget).toBe("web:project-x");
  });

  test("empty string disables proactive delivery", () => {
    const config = HeartbeatService.resolveConfig(
      makeHbConfig({ delivery_target: "" }),
    );
    expect(config.deliveryTarget).toBe("");
  });
});

// =============================================================================
// Cron delivery_target
// =============================================================================

describe("Cron delivery_target", () => {
  test("CronJob accepts delivery_target", () => {
    const job: Partial<import("../src/gateway/cron-store.js").CronJob> = {
      delivery_target: "web:general",
    };
    expect(job.delivery_target).toBe("web:general");
  });

  test("delivery_target defaults to undefined (no proactive delivery)", () => {
    const job: Partial<import("../src/gateway/cron-store.js").CronJob> = {};
    expect(job.delivery_target).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// sanitizeDeliveredText — strips <system-reminder> scratchpads the model
// sometimes emits as if they were private notes. They must never reach a
// user-visible channel or a push notification.
// -----------------------------------------------------------------------------

describe("sanitizeDeliveredText", () => {
  test("strips a single paired <system-reminder> block", () => {
    const input =
      "<system-reminder>Active task: writing SKILL.md. Keep output minimal.</system-reminder>\n\nIt's 9:00 PM.";
    expect(sanitizeDeliveredText(input)).toBe("It's 9:00 PM.");
  });

  test("strips multiple adjacent blocks independently", () => {
    const input =
      "<system-reminder>one</system-reminder>\nmiddle\n<system-reminder>two</system-reminder>\ntail";
    // The strip leaves the surrounding newlines intact — Markdown renders
    // runs of newlines identically to a single blank line, and we don't
    // want to mutate bytes when Slack / session history store them verbatim.
    const out = sanitizeDeliveredText(input);
    expect(out).toContain("middle");
    expect(out).toContain("tail");
    expect(out).not.toContain("system-reminder");
  });

  test("strips blocks that span multiple newlines", () => {
    const input =
      "<system-reminder>\nline A\nline B\n</system-reminder>\n\nreal body.";
    expect(sanitizeDeliveredText(input)).toBe("real body.");
  });

  test("case-insensitive match — also strips <System-Reminder>", () => {
    const input =
      "<System-Reminder>upper</System-Reminder>\ntail";
    expect(sanitizeDeliveredText(input)).toBe("tail");
  });

  test("also strips the underscore variant <system_reminder>", () => {
    const input = "<system_reminder>foo</system_reminder>\ntail";
    expect(sanitizeDeliveredText(input)).toBe("tail");
  });

  test("drops stray unpaired opening or closing tags", () => {
    const input = "<system-reminder>\nhello";
    expect(sanitizeDeliveredText(input)).toBe("hello");
    const input2 = "hello\n</system-reminder>";
    expect(sanitizeDeliveredText(input2)).toBe("hello");
  });

  test("preserves legitimate multi-newline runs — does NOT collapse \\n{3,}", () => {
    // Codex P2: cosmetically collapsing 3+ newlines mutated legitimate
    // heartbeat/cron output byte-for-byte even when no tag was stripped.
    // Markdown renders multiple blank lines identically to one anyway,
    // so we preserve exact bytes for Slack mirrors + session history.
    const input = "A\n\n\n\nB";
    expect(sanitizeDeliveredText(input)).toBe("A\n\n\n\nB");
  });

  test("leaves text without any tags untouched (aside from trim)", () => {
    expect(sanitizeDeliveredText("plain body")).toBe("plain body");
    expect(sanitizeDeliveredText("  padded  ")).toBe("padded");
  });

  test("empty or undefined-ish input returns empty string", () => {
    expect(sanitizeDeliveredText("")).toBe("");
    expect(sanitizeDeliveredText("   \n\n  ")).toBe("");
  });

  test("a stripped-only body becomes empty (never just whitespace)", () => {
    // The whole output was a scratchpad block — nothing meaningful to deliver.
    const input =
      "<system-reminder>just a note</system-reminder>";
    expect(sanitizeDeliveredText(input)).toBe("");
  });

  test("does not touch code blocks that don't contain the tag", () => {
    const input =
      "before\n```ts\nconst x = 1;\n```\nafter";
    expect(sanitizeDeliveredText(input)).toBe(input.trim());
  });

  test("preserves literal <system-reminder> inside a ``` code fence", () => {
    // Codex P2: a fenced code example showing the tag as literal content
    // (e.g. troubleshooting docs, log excerpts) must NOT be stripped.
    const input =
      "Example:\n```\n<system-reminder>\nActive task: foo\n</system-reminder>\n```\nend.";
    const out = sanitizeDeliveredText(input);
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("</system-reminder>");
    expect(out).toContain("Active task: foo");
  });

  test("preserves literal <system-reminder> inside a ~~~ code fence", () => {
    const input =
      "```\noutside ``` fence\n```\n~~~\n<system-reminder>inside ~~~</system-reminder>\n~~~\ndone.";
    // Second fence (tilde) should also preserve its content.
    const out = sanitizeDeliveredText(input);
    expect(out).toContain("<system-reminder>inside ~~~</system-reminder>");
  });

  test("strips tags outside a fence while preserving tags inside one", () => {
    const input =
      "<system-reminder>strip me</system-reminder>\n\n```\n<system-reminder>keep me</system-reminder>\n```\n<system-reminder>strip me too</system-reminder>";
    const out = sanitizeDeliveredText(input);
    expect(out).not.toContain("strip me");
    expect(out).toContain("keep me");
  });
});

// -----------------------------------------------------------------------------
// deliverToSession skip-empty behavior (Codex P2)
// -----------------------------------------------------------------------------

describe("deliverToSession skips empty bodies", () => {
  test("does not append a header-only message when body was entirely scratchpad", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();
    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    const result = deliverToSession(
      {
        sessionKey: "web:general",
        // Entire body is a <system-reminder> block — after scrubbing nothing
        // user-visible remains. Skipping prevents a blank "♡ heartbeat — 09:00 PM"
        // row showing up with no body.
        text: "<system-reminder>private note only</system-reminder>",
        origin: "heartbeat",
      },
      { sessions: sessions as any, server: server as any },
    );

    // deliverToSession still reports "accepted" (true) because the target
    // session exists — the empty-body skip is an internal decision once
    // we're inside the lane. But no message should actually land.
    expect(result).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(session._appendedMessages.length).toBe(0);
  });

  test("does not append when input is whitespace-only", async () => {
    const session = makeMockSession();
    const sessions = makeMockSessionManager(session);
    const server = makeMockServer();
    (sessions as any).has = () => true;
    (sessions as any).get = () => session;

    deliverToSession(
      { sessionKey: "web:general", text: "   \n\n\t", origin: "heartbeat" },
      { sessions: sessions as any, server: server as any },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(session._appendedMessages.length).toBe(0);
  });
});
