// =============================================================================
// Tests: Session Metadata (meta.json)
//
// Covers: loadSessionMeta, saveSessionMeta, updateSessionMeta,
//         deleteSessionMeta, deleteSessionFile, listSessions with meta
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  loadSessionMeta,
  saveSessionMeta,
  updateSessionMeta,
  deleteSessionMeta,
  deleteSessionFile,
  listSessions,
  renameSessionStorage,
  writeLastSession,
  readLastSession,
  sessionKeyToId,
  persistLastTurnUsage,
  setSessionsDir,
  resetSessionsDir,
  type SessionMetaStore,
} from "../src/storage/session.js";

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-meta-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function createTestSession(sessionId: string, messageCount = 0): void {
  const sm = new SessionManager(sessionId, testDir);
  sm.initSession("test-model", "/tmp/test");
  for (let i = 0; i < messageCount; i++) {
    sm.appendMessage({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Message ${i}` }],
    });
  }
}

// =============================================================================
// loadSessionMeta
// =============================================================================

describe("loadSessionMeta", () => {
  test("returns empty object when meta.json doesn't exist", () => {
    const meta = loadSessionMeta();
    expect(meta).toEqual({});
  });

  test("loads valid meta.json", () => {
    const data: SessionMetaStore = {
      "web:general": { displayName: "My Chat", pinned: true },
      "web:testing": { archived: true },
    };
    writeFileSync(join(testDir, "meta.json"), JSON.stringify(data));
    const meta = loadSessionMeta();
    expect(meta).toEqual(data);
  });

  test("returns empty object for corrupt meta.json", () => {
    writeFileSync(join(testDir, "meta.json"), "not valid json{{{");
    const meta = loadSessionMeta();
    expect(meta).toEqual({});
  });

  test("returns empty object for array meta.json", () => {
    writeFileSync(join(testDir, "meta.json"), "[]");
    const meta = loadSessionMeta();
    expect(meta).toEqual({});
  });

  test("returns empty object for null meta.json", () => {
    writeFileSync(join(testDir, "meta.json"), "null");
    const meta = loadSessionMeta();
    expect(meta).toEqual({});
  });
});

// =============================================================================
// saveSessionMeta
// =============================================================================

describe("saveSessionMeta", () => {
  test("writes meta.json with formatted JSON", () => {
    const data: SessionMetaStore = {
      "web:general": { displayName: "Test", pinned: true },
    };
    saveSessionMeta(data);
    const raw = readFileSync(join(testDir, "meta.json"), "utf-8");
    expect(raw).toContain('"displayName": "Test"');
    expect(raw).toContain('"pinned": true');
    // Ends with newline
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("overwrites existing meta.json", () => {
    saveSessionMeta({ "web:a": { displayName: "First" } });
    saveSessionMeta({ "web:b": { displayName: "Second" } });
    const meta = loadSessionMeta();
    expect(meta["web:a"]).toBeUndefined();
    expect(meta["web:b"]?.displayName).toBe("Second");
  });
});

// =============================================================================
// updateSessionMeta
// =============================================================================

describe("updateSessionMeta", () => {
  test("creates entry when none exists", () => {
    updateSessionMeta("web:test", { displayName: "My Session" });
    const meta = loadSessionMeta();
    expect(meta["web:test"]?.displayName).toBe("My Session");
  });

  test("merges with existing entry", () => {
    updateSessionMeta("web:test", { displayName: "Name" });
    updateSessionMeta("web:test", { pinned: true });
    const meta = loadSessionMeta();
    expect(meta["web:test"]).toEqual({ displayName: "Name", pinned: true });
  });

  test("removes entry when all fields are falsy", () => {
    updateSessionMeta("web:test", { displayName: "Name" });
    updateSessionMeta("web:test", { displayName: undefined });
    const meta = loadSessionMeta();
    expect(meta["web:test"]).toBeUndefined();
  });

  test("preserves other sessions when updating one", () => {
    updateSessionMeta("web:a", { displayName: "A" });
    updateSessionMeta("web:b", { displayName: "B" });
    updateSessionMeta("web:a", { pinned: true });
    const meta = loadSessionMeta();
    expect(meta["web:a"]?.displayName).toBe("A");
    expect(meta["web:b"]?.displayName).toBe("B");
  });

  test("clearing pinned keeps displayName", () => {
    updateSessionMeta("web:test", { displayName: "Keep", pinned: true });
    updateSessionMeta("web:test", { pinned: undefined });
    const meta = loadSessionMeta();
    expect(meta["web:test"]?.displayName).toBe("Keep");
    expect(meta["web:test"]?.pinned).toBeUndefined();
  });
});

// =============================================================================
// deleteSessionMeta
// =============================================================================

describe("deleteSessionMeta", () => {
  test("removes entry from meta.json", () => {
    updateSessionMeta("web:test", { displayName: "Gone" });
    deleteSessionMeta("web:test");
    const meta = loadSessionMeta();
    expect(meta["web:test"]).toBeUndefined();
  });

  test("no-op for nonexistent key", () => {
    updateSessionMeta("web:keep", { displayName: "Stay" });
    deleteSessionMeta("web:nonexistent");
    const meta = loadSessionMeta();
    expect(meta["web:keep"]?.displayName).toBe("Stay");
  });
});

// =============================================================================
// deleteSessionFile
// =============================================================================

describe("deleteSessionFile", () => {
  test("deletes existing session JSONL file", () => {
    createTestSession("test-delete", 2);
    expect(existsSync(join(testDir, "test-delete.jsonl"))).toBe(true);
    const result = deleteSessionFile("test-delete");
    expect(result).toBe(true);
    expect(existsSync(join(testDir, "test-delete.jsonl"))).toBe(false);
  });

  test("returns false for nonexistent file", () => {
    const result = deleteSessionFile("nonexistent");
    expect(result).toBe(false);
  });
});

// =============================================================================
// listSessions with meta integration
// =============================================================================

describe("listSessions with meta", () => {
  test("includes displayName and pinned from meta.json", () => {
    createTestSession("web/general", 3);
    updateSessionMeta("web:general", { displayName: "Main Chat", pinned: true });

    const sessions = listSessions(10);
    expect(sessions.length).toBe(1);
    expect(sessions[0].displayName).toBe("Main Chat");
    expect(sessions[0].pinned).toBe(true);
  });

  test("filters out archived sessions by default", () => {
    createTestSession("web/a", 2);
    createTestSession("web/b", 2);
    updateSessionMeta("web:a", { archived: true });

    const sessions = listSessions(10);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("web/b");
  });

  test("includes archived sessions when includeArchived=true", () => {
    createTestSession("web/a", 2);
    createTestSession("web/b", 2);
    updateSessionMeta("web:a", { archived: true });

    const sessions = listSessions(10, { includeArchived: true });
    expect(sessions.length).toBe(2);
    const archived = sessions.find((s) => s.id === "web/a");
    expect(archived?.archived).toBe(true);
  });

  test("sessions without meta have undefined displayName/pinned/archived", () => {
    createTestSession("web/plain", 1);
    const sessions = listSessions(10);
    expect(sessions.length).toBe(1);
    expect(sessions[0].displayName).toBeUndefined();
    expect(sessions[0].pinned).toBeUndefined();
    expect(sessions[0].archived).toBeUndefined();
  });

  test("respects limit after filtering archived", () => {
    for (let i = 0; i < 5; i++) {
      createTestSession(`web/s${i}`, 1);
    }
    updateSessionMeta("web:s0", { archived: true });
    updateSessionMeta("web:s1", { archived: true });

    const sessions = listSessions(2);
    expect(sessions.length).toBe(2);
    // None should be archived
    expect(sessions.every((s) => !s.archived)).toBe(true);
  });
});

// =============================================================================
// Per-session effort persistence
// =============================================================================

describe("Per-session effort persistence", () => {
  test("effort field saves and loads via updateSessionMeta", () => {
    updateSessionMeta("web:general", { effort: "max" });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.effort).toBe("max");
  });

  test("effort persists across save/load cycle", () => {
    updateSessionMeta("tui:main", { effort: "high" });
    // Simulate reload by reading from disk
    const meta = loadSessionMeta();
    expect(meta["tui:main"]?.effort).toBe("high");
  });

  test("effort can be cleared by setting undefined", () => {
    updateSessionMeta("web:test", { effort: "max" });
    expect(loadSessionMeta()["web:test"]?.effort).toBe("max");

    updateSessionMeta("web:test", { effort: undefined });
    const meta = loadSessionMeta();
    // Entry should be cleaned up entirely (no displayName, pinned, archived, or effort)
    expect(meta["web:test"]).toBeUndefined();
  });

  test("effort coexists with other meta fields", () => {
    updateSessionMeta("web:general", { displayName: "My Chat", effort: "low" });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.displayName).toBe("My Chat");
    expect(meta["web:general"]?.effort).toBe("low");
  });

  test("clearing effort preserves other meta fields", () => {
    updateSessionMeta("web:general", { displayName: "My Chat", effort: "max" });
    updateSessionMeta("web:general", { effort: undefined });
    const meta = loadSessionMeta();
    // displayName should still be there, effort gone
    expect(meta["web:general"]?.displayName).toBe("My Chat");
    expect(meta["web:general"]?.effort).toBeUndefined();
  });

  test("effort only accepts valid values", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      updateSessionMeta("web:test", { effort });
      expect(loadSessionMeta()["web:test"]?.effort).toBe(effort);
    }
  });
});

// =============================================================================
// renameSessionStorage
// =============================================================================

describe("renameSessionStorage", () => {
  function seedSession(key: string): string {
    const id = sessionKeyToId(key);
    const sm = new SessionManager(id);
    sm.initSession("test-model", "/tmp");
    return join(testDir, `${id}.jsonl`);
  }

  test("moves the JSONL file to the new key's path", () => {
    const oldPath = seedSession("web:email-triage");
    const newPath = join(testDir, "web", "message-triage.jsonl");

    expect(existsSync(oldPath)).toBe(true);
    renameSessionStorage("web:email-triage", "web:message-triage");

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  test("re-keys meta.json (dropping displayName)", () => {
    seedSession("web:email-triage");
    updateSessionMeta("web:email-triage", {
      displayName: "Email Triage",
      pinned: true,
    });

    renameSessionStorage("web:email-triage", "web:message-triage");

    const meta = loadSessionMeta();
    expect(meta["web:email-triage"]).toBeUndefined();
    // displayName is cleared — the key is now the name.
    expect(meta["web:message-triage"]?.displayName).toBeUndefined();
    expect(meta["web:message-triage"]?.pinned).toBe(true);
  });

  test("updates .last-session marker if it pointed at the renamed session", () => {
    seedSession("web:email-triage");
    writeLastSession(sessionKeyToId("web:email-triage"));

    renameSessionStorage("web:email-triage", "web:message-triage");

    expect(readLastSession()).toBe(sessionKeyToId("web:message-triage"));
  });

  test("leaves .last-session alone when it points at a different session", () => {
    seedSession("web:email-triage");
    seedSession("web:other");
    writeLastSession(sessionKeyToId("web:other"));

    renameSessionStorage("web:email-triage", "web:message-triage");

    expect(readLastSession()).toBe(sessionKeyToId("web:other"));
  });

  test("throws if the source session does not exist", () => {
    expect(() => renameSessionStorage("web:missing", "web:new")).toThrow();
  });

  test("throws if the target key already exists", () => {
    seedSession("web:a");
    seedSession("web:b");
    expect(() => renameSessionStorage("web:a", "web:b")).toThrow(/already exists/);
  });

  test("rejects cross-prefix renames", () => {
    seedSession("web:foo");
    expect(() => renameSessionStorage("web:foo", "tui:foo")).toThrow(/cross-prefix/);
  });

  test("rejects traversal in the target key before moving files", () => {
    const oldPath = seedSession("web:foo");
    const outsidePath = join(testDir, "..", "escape.jsonl");

    expect(() => renameSessionStorage("web:foo", "web:../escape")).toThrow(/invalid session id/);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(outsidePath)).toBe(false);
  });

  test("no-op for identical old and new keys", () => {
    const path = seedSession("web:unchanged");
    renameSessionStorage("web:unchanged", "web:unchanged");
    expect(existsSync(path)).toBe(true);
  });

  test("rolls back the file move if meta persistence fails", () => {
    const oldPath = seedSession("web:source");
    const newPath = join(testDir, "web", "target.jsonl");

    // Seed meta.json so loadSessionMeta returns a real entry (rollback branch
    // only triggers when saveSessionMeta is actually reached).
    const metaFile = join(testDir, "meta.json");
    writeFileSync(metaFile, JSON.stringify({ "web:source": { pinned: true } }) + "\n");

    // Make meta.json read-only so saveSessionMeta's writeFileSync throws
    // with EACCES. That exercises the rollback branch without racing or
    // filesystem-dependent kernel errors.
    chmodSync(metaFile, 0o400);

    try {
      expect(() => renameSessionStorage("web:source", "web:target")).toThrow();

      // After the throw, storage should be back where it started — otherwise
      // the caller's view of "rename failed" disagrees with on-disk state.
      expect(existsSync(oldPath)).toBe(true);
      expect(existsSync(newPath)).toBe(false);
    } finally {
      chmodSync(metaFile, 0o600);
    }
  });
});

// =============================================================================
// Last-turn usage persistence (drives sidebar ring + chat footer on cold load)
// =============================================================================

describe("Last-turn usage persistence", () => {
  test("lastContextUsagePercent round-trips", () => {
    updateSessionMeta("web:general", { lastContextUsagePercent: 42 });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.lastContextUsagePercent).toBe(42);
  });

  test("lastSessionTokens round-trips", () => {
    updateSessionMeta("web:general", { lastSessionTokens: { input: 1200, output: 340 } });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.lastSessionTokens).toEqual({ input: 1200, output: 340 });
  });

  test("lastSessionTokens round-trips cache buckets when present", () => {
    // After the prompt-caching audit, lastSessionTokens carries optional
    // cacheRead + cacheCreation so the footer/sidebar can show total input
    // (sum of all three input buckets) instead of only the fresh slice.
    updateSessionMeta("web:cache-rt", {
      lastSessionTokens: { input: 5000, output: 200, cacheRead: 50000, cacheCreation: 1000 },
    });
    const meta = loadSessionMeta();
    expect(meta["web:cache-rt"]?.lastSessionTokens).toEqual({
      input: 5000,
      output: 200,
      cacheRead: 50000,
      cacheCreation: 1000,
    });
  });

  test("lastSessionCostUSD round-trips", () => {
    updateSessionMeta("web:general", { lastSessionCostUSD: 0.0175 });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.lastSessionCostUSD).toBe(0.0175);
  });

  test("usage-only entry is not cleaned up", () => {
    // An entry that only has usage fields must survive the cleanup check
    // in updateSessionMeta — otherwise the ring would vanish right after
    // chat.send persists it.
    updateSessionMeta("web:usage-only", {
      lastContextUsagePercent: 55,
      lastSessionTokens: { input: 100, output: 50 },
      lastSessionCostUSD: 0.01,
    });
    const meta = loadSessionMeta();
    expect(meta["web:usage-only"]).toBeDefined();
    expect(meta["web:usage-only"]?.lastContextUsagePercent).toBe(55);
  });

  test("usage fields coexist with displayName + pinned", () => {
    updateSessionMeta("web:general", {
      displayName: "Main",
      pinned: true,
      lastContextUsagePercent: 73,
    });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.displayName).toBe("Main");
    expect(meta["web:general"]?.pinned).toBe(true);
    expect(meta["web:general"]?.lastContextUsagePercent).toBe(73);
  });

  test("listSessions exposes persisted usage fields", () => {
    createTestSession("web/general", 3);
    updateSessionMeta("web:general", {
      lastContextUsagePercent: 88,
      lastSessionTokens: { input: 50_000, output: 2_000 },
      lastSessionCostUSD: 0.42,
    });

    const sessions = listSessions(10);
    expect(sessions.length).toBe(1);
    expect(sessions[0].contextUsagePercent).toBe(88);
    expect(sessions[0].sessionTokens).toEqual({ input: 50_000, output: 2_000 });
    expect(sessions[0].sessionCostUSD).toBeCloseTo(0.42, 5);
  });

  test("listSessions leaves usage fields undefined when meta has none", () => {
    createTestSession("web/plain", 1);
    const sessions = listSessions(10);
    expect(sessions.length).toBe(1);
    expect(sessions[0].contextUsagePercent).toBeUndefined();
    expect(sessions[0].sessionTokens).toBeUndefined();
    expect(sessions[0].sessionCostUSD).toBeUndefined();
  });

  test("clearing usage fields on an otherwise-empty entry removes it", () => {
    updateSessionMeta("web:test", { lastContextUsagePercent: 40 });
    expect(loadSessionMeta()["web:test"]?.lastContextUsagePercent).toBe(40);
    updateSessionMeta("web:test", {
      lastContextUsagePercent: undefined,
      lastSessionTokens: undefined,
      lastSessionCostUSD: undefined,
    });
    const meta = loadSessionMeta();
    expect(meta["web:test"]).toBeUndefined();
  });
});

// =============================================================================
// persistLastTurnUsage — shared helper used by chat.send + triggerAgentTurn
// =============================================================================

describe("persistLastTurnUsage", () => {
  test("writes all three fields when provided", () => {
    persistLastTurnUsage("web:general", {
      contextUsagePercent: 55,
      inputTokens: 1200,
      outputTokens: 340,
      sessionCostUSD: 0.012,
    });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.lastContextUsagePercent).toBe(55);
    // Cache buckets default to 0 when the caller doesn't observe any cache
    // activity for the turn — that's accurate (0 cache reads / writes), and
    // gives downstream consumers a complete shape to sum without ?? 0
    // sprinkled at every read site.
    expect(meta["web:general"]?.lastSessionTokens).toEqual({ input: 1200, output: 340, cacheRead: 0, cacheCreation: 0 });
    expect(meta["web:general"]?.lastSessionCostUSD).toBeCloseTo(0.012, 5);
  });

  test("persists cache buckets when caching engaged on the turn", () => {
    persistLastTurnUsage("web:cache-on", {
      contextUsagePercent: 60,
      inputTokens: 5_000,
      outputTokens: 200,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 2_000,
      sessionCostUSD: 0.05,
    });
    const meta = loadSessionMeta();
    expect(meta["web:cache-on"]?.lastSessionTokens).toEqual({
      input: 5_000,
      output: 200,
      cacheRead: 50_000,
      cacheCreation: 2_000,
    });
  });

  test("persists contextUsagePercent=0 (valid short-turn observation)", () => {
    // A 1M-context model with ~1000 tokens rounds to 0%, which is a real
    // observation. Dropping it would keep a stale value on the ring/footer.
    updateSessionMeta("web:general", { lastContextUsagePercent: 40 });
    persistLastTurnUsage("web:general", { contextUsagePercent: 0 });
    expect(loadSessionMeta()["web:general"]?.lastContextUsagePercent).toBe(0);
  });

  test("persists sessionCostUSD=0 (valid fresh-session observation)", () => {
    updateSessionMeta("web:general", { lastSessionCostUSD: 0.5 });
    persistLastTurnUsage("web:general", { sessionCostUSD: 0 });
    expect(loadSessionMeta()["web:general"]?.lastSessionCostUSD).toBe(0);
  });

  test("null sessionCostUSD leaves prior value untouched", () => {
    updateSessionMeta("web:general", { lastSessionCostUSD: 0.5 });
    persistLastTurnUsage("web:general", { sessionCostUSD: null });
    expect(loadSessionMeta()["web:general"]?.lastSessionCostUSD).toBe(0.5);
  });

  test("persists tokens even when both are 0 (valid empty turn)", () => {
    // Tokens at 0 is meaningful — it means the turn ran with no usage.
    // The check only skips when ALL token fields are null/undefined.
    persistLastTurnUsage("web:general", { inputTokens: 0, outputTokens: 0 });
    expect(loadSessionMeta()["web:general"]?.lastSessionTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });

  test("no-op when all fields missing (does not create an empty entry)", () => {
    persistLastTurnUsage("web:general", {});
    expect(loadSessionMeta()["web:general"]).toBeUndefined();
  });

  test("merges with existing displayName/pinned without dropping them", () => {
    updateSessionMeta("web:general", { displayName: "Main", pinned: true });
    persistLastTurnUsage("web:general", {
      contextUsagePercent: 72,
      inputTokens: 10,
      outputTokens: 5,
      sessionCostUSD: 0.001,
    });
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.displayName).toBe("Main");
    expect(meta["web:general"]?.pinned).toBe(true);
    expect(meta["web:general"]?.lastContextUsagePercent).toBe(72);
  });

  test("clearing usage via updateSessionMeta wipes all three fields", () => {
    // Mirrors the shape used by session.clear — /new should reset the
    // ring + footer so the empty session doesn't show stale data.
    updateSessionMeta("web:reset", {
      displayName: "Keep me",
      lastContextUsagePercent: 80,
      lastSessionTokens: { input: 1000, output: 500 },
      lastSessionCostUSD: 0.05,
    });
    updateSessionMeta("web:reset", {
      effort: undefined,
      lastContextUsagePercent: undefined,
      lastSessionTokens: undefined,
      lastSessionCostUSD: undefined,
    });
    const entry = loadSessionMeta()["web:reset"];
    // displayName survives (the session still exists); usage fields are gone.
    expect(entry?.displayName).toBe("Keep me");
    expect(entry?.lastContextUsagePercent).toBeUndefined();
    expect(entry?.lastSessionTokens).toBeUndefined();
    expect(entry?.lastSessionCostUSD).toBeUndefined();
  });

  test("clearing usage on a usage-only entry removes it entirely", () => {
    updateSessionMeta("web:ephemeral", {
      lastContextUsagePercent: 30,
      lastSessionTokens: { input: 100, output: 50 },
      lastSessionCostUSD: 0.01,
    });
    updateSessionMeta("web:ephemeral", {
      effort: undefined,
      lastContextUsagePercent: undefined,
      lastSessionTokens: undefined,
      lastSessionCostUSD: undefined,
    });
    expect(loadSessionMeta()["web:ephemeral"]).toBeUndefined();
  });
});
