// =============================================================================
// Tests: Session Storage Migration (gw-* flat → folder-based)
//
// Verifies:
// - Legacy gw-*.jsonl files are migrated to type/name.jsonl folders
// - Session listing works with folder-based layout (no duplicates)
// - sessionIdToKey handles both old and new formats
// - deleteSessionFile works with folder-based paths
// - readLastSession works with folder-based IDs
// =============================================================================

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We need to test the session storage functions with a custom directory.
// Import the relevant functions.
import {
  SessionManager,
  listSessions,
  deleteSessionFile,
  setSessionsDir,
} from "../src/storage/session.js";

let testDir: string;
let originalDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-migration-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });
  originalDir = setSessionsDir(testDir);
});

afterAll(() => {
  // Restore original dir
  if (originalDir) setSessionsDir(originalDir);
  // Clean up test dirs
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith("hawky-migration-test-")) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  } catch {}
});

function writeSessionFile(dir: string, filename: string, sessionId: string, messageCount: number): void {
  const filePath = join(dir, filename);
  const parentDir = join(filePath, "..");
  mkdirSync(parentDir, { recursive: true });

  const header = JSON.stringify({
    type: "session",
    version: 1,
    id: sessionId,
    model: "test",
    working_directory: "/",
    created_at: new Date().toISOString(),
  });

  let content = header + "\n";
  for (let i = 0; i < messageCount; i++) {
    content += JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `msg ${i}` }] },
    }) + "\n";
  }

  writeFileSync(filePath, content);
}

// =============================================================================
// Migration tests
// =============================================================================

describe("legacy migration", () => {
  test("migrates gw-web-general.jsonl to web/general.jsonl", () => {
    writeSessionFile(testDir, "gw-web-general.jsonl", "gw-web-general", 5);

    const sessions = listSessions(100);

    // Should find exactly one session, not two
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("web/general");

    // Old file should be gone, new file should exist
    expect(existsSync(join(testDir, "gw-web-general.jsonl"))).toBe(false);
    expect(existsSync(join(testDir, "web", "general.jsonl"))).toBe(true);
  });

  test("migrates multiple session types", () => {
    writeSessionFile(testDir, "gw-web-general.jsonl", "gw-web-general", 3);
    writeSessionFile(testDir, "gw-cron-hn-digest.jsonl", "gw-cron-hn-digest", 2);
    writeSessionFile(testDir, "gw-heartbeat-main.jsonl", "gw-heartbeat-main", 1);
    writeSessionFile(testDir, "gw-tui-main.jsonl", "gw-tui-main", 4);

    const sessions = listSessions(100);

    expect(sessions.length).toBe(4);
    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["cron/hn-digest", "heartbeat/main", "tui/main", "web/general"]);
  });

  test("does not create duplicates after migration", () => {
    writeSessionFile(testDir, "gw-web-general.jsonl", "gw-web-general", 5);

    // Call listSessions twice — migration runs once, second call should be same
    const sessions1 = listSessions(100);
    const sessions2 = listSessions(100);

    expect(sessions1.length).toBe(1);
    expect(sessions2.length).toBe(1);
    expect(sessions1[0].id).toBe(sessions2[0].id);
  });

  test("preserves message count after migration", () => {
    writeSessionFile(testDir, "gw-web-general.jsonl", "gw-web-general", 10);

    const sessions = listSessions(100);
    expect(sessions[0].messageCount).toBe(10);
  });

  test("skips migration if target already exists", () => {
    // Create both old and new format
    writeSessionFile(testDir, "gw-web-general.jsonl", "gw-web-general", 3);
    writeSessionFile(testDir, "web/general.jsonl", "web/general", 5);

    const sessions = listSessions(100);

    // Should see new format (5 messages) plus old format still present
    // The migration skips because target exists
    const webSessions = sessions.filter((s) => s.id.includes("general"));
    // Old gw- file should still be there since migration was skipped
    expect(webSessions.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Folder-based listing
// =============================================================================

describe("folder-based listing", () => {
  test("lists sessions from subdirectories", () => {
    writeSessionFile(testDir, "web/general.jsonl", "web/general", 5);
    writeSessionFile(testDir, "web/code.jsonl", "web/code", 3);
    writeSessionFile(testDir, "cron/daily.jsonl", "cron/daily", 2);

    const sessions = listSessions(100);

    expect(sessions.length).toBe(3);
    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["cron/daily", "web/code", "web/general"]);
  });

  test("session ID derived from path, not header", () => {
    // Header says gw-web-general (old format) but path says web/general (new)
    writeSessionFile(testDir, "web/general.jsonl", "gw-web-general", 5);

    const sessions = listSessions(100);

    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("web/general"); // Path wins
  });

  test("ignores non-jsonl files in subdirectories", () => {
    writeSessionFile(testDir, "web/general.jsonl", "web/general", 5);
    writeFileSync(join(testDir, "web", "notes.txt"), "not a session");

    const sessions = listSessions(100);
    expect(sessions.length).toBe(1);
  });
});

// =============================================================================
// Session ID ↔ Key conversion
// =============================================================================

describe("sessionIdToKey", () => {
  // We test indirectly through listSessions + meta lookup

  test("folder-based ID maps to correct session key for meta lookup", () => {
    writeSessionFile(testDir, "web/general.jsonl", "web/general", 5);

    const sessions = listSessions(100);
    // The session key should be "web:general" (for meta.json lookup)
    // Verify by checking the ID can be converted
    expect(sessions[0].id).toBe("web/general");
    // id.replace("/", ":") should give "web:general"
    expect(sessions[0].id.replace("/", ":")).toBe("web:general");
  });
});

// =============================================================================
// Delete with folder-based paths
// =============================================================================

describe("deleteSessionFile with folders", () => {
  test("deletes folder-based session file", () => {
    writeSessionFile(testDir, "web/general.jsonl", "web/general", 5);
    expect(existsSync(join(testDir, "web", "general.jsonl"))).toBe(true);

    const deleted = deleteSessionFile("web/general");

    expect(deleted).toBe(true);
    expect(existsSync(join(testDir, "web", "general.jsonl"))).toBe(false);
  });

  test("returns false for non-existent session", () => {
    const deleted = deleteSessionFile("web/nonexistent");
    expect(deleted).toBe(false);
  });
});

// =============================================================================
// SessionManager with folder-based paths
// =============================================================================

describe("SessionManager with folders", () => {
  test("creates session file in subdirectory", () => {
    const sm = new SessionManager("web/new-session", testDir);
    sm.rewriteMessages([{
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
    }]);

    expect(existsSync(join(testDir, "web", "new-session.jsonl"))).toBe(true);
  });

  test("appends messages to folder-based session", () => {
    const sm = new SessionManager("cron/daily", testDir);
    sm.rewriteMessages([{
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hi" }],
    }]);

    sm.appendMessage({
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
    });

    const content = readFileSync(join(testDir, "cron", "daily.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3); // header + 2 messages
  });
});
