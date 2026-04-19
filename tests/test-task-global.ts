// =============================================================================
// Per-Session TaskStore Registry Tests
//
// Defect A from the audit: the previous process-wide singleton
// `getGlobalTaskStore()` caused cross-session contamination — tasks
// created in session A surfaced in session B's per-turn reminder. The
// registry now keys TaskStores by sessionKey.
//
// **In-memory only** — the agent's task_create/task_update is a scratchpad
// for one unit of work, not the user's long-term todo list. Task state
// dies on gateway restart by design (matching Claude Code V1 TodoWrite
// semantics). Long-term user todos live in workspace memory files.
//
// This file pins the contract:
//   - Different sessions get different stores; tasks don't leak.
//   - Per-store id counter (task_1 doesn't collide across sessions).
//   - Sub-agent sessions are isolated from parents.
//   - deleteTaskStore drops the in-memory entry.
//   - renameTaskStore re-keys without losing state.
//   - task_create/task_update route through ToolContext.session_id.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTaskStore, peekTaskStore, resetAllTaskStores, deleteTaskStore, renameTaskStore, setTaskBroadcaster } from "../src/tools/task_global.js";
import { taskCreateToolDefinition } from "../src/tools/task.js";
import { setSessionsDir, resetSessionsDir, sessionKeyToId } from "../src/storage/session.js";
import type { ToolContext } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Most tests are pure in-memory. The legacy-tasks-file cleanup tests
// (the only ones that touch disk) set up an isolated sessions dir in
// their own scope to avoid leaking files to the real ~/.hawky.
beforeEach(() => {
  resetAllTaskStores();
  setTaskBroadcaster(undefined);
});

afterEach(() => {
  resetAllTaskStores();
  setTaskBroadcaster(undefined);
});

function ctx(session_id: string): ToolContext {
  return {
    session_id,
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

// -----------------------------------------------------------------------------
// Isolation: different sessions → different stores
// -----------------------------------------------------------------------------

describe("Per-session isolation", () => {
  test("two sessions get two separate stores", () => {
    const a = getTaskStore("web:A");
    const b = getTaskStore("web:B");
    expect(a).not.toBe(b);
  });

  test("tasks created in session A are invisible to session B", () => {
    getTaskStore("web:A").create("A-only task");
    expect(getTaskStore("web:A").getTasks().length).toBe(1);
    expect(getTaskStore("web:B").getTasks().length).toBe(0);
  });

  test("task id counter is per-store (no collision across sessions)", () => {
    const id1 = getTaskStore("web:A").create("A task 1");
    const id2 = getTaskStore("web:B").create("B task 1");
    expect(id1).toBe("task_1");
    expect(id2).toBe("task_1"); // same id string, different stores — OK
    expect(getTaskStore("web:A").getTasks()[0].id).toBe("task_1");
    expect(getTaskStore("web:B").getTasks()[0].id).toBe("task_1");
  });

  test("task tools scope by ToolContext.session_id", async () => {
    await taskCreateToolDefinition.execute({ description: "scoped" } as any, ctx("web:A"));
    // The tool landed in session A's store, not B's, not "default".
    expect(getTaskStore("web:A").getTasks().length).toBe(1);
    expect(getTaskStore("web:B").getTasks().length).toBe(0);
    expect(getTaskStore("default").getTasks().length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Sub-agent isolation
// -----------------------------------------------------------------------------

describe("Sub-agent stores", () => {
  test("sub-agent session gets its own store, isolated from the parent", () => {
    getTaskStore("web:parent").create("Parent task");
    const sub = getTaskStore("subagent:web:parent:agent_1");
    expect(sub.getTasks().length).toBe(0);
    sub.create("Sub task");
    // Parent is unchanged.
    expect(getTaskStore("web:parent").getTasks().length).toBe(1);
    expect(getTaskStore("web:parent").getTasks()[0].description).toBe("Parent task");
  });
});

// -----------------------------------------------------------------------------
// Lifecycle hooks called from AgentSessionManager
// -----------------------------------------------------------------------------

describe("peekTaskStore — non-creating lookup (Codex P2)", () => {
  test("peekTaskStore returns undefined for sessions that never created a task", () => {
    // Critical: simply calling peek must NOT inflate the internal
    // registry with an empty store. Browsing past sessions via the
    // `task.list` RPC would otherwise leak a TaskStore per session
    // opened for the lifetime of the gateway.
    expect(peekTaskStore("web:never-touched")).toBeUndefined();
    // And the store still doesn't exist after the peek — peek must
    // be side-effect-free.
    expect(peekTaskStore("web:never-touched")).toBeUndefined();
  });

  test("peekTaskStore returns the same instance as getTaskStore once one exists", () => {
    const created = getTaskStore("web:exists");
    expect(peekTaskStore("web:exists")).toBe(created);
  });
});

describe("Lifecycle", () => {
  test("deleteTaskStore drops the in-memory entry so a recreated session starts fresh", () => {
    getTaskStore("web:delete-me").create("Ephemeral");
    expect(getTaskStore("web:delete-me").getTasks().length).toBe(1);

    const deleted = deleteTaskStore("web:delete-me");
    expect(deleted).toBe(true);

    // Fresh getTaskStore for the SAME key must start empty — the previous
    // store was dropped from the Map, not revived.
    expect(getTaskStore("web:delete-me").getTasks()).toEqual([]);
  });

  test("deleteTaskStore on a never-touched session is a safe no-op", () => {
    expect(deleteTaskStore("web:never-existed")).toBe(false);
  });

  test("renameTaskStore moves the store under the new key", () => {
    getTaskStore("web:before-rename").create("T1");
    getTaskStore("web:before-rename").create("T2");

    renameTaskStore("web:before-rename", "web:after-rename");

    // Under the new key, the tasks are intact.
    const renamed = getTaskStore("web:after-rename");
    expect(renamed.getTasks().length).toBe(2);
    expect(renamed.getTasks().map((t) => t.description)).toEqual(["T1", "T2"]);

    // Under the old key, a fresh empty store — not a ghost of the renamed one.
    expect(getTaskStore("web:before-rename").getTasks()).toEqual([]);
  });

  test("renameTaskStore is a no-op when oldKey === newKey", () => {
    const before = getTaskStore("web:same").create("preserved");
    renameTaskStore("web:same", "web:same");
    expect(getTaskStore("web:same").getTasks()[0].id).toBe(before);
  });

  test("renameTaskStore on a never-touched session is a safe no-op", () => {
    // No exception, and the new key stays fresh-empty.
    renameTaskStore("web:vacant", "web:new-vacant");
    expect(getTaskStore("web:new-vacant").getTasks()).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Legacy cleanup — earlier versions of this code persisted tasks to
// `<sanitized-id>.tasks.json` in the sessions dir. Current code is
// in-memory only, but users upgrading from that version may have stale
// files on disk. Session delete / rename should sweep them.
// -----------------------------------------------------------------------------

describe("Legacy .tasks.json cleanup (upgrade path)", () => {
  let tmpSessionsDir: string;

  beforeEach(() => {
    tmpSessionsDir = join(
      tmpdir(),
      `hawky-task-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpSessionsDir, { recursive: true });
    setSessionsDir(tmpSessionsDir);
  });

  afterEach(() => {
    resetSessionsDir();
    try { rmSync(tmpSessionsDir, { recursive: true, force: true }); } catch {}
  });

  function legacyPath(sessionKey: string): string {
    const id = sessionKeyToId(sessionKey);
    return join(tmpSessionsDir, `${id}.tasks.json`);
  }

  function plantLegacyFile(sessionKey: string): string {
    const p = legacyPath(sessionKey);
    const dir = p.substring(0, p.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, nextIdCounter: 2, tasks: [] }), "utf8");
    return p;
  }

  test("deleteTaskStore removes a stale .tasks.json left by a prior version", () => {
    const p = plantLegacyFile("web:upgraded");
    expect(existsSync(p)).toBe(true);

    deleteTaskStore("web:upgraded");

    expect(existsSync(p)).toBe(false);
  });

  test("renameTaskStore removes the old key's stale .tasks.json", () => {
    const oldPath = plantLegacyFile("web:old-legacy");
    expect(existsSync(oldPath)).toBe(true);

    // No in-memory store present at oldKey (simulates a fresh upgrade).
    renameTaskStore("web:old-legacy", "web:new-legacy");

    expect(existsSync(oldPath)).toBe(false);
    // The new key's path is also clean — current code never writes it.
    expect(existsSync(legacyPath("web:new-legacy"))).toBe(false);
  });

  test("cleanup is a silent no-op when no legacy file exists", () => {
    // Just shouldn't throw.
    expect(() => deleteTaskStore("web:never-had-one")).not.toThrow();
    expect(() => renameTaskStore("web:never-had-one", "web:nhno-2")).not.toThrow();
  });

  test("sub-agent cleanup never touches disk (sub-agents never persisted)", () => {
    // Plant a file at what would be a subagent's legacy path anyway to
    // prove we don't go near it.
    const subPath = legacyPath("subagent:web:x:agent_1");
    mkdirSync(subPath.substring(0, subPath.lastIndexOf("/")), { recursive: true });
    writeFileSync(subPath, "{}", "utf8");

    deleteTaskStore("subagent:web:x:agent_1");

    // File is untouched — the cleanup skips subagent sessions by design.
    expect(existsSync(subPath)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Broadcast bridge — the registry (not AgentLoop) wires store → WebSocket
//
// Rationale: wiring at AgentLoop construction eagerly allocated a TaskStore
// for every session opened (even task-less ones browsed via session.history),
// which bloated the registry over time. The broadcaster lives at the
// registry level and attaches exactly when a store is created, so the
// subscription lifetime matches actual task activity. (Codex round 9.)
// -----------------------------------------------------------------------------

describe("task.update broadcast via registry", () => {
  test("a newly created store broadcasts its mutations through the registered broadcaster", () => {
    const events: Array<{ sessionKey: string; event: string; payload: any }> = [];
    setTaskBroadcaster((sk, evt, payload) => events.push({ sessionKey: sk, event: evt, payload }));

    const store = getTaskStore("web:broadcast-test");
    store.create("T1");
    store.create("T2");

    const taskEvents = events.filter((e) => e.event === "task.update");
    expect(taskEvents.length).toBeGreaterThanOrEqual(2);
    const last = taskEvents[taskEvents.length - 1];
    expect(last.sessionKey).toBe("web:broadcast-test");
    expect(last.payload.type).toBe("task.update");
    expect(last.payload.sessionKey).toBe("web:broadcast-test");
    expect(last.payload.summary.total).toBe(2);
    expect(last.payload.summary.pending).toBe(2);
  });

  test("mere AgentLoop construction does NOT create an empty store (Codex P2, round 9)", async () => {
    // This is THE test that protects the fix. Opening a session to
    // serve session.history constructs an AgentLoop. With the old
    // wiring, that subscribed a listener on getTaskStore(sessionKey),
    // which created an empty store. Browsing N task-less sessions
    // would leak N TaskStores for the process lifetime. Verify that
    // constructing a loop leaves the registry untouched.
    const { AgentLoop } = await import("../src/agent/loop.js");
    const { ToolRegistry } = await import("../src/tools/registry.js");

    expect(peekTaskStore("web:history-only")).toBeUndefined();
    new AgentLoop({
      provider: { async *stream() {} } as any,
      registry: new ToolRegistry(),
      config: {
        api_keys: { anthropic: "test", brave_search: "" },
        api_base_url: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        max_iterations: 5,
        max_tool_result_chars: 1000,
        workspace_dir: "/tmp",
        gateway_port: 4242,
        heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
      } as any,
      working_directory: "/tmp/test",
      session_key: "web:history-only",
      broadcastToSession: () => {},
    });
    expect(peekTaskStore("web:history-only")).toBeUndefined();
  });

  test("deleteTaskStore stops broadcasts from the removed key", () => {
    const events: Array<{ sessionKey: string }> = [];
    setTaskBroadcaster((sk) => events.push({ sessionKey: sk }));

    getTaskStore("web:gone").create("before");
    expect(events.filter((e) => e.sessionKey === "web:gone").length).toBe(1);

    deleteTaskStore("web:gone");
    events.length = 0;

    // After delete, a fresh getTaskStore builds a NEW store (with its
    // own listener closure still bound to the same key). So subsequent
    // creates still fire — that's expected. The important invariant
    // here is that the old store's listener is released when the
    // store is dropped, not that broadcasts stop forever.
    getTaskStore("web:gone").create("after");
    expect(events.filter((e) => e.sessionKey === "web:gone").length).toBe(1);
    // And there's exactly one listener on the new store.
    expect(peekTaskStore("web:gone")!.listenerCount("update")).toBe(1);
  });

  test("renameTaskStore rebroadcasts future mutations under the new key, not the old one", () => {
    // The rename moves the SAME store object to a new key in the Map;
    // the listener's captured sessionKey is still the old one. To
    // avoid ghost broadcasts under the old key, rename must detach
    // and re-attach under the new key. Verify events go ONLY to newKey.
    const events: Array<{ sessionKey: string }> = [];
    setTaskBroadcaster((sk) => events.push({ sessionKey: sk }));

    getTaskStore("web:old").create("first");
    events.length = 0;

    renameTaskStore("web:old", "web:new");
    peekTaskStore("web:new")!.create("after-rename");

    // All post-rename events are keyed under the new key.
    expect(events.every((e) => e.sessionKey === "web:new")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  test("another session's mutations do NOT leak into this session's broadcast channel (Defect A regression)", () => {
    const events: Array<{ sessionKey: string }> = [];
    setTaskBroadcaster((sk) => events.push({ sessionKey: sk }));

    getTaskStore("web:B").create("not yours");

    // Every event is keyed under web:B, never under web:A.
    expect(events.every((e) => e.sessionKey === "web:B")).toBe(true);
    expect(events.some((e) => e.sessionKey === "web:A")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// AgentSessionManager.reset — wipes the global task-store registry too
// -----------------------------------------------------------------------------

describe("AgentSessionManager.reset clears task registry (Codex P2)", () => {
  test("reset() drops TaskStores from the global registry so deterministic keys start clean", async () => {
    // reset() is a test-only cleanup path. It was already disposing
    // loops' bridges, but it left task stores intact — so the next
    // test run that reopened the same deterministic key (e.g.
    // "heartbeat:main") would inherit the previous run's task list
    // and summary, causing false-positive reminders and ghost chips.
    const { AgentSessionManager } = await import("../src/gateway/agent-sessions.js");

    const cfg = {
      api_keys: { anthropic: "test", brave_search: "" },
      api_base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      max_iterations: 5,
      max_tool_result_chars: 1000,
      workspace_dir: "/tmp",
      gateway_port: 4242,
      heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
    } as any;
    const manager = new AgentSessionManager({
      provider: { async *stream() {} } as any,
      config: cfg,
      workingDirectory: "/tmp",
    });

    // Plant tasks in two deterministic keys.
    getTaskStore("heartbeat:main").create("leftover 1");
    getTaskStore("cron:digest").create("leftover 2");
    expect(peekTaskStore("heartbeat:main")).toBeDefined();
    expect(peekTaskStore("cron:digest")).toBeDefined();

    manager.reset();

    // Both stores must be gone — the next run starts with a clean slate.
    expect(peekTaskStore("heartbeat:main")).toBeUndefined();
    expect(peekTaskStore("cron:digest")).toBeUndefined();
  });
});
