// =============================================================================
// Heartbeat Prompt Builder
//
// Builds the decision prompt and virtual tool definition for the heartbeat's
// Phase 1 (skip/run decision). Uses Nanobot's virtual tool call pattern
// instead of a proven HEARTBEAT_OK token — structured JSON, no parsing.
//
// The LLM is given the HEARTBEAT.md content + current time + any pending
// system events, and must call the heartbeat tool with action "skip" or "run".
// =============================================================================

import type { SystemEvent } from "./system-events.js";
import { formatDate } from "../storage/workspace.js";
import type { BootstrapFile } from "../storage/workspace.js";
import { getPrompt } from "../prompts/index.js";

// -----------------------------------------------------------------------------
// Virtual tool definition
// -----------------------------------------------------------------------------

/**
 * Tool definition for the heartbeat decision call.
 * The LLM must call this tool — it's the only tool available in Phase 1.
 */
export const HEARTBEAT_DECISION_TOOL = {
  name: "heartbeat_decision",
  description:
    "Decide whether the heartbeat tasks need action. Call with action='skip' if nothing needs attention right now, or action='run' with a task summary if work should be done.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string" as const,
        enum: ["skip", "run"],
        description:
          "skip = nothing needs attention right now. run = tasks need execution.",
      },
      tasks: {
        type: "string" as const,
        description:
          "When action is 'run': a concise summary of what needs to be done. Omit when skipping.",
      },
      reason: {
        type: "string" as const,
        description:
          "Brief reason for the decision (e.g., 'no urgent items', 'email check needed').",
      },
    },
    required: ["action"],
  },
};

// -----------------------------------------------------------------------------
// Decision result
// -----------------------------------------------------------------------------

export interface HeartbeatDecision {
  action: "skip" | "run";
  tasks?: string;
  reason?: string;
}

/**
 * Parse the tool call result from the LLM into a HeartbeatDecision.
 * Returns a "skip" decision if parsing fails (permissive — don't crash).
 */
export function parseHeartbeatDecision(
  toolInput: Record<string, unknown>,
): HeartbeatDecision {
  const action = toolInput.action;
  if (action === "run") {
    return {
      action: "run",
      tasks: typeof toolInput.tasks === "string" ? toolInput.tasks : undefined,
      reason:
        typeof toolInput.reason === "string" ? toolInput.reason : undefined,
    };
  }
  // Default to skip for anything unexpected
  return {
    action: "skip",
    reason: typeof toolInput.reason === "string" ? toolInput.reason : undefined,
  };
}

// -----------------------------------------------------------------------------
// Prompt building
// -----------------------------------------------------------------------------

/**
 * Build the system prompt for the heartbeat decision call.
 *
 * Includes workspace context (USER.md, SOUL.md, IDENTITY.md, MEMORY.md)
 * so the LLM understands who the user is, what matters, and can make
 * informed triage decisions. Pattern: a proven design injects bootstrap context
 * into heartbeat system prompt.
 *
 * @param bootstrapFiles - Workspace files to include as context
 */
export function buildHeartbeatSystemPrompt(
  bootstrapFiles?: BootstrapFile[],
): string {
  const parts: string[] = [];

  parts.push(
    "You are a background heartbeat agent for a personal assistant called Hawky.",
    "Your job is to periodically check on tasks and decide whether any need action.",
    "",
  );

  // Include workspace context if available
  if (bootstrapFiles && bootstrapFiles.length > 0) {
    parts.push("## Context");
    parts.push("");
    for (const file of bootstrapFiles) {
      // Skip HEARTBEAT.md itself (sent in user message) and BOOTSTRAP.md (onboarding)
      if (file.filename === "HEARTBEAT.md" || file.filename === "BOOTSTRAP.md") continue;
      if (!file.content.trim()) continue;
      parts.push(`### ${file.filename}`);
      parts.push(file.content.trim());
      parts.push("");
    }
  }

  parts.push(
    "## Instructions",
    "",
    "You MUST call the heartbeat_decision tool with your decision.",
    "- action='skip' if nothing needs attention right now",
    "- action='run' with a clear task summary if work should be done",
    "",
    "Guidelines:",
    "- Do NOT infer or repeat old tasks from prior conversations.",
    "- Only act on tasks explicitly listed in HEARTBEAT.md or pending system events.",
    "- Consider the current time when deciding urgency (e.g., business hours, deadlines).",
    "- If a task says 'check email' but you have no email tool configured, skip it.",
    "- Be concise. Do not explain reasoning in text — use the tool.",
  );

  return parts.join("\n");
}

/**
 * Build the user message for the heartbeat decision call.
 *
 * @param heartbeatContent - Contents of HEARTBEAT.md
 * @param systemEvents - Any pending system events to include
 * @param nowMs - Current timestamp (for formatting current time)
 */
export function buildHeartbeatUserMessage(
  heartbeatContent: string,
  systemEvents: SystemEvent[],
  nowMs?: number,
): string {
  const now = new Date(nowMs ?? Date.now());
  const timeStr = now.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const parts: string[] = [];

  parts.push(`Current time: ${timeStr}`);
  parts.push("");

  if (systemEvents.length > 0) {
    parts.push(`Pending system events (${systemEvents.length}):`);
    for (const evt of systemEvents) {
      const age = Math.round((now.getTime() - evt.ts) / 1000);
      parts.push(`  - [${age}s ago] ${evt.text}`);
    }
    parts.push("");
  }

  parts.push("=== HEARTBEAT.md ===");
  parts.push(heartbeatContent.trim());
  parts.push("=== END ===");

  return parts.join("\n");
}

// -----------------------------------------------------------------------------
// HEARTBEAT.md content checks
// -----------------------------------------------------------------------------

/**
 * Check if HEARTBEAT.md content is effectively empty.
 * Returns true if the file contains only whitespace, markdown headers,
 * or empty list items.
 *
 * Pattern: a proven isHeartbeatContentEffectivelyEmpty
 */
export function isHeartbeatContentEffectivelyEmpty(
  content: string,
): boolean {
  // Strip HTML comments first (they can span multiple lines)
  const withoutHtmlComments = content.replace(/<!--[\s\S]*?-->/g, "");

  const lines = withoutHtmlComments.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Markdown headers (must have space after #)
    if (/^#{1,6}\s/.test(trimmed)) continue;

    // Empty list items: "- ", "* ", "- [ ]", "- [x]"
    if (/^[-*]\s*$/.test(trimmed)) continue;
    if (/^[-*]\s+\[[ x]?\]\s*$/.test(trimmed)) continue;

    // Numbered empty list items: "1. ", "2. "
    if (/^\d+\.\s*$/.test(trimmed)) continue;

    // Horizontal rules
    if (/^[-*_]{3,}$/.test(trimmed)) continue;

    // Something meaningful exists
    return false;
  }

  return true;
}

// -----------------------------------------------------------------------------
// Phase 3: Consolidation prompts
// -----------------------------------------------------------------------------

/**
 * Build the system prompt for the heartbeat consolidation phase.
 * The consolidation agent reviews daily logs and maintains MEMORY.md.
 */
export function buildConsolidationSystemPrompt(): string {
  return getPrompt("heartbeat.consolidation.system");
}

/**
 * Build the user message for the consolidation phase.
 * Includes the content of recent daily logs for the agent to review.
 */
export function buildConsolidationUserMessage(
  dailyLogEntries: Array<{ date: string; content: string }>,
  memoryMdPath: string,
  nowMs?: number,
): string {
  const now = new Date(nowMs ?? Date.now());
  const timeStr = now.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const parts: string[] = [];
  parts.push(`Memory consolidation review — ${timeStr}`);
  parts.push(`MEMORY.md path: ${memoryMdPath}`);
  parts.push("");

  if (dailyLogEntries.length === 0) {
    parts.push("No recent daily log entries found. Check if MEMORY.md needs staleness cleanup.");
  } else {
    parts.push(`Recent daily logs (${dailyLogEntries.length} day(s)):`);
    parts.push("");
    for (const entry of dailyLogEntries) {
      parts.push(`=== ${entry.date} ===`);
      parts.push(entry.content.trim());
      parts.push("");
    }
  }

  parts.push("Review the above and update MEMORY.md as needed. Reply NO_REPLY if nothing to change.");
  return parts.join("\n");
}

// -----------------------------------------------------------------------------
// Pre-compaction memory flush prompts
// Pattern: a proven flush-plan.ts — extract durable memories before /new or
// context pressure. MEMORY.md is read-only during flush.
// -----------------------------------------------------------------------------

/**
 * Build the system prompt for the pre-compaction memory flush.
 * Instructs the agent to extract noteworthy facts from the conversation
 * and write them to the daily log. Triggered by /new or token pressure.
 */
export function buildFlushSystemPrompt(): string {
  return getPrompt("heartbeat.flush.system");
}

/**
 * Build the user message for the pre-compaction flush.
 *
 * @param workspacePath - Workspace directory path
 * @param trigger - What triggered the flush
 * @param nowMs - Current timestamp
 */
export function buildFlushUserMessage(
  workspacePath: string,
  trigger: "new" | "pressure" | "flush" = "flush",
  nowMs?: number,
): string {
  const now = new Date(nowMs ?? Date.now());
  const dateStr = formatDate(now);
  const timeStr = now.toLocaleTimeString();

  const triggerText = trigger === "new"
    ? "The user is starting a new session (/new)."
    : trigger === "pressure"
      ? "The session is approaching context limits."
      : "The user manually triggered a memory flush (/flush).";

  return [
    `Memory flush — ${triggerText}`,
    `Current time: ${timeStr}`,
    `Daily log target: ${workspacePath}/memory/${dateStr}.md`,
    ``,
    `Review this conversation and extract any durable memories worth preserving.`,
    `Append to the daily log file above using edit_file or write_file.`,
    `Do NOT modify MEMORY.md or other bootstrap files.`,
    `If nothing to preserve, reply with NO_REPLY.`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Node context prefix (shared by cron + heartbeat execution)
// -----------------------------------------------------------------------------

export interface NodeInfo {
  name: string;
  platform: string;
  commands: string[];
}

/** Sanitize a node metadata string — strip control characters and brackets. */
function sanitizeNodeField(s: string): string {
  return s.replace(/[\x00-\x1f\[\]{}]/g, "").slice(0, 64);
}

/**
 * Build a one-line node context prefix for background jobs.
 * Tells the agent what devices are available for remote execution.
 * Node metadata is sanitized to prevent prompt injection.
 */
export function buildNodeContextPrefix(nodes: NodeInfo[]): string {
  if (nodes.length === 0) {
    return "[No remote nodes connected. Local gateway tools (bash, files) are still available.]\n";
  }
  const list = nodes.map((n) =>
    `${sanitizeNodeField(n.name)} (${sanitizeNodeField(n.platform)})`,
  ).join(", ");
  return `[Connected nodes: ${list}. Run commands on them via bash with host="node" or the nodes tool. If a node is offline, use local gateway tools or cloud alternatives.]\n`;
}

// -----------------------------------------------------------------------------
// Cron distillation prompt
// -----------------------------------------------------------------------------

// =============================================================================
// Session Distillation Prompts
// =============================================================================

/**
 * Build the system prompt for session distillation.
 * The LLM reads extracted session text and writes durable facts to the daily log.
 */
export function buildDistillationSystemPrompt(): string {
  return getPrompt("heartbeat.distillation.system");
}

/**
 * Build the user message for session distillation.
 * Includes the extracted session text and target daily log path.
 */
export function buildDistillationUserMessage(
  sessionText: string,
  workspacePath: string,
  nowMs?: number,
): string {
  const dateStr = formatDate(new Date(nowMs ?? Date.now()));
  return [
    "## Session Excerpts",
    "",
    "The following are excerpts from recent sessions that have not been flushed to memory.",
    "Extract any durable facts worth preserving.",
    "",
    sessionText,
    "",
    "---",
    "",
    `Daily log target: ${workspacePath}/memory/${dateStr}.md`,
    `Read the daily log FIRST (if it exists) to avoid duplicating facts already recorded.`,
    `Append new facts only. Reply NO_REPLY if nothing to preserve.`,
  ].join("\n");
}

/**
 * Build the memory distillation instruction prepended to cron job execution prompts.
 */
export function buildCronDistillationPrefix(
  workspacePath: string,
  nowMs?: number,
): string {
  const dateStr = formatDate(new Date(nowMs ?? Date.now()));
  return [
    `[After completing the task below, consider: did you learn any facts that would be`,
    `useful across future sessions? If so, append notes to ${workspacePath}/memory/${dateStr}.md.`,
    `Do NOT write the task's entire output there — that belongs in your response only.`,
    `Do NOT write to MEMORY.md — only to the daily log.`,
    `Do NOT create other files in memory/ — always use ${dateStr}.md only.`,
    `Many routine tasks have nothing worth saving. When in doubt, skip this step.]`,
    ``,
  ].join("\n");
}

