// =============================================================================
// Agent-Initiated Turn
//
// Reusable function for triggering a headless agent turn in any session.
// Extracts the common execution pattern shared by heartbeat, cron, and
// future proactive delivery (Phase 2+).
//
// Pattern: executeInSession → getOrCreate → subscribe → sendMessage → persist
// =============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionManager } from "./agent-sessions.js";
import type { GatewayServer } from "./server.js";
import type { StreamEvent, ChatMessage } from "../agent/types.js";
import { executeInSession } from "./lanes.js";
import { CommandLane } from "./types.js";
import { deliver } from "./delivery.js";
import type { DeliveryConfig } from "./delivery.js";
import { getSessionsDir, persistLastTurnUsage } from "../storage/session.js";
import { createSubsystemLogger } from "../logging/index.js";
import type { ChannelRegistry } from "./channel.js";
import type { SessionBindingService } from "./session-binding.js";
import { relayToChannels } from "./channel-relay.js";

const log = createSubsystemLogger("gateway/agent-turn");

// Channel relay references for full sync (set during gateway startup)
let channelRegistryRef: ChannelRegistry | null = null;
let sessionBindingRef: SessionBindingService | null = null;
export function setAgentTurnChannelRelay(registry: ChannelRegistry, bindings: SessionBindingService): void {
  channelRegistryRef = registry;
  sessionBindingRef = bindings;
}

/**
 * Relay text to any external channels bound to `sessionKey` (Slack DM, etc.).
 * Wraps the module-level registry/bindings refs so callers outside this file
 * (heartbeat's display-only path, future cron path) can mirror their summary
 * to bound channels without taking a hard import on the relay plumbing.
 *
 * No-op if the channel relay refs haven't been wired by the gateway startup
 * (e.g., during tests with a minimal server harness).
 */
export function relayToBoundChannels(args: {
  sessionKey: string;
  text: string;
  origin: string;
}): void {
  if (!args.text) return;
  relayToChannels({
    sessionKey: args.sessionKey,
    text: args.text,
    registry: channelRegistryRef,
    bindings: sessionBindingRef,
    origin: args.origin,
  });
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AgentTurnRequest {
  /** Target session key (e.g., "web:general", "heartbeat:main", "cron:standup") */
  sessionKey: string;
  /** Synthetic user message — becomes user-role content in the session history */
  message: string;
  /** Which command lane to execute on (Main, Cron, etc.) */
  lane: CommandLane;
  /** Origin identifier for logging (e.g., "heartbeat", "cron:standup") */
  origin: string;
  /** Run headless (auto-approve tools, exclude ask_user). Default: true. */
  headless?: boolean;
}

export interface AgentTurnResult {
  /** Whether the turn completed successfully or errored */
  status: "completed" | "error";
  /** Last assistant text output, truncated to MAX_SUMMARY_CHARS (for logging/display) */
  summary: string;
  /** Full untruncated assistant text (for passing to downstream consumers like proactive delivery) */
  fullSummary: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Error message if status is "error" */
  error?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_SUMMARY_CHARS = 500;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Trigger a headless agent turn in any target session.
 *
 * Handles the full execution lifecycle:
 * 1. Lane serialization (session + global)
 * 2. Session creation / reuse
 * 3. Stream event subscription → WebSocket broadcast
 * 4. Agent loop execution (sendMessage)
 * 5. History persistence to disk
 *
 * If the target session already has an active turn, this call queues behind it
 * (automatic via session lane serialization, max concurrency 1).
 *
 * NOTE: `status: "error"` reflects infrastructure failures (lane timeout,
 * session creation failure, sendMessage rejection). AgentLoop.sendMessage
 * catches LLM/tool errors internally and emits error events instead of
 * throwing — those are reported as `status: "completed"` with the error
 * visible in stream events. This matches the original heartbeat/cron behavior.
 */
export async function triggerAgentTurn(
  request: AgentTurnRequest,
  deps: {
    sessions: AgentSessionManager;
    server: GatewayServer;
  },
): Promise<AgentTurnResult> {
  const {
    sessionKey,
    message,
    lane,
    origin,
    headless = true,
  } = request;

  const startMs = Date.now();
  let summary = "";
  let error: string | undefined;
  // Capture usage from the final `done` event so the sidebar ring and
  // chat footer have data after non-chat.send turns (heartbeat, cron, Slack).
  // A 0% / $0 done event is a real observation (short turn on 1M-context
  // model, fresh session), so zeros must be preserved — the sawDone flag
  // distinguishes "turn completed with 0" from "turn failed, no data".
  let sawDoneEvent = false;
  let lastContextUsagePercent = 0;
  let lastInputTokens: number | null = null;
  let lastOutputTokens: number | null = null;
  let lastCacheReadTokens: number | null = null;
  let lastCacheCreationTokens: number | null = null;
  let lastSessionCostUSD: number | null = null;

  try {
    await executeInSession(sessionKey, lane, async () => {
      const session = deps.sessions.getOrCreate(sessionKey);

      // Subscribe to stream events → broadcast to WebSocket clients + capture summary
      const unsub = session.loop.subscribe((event: StreamEvent) => {
        deps.server.broadcastToSession(
          sessionKey,
          `agent.${event.type}`,
          event,
        );

        // Accumulate assistant text for summary
        if (event.type === "text") {
          summary = event.replace ? event.content : summary + event.content;
        }
        // Capture usage on turn completion — mirrors the chat.send path.
        if (event.type === "done") {
          sawDoneEvent = true;
          if (event.usage?.context_usage_percent != null) {
            lastContextUsagePercent = event.usage.context_usage_percent;
          }
          if (event.usage?.input_tokens != null) lastInputTokens = event.usage.input_tokens;
          if (event.usage?.output_tokens != null) lastOutputTokens = event.usage.output_tokens;
          // Capture cache buckets too — without these the persisted total
          // tokens would shrink dramatically once prompt caching engages.
          if (event.usage?.cache_read_input_tokens != null) lastCacheReadTokens = event.usage.cache_read_input_tokens;
          if (event.usage?.cache_creation_input_tokens != null) lastCacheCreationTokens = event.usage.cache_creation_input_tokens;
          if ((event as any).sessionCostUSD != null) lastSessionCostUSD = (event as any).sessionCostUSD;
        }
      });

      try {
        const prevLength = session.loop.getHistory().length;

        await session.loop.sendMessage(message, { headless });

        // Persist all new messages (user + assistant + tool_use + tool_result)
        const history = session.loop.getHistory();
        const newMessages = history.slice(prevLength);
        for (const msg of newMessages) {
          session.sessionManager.appendMessage(msg);
        }
      } finally {
        unsub();
      }
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error("agent turn failed", { sessionKey, origin, error });
  }

  // Persist last-turn usage so the sidebar/footer reflect non-web turns too.
  // Only if we actually observed a done event; otherwise keep the prior value.
  if (sawDoneEvent) {
    persistLastTurnUsage(sessionKey, {
      contextUsagePercent: lastContextUsagePercent,
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens,
      cacheReadTokens: lastCacheReadTokens,
      cacheCreationTokens: lastCacheCreationTokens,
      sessionCostUSD: lastSessionCostUSD,
    });
  }

  const durationMs = Date.now() - startMs;

  // Truncate summary
  const truncated = summary.length > MAX_SUMMARY_CHARS
    ? summary.slice(0, MAX_SUMMARY_CHARS) + "..."
    : summary;

  log.info("agent turn completed", {
    sessionKey,
    origin,
    status: error ? "error" : "completed",
    durationMs,
    summaryLength: summary.length,
  });

  return {
    status: error ? "error" : "completed",
    summary: truncated,
    fullSummary: summary,
    durationMs,
    error,
  };
}

// -----------------------------------------------------------------------------
// Delivery text sanitization
// -----------------------------------------------------------------------------

/**
 * Clean up an agent's raw output before it's rendered to a user-visible
 * channel via `deliverToSession`.
 *
 * The heartbeat/cron agent runs in its own session where it sees
 * `<system-reminder>…</system-reminder>` blocks (from
 * `buildPerTurnReminders` in src/agent/context.ts) used as a convention
 * for injected app-side context. The model occasionally *imitates* that
 * pattern in its own output — e.g. "<system-reminder>Active task:
 * writing SKILL.md skeleton…</system-reminder>" — treating it as a
 * private scratchpad. That scratchpad has no business leaking into
 * the user's channel, so strip all such blocks here before delivery.
 * The original blocks still live in the heartbeat session's own history.
 *
 * Three invariants this function must respect (each was a Codex P2):
 *   1. **Preserve fenced code.** A literal `<system-reminder>` inside a
 *      ```…``` or ~~~…~~~ block is legitimate user-facing content
 *      (docs, log excerpts, troubleshooting examples); do not touch it.
 *   2. **Never rewrite bytes just for cosmetics.** Don't collapse
 *      3+ newlines — Markdown renders them identically to 2 anyway,
 *      but the Slack mirror and session history are byte-exact copies.
 *   3. **Empty after scrub = nothing to deliver.** The caller is
 *      expected to check for an empty return and skip the whole
 *      delivery (no blank proactive rows in the UI).
 *
 * Pure function — exported for testing.
 */
export function sanitizeDeliveredText(text: string): string {
  if (!text) return "";
  // Split on fenced code blocks so the strip only touches non-code regions.
  // The alternating pattern puts code fences on odd indices; prose on even.
  // Match both backtick (```) and tilde (~~~) fences, with an optional info
  // string after the opener (e.g. ```ts).
  const parts = text.split(
    /(```[^\n]*\n[\s\S]*?\n```|~~~[^\n]*\n[\s\S]*?\n~~~)/g,
  );
  const cleaned = parts.map((part, i) => {
    if (i % 2 === 1) return part; // inside a code fence — preserve verbatim
    return part
      // Paired <system-reminder>…</system-reminder>, case-insensitive,
      // non-greedy across newlines so adjacent blocks stay independent.
      .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
      // Defensive: unpaired opening/closing tags the model might emit.
      .replace(/<\/?system[-_]reminder[^>]*>/gi, "");
  });
  return cleaned.join("").trim();
}

// -----------------------------------------------------------------------------
// Proactive delivery — insert assistant message into target session
// -----------------------------------------------------------------------------

export interface DeliverToSessionRequest {
  /** Target session key (e.g., "web:general") */
  sessionKey: string;
  /** The text to deliver as an assistant message */
  text: string;
  /** Origin for logging and message metadata (e.g., "heartbeat", "cron:standup") */
  origin: string;
  /** Push notification config (optional) */
  delivery?: DeliveryConfig;
  /** Push notification title */
  notificationTitle?: string;
}

/**
 * Deliver a message to a target session as an assistant-role message.
 *
 * No LLM call — directly inserts the text as an assistant message in the
 * session's history, persists to disk, and broadcasts to WebSocket clients.
 * The message will be part of the conversation context on the next user turn.
 *
 * Runs through the session lane to avoid race conditions with concurrent turns
 * (e.g., if a user is chatting in the same session). Fire-and-forget from the
 * caller's perspective — the returned promise resolves when the lane processes it.
 *
 * Returns false immediately if the session doesn't exist (won't create with wrong cwd).
 */
export function deliverToSession(
  request: DeliverToSessionRequest,
  deps: {
    sessions: AgentSessionManager;
    server: GatewayServer;
  },
): boolean {
  const { sessionKey, text, origin } = request;

  // Check if the session exists either in memory or on disk.
  // Don't create a brand-new session — that would use the wrong cwd
  // and pollute the session list with unintended channels.
  const sessionId = sessionKey.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  const sessionFileExists = existsSync(join(getSessionsDir(), `${sessionId}.jsonl`));
  if (!deps.sessions.has(sessionKey) && !sessionFileExists) {
    log.debug("skipping delivery — target session does not exist", {
      sessionKey,
      origin,
    });
    return false;
  }

  // Run through the session lane to serialize with any active turns.
  // Fire-and-forget — we don't await, but the lane ensures ordering.
  // Uses getOrCreate to load from disk if the session exists but hasn't
  // been accessed yet (e.g., no client connected to that channel since restart).
  void executeInSession(sessionKey, CommandLane.Main, async () => {
    const session = deps.sessions.getOrCreate(sessionKey);

    // Format with a delivery header so the user can distinguish these
    // from regular conversation messages. Use matching icons from sidebar:
    // 🕐 for cron, ♡ for heartbeat.
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const isCronOrigin = origin.startsWith("cron:");
    const icon = isCronOrigin ? "\ud83d\udd50" : "\u2661"; // 🕐 or ♡
    const rawLabel = isCronOrigin ? origin.replace("cron:", "") : origin;
    // Sanitize: strip markdown-breaking characters from the source label
    const sourceLabel = rawLabel.replace(/[*_`~\[\]\\<>|#\n\r]/g, "");
    // Strip <system-reminder> blocks the model may have emitted as a
    // private scratchpad — they'd otherwise render verbatim in the channel.
    const cleanBody = sanitizeDeliveredText(text);
    // If the whole payload was scratchpad (or empty to begin with), skip
    // the delivery entirely. Otherwise we'd append a header-only row like
    // "♡ heartbeat — 09:00 PM" with no body to the target session.
    if (!cleanBody) {
      log.debug("delivery skipped — body empty after scrubbing", {
        sessionKey,
        origin,
      });
      return;
    }
    const formatted = `> ${icon} **${sourceLabel}** \u2014 ${time}\n\n${cleanBody}`;

    // Build assistant message
    const message: ChatMessage = {
      role: "assistant",
      content: [{ type: "text", text: formatted }],
      timestamp: new Date().toISOString(),
    };

    // Add to in-memory history so the LLM sees it on next turn
    // getHistory() returns a copy, so we must append and setHistory.
    const history = session.loop.getHistory();
    history.push(message);
    session.loop.setHistory(history);

    // Persist to session file
    session.sessionManager.appendMessage(message);

    // Broadcast to WebSocket clients so the web UI shows it immediately
    deps.server.broadcastToSession(sessionKey, "agent.text", {
      type: "text",
      content: formatted,
    });
    deps.server.broadcastToSession(sessionKey, "agent.done", {
      type: "done",
    });

    // Send push notification if configured — use the cleaned body so
    // the iOS banner doesn't include scratchpad <system-reminder> tags.
    if (request.delivery && cleanBody) {
      deliver({
        config: request.delivery,
        title: request.notificationTitle ?? `Hawky: ${origin}`,
        message: cleanBody.length > MAX_SUMMARY_CHARS
          ? cleanBody.slice(0, MAX_SUMMARY_CHARS) + "..."
          : cleanBody,
        sessionKey,
      });
    }

    // Full sync: relay to bound channels (Slack, etc.) — use the cleaned
    // body so Slack doesn't receive the scratchpad tags either.
    relayToChannels({
      sessionKey,
      text: cleanBody,
      registry: channelRegistryRef,
      bindings: sessionBindingRef,
      origin,
    });

    log.info("delivered to session", {
      sessionKey,
      origin,
      textLength: cleanBody.length,
    });
  }).catch((err) => {
    log.warn("delivery to session failed (non-fatal)", {
      sessionKey,
      origin,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return true;
}
