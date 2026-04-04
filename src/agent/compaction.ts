// =============================================================================
// Auto-Compaction
//
// LLM-powered context summarization when conversation approaches token limits.
// Two independent phases (triggered at different thresholds):
//   - Memory flush (90%): extracts durable facts to daily logs (existing, see memory-flush.ts)
//   - Auto-compact (95%): summarizes old messages to free context space (this module)
//
// Design:
//   1. Split history into old messages (to summarize) and recent messages (to keep)
//   2. Call Claude to produce a structured summary of old messages
//   3. Replace old messages with a single summary message
//   4. Persist via sessionManager.rewriteMessages()
//
// Reference: Claude Code's src/services/compact/ (4-strategy approach).
// We implement a single strategy: full conversation summarization.
// =============================================================================

import type { ChatMessage, ContentBlock, HawkyConfig, TokenUsage } from "./types.js";
import type { LLMProvider } from "./provider.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getContextWindowTokens } from "./context-window.js";
import { getPrompt } from "../prompts/index.js";

const log = createSubsystemLogger("agent/compaction");

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export interface CompactionConfig {
  /** Whether auto-compaction is enabled (default: true). */
  enabled: boolean;
  /** Context usage % at which auto-compaction triggers (default: 95). */
  threshold_percent: number;
  /** Context usage % at which new messages are blocked (default: 98). */
  blocking_percent: number;
  /** Number of recent turns (user+assistant pairs) to keep after compaction (default: 10). */
  keep_recent_turns: number;
  /** Max consecutive auto-compact failures before circuit breaker trips (default: 3). */
  max_failures: number;
}

const DEFAULTS: CompactionConfig = {
  enabled: true,
  threshold_percent: 95,
  blocking_percent: 98,
  keep_recent_turns: 10,
  max_failures: 3,
};

export function resolveCompactionConfig(config: HawkyConfig): CompactionConfig {
  const c = config.compaction;
  return {
    enabled: c?.enabled ?? DEFAULTS.enabled,
    threshold_percent: c?.threshold_percent ?? DEFAULTS.threshold_percent,
    blocking_percent: c?.blocking_percent ?? DEFAULTS.blocking_percent,
    keep_recent_turns: c?.keep_recent_turns ?? DEFAULTS.keep_recent_turns,
    max_failures: c?.max_failures ?? DEFAULTS.max_failures,
  };
}

// -----------------------------------------------------------------------------
// Compaction state (per-session, tracked in agent-methods.ts)
// -----------------------------------------------------------------------------

export interface CompactionState {
  consecutiveFailures: number;
  lastCompactedAt: number | null;
}

export function createCompactionState(): CompactionState {
  return { consecutiveFailures: 0, lastCompactedAt: null };
}

// -----------------------------------------------------------------------------
// Trigger decision
// -----------------------------------------------------------------------------

/**
 * Should we auto-compact this session?
 * Returns false if disabled, below threshold, or circuit breaker tripped.
 */
export function shouldAutoCompact(
  contextUsagePercent: number,
  config: CompactionConfig,
  state: CompactionState,
): boolean {
  if (!config.enabled) return false;
  if (contextUsagePercent < config.threshold_percent) return false;
  if (state.consecutiveFailures >= config.max_failures) {
    log.debug("auto-compact circuit breaker tripped", {
      failures: state.consecutiveFailures,
      max: config.max_failures,
    });
    return false;
  }
  return true;
}

/**
 * Is the context so full that we should block new messages?
 */
export function isContextBlocked(
  contextUsagePercent: number,
  config: CompactionConfig,
): boolean {
  return config.enabled && contextUsagePercent >= config.blocking_percent;
}

// Compaction prompt text lives in the prompt registry (#512); resolved at the
// call site so deployment overrides + test config dirs take effect.

/**
 * Truncate a string at `n` UTF-16 code units WITHOUT splitting a surrogate
 * pair. Plain `String.prototype.slice(0, n)` operates on UTF-16 code units,
 * so any non-BMP character (most emoji — 📄 🤖 🗞 etc.) takes two units.
 * If `n` lands between the high and low half of one of those, the result
 * has a lone surrogate at the boundary.
 *
 * Vertex AI rejects requests containing lone surrogates with the misleading
 * error `400 "The input data is not valid json." status FAILED_PRECONDITION`.
 * The Anthropic direct API tolerates them. Either way, lone surrogates are
 * not valid Unicode and must not appear in any wire-format string.
 *
 * Fix: if `slice(0, n)` would end on a high surrogate (U+D800–U+DBFF),
 * back off by one code unit so the trailing pair is dropped cleanly.
 */
export function safeSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n > 0) {
    const last = s.charCodeAt(n - 1);
    if (last >= 0xD800 && last <= 0xDBFF) {
      n -= 1;
    }
  }
  return s.slice(0, n);
}

/**
 * Render `tool_result.content` to a short text marker for the compaction
 * transcript. The content can be either:
 *   - a plain string (most tools — bash, read_file, etc.)
 *   - an array of content blocks (multimodal — screenshot, document, image)
 *
 * For arrays, we MUST NOT inline the embedded base64 source data. The model
 * doesn't get vision in compaction prompts, so the bytes are noise; and
 * compaction runs precisely when the session is already near the context
 * limit, so even 500 chars per old screenshot adds up. Emit a brief
 * type-summary instead.
 */
function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let text = "";
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const t = (b as any).type;
      if (t === "text" && typeof (b as any).text === "string") {
        text = (b as any).text;
      } else if (t === "image" || t === "document") {
        const mt = (b as any).source?.media_type ?? t;
        const data = (b as any).source?.data;
        const bytes = typeof data === "string" ? Math.round((data.length * 3) / 4) : 0;
        parts.push(bytes > 0 ? `${mt} (${bytes} bytes)` : mt);
      }
    }
    const meta = parts.length ? ` [+${parts.join(", ")}]` : "";
    return text + meta;
  }
  // Anything else (null, number, plain object) — stringify defensively but
  // briefly. Should not happen in practice.
  return content === null || content === undefined ? "" : String(content);
}

/**
 * Build the messages array for the compaction LLM call.
 * We send the old messages as conversation context, then ask for a summary.
 */
export function buildCompactionMessages(
  messagesToSummarize: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  // Flatten old messages into a readable transcript
  const transcript = messagesToSummarize.map((msg) => {
    const role = msg.role === "user" ? "User" : "Assistant";
    const text = msg.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return `[thinking: ${safeSlice(block.thinking, 200)}...]`;
        if (block.type === "tool_use") return `[tool_use: ${block.name}(${safeSlice(JSON.stringify(block.input), 200)})]`;
        if (block.type === "tool_result") {
          const raw = renderToolResultContent(block.content);
          const content = safeSlice(raw, 500);
          return `[tool_result${block.is_error ? " ERROR" : ""}: ${content}${raw.length > 500 ? "..." : ""}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return `${role}:\n${text}`;
  }).join("\n\n---\n\n");

  return [
    {
      role: "user" as const,
      content: `Here is the conversation to summarize:\n\n${transcript}\n\n${getPrompt("compaction")}`,
    },
  ];
}

// -----------------------------------------------------------------------------
// Summary parsing
// -----------------------------------------------------------------------------

/**
 * Extract summary text from LLM response.
 * Looks for <summary> tags, falls back to full response.
 */
export function parseSummary(response: string): string {
  const match = response.match(/<summary>([\s\S]*?)<\/summary>/);
  if (match) return match[1].trim();
  // No tags — use full response (LLM didn't follow instructions perfectly)
  return response.trim();
}

// -----------------------------------------------------------------------------
// History splitting
// -----------------------------------------------------------------------------

/**
 * Split history into messages to summarize and messages to keep.
 * Keeps the last `keepTurns` turns (each turn = user + assistant).
 * Respects message boundaries — won't split a tool_use from its tool_result.
 */
export function splitHistory(
  history: ChatMessage[],
  keepTurns: number,
): { toSummarize: ChatMessage[]; toKeep: ChatMessage[] } {
  if (history.length === 0) {
    return { toSummarize: [], toKeep: [] };
  }

  // Count turns from the end. A "turn" boundary is a user message that
  // is NOT a tool_result-only message (those are continuations of a turn).
  const keepMessages = keepTurns * 2; // rough: each turn ≈ user + assistant
  const keepFrom = Math.max(0, history.length - keepMessages);

  // Ensure we don't split in the middle of a tool_use/tool_result pair.
  // Walk backward from keepFrom to find a clean boundary: a user message
  // whose content is NOT exclusively tool_result blocks.
  let splitIndex = keepFrom;
  while (splitIndex > 0) {
    const msg = history[splitIndex];
    if (msg.role === "user") {
      const isToolResultOnly = msg.content.every((b) => b.type === "tool_result");
      if (!isToolResultOnly) break; // Clean boundary: regular user message
    }
    splitIndex--;
  }

  // Need at least a few messages to summarize — don't compact tiny histories
  if (splitIndex < 4) {
    return { toSummarize: [], toKeep: history };
  }

  return {
    toSummarize: history.slice(0, splitIndex),
    toKeep: history.slice(splitIndex),
  };
}

// -----------------------------------------------------------------------------
// Build summary message
// -----------------------------------------------------------------------------

/**
 * Create a ChatMessage containing the compaction summary.
 * Uses role "user" so the API treats it as context.
 */
export function buildSummaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "[This conversation was automatically compacted to preserve context quality.",
          "The following is a summary of the earlier conversation.]\n",
          summary,
          "\n[End of compacted summary. The conversation continues below.]",
        ].join("\n"),
        internal_only: false,
      } as ContentBlock,
    ],
    timestamp: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Main compaction function
// -----------------------------------------------------------------------------

export interface CompactionResult {
  compactedHistory: ChatMessage[];
  summary: string;
  messagesRemoved: number;
  messagesKept: number;
}

/**
 * Compact a conversation by summarizing old messages with an LLM call.
 *
 * Returns the new (shorter) history, or null if compaction was skipped
 * (e.g., not enough messages to summarize).
 *
 * Throws on LLM errors (caller should handle with circuit breaker).
 */
export async function compactConversation(
  history: ChatMessage[],
  provider: LLMProvider,
  model: string,
  config: CompactionConfig,
): Promise<CompactionResult | null> {
  const { toSummarize, toKeep } = splitHistory(history, config.keep_recent_turns);

  if (toSummarize.length === 0) {
    log.debug("skipping compaction — not enough messages to summarize", {
      historyLength: history.length,
      keepTurns: config.keep_recent_turns,
    });
    return null;
  }

  log.info("starting compaction", {
    totalMessages: history.length,
    toSummarize: toSummarize.length,
    toKeep: toKeep.length,
  });

  // Build compaction request
  const compactionMessages = buildCompactionMessages(toSummarize);

  // Use a smaller max_tokens for the summary (we don't need 8K output)
  const maxSummaryTokens = 4096;

  // Stream the compaction call and collect the response
  let responseText = "";
  const abortController = new AbortController();

  for await (const event of provider.stream(
    {
      model,
      max_tokens: maxSummaryTokens,
      messages: compactionMessages,
      system: getPrompt("compaction.summarizer.system"),
    },
    abortController.signal,
  )) {
    if (event.type === "text_delta") {
      responseText += event.text;
    }
  }

  if (!responseText.trim()) {
    throw new Error("Compaction LLM call returned empty response");
  }

  const summary = parseSummary(responseText);
  const summaryMessage = buildSummaryMessage(summary);
  const compactedHistory = [summaryMessage, ...toKeep];

  log.info("compaction complete", {
    messagesRemoved: toSummarize.length,
    messagesKept: toKeep.length,
    summaryLength: summary.length,
  });

  return {
    compactedHistory,
    summary,
    messagesRemoved: toSummarize.length,
    messagesKept: toKeep.length,
  };
}
