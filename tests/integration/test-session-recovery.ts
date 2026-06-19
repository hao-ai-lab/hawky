// =============================================================================
// Integration Tests: Session Recovery After Restart
//
// Tests the full pipeline: write session → "restart" → load → normalize → API
// Verifies that session persistence + normalization produce valid conversations.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  generateSessionId,
  setSessionsDir,
  resetSessionsDir,
  listSessions,
  writeLastSession,
  readLastSession,
} from "../../src/storage/session.js";
import { formatMessagesForApi } from "../../src/agent/context.js";
import { PermissionCache } from "../../src/agent/tool_executor.js";
import type { ChatMessage } from "../../src/agent/types.js";

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function userMsg(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: new Date().toISOString() };
}

function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: new Date().toISOString() };
}

function toolUseMsg(id: string, name: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
    timestamp: new Date().toISOString(),
  };
}

function toolResultMsg(toolUseId: string, content: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate Anthropic API format (same as normalize-pipeline tests).
 */
function validateAnthropicFormat(messages: ReturnType<typeof formatMessagesForApi>): string[] {
  const errors: string[] = [];
  if (messages.length === 0) return errors;

  if (messages[0].role !== "user") {
    errors.push(`first message role is "${messages[0].role}", expected "user"`);
  }

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      errors.push(`consecutive ${messages[i].role} at indices ${i - 1} and ${i}`);
    }
  }

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") toolUseIds.add((block as any).id);
      if (block.type === "tool_result") toolResultIds.add((block as any).tool_use_id);
    }
  }

  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) errors.push(`tool_use "${id}" has no matching tool_result`);
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) errors.push(`tool_result "${id}" has no matching tool_use`);
  }

  return errors;
}

// =============================================================================
// Write → Restart → Load → Normalize → Valid API format
// =============================================================================

describe("session recovery — write, reload, normalize", () => {
  test("simple conversation survives restart and produces valid API messages", () => {
    const id = generateSessionId();

    // Phase 1: write session
    const writer = new SessionManager(id);
    writer.initSession("claude-sonnet-4-6", "/tmp/work");
    writer.appendMessage(userMsg("hello"));
    writer.appendMessage(assistantMsg("hi there!"));
    writer.appendMessage(userMsg("how are you?"));
    writer.appendMessage(assistantMsg("I'm doing well"));

    // Phase 2: "restart" — new SessionManager reads from disk
    const reader = new SessionManager(id);
    const data = reader.loadSession();
    expect(data).not.toBeNull();
    expect(data!.messages).toHaveLength(4);

    // Phase 3: normalize and verify
    const apiMessages = formatMessagesForApi(data!.messages);
    const errors = validateAnthropicFormat(apiMessages);
    expect(errors).toEqual([]);
    expect(apiMessages).toHaveLength(4);
  });

  test("tool call conversation survives restart", () => {
    const id = generateSessionId();

    const writer = new SessionManager(id);
    writer.initSession("claude-sonnet-4-6", "/tmp");
    writer.appendMessage(userMsg("list files"));
    writer.appendMessage(toolUseMsg("tu_1", "bash"));
    writer.appendMessage(toolResultMsg("tu_1", "file1.txt\nfile2.txt"));
    writer.appendMessage(assistantMsg("Found 2 files"));
    writer.appendMessage(userMsg("read file1"));
    writer.appendMessage(toolUseMsg("tu_2", "read_file"));
    writer.appendMessage(toolResultMsg("tu_2", "content of file1"));
    writer.appendMessage(assistantMsg("Here's the content"));

    const reader = new SessionManager(id);
    const data = reader.loadSession()!;
    expect(data.messages).toHaveLength(8);

    const apiMessages = formatMessagesForApi(data.messages);
    const errors = validateAnthropicFormat(apiMessages);
    expect(errors).toEqual([]);
  });

  test("session with permission cache restores cache correctly", () => {
    const id = generateSessionId();

    const writer = new SessionManager(id);
    writer.initSession("claude-sonnet-4-6", "/tmp");
    writer.appendMessage(userMsg("do stuff"));
    writer.appendMessage(assistantMsg("ok"));

    // Save permission cache
    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_always");
    cache.recordDecision("write_file", "allow_always");
    writer.appendPermissionCache(cache.serialize());

    // Restart
    const reader = new SessionManager(id);
    const data = reader.loadSession()!;

    // Restore cache
    const restoredCache = new PermissionCache();
    expect(data.permissionCache).not.toBeNull();
    restoredCache.restore(data.permissionCache!);

    expect(restoredCache.isAutoApproved("bash", "ask_user")).toBe(true);
    expect(restoredCache.isAutoApproved("write_file", "ask_user")).toBe(true);
    expect(restoredCache.isAutoApproved("read_file", "ask_user")).toBe(false);
  });
});

// =============================================================================
// Corruption recovery → normalize → valid API format
// =============================================================================

describe("session recovery — corrupted files still produce valid API format", () => {
  test("corrupted line mid-session: skipped, remaining messages normalize", () => {
    const id = generateSessionId();
    const filePath = join(testDir, `${id}.jsonl`);

    const header = JSON.stringify({
      type: "session", version: 1, id, model: "test",
      working_directory: "/tmp", created_at: "2026-01-01",
    });
    const msg1 = JSON.stringify({ type: "message", timestamp: "t1", message: userMsg("hello") });
    const corrupted = "NOT VALID JSON {{{";
    const msg2 = JSON.stringify({ type: "message", timestamp: "t2", message: assistantMsg("hi") });

    writeFileSync(filePath, [header, msg1, corrupted, msg2].join("\n") + "\n");

    const reader = new SessionManager(id);
    const data = reader.loadSession()!;
    expect(data.messages).toHaveLength(2);

    const apiMessages = formatMessagesForApi(data.messages);
    const errors = validateAnthropicFormat(apiMessages);
    expect(errors).toEqual([]);
  });

  test("corrupted tool_result line: load-time repair inserts synthetic result", () => {
    const id = generateSessionId();
    const filePath = join(testDir, `${id}.jsonl`);

    const header = JSON.stringify({
      type: "session", version: 1, id, model: "test",
      working_directory: "/tmp", created_at: "2026-01-01",
    });
    const msg1 = JSON.stringify({ type: "message", timestamp: "t1", message: userMsg("run cmd") });
    const msg2 = JSON.stringify({ type: "message", timestamp: "t2", message: toolUseMsg("tu_1", "bash") });
    // The tool_result line is corrupted — lost to disk corruption
    const corrupted = "CORRUPT TOOL RESULT LINE";
    const msg3 = JSON.stringify({ type: "message", timestamp: "t3", message: userMsg("what happened?") });

    writeFileSync(filePath, [header, msg1, msg2, corrupted, msg3].join("\n") + "\n");

    const reader = new SessionManager(id);
    const data = reader.loadSession()!;
    // Four messages now: user + tool_use + synthetic tool_result (inserted by
    // the load-time repairOrphanedToolUses pass) + user prose. Previously
    // this was three because normalization deferred the synthesis to
    // formatMessagesForApi time; the repair now happens at load time so
    // every in-memory consumer sees a valid conversation, not just the
    // API formatter.
    expect(data.messages.length).toBe(4);
    // The third message should be the synthetic tool_result with the
    // matching tool_use_id and is_error: true.
    const repairBlocks = (data.messages[2].content as any[]).filter(
      (b) => b?.type === "tool_result",
    );
    expect(repairBlocks).toHaveLength(1);
    expect(repairBlocks[0].tool_use_id).toBe("tu_1");
    expect(repairBlocks[0].is_error).toBe(true);

    // And the API-formatted shape still validates (normalize is idempotent
    // over an already-valid history).
    const apiMessages = formatMessagesForApi(data.messages);
    const errors = validateAnthropicFormat(apiMessages);
    expect(errors).toEqual([]);
  });

  test("permission cache corruption: messages still load fine", () => {
    const id = generateSessionId();
    const filePath = join(testDir, `${id}.jsonl`);

    const header = JSON.stringify({
      type: "session", version: 1, id, model: "test",
      working_directory: "/tmp", created_at: "2026-01-01",
    });
    const msg1 = JSON.stringify({ type: "message", timestamp: "t1", message: userMsg("hi") });
    const msg2 = JSON.stringify({ type: "message", timestamp: "t2", message: assistantMsg("hello") });
    // Corrupted permission cache entry
    const corruptedCache = '{"type":"permission_cache","timestamp":"t3","data":';  // truncated JSON

    writeFileSync(filePath, [header, msg1, msg2, corruptedCache].join("\n") + "\n");

    const reader = new SessionManager(id);
    const data = reader.loadSession()!;
    expect(data.messages).toHaveLength(2);
    expect(data.permissionCache).toBeNull();  // corrupted cache discarded

    const apiMessages = formatMessagesForApi(data.messages);
    const errors = validateAnthropicFormat(apiMessages);
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// Multi-session isolation
// =============================================================================

describe("session recovery — multi-session isolation", () => {
  test("two sessions load independently with correct data", () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    const s1 = new SessionManager(id1);
    s1.initSession("model-a", "/work/project1");
    s1.appendMessage(userMsg("session 1 message"));
    s1.appendMessage(assistantMsg("s1 reply"));

    const s2 = new SessionManager(id2);
    s2.initSession("model-b", "/work/project2");
    s2.appendMessage(userMsg("session 2 message"));
    s2.appendMessage(assistantMsg("s2 reply"));

    // Load both
    const data1 = new SessionManager(id1).loadSession()!;
    const data2 = new SessionManager(id2).loadSession()!;

    expect(data1.header.model).toBe("model-a");
    expect(data2.header.model).toBe("model-b");
    expect((data1.messages[0].content[0] as any).text).toBe("session 1 message");
    expect((data2.messages[0].content[0] as any).text).toBe("session 2 message");

    // Both produce valid API messages
    expect(validateAnthropicFormat(formatMessagesForApi(data1.messages))).toEqual([]);
    expect(validateAnthropicFormat(formatMessagesForApi(data2.messages))).toEqual([]);
  });

  test("listSessions shows both sessions after restart", () => {
    const id1 = generateSessionId();
    const s1 = new SessionManager(id1);
    s1.initSession("test", "/tmp");
    s1.appendMessage(userMsg("a"));

    const id2 = generateSessionId();
    const s2 = new SessionManager(id2);
    s2.initSession("test", "/tmp");
    s2.appendMessage(userMsg("b"));
    s2.appendMessage(assistantMsg("c"));

    const sessions = listSessions();
    expect(sessions).toHaveLength(2);
    // Both should be findable
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  test("last-session marker points to most recent session after restart", () => {
    const id1 = generateSessionId();
    const s1 = new SessionManager(id1);
    s1.initSession("test", "/tmp");
    s1.appendMessage(userMsg("first session"));
    writeLastSession(id1);

    const id2 = generateSessionId();
    const s2 = new SessionManager(id2);
    s2.initSession("test", "/tmp");
    s2.appendMessage(userMsg("second session"));
    writeLastSession(id2);

    // After "restart", last session should be id2
    expect(readLastSession()).toBe(id2);

    // And we can load it
    const data = new SessionManager(id2).loadSession()!;
    expect((data.messages[0].content[0] as any).text).toBe("second session");
  });
});
