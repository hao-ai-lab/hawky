// =============================================================================
// Per-Session Task Store Registry
//
// Each sessionKey (e.g. "web:general", "cron:digest", "subagent:web:X:agent_1")
// gets its OWN TaskStore. Tasks created in one session do NOT appear in
// another session's per-turn reminder — this was the "cross-session
// contamination" bug (Defect A from the audit).
//
// **In-memory only. No persistence.** The agent's task_create/task_update
// tool is a scratchpad for multi-step work within one session — not the
// user's long-term todo list. Persisting it to disk would (a) confuse
// the PA mental model (agent scratchpad masquerading as user todos) and
// (b) accumulate stale entries over long-lived sessions. Long-term user
// todos live in workspace memory (`memory/*.md`, distillation output)
// and surface via memory_search. See Claude Code's V1 TodoWriteTool
// (`src/tools/TodoWriteTool/TodoWriteTool.ts:88-94` in that source,
// via the earlier research Explore) — same in-memory semantics.
//
// Task state dies on gateway restart by design.
// =============================================================================

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/index.js";
import { getSessionsDir, sessionKeyToId } from "../storage/session.js";
import { TaskStore } from "../agent/task_store.js";

const log = createSubsystemLogger("tools/task-store");

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const stores = new Map<string, TaskStore>();

/**
 * Process-level broadcaster. Set once at gateway startup via
 * `setTaskBroadcaster`; receives every store's "update" emission so web
 * clients see the chip change in real time.
 *
 * Kept at the registry level (not per-AgentLoop) so we only subscribe
 * when a store is actually created. Wiring at AgentLoop construction
 * eagerly allocates a store for every session opened for its history
 * (task-less sessions included), which bloats the registry — see
 * Codex P2 (round 9). Now the subscription lifetime matches the
 * store's lifetime, which matches actual task activity.
 */
type Broadcaster = (sessionKey: string, event: string, payload: unknown) => void;
let broadcaster: Broadcaster | undefined;

export function setTaskBroadcaster(fn: Broadcaster | undefined): void {
  broadcaster = fn;
}

/**
 * Get (or create) the TaskStore for a specific session. First call for a
 * session creates an empty store; subsequent calls return the cached
 * in-memory instance. On creation, the store is wired to the
 * process-level broadcaster so mutations flow out to web clients as
 * `task.update` events.
 *
 * Task tools resolve the sessionKey from ToolContext.session_id; the
 * AgentLoop reads from its own this.sessionKey. See src/tools/task.ts
 * and src/agent/loop.ts.
 */
export function getTaskStore(sessionKey: string): TaskStore {
  let store = stores.get(sessionKey);
  if (store) return store;
  store = new TaskStore();
  // The listener reads the current key from the store itself rather
  // than capturing it by closure — that way a later rename can
  // update `store.sessionKey` and broadcasts follow to the new key
  // without having to detach/reattach listeners (which would drop
  // any unrelated TUI subscribers on the same store).
  store.sessionKey = sessionKey;
  const s = store;
  store.on("update", (summary) => {
    const currentKey = s.sessionKey ?? sessionKey;
    broadcaster?.(currentKey, "task.update", {
      type: "task.update",
      sessionKey: currentKey,
      summary,
    });
  });
  stores.set(sessionKey, store);
  return store;
}

/**
 * Non-creating lookup. Returns the existing store for a session, or
 * `undefined` if one has never been created. Use this for read-only
 * paths (e.g. the `task.list` RPC called on every session switch) so
 * browsing past sessions doesn't inflate the registry with empty
 * stores for task-less sessions. (Codex P2.)
 */
export function peekTaskStore(sessionKey: string): TaskStore | undefined {
  return stores.get(sessionKey);
}

/**
 * Drop all cached stores. For testing and gateway shutdown.
 */
export function resetAllTaskStores(): void {
  for (const [, store] of stores) store.removeAllListeners();
  stores.clear();
}

/**
 * Drop the in-memory store for a session. Called by
 * AgentSessionManager.deleteSession so a deleted session's tasks don't
 * linger in memory for the process lifetime. Returns true if a store
 * was present.
 *
 * Also best-effort-deletes any legacy `<id>.tasks.json` file left on
 * disk by a previous version that used to persist. Current code never
 * writes these files, but a user upgrading from a prior build could
 * have stale files under `~/.hawky/sessions/` that would otherwise
 * never be cleaned up.
 */
export function deleteTaskStore(sessionKey: string): boolean {
  const existing = stores.get(sessionKey);
  let present = false;
  if (existing) {
    existing.removeAllListeners();
    stores.delete(sessionKey);
    present = true;
  }
  unlinkLegacyTasksFile(sessionKey);
  return present;
}

/**
 * Re-key the in-memory store when a session is renamed. Moves the
 * store from oldKey to newKey. Called by AgentSessionManager.rename.
 * No-op when oldKey === newKey or when no store exists at oldKey.
 * Also best-effort-deletes any legacy `<old-id>.tasks.json` left on
 * disk (see deleteTaskStore for rationale).
 */
export function renameTaskStore(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const existing = stores.get(oldKey);
  if (existing) {
    // Re-key the Map AND update the store's own sessionKey so the
    // broadcast listener's next fire reports the new key. Without
    // this, a rename would keep broadcasting under the old key
    // (ghost events that web clients would route to a session that
    // no longer exists).
    existing.sessionKey = newKey;
    stores.set(newKey, existing);
    stores.delete(oldKey);
  }
  unlinkLegacyTasksFile(oldKey);
}

function unlinkLegacyTasksFile(sessionKey: string): void {
  if (sessionKey.startsWith("subagent:")) return; // never persisted
  const p = join(getSessionsDir(), `${sessionKeyToId(sessionKey)}.tasks.json`);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch (err) {
    log.debug("failed to unlink legacy tasks file", {
      sessionKey,
      path: p,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
