// =============================================================================
// Memory Flush Service
//
// Orchestrates pre-compaction memory flush: an LLM turn that extracts durable
// memories from the conversation and writes them to the daily log.
//
// Two triggers:
//   1. /flush command — manual trigger to extract memories from conversation
//   2. Token pressure — automatic flush when context usage exceeds threshold
//
// Pattern: a proven memory-flush.ts + flush-plan.ts
// =============================================================================

import type { AgentSessionManager } from "./agent-sessions.js";
import type { HawkyConfig, ChatMessage } from "../agent/types.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { executeInSession } from "./lanes.js";
import { CommandLane } from "./types.js";
import {
  buildFlushSystemPrompt,
  buildFlushUserMessage,
} from "./heartbeat-prompt.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/memory-flush");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface FlushConfig {
  enabled: boolean;
  /** Token pressure threshold as percentage (0-100). Flush triggers when exceeded. */
  thresholdPercent: number;
}

// Track which sessions have already flushed in the current context cycle.
// Prevents duplicate flushes within the same session cycle.
const flushedSessions = new Set<string>();

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Run a memory flush for a session. Extracts durable memories from the
 * conversation and writes them to memory/YYYY-MM-DD.md.
 *
 * Fire-and-forget: caller should not await this. It runs as a background
 * headless agent turn in a dedicated flush session.
 *
 * @param sessionKey - The source session key (e.g., "tui:main")
 * @param trigger - What triggered the flush ("new" or "pressure")
 * @param sessions - Session manager for creating the flush session
 * @param config - Full config (for model, workspace, etc.)
 * @param historySnapshot - Conversation history to flush (captured before clear)
 */
export async function runMemoryFlush(opts: {
  sessionKey: string;
  trigger: "new" | "pressure" | "flush";
  sessions: AgentSessionManager;
  config: HawkyConfig;
  historySnapshot?: ChatMessage[];
  /** Broadcast callback for flush status events (TUI display). Scoped to session. */
  broadcastToSession?: (sessionKey: string, event: string, payload: unknown) => void;
  /** Callback when flush completes — updates shared distillation byte offset.
   *  Receives the session file path and its current byte size so distillation
   *  knows to skip content that flush already processed. */
  onFlushed?: (sessionFilePath: string, byteOffset: number) => void;
}): Promise<void> {
  const { sessionKey, trigger, sessions, config } = opts;

  // Dedup: don't flush the same session twice per context cycle
  if (flushedSessions.has(sessionKey)) {
    log.info("memory flush skipped (already flushed this cycle)", { sessionKey });
    return;
  }

  const workspace = new WorkspaceManager();
  const workspacePath = workspace.getWorkspacePath();

  const systemInstructions = buildFlushSystemPrompt();
  const dataMessage = buildFlushUserMessage(workspacePath, trigger);
  const fullMessage = `${systemInstructions}\n\n---\n\n${dataMessage}`;

  log.info("memory flush starting", { sessionKey, trigger });
  opts.broadcastToSession?.(sessionKey, "flush.started", { type: "flush.started", sessionKey, trigger, timestamp: Date.now() });

  // Run flush in the SOURCE session's lane (serialized with user chat)
  // but inject the old history so the flush agent has context to review.
  // No dedicated flush session — avoids creating a visible "flush:*" session
  // that confuses the user in session lists.
  await executeInSession(
    sessionKey,
    CommandLane.Main,
    async () => {
      const session = sessions.getOrCreate(sessionKey);

      if (!opts.historySnapshot || opts.historySnapshot.length === 0) {
        log.info("memory flush skipped (no history to review)", { sessionKey });
        return;
      }

      // Save the current history so we can restore it after the flush turn.
      // For /flush and pressure: the user's conversation must be unaffected.
      const originalHistory = session.loop.getHistory();

      // Inject the snapshot as context so the flush agent can review it.
      session.loop.setHistory(opts.historySnapshot);

      await session.loop.sendMessage(fullMessage, { headless: true });

      // Restore original history. The flush turn is NOT persisted to the
      // session JSONL — its durable output is in memory/YYYY-MM-DD.md
      // (written by the agent's tool calls). Persisting flush messages
      // would leak internal maintenance turns into the user's context
      // on gateway restart when the JSONL is reloaded.
      session.loop.setHistory(originalHistory);
    },
  );

  flushedSessions.add(sessionKey);

  // Update shared distillation offset so heartbeat distillation won't
  // re-process content that flush already handled.
  if (opts.onFlushed) {
    try {
      const session = sessions.getOrCreate(sessionKey);
      const filePath = session.sessionManager.getFilePath();
      const fileSize = Bun.file(filePath).size;
      opts.onFlushed(filePath, fileSize);
    } catch {
      // Non-fatal — distillation will handle dedup via LLM prompt
    }
  }

  log.info("memory flush completed", { sessionKey, trigger });
  opts.broadcastToSession?.(sessionKey, "flush.completed", { type: "flush.completed", sessionKey, trigger, timestamp: Date.now() });
}

/**
 * Reset the flush dedup tracker for a session.
 * Reset dedup state so the session can flush again (e.g., after continued conversation).
 */
export function resetFlushState(sessionKey: string): void {
  flushedSessions.delete(sessionKey);
}

/**
 * Check if a session has already been flushed in the current cycle.
 */
export function hasAlreadyFlushed(sessionKey: string): boolean {
  return flushedSessions.has(sessionKey);
}

/**
 * Check if a memory flush should be triggered based on token usage.
 *
 * @param contextUsagePercent - Current context usage as percentage (0-100)
 * @param thresholdPercent - Threshold to trigger flush (default 90)
 * @param sessionKey - Session key for dedup check
 */
export function shouldTriggerFlush(
  contextUsagePercent: number,
  thresholdPercent: number,
  sessionKey: string,
): boolean {
  if (flushedSessions.has(sessionKey)) return false;
  return contextUsagePercent >= thresholdPercent;
}

/**
 * Resolve flush config from HawkyConfig.
 */
export function resolveFlushConfig(config: HawkyConfig): FlushConfig {
  const flush = config.memory_flush;
  return {
    enabled: flush?.enabled ?? true,
    thresholdPercent: flush?.threshold_percent ?? 90,
  };
}
