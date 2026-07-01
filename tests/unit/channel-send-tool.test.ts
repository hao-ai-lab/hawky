// =============================================================================
// channel.send tool — unit tests.
//
// Scope:
//   - invalid `to` → error
//   - missing text → error
//   - no deps injected → error
//   - happy path appends to target session
//   - trigger_run enqueues a lane run on the target session
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  executeChannelSend,
  setChannelSendDeps,
  resetChannelSendDeps,
} from "../../src/tools/channel_send.js";
import type { ToolContext } from "../../src/agent/types.js";

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

interface MockMessage {
  role: "user" | "assistant";
  content: any[];
  timestamp?: string;
}

class MockSessionManager {
  appended: MockMessage[] = [];
  appendMessage(m: MockMessage): void {
    this.appended.push(m);
  }
}

class MockLoop {
  private history: MockMessage[] = [];
  sendMessageCalls: string[] = [];
  getHistory(): MockMessage[] { return this.history; }
  setHistory(h: MockMessage[]): void { this.history = h; }
  async sendMessage(text: string, _opts?: unknown): Promise<void> {
    this.sendMessageCalls.push(text);
    // Mirror real AgentLoop: sendMessage appends a user message of its own.
    this.history = [
      ...this.history,
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "text", text: `acted on: ${text}` }] },
    ];
  }
}

class MockSessions {
  sessions = new Map<string, { loop: MockLoop; sessionManager: MockSessionManager }>();
  getOrCreate(key: string) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { loop: new MockLoop(), sessionManager: new MockSessionManager() };
      this.sessions.set(key, s);
    }
    return s;
  }
}

class MockServer {
  broadcasts: Array<{ event: string; payload: unknown }> = [];
  broadcast(event: string, payload: unknown): void {
    this.broadcasts.push({ event, payload });
  }
  broadcastToSession(): void {}
}

function makeCtx(): ToolContext {
  return {
    session_id: "test:source",
    working_directory: process.cwd(),
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("channel.send tool", () => {
  let sessions: MockSessions;
  let server: MockServer;

  beforeEach(() => {
    sessions = new MockSessions();
    server = new MockServer();
    setChannelSendDeps(sessions as any, server as any);
  });

  afterEach(() => {
    resetChannelSendDeps();
  });

  test("missing `to` returns an error", async () => {
    const result = await executeChannelSend({ to: "", text: "hello" }, makeCtx());
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("to");
  });

  test("missing `text` returns an error", async () => {
    const result = await executeChannelSend({ to: "web:general", text: "   " }, makeCtx());
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("text");
  });

  test("malformed session key returns an error", async () => {
    const result = await executeChannelSend({ to: "not-a-session-key", text: "hi" }, makeCtx());
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("Invalid session key");
  });

  test("no deps injected returns an error", async () => {
    resetChannelSendDeps();
    const result = await executeChannelSend({ to: "web:general", text: "hi" }, makeCtx());
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("not available");
  });

  test("happy path appends to target session", async () => {
    const result = await executeChannelSend(
      { to: "web:general", text: "actionable memo" },
      makeCtx(),
    );
    expect(result.type).toBe("text");
    const target = sessions.sessions.get("web:general");
    expect(target).toBeDefined();
    expect(target!.sessionManager.appended.length).toBe(1);
    expect(target!.sessionManager.appended[0].role).toBe("user");
    expect(target!.sessionManager.appended[0].content[0].text).toBe("actionable memo");
    // Loop in-memory history mirrors the persisted append.
    expect(target!.loop.getHistory().length).toBe(1);
    // And a session.updated broadcast was emitted.
    const updated = server.broadcasts.find((b) => b.event === "session.updated");
    expect(updated).toBeDefined();
    expect((updated!.payload as any).sessionKey).toBe("web:general");
  });

  test("trigger_run=true enqueues a lane run on the target session", async () => {
    const result = await executeChannelSend(
      { to: "web:general", text: "please act", trigger_run: true },
      makeCtx(),
    );
    expect(result.type).toBe("text");
    // Lane execution is async — give it a tick to drain.
    await new Promise((r) => setTimeout(r, 50));
    const target = sessions.sessions.get("web:general");
    expect(target).toBeDefined();
    expect(target!.loop.sendMessageCalls.length).toBe(1);
    expect(target!.loop.sendMessageCalls[0]).toBe("please act");
  });

  test("trigger_run persists generated messages without duplicating the user message", async () => {
    const result = await executeChannelSend(
      { to: "web:general", text: "please persist", trigger_run: true },
      makeCtx(),
    );
    expect(result.type).toBe("text");

    await new Promise((r) => setTimeout(r, 50));
    const target = sessions.sessions.get("web:general");
    expect(target).toBeDefined();
    expect(target!.sessionManager.appended.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(target!.sessionManager.appended[0].content[0].text).toBe("please persist");
    expect(target!.sessionManager.appended[1].content[0].text).toBe("acted on: please persist");
  });

  test("trigger_run=false does NOT run the loop", async () => {
    await executeChannelSend(
      { to: "web:general", text: "just queue", trigger_run: false },
      makeCtx(),
    );
    await new Promise((r) => setTimeout(r, 50));
    const target = sessions.sessions.get("web:general");
    expect(target!.loop.sendMessageCalls.length).toBe(0);
  });
});
