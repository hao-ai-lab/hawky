// =============================================================================
// Test: Session Rewind
//
// Covers the rewindSession orchestrator and the summarizeSideEffects helper.
// The orchestrator coordinates seven+ invalidations across in-memory state,
// JSONL on disk, per-session caches, and derived indices — this test file
// pins the happy path and a few edge cases (wrong message role, out of
// bounds, no active session, orphaned sub-agent file cleanup).
//
// Run: bun test tests/test-rewind.ts
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rewindSession, summarizeSideEffects, userTurnIndexToMessageIndex } from "../src/gateway/rewind.js";
import type { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import type { GatewayServer } from "../src/gateway/server.js";
import type { ChatMessage } from "../src/agent/types.js";
import { SessionManager, updateSessionMeta, loadSessionMeta } from "../src/storage/session.js";
import { getTaskStore, deleteTaskStore } from "../src/tools/task_global.js";
import { drainCompletedAgents } from "../src/tools/agent.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-rewind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  };
}

function toolUseMsg(name: string, input: Record<string, unknown> = {}): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `calling ${name}` },
      { type: "tool_use", id: `tu_${name}_${Math.random().toString(36).slice(2, 6)}`, name, input } as any,
    ],
    timestamp: new Date().toISOString(),
  };
}

/** Build a stand-in AgentSession — enough surface for rewindSession. */
function stubSession(history: ChatMessage[], filePath: string) {
  const sm = new SessionManager("test-session", testDir);
  sm.rewriteMessages(history, "claude-opus-4-7");
  const loopState = { history: [...history], cancelled: false };
  const fakeLoop = {
    getHistory: () => [...loopState.history],
    setHistory: (m: ChatMessage[]) => { loopState.history = [...m]; },
    cancel: () => { loopState.cancelled = true; },
    // AgentLoop exposes a private config via indexed access in rewind.ts
    // for the JSONL header rewrite's model field. Stub it minimally.
    config: { model: "claude-opus-4-7" },
  };
  return {
    session: { loop: fakeLoop, sessionManager: sm, registry: null, createdAt: Date.now() } as any,
    loopState,
    filePath: sm.getFilePath(),
  };
}

function stubDeps(session: any, broadcasts: Array<{ event: string; payload: any }>) {
  const sessions = {
    // Both entry points delegate to the same stub; rewindSession uses
    // getOrCreate but other callers can use get() — mirror prod behavior.
    get: (_key: string) => session,
    getOrCreate: (_key: string) => session,
  } as unknown as AgentSessionManager;
  const server = {
    broadcastToSession: (_sessionKey: string, event: string, payload: any) => {
      broadcasts.push({ event, payload });
    },
  } as unknown as GatewayServer;
  return { sessions, server };
}

// -----------------------------------------------------------------------------
// summarizeSideEffects — pure unit tests (no I/O)
// -----------------------------------------------------------------------------

describe("summarizeSideEffects", () => {
  test("counts edit_file / write_file as filesModified", () => {
    const counts = summarizeSideEffects([
      toolUseMsg("edit_file", { file_path: "/a.ts" }),
      toolUseMsg("write_file", { file_path: "/b.ts" }),
    ]);
    expect(counts.filesModified).toBe(2);
    expect(counts.bashCommands).toBe(0);
  });

  test("counts bash / shell as bashCommands", () => {
    const counts = summarizeSideEffects([toolUseMsg("bash", { command: "ls" })]);
    expect(counts.bashCommands).toBe(1);
  });

  test("counts web_fetch and web_search as webRequests", () => {
    const counts = summarizeSideEffects([
      toolUseMsg("web_fetch", { url: "https://x" }),
      toolUseMsg("web_search", { query: "y" }),
    ]);
    expect(counts.webRequests).toBe(2);
  });

  test("only counts cron 'add' action, not status/list", () => {
    const counts = summarizeSideEffects([
      toolUseMsg("cron", { action: "add", name: "j1" }),
      toolUseMsg("cron", { action: "list" }),
      toolUseMsg("cron", { action: "status" }),
    ]);
    expect(counts.cronJobsCreated).toBe(1);
  });

  test("counts agent tool as subagentsSpawned", () => {
    const counts = summarizeSideEffects([toolUseMsg("agent", { prompt: "do x" })]);
    expect(counts.subagentsSpawned).toBe(1);
  });

  test("ignores user messages and plain text assistant turns", () => {
    const counts = summarizeSideEffects([
      msg("user", "hi"),
      msg("assistant", "hello"),
      msg("user", "ok"),
    ]);
    expect(counts).toEqual({
      filesModified: 0,
      bashCommands: 0,
      webRequests: 0,
      cronJobsCreated: 0,
      subagentsSpawned: 0,
    });
  });
});

// -----------------------------------------------------------------------------
// rewindSession — orchestrator integration tests
// -----------------------------------------------------------------------------

describe("rewindSession", () => {
  test("truncates history at the given user-message index", async () => {
    const history = [
      msg("user", "turn1"),
      msg("assistant", "reply1"),
      msg("user", "turn2"),
      msg("assistant", "reply2"),
      msg("user", "turn3"),
    ];
    const { session, loopState } = stubSession(history, "");
    const broadcasts: any[] = [];
    const deps = stubDeps(session, broadcasts);
    const result = await rewindSession(deps, "test:sess", 2);
    expect(loopState.history.length).toBe(2);
    expect((loopState.history[0].content[0] as any).text).toBe("turn1");
    expect(result.droppedCount).toBe(3);
  });

  test("rewrites the JSONL file to match the truncated history", async () => {
    const history = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];
    const { session, filePath } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await rewindSession(deps, "test:sess", 2);
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).toContain("u1");
    expect(raw).toContain("a1");
    expect(raw).not.toContain("u2");
    expect(raw).not.toContain("a2");
  });

  test("refuses to rewind to an assistant-role message", async () => {
    const history = [msg("user", "u1"), msg("assistant", "a1")];
    const { session } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await expect(rewindSession(deps, "test:sess", 1)).rejects.toThrow(
      /must be a user message/,
    );
  });

  test("refuses out-of-bounds index", async () => {
    const history = [msg("user", "u1"), msg("assistant", "a1")];
    const { session } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await expect(rewindSession(deps, "test:sess", 99)).rejects.toThrow(/out of bounds/);
    await expect(rewindSession(deps, "test:sess", -1)).rejects.toThrow(/out of bounds/);
  });

  test("hydrates sessions via getOrCreate (doesn't fail on persisted-but-inactive sessions)", async () => {
    // Codex P2: previously we only checked the in-memory session map. A
    // session that exists on disk but hasn't been warmed yet (right after
    // gateway restart, or the user picked an older chat from session.list)
    // should rewind successfully. We assert the orchestrator calls
    // `getOrCreate`, which hydrates from JSONL. If history really is empty
    // (no JSONL either), the bounds check below catches it with a clear
    // error — no separate "No active session" path needed.
    const history = [msg("user", "u1"), msg("assistant", "a1")];
    const { session } = stubSession(history, "");
    let getOrCreateCalled = false;
    let plainGetCalled = false;
    const deps = {
      sessions: {
        get: () => { plainGetCalled = true; return undefined; },
        getOrCreate: () => { getOrCreateCalled = true; return session; },
      } as unknown as AgentSessionManager,
      server: { broadcastToSession: () => {} } as unknown as GatewayServer,
    };
    await rewindSession(deps, "persisted:key", 0);
    expect(getOrCreateCalled).toBe(true);
    expect(plainGetCalled).toBe(false);
  });

  test("an empty session still gives a clean bounds error", async () => {
    // After getOrCreate hydration, a truly-empty session should fall through
    // to the bounds check rather than crashing or silently succeeding.
    const { session } = stubSession([], "");
    const deps = {
      sessions: {
        getOrCreate: () => session,
      } as unknown as AgentSessionManager,
      server: { broadcastToSession: () => {} } as unknown as GatewayServer,
    };
    await expect(rewindSession(deps, "empty:key", 0)).rejects.toThrow(/out of bounds/);
  });

  test("broadcasts session.rewound with the drop count and side effects", async () => {
    const history = [
      msg("user", "u1"),
      toolUseMsg("edit_file", { file_path: "/a.ts" }),
      toolUseMsg("bash", { command: "ls" }),
      msg("user", "u2"),
    ];
    const { session } = stubSession(history, "");
    const broadcasts: any[] = [];
    const deps = stubDeps(session, broadcasts);
    await rewindSession(deps, "test:sess", 0);
    const ev = broadcasts.find((b) => b.event === "session.rewound");
    expect(ev).toBeDefined();
    expect(ev.payload.droppedCount).toBe(4);
    expect(ev.payload.sideEffects.filesModified).toBe(1);
    expect(ev.payload.sideEffects.bashCommands).toBe(1);
  });

  test("cancels a running agent before truncating", async () => {
    const history = [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2")];
    const { session, loopState } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await rewindSession(deps, "test:sess", 2);
    expect(loopState.cancelled).toBe(true);
  });

  test("wipes the per-session task store", async () => {
    const sessionKey = "test:wipe-tasks";
    const store = getTaskStore(sessionKey);
    store.create("scratch task from dropped turn");
    expect(store.getSummary().tasks.length).toBeGreaterThan(0);

    const history = [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2")];
    const { session } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await rewindSession(deps, sessionKey, 0);

    // After rewind, a freshly-fetched store for the same key should be empty
    // (deleteTaskStore drops the entry; getTaskStore lazy-creates an empty one).
    const fresh = getTaskStore(sessionKey);
    expect(fresh.getSummary().tasks.length).toBe(0);
    deleteTaskStore(sessionKey);
  });

  test("clears meta.json snapshot fields so stale numbers don't render", async () => {
    const sessionKey = "test:meta-clear";
    updateSessionMeta(sessionKey, {
      lastContextUsagePercent: 73,
      lastSessionTokens: { input: 1000, output: 500 },
      lastSessionCostUSD: 1.23,
    });
    const before = loadSessionMeta()[sessionKey];
    expect(before.lastContextUsagePercent).toBe(73);

    const history = [msg("user", "u1"), msg("assistant", "a1")];
    const { session } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await rewindSession(deps, sessionKey, 0);

    const after = loadSessionMeta()[sessionKey];
    expect(after.lastContextUsagePercent).toBe(0);
    expect(after.lastSessionTokens?.input).toBe(0);
  });

  test("deletes orphaned subagent JSONL files in the same dir", async () => {
    const history = [
      msg("user", "u1"),
      toolUseMsg("agent", { prompt: "do it" }),
      msg("user", "u2"),
    ];
    const { session, filePath } = stubSession(history, "");
    // Place two subagent files in the session dir with the expected naming.
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    writeFileSync(join(dir, "subagent:test:sess:agent_1.jsonl"), "", "utf-8");
    writeFileSync(join(dir, "subagent:test:sess:agent_2.jsonl"), "", "utf-8");
    // Place an unrelated file that must NOT be deleted.
    writeFileSync(join(dir, "unrelated.jsonl"), "", "utf-8");

    const deps = stubDeps(session, []);
    await rewindSession(deps, "test:sess", 0);

    expect(existsSync(join(dir, "subagent:test:sess:agent_1.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "subagent:test:sess:agent_2.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "unrelated.jsonl"))).toBe(true);
  });

  test("drainCompletedAgents is called (no crash if map is empty)", async () => {
    // Baseline: start with no background agents. The orchestrator should
    // still call drainCompletedAgents without error — regression guard
    // against the sub-agent map being undefined-indexed for a fresh session.
    drainCompletedAgents("test:sess-empty-agents");
    const history = [msg("user", "u1"), msg("assistant", "a1")];
    const { session } = stubSession(history, "");
    const deps = stubDeps(session, []);
    await expect(rewindSession(deps, "test:sess-empty-agents", 0)).resolves.toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// userTurnIndexToMessageIndex — the web-friendly index projection
// -----------------------------------------------------------------------------

describe("userTurnIndexToMessageIndex", () => {
  const toolResultMsg = (id: string): ChatMessage => ({
    role: "user",
    content: [{ type: "tool_result" as const, tool_use_id: id, content: "ok" } as any],
    timestamp: new Date().toISOString(),
  });

  test("maps the N-th user-text message to its absolute history index", () => {
    // History layout: [user, assistant, user, assistant, user]
    // Indices:          0     1          2     3          4
    const history = [
      msg("user", "u0"),
      msg("assistant", "a0"),
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
    ];
    expect(userTurnIndexToMessageIndex(history, 0)).toBe(0);
    expect(userTurnIndexToMessageIndex(history, 1)).toBe(2);
    expect(userTurnIndexToMessageIndex(history, 2)).toBe(4);
  });

  test("skips pure tool_result messages (which are role=user in Anthropic format)", () => {
    // Realistic tool-using turn:
    //   0: user  text   "run ls"
    //   1: asst  tool_use
    //   2: user  tool_result   ← NOT a user turn
    //   3: asst  text  "done"
    //   4: user  text   "now grep"
    const history = [
      msg("user", "run ls"),
      toolUseMsg("bash", { command: "ls" }),
      toolResultMsg("tu_1"),
      msg("assistant", "done"),
      msg("user", "now grep"),
    ];
    // User-turn 0 should be msg 0, user-turn 1 should be msg 4 (skipping idx 2).
    expect(userTurnIndexToMessageIndex(history, 0)).toBe(0);
    expect(userTurnIndexToMessageIndex(history, 1)).toBe(4);
  });

  test("counts user messages with images/documents as user turns", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "" } } as any,
        ],
        timestamp: new Date().toISOString(),
      },
    ];
    expect(userTurnIndexToMessageIndex(history, 0)).toBe(0);
  });

  test("returns -1 for out-of-range indices", () => {
    const history = [msg("user", "u0"), msg("assistant", "a0")];
    expect(userTurnIndexToMessageIndex(history, 1)).toBe(-1);
    expect(userTurnIndexToMessageIndex(history, 99)).toBe(-1);
    expect(userTurnIndexToMessageIndex(history, -1)).toBe(-1);
  });

  test("returns -1 for empty history", () => {
    expect(userTurnIndexToMessageIndex([], 0)).toBe(-1);
  });
});
