// =============================================================================
// Session Rewind
//
// Truncate a session's history at a given (user) message index, discard every
// derived state that references the dropped turns, and leave the session in a
// clean state ready for the user to submit a replacement message.
//
// The operation is destructive on:
//   - in-memory history of the active AgentLoop (if any)
//   - the session JSONL on disk (rewritten atomically via SessionManager)
//   - per-session ephemeral state: background sub-agents, task store, compaction
//     circuit breaker
//   - persisted per-session metadata (cost/token snapshots, context %)
//   - memory search index chunks derived from the session file
//   - heartbeat distillation byte-offset for this file
//   - sub-agent JSONL files spawned inside the dropped turns
//
// It is NOT destructive on:
//   - cost tracker cumulative totals (the user's money was spent; we don't
//     pretend otherwise)
//   - MEMORY.md / daily logs / any facts the agent may have curated from the
//     dropped turns (no reliable reverse mapping from message → fact)
//   - filesystem side effects from tool calls (bash / edit_file / write_file
//     actually changed files; `git status` is the user's friend)
//   - Slack / push messages / cron jobs created in dropped turns (already
//     out the door — we list them as "cannot be undone" in the warning)
//
// This module is the single seam for the "rewind" feature so the RPC handler
// stays thin and the invalidation order is easy to audit.
// =============================================================================

import { existsSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

import type { AgentSessionManager } from "./agent-sessions.js";
import type { GatewayServer } from "./server.js";
import type { HeartbeatService } from "./heartbeat.js";
import type { ChatMessage, ContentBlock } from "../agent/types.js";
import { updateSessionMeta } from "../storage/session.js";
import { deleteTaskStore } from "../tools/task_global.js";
import { drainCompletedAgents } from "../tools/agent.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getGlobalMemoryIndex } from "../memory/global.js";

const log = createSubsystemLogger("gateway/rewind");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface RewindResult {
  droppedCount: number;
  sideEffects: {
    filesModified: number;
    bashCommands: number;
    webRequests: number;
    cronJobsCreated: number;
    subagentsSpawned: number;
  };
}

export interface RewindDeps {
  sessions: AgentSessionManager;
  server: GatewayServer;
  heartbeat?: HeartbeatService;
  /** Optional clientId of the client that initiated the rewind. When
   *  provided, the session.rewound broadcast excludes EVERY connection
   *  belonging to that client (not just the originating socket) so the
   *  initiator never races against its own event. The initiator already
   *  knows the new state from the RPC response. Other clients (other
   *  browsers, the PWA on a different device, the TUI) still receive
   *  the broadcast and refresh. Excluding by clientId rather than the
   *  connId of the WS socket the request arrived on is what keeps this
   *  correct when one logical client has multiple sockets open at once
   *  (PWA service worker, transient reconnect overlap, dev tunnels). */
  excludeClientId?: string;
}

// -----------------------------------------------------------------------------
// Side-effect tally — for the UI confirmation modal copy
// -----------------------------------------------------------------------------

/**
 * Scan the slice of history we're about to discard and count tool calls that
 * had real-world effects, so the user sees "3 files modified, 2 cron jobs
 * created" before committing to the rewind. Does NOT attempt to undo any of
 * them — the feature is conversation rewind, not world rewind.
 */
export function summarizeSideEffects(dropped: ChatMessage[]): RewindResult["sideEffects"] {
  const counts = {
    filesModified: 0,
    bashCommands: 0,
    webRequests: 0,
    cronJobsCreated: 0,
    subagentsSpawned: 0,
  };
  for (const msg of dropped) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks as ContentBlock[]) {
      if (b.type !== "tool_use") continue;
      const name = (b as any).name as string;
      const input = ((b as any).input ?? {}) as Record<string, unknown>;
      switch (name) {
        case "edit_file":
        case "write_file":
          counts.filesModified++;
          break;
        case "bash":
        case "shell":
          counts.bashCommands++;
          break;
        case "web_fetch":
        case "web_search":
          counts.webRequests++;
          break;
        case "cron": {
          // Only count creations — not status/list/delete — so the warning
          // reflects new background work the dropped turns started.
          if (typeof input.action === "string" && input.action === "add") {
            counts.cronJobsCreated++;
          }
          break;
        }
        case "agent":
          counts.subagentsSpawned++;
          break;
      }
    }
  }
  return counts;
}

// -----------------------------------------------------------------------------
// Sub-agent JSONL file cleanup
// -----------------------------------------------------------------------------

/**
 * Sub-agents spawned in a dropped turn have their own JSONL files at
 * `sessions/.../subagent:<parent>:<agentId>.jsonl`. Those files are orphaned
 * by the rewind — the parent session will never reference them again — so
 * delete them to keep the sessions dir tidy. Matches the `agent` tool's
 * session_key convention in src/tools/agent.ts.
 */
function deleteSubagentFilesForParent(parentSessionFilePath: string, parentSessionKey: string): number {
  const dir = dirname(parentSessionFilePath);
  if (!existsSync(dir)) return 0;
  let deleted = 0;
  try {
    for (const entry of readdirSync(dir)) {
      // Sub-agent files are named like `subagent:<parentKey>:<agentId>.jsonl`.
      // The parent key itself may contain colons (e.g. `web:general`), so
      // match on the full prefix rather than a simple split.
      if (entry.startsWith(`subagent:${parentSessionKey}:`) && entry.endsWith(".jsonl")) {
        try {
          unlinkSync(join(dir, entry));
          deleted++;
        } catch (err) {
          log.warn("failed to delete orphaned subagent JSONL", {
            file: entry,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch {
    /* sessions dir unreadable — best-effort cleanup */
  }
  return deleted;
}

// -----------------------------------------------------------------------------
// Turn-index resolution
// -----------------------------------------------------------------------------

/**
 * Convert a "user turn index" (0-based count of user-authored text messages
 * from the start of history) to an absolute message index in the ChatMessage
 * array. User-authored means role==="user" AND content includes at least one
 * text / image / document block — pure tool_result messages (also role:user
 * in the Anthropic format) are SKIPPED.
 *
 * This exists because the web frontend renders each assistant tool_use as a
 * separate UI row, so the UI's `messages[]` index diverges from the backend
 * history index. Counting user-text messages, however, is a stable projection
 * both sides can agree on.
 *
 * Returns -1 if the count is out of range (caller should surface a 4xx).
 */
export function userTurnIndexToMessageIndex(
  history: ChatMessage[],
  userTurnIndex: number,
): number {
  if (userTurnIndex < 0) return -1;
  let count = 0;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const hasUserAuthoredBlock = blocks.some(
      (b) => b.type === "text" || b.type === "image" || (b as any).type === "document",
    );
    if (!hasUserAuthoredBlock) continue;
    if (count === userTurnIndex) return i;
    count++;
  }
  return -1;
}

// -----------------------------------------------------------------------------
// Public API: rewindSession
// -----------------------------------------------------------------------------

/**
 * Truncate the session identified by `sessionKey` to keep the first
 * `messageIndex` messages (0-based); everything at or after that index is
 * discarded. Returns a summary of what was dropped for UI display.
 *
 * Does NOT send any new user message — the caller (RPC handler) is
 * responsible for the `sendMessage` call after this completes, so that the
 * rewind itself and the new turn are clearly separable operations.
 *
 * Throws if `messageIndex` is out of bounds or if there is no active session
 * with history to rewind. The caller should validate and surface a 4xx-style
 * error to the client.
 */
export async function rewindSession(
  deps: RewindDeps,
  sessionKey: string,
  messageIndex: number,
): Promise<RewindResult> {
  // Use getOrCreate so a session that exists on disk but hasn't been
  // hydrated into memory yet (e.g. after a gateway restart, or the user
  // picked an older chat from session.list and rewinds before any other
  // RPC warmed it) is loaded from JSONL. Other read paths (session.history)
  // already do this — rewind must match, otherwise it's inconsistently
  // unavailable for perfectly valid sessions. If the session is genuinely
  // empty (no JSONL on disk either), the bounds check below catches it.
  const session = deps.sessions.getOrCreate(sessionKey);

  const history = session.loop.getHistory();
  if (messageIndex < 0 || messageIndex >= history.length) {
    throw new Error(
      `messageIndex ${messageIndex} out of bounds (history has ${history.length} messages)`,
    );
  }

  const target = history[messageIndex];
  if (target.role !== "user") {
    // Rewinding to an assistant / tool message makes no semantic sense — the
    // next thing the user provides would land on top of a half-turn.
    throw new Error(
      `rewind target must be a user message (got role="${target.role}" at index ${messageIndex})`,
    );
  }

  const dropped = history.slice(messageIndex);
  const sideEffects = summarizeSideEffects(dropped);

  // 1. Cancel any in-flight LLM call on this session so it doesn't race
  //    with our history rewrite. cancel() is a no-op if nothing's running.
  session.loop.cancel();

  // 2. Drop background sub-agents tracked for this session. drainCompletedAgents
  //    removes completed entries; running ones are less tractable (no per-agent
  //    abort handle exposed) but their results would no longer reach a message
  //    slot after the rewind anyway, so they become harmless dangling promises.
  drainCompletedAgents(sessionKey);

  // 3. Wipe the per-session task scratchpad. Tasks are a by-product of the
  //    conversation shape — once we've rewound, the agent will recreate
  //    whatever tasks it still needs. Leaving them would surface phantom
  //    work in the next turn's reminder.
  deleteTaskStore(sessionKey);

  // 4. Truncate in-memory history. Do this BEFORE the JSONL rewrite so that
  //    if we crash between the two, the disk is still the source of truth
  //    for the pre-rewind state and a gateway restart will recover.
  const keep = history.slice(0, messageIndex);
  session.loop.setHistory(keep);

  // 5. Atomic JSONL rewrite (same path compaction uses).
  const sessionManager = session.sessionManager;
  const modelForHeader = session.loop["config"]?.model;
  sessionManager.rewriteMessages(keep, modelForHeader);

  // 6. Reset the heartbeat distillation offset for this file. Without this,
  //    distillation remembers "I already processed bytes 0..N" pointing into
  //    a byte position that no longer exists in the rewritten file, so the
  //    next distillation run would skip everything.
  if (deps.heartbeat) {
    try {
      deps.heartbeat.updateSessionOffset(sessionManager.getFilePath(), 0);
    } catch (err) {
      log.warn("failed to reset distillation offset (non-fatal)", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. Invalidate memory-index chunks derived from this session file. The
  //    indexer will re-index on its next sync because rewriteMessages
  //    changes mtime+size, but we explicitly drop existing chunks so a
  //    user running memory_search in the meantime doesn't hit text from
  //    the dropped turns.
  try {
    const index = getGlobalMemoryIndex();
    if (index) {
      index.invalidateAbsPath(sessionManager.getFilePath());
    }
  } catch (err) {
    log.warn("failed to invalidate memory index for rewound session (non-fatal)", {
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 8. Delete orphaned sub-agent JSONLs — files whose existence is only
  //    justified by the dropped turns.
  const subagentFilesDeleted = deleteSubagentFilesForParent(
    sessionManager.getFilePath(),
    sessionKey,
  );
  if (subagentFilesDeleted > 0) {
    log.info("cleaned up orphaned subagent JSONLs", {
      sessionKey,
      deleted: subagentFilesDeleted,
    });
  }

  // 9. Clear meta.json snapshot fields so the sidebar ring / footer don't
  //    show stale numbers from the dropped state. The next turn will re-seed.
  try {
    updateSessionMeta(sessionKey, {
      lastContextUsagePercent: 0,
      lastSessionTokens: { input: 0, output: 0 },
      lastSessionCostUSD: undefined,
    });
  } catch (err) {
    log.warn("failed to clear session meta (non-fatal)", {
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 10. Broadcast to all connected clients so their in-flight state (sidebar
  //     ring, footer cost, message list if they have it cached) refreshes
  //     before the new turn lands. The payload is shape-compatible with the
  //     existing session.* event family — clients should on receipt refetch
  //     history from session.history.
  deps.server.broadcastToSession(sessionKey, "session.rewound", {
    type: "session.rewound",
    sessionKey,
    droppedCount: dropped.length,
    keptCount: keep.length,
    sideEffects,
    timestamp: Date.now(),
  }, deps.excludeClientId);

  log.info("session rewound", {
    sessionKey,
    messageIndex,
    droppedCount: dropped.length,
    ...sideEffects,
  });

  return {
    droppedCount: dropped.length,
    sideEffects,
  };
}
