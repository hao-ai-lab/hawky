// =============================================================================
// Tests: Session Persistence (JSONL)
//
// Covers: SessionManager read/write/append, validation, corruption recovery,
//         permission cache persistence, last-session marker, session listing.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  generateSessionId,
  listSessions,
  writeLastSession,
  readLastSession,
  deleteSessionFile,
  validateMessages,
  setSessionsDir,
  resetSessionsDir,
  repairOrphanedToolUses,
} from "../src/storage/session.js";
import { PermissionCache } from "../src/agent/tool_executor.js";
import type { ChatMessage } from "../src/agent/types.js";
import type { PermissionCacheData } from "../src/agent/tool_executor.js";

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeMessage(role: "user" | "assistant", text: string): ChatMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  };
}

function makeToolUseMessage(toolId: string, toolName: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: toolId, name: toolName, input: {} }],
    timestamp: new Date().toISOString(),
  };
}

function makeToolResultMessage(toolId: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolId, content: "result" }],
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// generateSessionId
// =============================================================================

describe("generateSessionId", () => {
  test("generates UUID-like string", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

// =============================================================================
// SessionManager — write + read
// =============================================================================

describe("SessionManager — basic", () => {
  test("initSession creates JSONL file with header", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("claude-sonnet-4-6", "/tmp/work");

    expect(session.exists()).toBe(true);

    const data = session.loadSession();
    expect(data).not.toBeNull();
    expect(data!.header.id).toBe(id);
    expect(data!.header.model).toBe("claude-sonnet-4-6");
    expect(data!.header.working_directory).toBe("/tmp/work");
    expect(data!.header.version).toBe(1);
    expect(data!.messages).toHaveLength(0);
  });

  test("appendMessage adds messages that can be loaded", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("claude-sonnet-4-6", "/tmp");

    const msg1 = makeMessage("user", "hello");
    const msg2 = makeMessage("assistant", "hi there");
    session.appendMessage(msg1);
    session.appendMessage(msg2);

    const data = session.loadSession()!;
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe("user");
    expect((data.messages[0].content[0] as any).text).toBe("hello");
    expect(data.messages[1].role).toBe("assistant");
    expect((data.messages[1].content[0] as any).text).toBe("hi there");
  });

  test("appendMessage is truly append-only", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test-model", "/tmp");

    session.appendMessage(makeMessage("user", "first"));

    // Read raw file — should have 2 lines (header + message)
    const raw = readFileSync(session.getFilePath(), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);

    session.appendMessage(makeMessage("assistant", "second"));

    // Now 3 lines
    const raw2 = readFileSync(session.getFilePath(), "utf-8");
    const lines2 = raw2.trim().split("\n");
    expect(lines2).toHaveLength(3);
  });

  test("loadSession returns null for nonexistent file", () => {
    const session = new SessionManager("nonexistent-id");
    expect(session.loadSession()).toBeNull();
  });

  test("exists returns false for nonexistent file", () => {
    const session = new SessionManager("nonexistent-id");
    expect(session.exists()).toBe(false);
  });

  test("preserves tool_use and tool_result messages", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    session.appendMessage(makeMessage("user", "use tool"));
    session.appendMessage(makeToolUseMessage("tu_1", "bash"));
    session.appendMessage(makeToolResultMessage("tu_1"));
    session.appendMessage(makeMessage("assistant", "done"));

    const data = session.loadSession()!;
    expect(data.messages).toHaveLength(4);
    expect(data.messages[1].content[0].type).toBe("tool_use");
    expect(data.messages[2].content[0].type).toBe("tool_result");
  });
});

describe("SessionManager — path containment", () => {
  test("rejects session ids that would escape the sessions directory", () => {
    const invalidIds = [
      "../escape",
      "web/../escape",
      "/tmp/escape",
      "web//escape",
      "web/./escape",
      "web\\escape",
    ];

    for (const id of invalidIds) {
      expect(() => new SessionManager(id, testDir)).toThrow(/invalid session id/);
    }
  });

  test("writeLastSession rejects traversal ids", () => {
    expect(() => writeLastSession("../escape")).toThrow(/invalid session id/);
  });

  test("deleteSessionFile refuses traversal ids without touching outside files", () => {
    const outsideName = `outside-${generateSessionId()}`;
    const outsidePath = join(testDir, "..", `${outsideName}.jsonl`);
    writeFileSync(outsidePath, "keep", "utf-8");

    try {
      expect(deleteSessionFile(`../${outsideName}`)).toBe(false);
      expect(readFileSync(outsidePath, "utf-8")).toBe("keep");
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });
});

// =============================================================================
// Permission cache persistence
// =============================================================================

describe("SessionManager — permission cache", () => {
  test("appendPermissionCache and load", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    const cacheData: PermissionCacheData = {
      always_allowed: ["bash", "write_file"],
      allow_all: false,
    };
    session.appendPermissionCache(cacheData);

    const data = session.loadSession()!;
    expect(data.permissionCache).not.toBeNull();
    expect(data.permissionCache!.always_allowed).toEqual(["bash", "write_file"]);
    expect(data.permissionCache!.allow_all).toBe(false);
  });

  test("latest permission cache wins on multiple appends", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    session.appendPermissionCache({ always_allowed: ["bash"], allow_all: false });
    session.appendPermissionCache({ always_allowed: ["bash", "write_file"], allow_all: true });

    const data = session.loadSession()!;
    expect(data.permissionCache!.always_allowed).toEqual(["bash", "write_file"]);
    expect(data.permissionCache!.allow_all).toBe(true);
  });

  test("PermissionCache serialize/restore roundtrip", () => {
    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_always");
    cache.recordDecision("write_file", "allow_always");

    const serialized = cache.serialize();
    expect(serialized.always_allowed).toContain("bash");
    expect(serialized.always_allowed).toContain("write_file");
    expect(serialized.allow_all).toBe(false);

    const cache2 = new PermissionCache();
    cache2.restore(serialized);
    expect(cache2.isAutoApproved("bash", "ask_user")).toBe(true);
    expect(cache2.isAutoApproved("write_file", "ask_user")).toBe(true);
    expect(cache2.isAutoApproved("read_file", "ask_user")).toBe(false);
  });

  test("PermissionCache allow_all serialize/restore", () => {
    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_all");

    const serialized = cache.serialize();
    expect(serialized.allow_all).toBe(true);

    const cache2 = new PermissionCache();
    cache2.restore(serialized);
    expect(cache2.isAutoApproved("anything", "ask_user")).toBe(true);
  });

  test("PermissionCache hasEntries", () => {
    const cache = new PermissionCache();
    expect(cache.hasEntries()).toBe(false);

    cache.recordDecision("bash", "allow_always");
    expect(cache.hasEntries()).toBe(true);
  });
});

// =============================================================================
// Corruption recovery
// =============================================================================

describe("SessionManager — corruption recovery", () => {
  test("skips corrupted lines and loads valid ones", () => {
    const id = generateSessionId();
    const filePath = join(testDir, `${id}.jsonl`);

    // Write a file with a corrupted line in the middle
    const header = JSON.stringify({ type: "session", version: 1, id, model: "test", working_directory: "/tmp", created_at: "2026-01-01" });
    const msg1 = JSON.stringify({ type: "message", timestamp: "2026-01-01", message: makeMessage("user", "good1") });
    const corrupted = "this is not valid json{{{";
    const msg2 = JSON.stringify({ type: "message", timestamp: "2026-01-01", message: makeMessage("assistant", "good2") });

    writeFileSync(filePath, [header, msg1, corrupted, msg2].join("\n") + "\n");

    const session = new SessionManager(id);
    const data = session.loadSession()!;

    // Should load 2 valid messages, skip the corrupted line
    expect(data.messages).toHaveLength(2);
    expect((data.messages[0].content[0] as any).text).toBe("good1");
    expect((data.messages[1].content[0] as any).text).toBe("good2");
  });

  test("returns null for empty file", () => {
    const id = generateSessionId();
    const filePath = join(testDir, `${id}.jsonl`);
    writeFileSync(filePath, "");

    const session = new SessionManager(id);
    expect(session.loadSession()).toBeNull();
  });

  test("returns null for file with only corrupted lines", () => {
    const id = generateSessionId();
    const filePath = join(testDir, `${id}.jsonl`);
    writeFileSync(filePath, "bad line 1\nbad line 2\n");

    const session = new SessionManager(id);
    expect(session.loadSession()).toBeNull();
  });
});

// =============================================================================
// Last session marker
// =============================================================================

describe("Last session marker", () => {
  test("writeLastSession + readLastSession roundtrip", () => {
    const id = generateSessionId();
    // Create a session file so readLastSession verifies it exists
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    writeLastSession(id);
    expect(readLastSession()).toBe(id);
  });

  test("readLastSession returns null when no marker", () => {
    expect(readLastSession()).toBeNull();
  });

  test("readLastSession returns null when session file deleted", () => {
    const id = generateSessionId();
    writeLastSession(id);
    // Don't create the session file
    expect(readLastSession()).toBeNull();
  });

  test("last session marker written on first message (not on init)", () => {
    const id = generateSessionId();
    const session = new SessionManager(id);
    session.initSession("test", "/tmp");

    // Not written yet — no messages
    expect(readLastSession()).not.toBe(id);

    // Write a message — now marker should be written
    session.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: "2026-01-01" });
    expect(readLastSession()).toBe(id);
  });
});

// =============================================================================
// Session listing
// =============================================================================

describe("listSessions", () => {
  test("returns empty array when no sessions", () => {
    expect(listSessions()).toEqual([]);
  });

  test("lists sessions sorted by last modified", async () => {
    const id1 = generateSessionId();
    const s1 = new SessionManager(id1);
    s1.initSession("test", "/tmp");
    s1.appendMessage(makeMessage("user", "msg1"));

    // Ensure different mtime — filesystem resolution can be 1s on some CI runners
    await new Promise((r) => setTimeout(r, 1100));

    const id2 = generateSessionId();
    const s2 = new SessionManager(id2);
    s2.initSession("test", "/tmp");
    s2.appendMessage(makeMessage("user", "msg2"));
    s2.appendMessage(makeMessage("assistant", "reply2"));

    const sessions = listSessions();
    expect(sessions).toHaveLength(2);
    // Newest first
    expect(sessions[0].id).toBe(id2);
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[1].id).toBe(id1);
    expect(sessions[1].messageCount).toBe(1);
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      const id = generateSessionId();
      const s = new SessionManager(id);
      s.initSession("test", "/tmp");
    }

    const sessions = listSessions(3);
    expect(sessions).toHaveLength(3);
  });
});

// =============================================================================
// validateMessages
// =============================================================================

describe("validateMessages", () => {
  test("empty messages returns empty", () => {
    expect(validateMessages([])).toEqual([]);
  });

  test("valid conversation passes through", () => {
    const msgs = [
      makeMessage("user", "hi"),
      makeMessage("assistant", "hello"),
      makeMessage("user", "bye"),
      makeMessage("assistant", "goodbye"),
    ];
    expect(validateMessages(msgs)).toHaveLength(4);
  });

  test("stops at consecutive assistant messages", () => {
    const msgs = [
      makeMessage("user", "hi"),
      makeMessage("assistant", "hello"),
      makeMessage("assistant", "oops"), // Invalid: two assistants in a row
      makeMessage("user", "bye"),
    ];
    expect(validateMessages(msgs)).toHaveLength(2);
  });

  test("allows consecutive user messages (tool_result pattern)", () => {
    const msgs = [
      makeMessage("user", "use tool"),
      makeToolUseMessage("tu_1", "bash"),
      makeToolResultMessage("tu_1"), // user role
      makeMessage("assistant", "done"),
    ];
    // tool_result is user role, so user→assistant→user→assistant is valid
    expect(validateMessages(msgs)).toHaveLength(4);
  });

  test("stops at message with empty content", () => {
    const msgs = [
      makeMessage("user", "hi"),
      { role: "assistant" as const, content: [], timestamp: "2026-01-01" },
      makeMessage("user", "bye"),
    ];
    expect(validateMessages(msgs)).toHaveLength(1);
  });

  test("stops at message with missing content", () => {
    const msgs = [
      makeMessage("user", "hi"),
      { role: "assistant" as const } as any,
    ];
    expect(validateMessages(msgs)).toHaveLength(1);
  });
});

// =============================================================================
// repairOrphanedToolUses — defense-in-depth for process-kill crashes that
// slipped past the in-loop try/catch in agent/loop.ts.
// =============================================================================

function makeAssistantWithToolUse(id: string, name = "bash"): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `calling ${name}` } as any,
      { type: "tool_use", id, name, input: {} } as any,
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeToolResult(id: string, content = "ok"): ChatMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content, is_error: false } as any,
    ],
    timestamp: new Date().toISOString(),
  };
}

describe("repairOrphanedToolUses", () => {
  test("no-op on a valid transcript", () => {
    const msgs: ChatMessage[] = [
      makeMessage("user", "hi"),
      makeAssistantWithToolUse("tu_1"),
      makeToolResult("tu_1"),
      makeMessage("assistant", "done"),
    ];
    const out = repairOrphanedToolUses(msgs);
    expect(out.length).toBe(msgs.length);
  });

  test("injects a synthetic tool_result when the tool_use is orphaned", () => {
    const msgs: ChatMessage[] = [
      makeMessage("user", "hi"),
      makeAssistantWithToolUse("tu_orphan"),
      // ← gateway crashed here; no tool_result follows
      makeMessage("user", "are you still there?"),
    ];
    const out = repairOrphanedToolUses(msgs);
    expect(out.length).toBe(msgs.length + 1);
    // The synthetic result lands immediately after the assistant message.
    const synthetic = out[2];
    expect(synthetic.role).toBe("user");
    const block = (synthetic.content as any[])[0];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("tu_orphan");
    expect(block.is_error).toBe(true);
  });

  test("repairs only the missing ids in a multi-tool_use turn (merge into existing partial user message)", () => {
    const assistant: ChatMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_a", name: "bash", input: {} } as any,
        { type: "tool_use", id: "tu_b", name: "bash", input: {} } as any,
      ],
      timestamp: new Date().toISOString(),
    };
    const partialResults: ChatMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_a", content: "ok", is_error: false } as any,
        // tu_b is missing
      ],
      timestamp: new Date().toISOString(),
    };
    const out = repairOrphanedToolUses([assistant, partialResults]);
    // The partial message is extended in place — length stays the same
    // (no new message inserted), but the existing user message now covers
    // both ids.
    expect(out.length).toBe(2);
    const merged = out[1];
    const ids = (merged.content as any[])
      .filter((b) => b?.type === "tool_result")
      .map((b) => b.tool_use_id);
    expect(ids).toEqual(["tu_a", "tu_b"]);
    // And the synthetic result for tu_b is marked as an error.
    const syntheticB = (merged.content as any[]).find((b) => b?.tool_use_id === "tu_b");
    expect(syntheticB.is_error).toBe(true);
    // Sanity: the original input wasn't mutated.
    expect((partialResults.content as any[]).length).toBe(1);
  });

  test("treats ALL consecutive user tool_result messages as potential fulfillers", () => {
    // The agent could theoretically interleave multiple user tool_result
    // messages (though it currently doesn't). We collect every block of
    // consecutive user messages until we hit one containing prose.
    const msgs: ChatMessage[] = [
      makeAssistantWithToolUse("tu_1"),
      makeToolResult("tu_1"),
      // ← next user message is prose, so we stop scanning here
      makeMessage("user", "talk to me"),
    ];
    const out = repairOrphanedToolUses(msgs);
    expect(out.length).toBe(msgs.length);
  });

  test("tolerates malformed messages whose content is not an array", () => {
    // Regression: a JSONL entry with `content` that is null, undefined, a
    // string, or an object used to cause the repair pass to throw during
    // load, taking the whole session down. We now skip those messages.
    const bad1 = { role: "user", content: null } as any;
    const bad2 = { role: "assistant", content: undefined } as any;
    const bad3 = { role: "user", content: "a plain string" } as any;
    const bad4 = { role: "assistant", content: { nope: "obj" } } as any;
    const msgs: ChatMessage[] = [
      makeMessage("user", "hi"),
      bad1,
      bad2,
      bad3,
      bad4,
      makeAssistantWithToolUse("tu_1"),
      makeToolResult("tu_1"),
    ];
    // Must not throw, must leave the valid pair intact, must not add
    // a spurious repair for the malformed assistant (no tool_use blocks).
    let out: ChatMessage[] = [];
    expect(() => { out = repairOrphanedToolUses(msgs); }).not.toThrow();
    expect(out.length).toBe(msgs.length);
  });
});

describe("SessionManager.loadSession — repairs orphaned tool_use at load time", () => {
  test("orphaned tool_use in JSONL → repaired in returned messages", () => {
    const sid = generateSessionId();
    const mgr = new SessionManager(sid);
    mgr.initSession("claude-sonnet-4-6", "/tmp");

    // Write an assistant(tool_use) with no matching tool_result — the exact
    // JSONL shape we saw in the email-triage incident.
    mgr.appendMessage(makeMessage("user", "do the thing"));
    mgr.appendMessage(makeAssistantWithToolUse("tu_crashed"));
    // Simulate gateway crash: do NOT append the tool_result.
    // Also simulate a new user prompt arriving AFTER the crash:
    mgr.appendMessage(makeMessage("user", "are you still there?"));

    // Fresh SessionManager to force a real read from disk
    const loader = new SessionManager(sid);
    const data = loader.loadSession();
    expect(data).not.toBeNull();
    const history = data!.messages;

    // The loader should have injected a synthetic tool_result for tu_crashed.
    const hasRepair = history.some((m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      (m.content as any[]).some(
        (b) => b?.type === "tool_result" && b.tool_use_id === "tu_crashed" && b.is_error === true,
      ),
    );
    expect(hasRepair).toBe(true);
  });
});
