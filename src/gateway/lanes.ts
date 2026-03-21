// =============================================================================
// Lane Helpers
//
// Session lane resolution, nested execution, and lane configuration.
// Pattern: a proven lanes.ts + embedded-runner/lanes.ts.
// =============================================================================

import { CommandLane } from "./types.js";
import type { EnqueueOptions } from "./types.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "./command-queue.js";
import type { AgentSessionManager } from "./agent-sessions.js";

// Set by gateway boot to allow executeInSession to check the swap guard.
let agentSessionsRef: AgentSessionManager | null = null;
export function setAgentSessionsRef(mgr: AgentSessionManager): void {
  agentSessionsRef = mgr;
}

// -----------------------------------------------------------------------------
// Session lane helpers
// -----------------------------------------------------------------------------

/**
 * Resolve a session key to a session lane name.
 * Session lanes are prefixed with "session:" to avoid collisions with global lanes.
 */
export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim();
  if (!cleaned) return `session:${CommandLane.Main}`;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

/**
 * Resolve a global lane from an optional CommandLane.
 * Defaults to Main if not specified.
 */
export function resolveGlobalLane(lane?: CommandLane): string {
  return lane ?? CommandLane.Main;
}

// -----------------------------------------------------------------------------
// Nested execution (a proven design pattern)
// -----------------------------------------------------------------------------

/**
 * Execute a task with nested lane serialization:
 *   1. Session lane: serializes within the same conversation (max=1)
 *   2. Global lane: rate-limits across all sessions (configurable max)
 *
 * This ensures:
 * - Two messages in the same session are always serialized
 * - Two different sessions can run in parallel (if global lane allows)
 * - Global rate limiting (e.g., max 1 concurrent Claude API call)
 */
export function executeInSession<T>(
  sessionKey: string,
  globalLane: CommandLane,
  task: () => Promise<T>,
  opts?: EnqueueOptions,
): Promise<T> {
  if (agentSessionsRef?.swapping) {
    return Promise.reject(new Error("provider swap in progress, retry in a moment"));
  }
  const sessionLaneName = resolveSessionLane(sessionKey);
  const globalLaneName = resolveGlobalLane(globalLane);

  return enqueueCommandInLane(
    sessionLaneName,
    () => enqueueCommandInLane(globalLaneName, task, opts),
    opts,
  );
}

// -----------------------------------------------------------------------------
// Default lane configuration
// -----------------------------------------------------------------------------

/**
 * Apply default lane concurrency settings.
 * Called during gateway startup.
 */
export function applyDefaultLaneConcurrency(overrides?: {
  main?: number;
  cron?: number;
  subagent?: number;
}): void {
  // Main lane: controls how many sessions can have active LLM calls simultaneously.
  // Default 4 (matching a proven design). Per-session lanes (max=1 each) still serialize
  // within a single session, so increasing Main only enables cross-session parallelism.
  setCommandLaneConcurrency(CommandLane.Main, overrides?.main ?? 4);
  // Cron lane: default 4. Shared with consolidation (moved off Main to avoid blocking user chat).
  setCommandLaneConcurrency(CommandLane.Cron, overrides?.cron ?? 4);
  // Subagent lane: default 8 (matching a proven design). Currently unused — sub-agents bypass lanes.
  setCommandLaneConcurrency(CommandLane.Subagent, overrides?.subagent ?? 8);
}
