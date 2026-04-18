// =============================================================================
// Tests: Session Management Integration
//
// End-to-end lifecycle: create → rename → pin → archive → unarchive → delete.
// Tests the full pipeline: storage → gateway RPCs → meta.json persistence.
// Uses mock server (no real WebSocket) for speed and reliability.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  setSessionsDir,
  resetSessionsDir,
  loadSessionMeta,
  listSessions,
} from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { setCronServiceRef } from "../src/tools/cron.js";

// =============================================================================
// Mock server (same pattern as test-session-rpc.ts)
// =============================================================================

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: any, params: any) {
      const method = methods[name];
      if (!method) throw new Error(`Method not found: ${name}`);
      return method(conn, params, this);
    },
    methods,
    broadcast() {},
    broadcastToSession() {},
    getConnections() { return new Map(); },
  };
}

// =============================================================================
// Setup
// =============================================================================

let testDir: string;
let sessionsDir: string;
let server: ReturnType<typeof makeMockServer>;
let sessions: AgentSessionManager;
const mockConn = { sessionKey: null, workingDirectory: "/tmp", bindSession() {} };

function createSession(key: string, messages = 3): void {
  const sessionId = key.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  const sm = new SessionManager(sessionId, sessionsDir);
  sm.initSession("test-model", "/tmp");
  for (let i = 0; i < messages; i++) {
    sm.appendMessage({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `msg-${i}` }],
    });
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-mgmt-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionsDir = join(testDir, "sessions");
  const wsDir = join(testDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  setWorkspaceDir(wsDir);
  writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n");

  server = makeMockServer();
  const mockProvider = {
    async *stream() { yield { type: "message_stop" as const }; },
  };
  sessions = new AgentSessionManager({
    provider: mockProvider as any,
    config: { model: "test", api_key: "test" } as any,
    workingDirectory: "/tmp",
    server: server as any,
  });
  registerAgentMethods(server as any, sessions, { model: "test", api_key: "test" } as any);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// Full lifecycle tests
// =============================================================================

describe("session management lifecycle", () => {
  test("create → rename → verify in list", () => {
    createSession("web:project", 5);

    // Rename
    server.call("session.rename", mockConn, { sessionKey: "web:project", displayName: "My Project" });

    // Verify in list
    const result = server.call("session.list", mockConn, { limit: 10 });
    const session = result.sessions.find((s: any) => s.id === "web/project");
    expect(session).toBeDefined();
    expect(session.displayName).toBe("My Project");
    expect(session.messageCount).toBe(5);
  });

  test("create → pin → verify sort order in list", () => {
    createSession("web:alpha", 1);
    createSession("web:beta", 10); // More messages, normally sorted first

    server.call("session.pin", mockConn, { sessionKey: "web:alpha" });

    const result = server.call("session.list", mockConn, { limit: 10 });
    // Both sessions should be visible
    expect(result.sessions.length).toBe(2);
    // Alpha should have pinned=true
    const alpha = result.sessions.find((s: any) => s.id === "web/alpha");
    expect(alpha.pinned).toBe(true);
  });

  test("create → archive → hidden from list → unarchive → visible again", () => {
    createSession("web:temp", 2);
    createSession("web:keep", 2);

    // Archive
    server.call("session.archive", mockConn, { sessionKey: "web:temp" });

    // Hidden from default list
    const hidden = server.call("session.list", mockConn, { limit: 10 });
    expect(hidden.sessions.length).toBe(1);
    expect(hidden.sessions[0].id).toBe("web/keep");

    // Visible when includeArchived
    const all = server.call("session.list", mockConn, { limit: 10, includeArchived: true });
    expect(all.sessions.length).toBe(2);

    // JSONL file preserved
    expect(existsSync(join(sessionsDir, "web", "temp.jsonl"))).toBe(true);

    // Unarchive
    server.call("session.unarchive", mockConn, { sessionKey: "web:temp" });

    // Visible again
    const restored = server.call("session.list", mockConn, { limit: 10 });
    expect(restored.sessions.length).toBe(2);
  });

  test("create → delete → JSONL gone + meta cleaned", () => {
    createSession("web:trash", 2);
    server.call("session.rename", mockConn, { sessionKey: "web:trash", displayName: "Trash" });
    server.call("session.pin", mockConn, { sessionKey: "web:trash" });

    // Verify file exists
    expect(existsSync(join(sessionsDir, "web", "trash.jsonl"))).toBe(true);

    // Delete
    server.call("session.delete", mockConn, { sessionKey: "web:trash" });

    // JSONL gone
    expect(existsSync(join(sessionsDir, "web", "trash.jsonl"))).toBe(false);

    // Meta cleaned
    const meta = loadSessionMeta();
    expect(meta["web:trash"]).toBeUndefined();

    // Not in list
    const result = server.call("session.list", mockConn, { limit: 10, includeArchived: true });
    expect(result.sessions.find((s: any) => s.id === "web/trash")).toBeUndefined();
  });

  test("full lifecycle: create → rename → pin → archive → unarchive → unpin → rename → delete", () => {
    createSession("web:lifecycle", 4);

    // Rename
    server.call("session.rename", mockConn, { sessionKey: "web:lifecycle", displayName: "Step 1" });
    let meta = loadSessionMeta();
    expect(meta["web:lifecycle"]?.displayName).toBe("Step 1");

    // Pin
    server.call("session.pin", mockConn, { sessionKey: "web:lifecycle" });
    meta = loadSessionMeta();
    expect(meta["web:lifecycle"]?.pinned).toBe(true);

    // Archive (while pinned)
    server.call("session.archive", mockConn, { sessionKey: "web:lifecycle" });
    meta = loadSessionMeta();
    expect(meta["web:lifecycle"]?.archived).toBe(true);
    expect(meta["web:lifecycle"]?.pinned).toBe(true); // Pin preserved

    // Unarchive
    server.call("session.unarchive", mockConn, { sessionKey: "web:lifecycle" });
    meta = loadSessionMeta();
    expect(meta["web:lifecycle"]?.archived).toBeUndefined();

    // Unpin
    server.call("session.unpin", mockConn, { sessionKey: "web:lifecycle" });
    meta = loadSessionMeta();
    expect(meta["web:lifecycle"]?.pinned).toBeUndefined();
    expect(meta["web:lifecycle"]?.displayName).toBe("Step 1"); // Name preserved

    // Rename again
    server.call("session.rename", mockConn, { sessionKey: "web:lifecycle", displayName: "Final" });
    meta = loadSessionMeta();
    expect(meta["web:lifecycle"]?.displayName).toBe("Final");

    // Delete
    server.call("session.delete", mockConn, { sessionKey: "web:lifecycle" });
    expect(existsSync(join(sessionsDir, "web", "lifecycle.jsonl"))).toBe(false);
    meta = loadSessionMeta();
    expect(meta["web:lifecycle"]).toBeUndefined();
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe("edge cases", () => {
  test("delete nonexistent session doesn't crash", () => {
    const result = server.call("session.delete", mockConn, { sessionKey: "web:ghost" });
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
  });

  test("rename without creating session first still saves meta", () => {
    server.call("session.rename", mockConn, { sessionKey: "web:future", displayName: "Planned" });
    const meta = loadSessionMeta();
    expect(meta["web:future"]?.displayName).toBe("Planned");
  });

  test("archive already-archived session is idempotent", () => {
    createSession("web:double", 1);
    server.call("session.archive", mockConn, { sessionKey: "web:double" });
    server.call("session.archive", mockConn, { sessionKey: "web:double" });
    const meta = loadSessionMeta();
    expect(meta["web:double"]?.archived).toBe(true);
  });

  test("pin already-pinned session is idempotent", () => {
    server.call("session.pin", mockConn, { sessionKey: "web:x" });
    server.call("session.pin", mockConn, { sessionKey: "web:x" });
    const meta = loadSessionMeta();
    expect(meta["web:x"]?.pinned).toBe(true);
  });

  test("multiple sessions: operations on one don't affect others", () => {
    createSession("web:a", 2);
    createSession("web:b", 2);
    createSession("web:c", 2);

    server.call("session.rename", mockConn, { sessionKey: "web:a", displayName: "AAA" });
    server.call("session.pin", mockConn, { sessionKey: "web:b" });
    server.call("session.archive", mockConn, { sessionKey: "web:c" });

    const meta = loadSessionMeta();
    expect(meta["web:a"]?.displayName).toBe("AAA");
    expect(meta["web:a"]?.pinned).toBeUndefined();
    expect(meta["web:b"]?.pinned).toBe(true);
    expect(meta["web:b"]?.displayName).toBeUndefined();
    expect(meta["web:c"]?.archived).toBe(true);
  });

  test("in-memory session evicted on delete", () => {
    createSession("web:live", 2);
    // Load into memory via getOrCreate
    sessions.getOrCreate("web:live");
    expect(sessions.has("web:live")).toBe(true);

    server.call("session.delete", mockConn, { sessionKey: "web:live" });
    expect(sessions.has("web:live")).toBe(false);
  });
});

// =============================================================================
// Deep rename (newKey)
// =============================================================================

describe("session.rename deep rename", () => {
  test("newKey moves JSONL and evicts in-memory session", () => {
    createSession("web:email-triage", 3);
    sessions.getOrCreate("web:email-triage");
    expect(sessions.has("web:email-triage")).toBe(true);
    expect(existsSync(join(sessionsDir, "web", "email-triage.jsonl"))).toBe(true);

    const result = server.call("session.rename", mockConn, {
      sessionKey: "web:email-triage",
      newKey: "web:message-triage",
    });
    expect(result.ok).toBe(true);
    expect(result.newKey).toBe("web:message-triage");

    expect(existsSync(join(sessionsDir, "web", "email-triage.jsonl"))).toBe(false);
    expect(existsSync(join(sessionsDir, "web", "message-triage.jsonl"))).toBe(true);
    expect(sessions.has("web:email-triage")).toBe(false);
  });

  test("newKey preserves non-displayName meta (pinned, archived)", () => {
    createSession("web:rename-me", 1);
    server.call("session.pin", mockConn, { sessionKey: "web:rename-me" });
    server.call("session.rename", mockConn, { sessionKey: "web:rename-me", displayName: "Old Label" });

    server.call("session.rename", mockConn, {
      sessionKey: "web:rename-me",
      newKey: "web:renamed",
    });

    const meta = loadSessionMeta();
    expect(meta["web:rename-me"]).toBeUndefined();
    expect(meta["web:renamed"]?.pinned).toBe(true);
    // displayName is dropped — the key is now the name.
    expect(meta["web:renamed"]?.displayName).toBeUndefined();
  });

  test("newKey rejects cross-prefix rename", () => {
    createSession("web:foo", 1);
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "web:foo", newKey: "tui:foo" }),
    ).toThrow(/same prefix/);
  });

  test("newKey rejects heartbeat and cron prefixes", () => {
    // No need to seed — prefix validation runs first.
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "heartbeat:main", newKey: "heartbeat:other" }),
    ).toThrow(/cannot be key-renamed/);
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "cron:abc", newKey: "cron:xyz" }),
    ).toThrow(/cannot be key-renamed/);
  });

  test("newKey rejects collision with existing session", () => {
    createSession("web:a", 1);
    createSession("web:b", 1);
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "web:a", newKey: "web:b" }),
    ).toThrow(/already exists/);
  });

  test("newKey rejects missing source session", () => {
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "web:ghost", newKey: "web:new" }),
    ).toThrow();
  });

  test("newKey rejects invalid suffix characters", () => {
    createSession("web:x", 1);
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "web:x", newKey: "web:has spaces" }),
    ).toThrow();
  });

  test("rename rolls back cron rebind when storage rename fails", () => {
    createSession("web:alpha", 2);
    createSession("web:beta", 2);

    const calls: Array<{ from: string; to: string }> = [];
    setCronServiceRef({
      rebindSessionKey(from: string, to: string) {
        calls.push({ from, to });
        return 1;
      },
    });

    // web:beta already exists, so storage rename throws "already exists".
    // Cron rebind runs first; we expect a rollback call reversing it.
    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "web:alpha", newKey: "web:beta" }),
    ).toThrow(/already exists/);

    expect(calls).toEqual([
      { from: "web:alpha", to: "web:beta" },
      { from: "web:beta", to: "web:alpha" },
    ]);
    // Storage untouched: both original files still exist.
    expect(existsSync(join(sessionsDir, "web", "alpha.jsonl"))).toBe(true);
    expect(existsSync(join(sessionsDir, "web", "beta.jsonl"))).toBe(true);

    setCronServiceRef(null);
  });

  test("rename aborts cleanly when cron rebind throws", () => {
    createSession("web:gamma", 2);
    setCronServiceRef({
      rebindSessionKey() {
        throw new Error("simulated cron I/O failure");
      },
    });

    expect(() =>
      server.call("session.rename", mockConn, { sessionKey: "web:gamma", newKey: "web:delta" }),
    ).toThrow(/cron rebind failed/);

    // Nothing moved, nothing evicted.
    expect(existsSync(join(sessionsDir, "web", "gamma.jsonl"))).toBe(true);
    expect(existsSync(join(sessionsDir, "web", "delta.jsonl"))).toBe(false);

    setCronServiceRef(null);
  });

  test("live connections bound to oldKey are rebound to newKey", () => {
    // Build an isolated server where getConnections actually returns a
    // connection the rename code can walk. The module-level mock returns
    // an empty map, which would hide this regression.
    const localServer = makeMockServer();
    const conn = {
      connId: "c1",
      sessionKey: null as string | null,
      workingDirectory: "/tmp",
      bindSession(k: string) { this.sessionKey = k; },
    };
    (localServer as any).getConnections = () => new Map([[conn.connId, conn]]);
    const localSessions = new AgentSessionManager({
      provider: { async *stream() { yield { type: "message_stop" as const }; } } as any,
      config: { model: "test", api_key: "test" } as any,
      workingDirectory: "/tmp",
      server: localServer as any,
    });
    registerAgentMethods(
      localServer as any,
      localSessions,
      { model: "test", api_key: "test" } as any,
    );

    createSession("web:bound", 2);
    conn.bindSession("web:bound");
    expect(conn.sessionKey).toBe("web:bound");

    localServer.call("session.rename", conn, {
      sessionKey: "web:bound",
      newKey: "web:rebound",
    });

    // Without the rebind, conn.sessionKey would still be "web:bound" and
    // any follow-up RPC defaulting to conn.sessionKey would recreate an
    // empty session on disk.
    expect(conn.sessionKey).toBe("web:rebound");
    expect(localSessions.has("web:bound")).toBe(false);
  });
});
