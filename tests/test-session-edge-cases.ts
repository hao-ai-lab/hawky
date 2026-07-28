// =============================================================================
// Session Persistence — Edge Case Tests
//
// Tests for: concurrent appends, large sessions, special characters,
// permission cache edge cases, session file cleanup, multi-session isolation.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  generateSessionId,
  listSessions,
  writeLastSession,
  readLastSession,
  validateMessages,
  setSessionsDir,
  resetSessionsDir,
} from "../src/storage/session.js";
import { PermissionCache } from "../src/agent/tool_executor.js";
import type { ChatMessage } from "../src/agent/types.js";
import { historyToDisplay } from "../src/tui/utils/transcript_display.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: [{ type: "text", text }], timestamp: new Date().toISOString() };
}

// =============================================================================
// Large sessions
// =============================================================================

describe("Session — large conversations", () => {
  test("100-message conversation persists and loads correctly", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    for (let i = 0; i < 50; i++) {
      session.appendMessage(msg("user", `message ${i}`));
      session.appendMessage(msg("assistant", `reply ${i}`));
    }

    const data = session.loadSession()!;
    expect(data.messages).toHaveLength(100);
    expect((data.messages[0].content[0] as any).text).toBe("message 0");
    expect((data.messages[99].content[0] as any).text).toBe("reply 49");
  });

  test("100-message conversation converts to display messages", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(msg("user", `message ${i}`));
      messages.push(msg("assistant", `reply ${i}`));
    }
    const display = historyToDisplay(messages);
    expect(display).toHaveLength(100);
    expect(display[0].role).toBe("user");
    expect(display[99].role).toBe("assistant");
  });
});

// =============================================================================
// Special characters
// =============================================================================

describe("Session — special characters", () => {
  test("messages with newlines, quotes, unicode persist correctly", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    session.appendMessage(msg("user", 'He said "hello"\nAnd then left'));
    session.appendMessage(msg("assistant", "Reply with 日本語 and emoji 🎉"));

    const data = session.loadSession()!;
    expect((data.messages[0].content[0] as any).text).toBe('He said "hello"\nAnd then left');
    expect((data.messages[1].content[0] as any).text).toBe("Reply with 日本語 and emoji 🎉");
  });

  test("messages with backslashes and JSON-special chars", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    session.appendMessage(msg("user", 'path: C:\\Users\\test\\file.txt'));
    session.appendMessage(msg("assistant", '{"key": "value"}'));

    const data = session.loadSession()!;
    expect((data.messages[0].content[0] as any).text).toBe('path: C:\\Users\\test\\file.txt');
    expect((data.messages[1].content[0] as any).text).toBe('{"key": "value"}');
  });
});

// =============================================================================
// Multi-session isolation
// =============================================================================

describe("Session — multi-session isolation", () => {
  test("two sessions don't interfere with each other", () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const s1 = new SessionManager(id1);
    const s2 = new SessionManager(id2);

    s1.initSession("model-a", "/tmp/a");
    s2.initSession("model-b", "/tmp/b");

    s1.appendMessage(msg("user", "session 1 msg"));
    s2.appendMessage(msg("user", "session 2 msg"));

    const d1 = s1.loadSession()!;
    const d2 = s2.loadSession()!;

    expect(d1.header.model).toBe("model-a");
    expect(d2.header.model).toBe("model-b");
    expect(d1.messages).toHaveLength(1);
    expect(d2.messages).toHaveLength(1);
    expect((d1.messages[0].content[0] as any).text).toBe("session 1 msg");
    expect((d2.messages[0].content[0] as any).text).toBe("session 2 msg");
  });

  test("last-session marker tracks the most recent active session", () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const s1 = new SessionManager(id1);
    const s2 = new SessionManager(id2);

    s1.initSession("test", "/tmp");
    s1.appendMessage(msg("user", "first"));
    expect(readLastSession()).toBe(id1);

    s2.initSession("test", "/tmp");
    s2.appendMessage(msg("user", "second"));
    expect(readLastSession()).toBe(id2);
  });
});

// =============================================================================
// Permission cache edge cases
// =============================================================================

describe("Session — permission cache edge cases", () => {
  test("empty permission cache not persisted", () => {
    const cache = new PermissionCache();
    expect(cache.hasEntries()).toBe(false);
    expect(cache.serialize()).toEqual({ always_allowed: [], allow_all: false, allowed_commands: {}, mode: "default" });
  });

  test("restore with empty data resets cache", () => {
    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_always", { command: "ls" });
    expect(cache.isAutoApproved("bash", "ask_user", { command: "ls" })).toBe(true);

    cache.restore({ always_allowed: [], allow_all: false });
    expect(cache.isAutoApproved("bash", "ask_user", { command: "ls" })).toBe(false);
  });

  test("restore with partial data handles missing fields", () => {
    const cache = new PermissionCache();
    // Simulate loading data with missing fields (forward compat)
    cache.restore({ always_allowed: ["bash"] } as any);
    expect(cache.isAutoApproved("bash", "ask_user")).toBe(true);
    expect(cache.isAutoApproved("write_file", "ask_user")).toBe(false);
  });

  test("permission cache survives roundtrip through session file", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_always");
    cache.recordDecision("write_file", "allow_always");
    session.appendPermissionCache(cache.serialize());

    // Load and restore
    const data = session.loadSession()!;
    const cache2 = new PermissionCache();
    cache2.restore(data.permissionCache!);

    expect(cache2.isAutoApproved("bash", "ask_user")).toBe(true);
    expect(cache2.isAutoApproved("write_file", "ask_user")).toBe(true);
    expect(cache2.isAutoApproved("read_file", "ask_user")).toBe(false);
  });
});

// =============================================================================
// Validation edge cases
// =============================================================================

describe("validateMessages — edge cases", () => {
  test("single user message is valid", () => {
    expect(validateMessages([msg("user", "hello")])).toHaveLength(1);
  });

  test("single assistant message is valid", () => {
    expect(validateMessages([msg("assistant", "hi")])).toHaveLength(1);
  });

  test("user → user is valid (tool_result pattern)", () => {
    const msgs = [msg("user", "use tool"), msg("user", "tool result")];
    expect(validateMessages(msgs)).toHaveLength(2);
  });

  test("message with null content stops validation", () => {
    const msgs = [msg("user", "hi"), { role: "assistant" as const, content: null } as any];
    expect(validateMessages(msgs)).toHaveLength(1);
  });

  test("message with non-array content stops validation", () => {
    const msgs = [msg("user", "hi"), { role: "assistant" as const, content: "string" } as any];
    expect(validateMessages(msgs)).toHaveLength(1);
  });
});

// =============================================================================
// History display — edge cases
// =============================================================================

describe("historyToDisplay — edge cases", () => {
  test("tool_result without matching tool_use is ignored", () => {
    const messages: ChatMessage[] = [
      msg("user", "hi"),
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan_tu", content: "result" }],
        timestamp: "2026-01-01",
      },
      msg("assistant", "ok"),
    ];
    const display = historyToDisplay(messages);
    // user + assistant, tool_result without matching tool_use is silently skipped
    expect(display).toHaveLength(2);
    expect(display[0].role).toBe("user");
    expect(display[1].role).toBe("assistant");
  });

  test("assistant message with only tool_use (no text)", () => {
    const messages: ChatMessage[] = [
      msg("user", "do it"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } }],
        timestamp: "2026-01-01",
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file.txt" }],
        timestamp: "2026-01-01",
      },
    ];
    const display = historyToDisplay(messages);
    // user + tool (no assistant text block)
    expect(display).toHaveLength(2);
    expect(display[0].role).toBe("user");
    expect(display[1].role).toBe("tool");
    expect(display[1].toolData!.outputLines[0].content).toBe("file.txt");
  });

  test("tool_result with multi-line content splits into output lines", () => {
    const messages: ChatMessage[] = [
      msg("user", "run"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } }],
        timestamp: "2026-01-01",
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a.txt\nb.txt\nc.txt" }],
        timestamp: "2026-01-01",
      },
    ];
    const display = historyToDisplay(messages);
    const tool = display[1];
    expect(tool.toolData!.outputLines).toHaveLength(3);
    expect(tool.toolData!.outputLines[0].content).toBe("a.txt");
    expect(tool.toolData!.outputLines[2].content).toBe("c.txt");
  });

  test("denied tool_result shows error status", () => {
    const messages: ChatMessage[] = [
      msg("user", "delete"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "rm -rf /" } }],
        timestamp: "2026-01-01",
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Tool execution denied by user.", is_error: true }],
        timestamp: "2026-01-01",
      },
    ];
    const display = historyToDisplay(messages);
    const tool = display[1];
    expect(tool.toolData!.status).toBe("error");
    expect(tool.toolData!.isError).toBe(true);
  });

  test("empty content blocks are handled gracefully", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [], timestamp: "2026-01-01" },
      msg("assistant", "ok"),
    ];
    const display = historyToDisplay(messages);
    // Empty content user message produces no display, assistant does
    expect(display).toHaveLength(1);
    expect(display[0].role).toBe("assistant");
  });
});

// =============================================================================
// Session Manager — append after load
// =============================================================================

describe("Session — append after load", () => {
  test("can append messages after loading existing session", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");
    session.appendMessage(msg("user", "first"));
    session.appendMessage(msg("assistant", "reply"));

    // Create new SessionManager instance (simulating restart)
    const session2 = new SessionManager(id);
    const data = session2.loadSession()!;
    expect(data.messages).toHaveLength(2);

    // Append more messages
    session2.appendMessage(msg("user", "second"));
    session2.appendMessage(msg("assistant", "second reply"));

    // Verify all messages present
    const data2 = session2.loadSession()!;
    expect(data2.messages).toHaveLength(4);
    expect((data2.messages[2].content[0] as any).text).toBe("second");
  });

  test("can append permission cache after loading", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");
    session.appendPermissionCache({ always_allowed: ["bash"], allow_all: false });

    // New instance
    const session2 = new SessionManager(id);
    session2.loadSession();
    session2.appendPermissionCache({ always_allowed: ["bash", "write_file"], allow_all: false });

    // Latest cache wins
    const data = session2.loadSession()!;
    expect(data.permissionCache!.always_allowed).toEqual(["bash", "write_file"]);
  });
});
