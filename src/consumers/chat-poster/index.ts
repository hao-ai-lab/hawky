// voice:* sessions are interim substrate. Time-series sensors (vision,
// keystrokes) should NOT be added under this model — design an event-log
// substrate first, or this becomes a maintenance trap.

// =============================================================================
// chat-poster — turns `asr.final` events into user messages in the per-node
// voice-memo session. Reuses the same injection path as session.fork
// (AgentSessionManager.getOrCreate → loop.setHistory + sessionManager.appendMessage),
// so the gateway UI, persistence, and broadcast paths work unchanged.
//
// COALESCING
// ----------
// Consecutive memos arriving within `debounce_ms` are appended to a single
// pending user message (separated by `\n\n[HH:MM:SS] `) before the inject
// path runs. This bounds consecutive-user-role runs in voice:* sessions to
// at most one per debounce window, which keeps `session.fork` from voice
// sessions producing a forkable transcript: the trailing turn is a single
// coalesced user message, which Anthropic accepts as the next turn after
// fork. The chat.send guard on voice:* sessions still rejects (the archive
// is read-only); fork is the recovery path.
//
// AUTHORITATIVENESS NOTE
// ----------------------
// The in-memory transcript store + the `.transcript.json` sidecar (written
// by the ASR pipeline) are the durable surfaces for the transcript artifact.
// The session JSONL on disk is authoritative for chat history — if
// appendMessage fails after setHistory, the in-memory copy is the lie and
// the next boot will restore the JSONL. v0 trade-off: no rollback path on
// partial failure; this is acceptable while voice:* is interim substrate.
// =============================================================================

import { createSubsystemLogger } from "../../logging/index.js";
import { getBus } from "../../bus/index.js";
import type { AsrFinalEvent } from "../asr/events.js";
import type { AgentSessionManager } from "../../gateway/agent-sessions.js";
import type { GatewayServer } from "../../gateway/server.js";
import { executeInSession } from "../../gateway/lanes.js";
import { CommandLane } from "../../gateway/types.js";
import { getVoiceMemoSessionKey } from "./session-resolver.js";

const log = createSubsystemLogger("chat-poster");

// -----------------------------------------------------------------------------
// ChatPostEvent — published on the flat `chat.post` topic after a memo turn
// has been injected. Subscribers filter on event.session_id.
// -----------------------------------------------------------------------------

export interface ChatPostEvent {
  session_id: string;
  role: "user";
  text: string;
  /** Source media duration (ms), forwarded from AsrFinalEvent.media_duration_ms. */
  media_duration_ms?: number;
  source: {
    kind: "voice_memo";
    /** Comma-separated list of media_ids when this turn coalesced multiple memos. */
    media_id: string;
    backend: string;
  };
}

/**
 * Default denylist of "silent / hallucinated" transcripts that ASR backends
 * commonly emit on near-silent or background-noise audio. ON BY DEFAULT —
 * users don't need to configure anything to get a working voice-memo loop
 * that doesn't spam the chat with "Thank you." every few seconds.
 *
 * Compared case-insensitively, after trimming.
 */
const DEFAULT_SILENCE_DENYLIST: ReadonlyArray<string> = [
  "thank you.",
  "thank you",
  "thanks for watching.",
  "thanks for watching",
  "you",
  ".",
  "",
];

/** Default minimum confidence — drop if the backend is < this. Off if no confidence reported. */
const DEFAULT_MIN_CONFIDENCE = 0.4;

/** Default minimum media duration — drop sub-half-second blips entirely. */
const DEFAULT_MIN_DURATION_MS = 500;

/** Default debounce window between memos before flushing a coalesced turn. */
const DEFAULT_DEBOUNCE_MS = 5000;

/** Default max age of a pending coalesce buffer before forced flush. */
const DEFAULT_FLUSH_AGE_MS = 30000;

/** Default max number of memos coalesced into one turn. */
const DEFAULT_MAX_ITEMS = 20;

/** Default max chars per coalesced turn. */
const DEFAULT_MAX_CHARS = 8000;

export interface ChatPosterConfig {
  enabled: boolean;
  session_id_override: string | null;
  prefix: string;
  include_confidence: boolean;
  /** If unset, falls back to DEFAULT_SILENCE_DENYLIST. Pass [] to disable. */
  silence_denylist?: ReadonlyArray<string>;
  /** Minimum reported confidence. Defaults to DEFAULT_MIN_CONFIDENCE. */
  min_confidence?: number;
  /** Minimum captured media duration. Defaults to DEFAULT_MIN_DURATION_MS. */
  min_duration_ms?: number;
  /** Inactivity window before a pending coalesce buffer flushes. */
  debounce_ms?: number;
  /** Hard cap on a pending buffer's age (from first event). */
  flush_age_ms?: number;
  /** Hard cap on number of memos coalesced into one turn. */
  max_items?: number;
  /** Hard cap on coalesced text length. */
  max_chars?: number;
}

export interface ChatPosterDeps {
  sessions: AgentSessionManager;
  server?: GatewayServer;
  config: ChatPosterConfig;
}

// -----------------------------------------------------------------------------
// Coalesce buffer — one per session key.
// -----------------------------------------------------------------------------

interface PendingMemo {
  body: string;
  capturedStartIso: string;
  mediaId: string;
  backend: string;
}

interface CoalesceBuffer {
  sessionKey: string;
  memos: PendingMemo[];
  firstEventAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function registerChatPoster(deps: ChatPosterDeps): () => void {
  const { config, sessions, server } = deps;
  if (!config.enabled) {
    log.info("chat-poster disabled — skipping subscription");
    return () => {};
  }

  const buffers = new Map<string, CoalesceBuffer>();
  const debounceMs = config.debounce_ms ?? DEFAULT_DEBOUNCE_MS;
  const flushAgeMs = config.flush_age_ms ?? DEFAULT_FLUSH_AGE_MS;
  const maxItems = config.max_items ?? DEFAULT_MAX_ITEMS;
  const maxChars = config.max_chars ?? DEFAULT_MAX_CHARS;

  const bus = getBus();
  const unsub = bus.subscribe<AsrFinalEvent>("asr.final", async (event) => {
    try {
      await handleAsrFinal(event, config, sessions, server, buffers, {
        debounceMs,
        flushAgeMs,
        maxItems,
        maxChars,
      });
    } catch (err) {
      log.warn("chat-poster handler failed", {
        media_id: event.media_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  log.info("chat-poster registered", {
    prefix: config.prefix,
    override: config.session_id_override,
    debounce_ms: debounceMs,
    flush_age_ms: flushAgeMs,
    max_items: maxItems,
    max_chars: maxChars,
  });

  return () => {
    unsub();
    // Best-effort: synchronously flush any pending buffers (fire-and-forget).
    for (const buf of buffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
      void flushBuffer(buf, sessions, server).catch((err) => {
        log.warn("shutdown flush failed", {
          sessionKey: buf.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    buffers.clear();
  };
}

/**
 * Returns true when the transcript looks like a silence/hallucination and
 * should be dropped. Defensive defaults — runs even with no user config.
 */
export function isLikelySilence(
  text: string,
  event: AsrFinalEvent,
  config: ChatPosterConfig,
): boolean {
  const denylist = config.silence_denylist ?? DEFAULT_SILENCE_DENYLIST;
  const minDuration = config.min_duration_ms ?? DEFAULT_MIN_DURATION_MS;
  const minConfidence = config.min_confidence ?? DEFAULT_MIN_CONFIDENCE;

  // Empty / whitespace-only → drop.
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;

  // Denylist match → drop. Compared case-insensitively after trim.
  if (denylist.some((bad) => bad.trim().toLowerCase() === normalized)) {
    return true;
  }

  // Sub-threshold media duration → drop.
  if (
    typeof event.media_duration_ms === "number" &&
    event.media_duration_ms < minDuration
  ) {
    return true;
  }

  // Sub-threshold confidence (when reported) → drop.
  // Confidence on the AsrFinalEvent rides on segments. Use the mean of
  // reported segment confidences.
  const confidences = (event.segments ?? [])
    .map((s) => s.confidence)
    .filter((c): c is number => typeof c === "number");
  if (confidences.length > 0) {
    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    if (mean < minConfidence) return true;
  }

  return false;
}

export function likelySilenceDropLogMetadata(event: AsrFinalEvent): Record<string, unknown> {
  const confidences = (event.segments ?? [])
    .map((s) => s.confidence)
    .filter((c): c is number => typeof c === "number");
  const meanConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : undefined;

  return {
    media_id: event.media_id,
    media_duration_ms: event.media_duration_ms,
    transcript_chars: event.text.trim().length,
    segment_count: event.segments?.length ?? 0,
    ...(meanConfidence !== undefined ? { mean_confidence: meanConfidence } : {}),
  };
}

interface CoalesceLimits {
  debounceMs: number;
  flushAgeMs: number;
  maxItems: number;
  maxChars: number;
}

async function handleAsrFinal(
  event: AsrFinalEvent,
  config: ChatPosterConfig,
  sessions: AgentSessionManager,
  server: GatewayServer | undefined,
  buffers: Map<string, CoalesceBuffer>,
  limits: CoalesceLimits,
): Promise<void> {
  const text = event.text.trim();
  if (!text) {
    log.info("skipping empty transcript", { media_id: event.media_id });
    return;
  }

  if (isLikelySilence(text, event, config)) {
    log.info("dropping likely-silence transcript", likelySilenceDropLogMetadata(event));
    return;
  }

  const sessionKey = getVoiceMemoSessionKey(config.session_id_override);
  const body = config.prefix + text;
  const memo: PendingMemo = {
    body,
    capturedStartIso: event.captured_start_iso,
    mediaId: event.media_id,
    backend: event.backend,
  };

  const now = Date.now();
  const existing = buffers.get(sessionKey);

  // Decide: append vs flush-then-start-new.
  const wouldOverflowChars =
    existing &&
    coalescedText(existing.memos).length +
      separator(memo.capturedStartIso).length +
      memo.body.length >
      limits.maxChars;
  const wouldOverflowItems =
    existing && existing.memos.length + 1 > limits.maxItems;
  const tooOld =
    existing && now - existing.firstEventAt >= limits.flushAgeMs;

  if (existing && (wouldOverflowChars || wouldOverflowItems || tooOld)) {
    if (existing.timer) clearTimeout(existing.timer);
    buffers.delete(sessionKey);
    await flushBuffer(existing, sessions, server);
  }

  let buf = buffers.get(sessionKey);
  if (!buf) {
    buf = {
      sessionKey,
      memos: [memo],
      firstEventAt: now,
      timer: null,
    };
    buffers.set(sessionKey, buf);
  } else {
    buf.memos.push(memo);
    if (buf.timer) clearTimeout(buf.timer);
  }

  // Schedule the inactivity flush.
  const target = buf;
  buf.timer = setTimeout(() => {
    if (buffers.get(sessionKey) === target) {
      buffers.delete(sessionKey);
    }
    void flushBuffer(target, sessions, server).catch((err) => {
      log.warn("debounce flush failed", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, limits.debounceMs);
}

function separator(capturedStartIso: string): string {
  const hhmmss = formatHHMMSS(capturedStartIso);
  return `\n\n[${hhmmss}] `;
}

function coalescedText(memos: ReadonlyArray<PendingMemo>): string {
  if (memos.length === 0) return "";
  const head = memos[0].body;
  let out = head;
  for (let i = 1; i < memos.length; i++) {
    out += separator(memos[i].capturedStartIso) + memos[i].body;
  }
  return out;
}

function formatHHMMSS(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "??:??:??";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "??:??:??";
  }
}

async function flushBuffer(
  buf: CoalesceBuffer,
  sessions: AgentSessionManager,
  server: GatewayServer | undefined,
): Promise<void> {
  if (buf.memos.length === 0) return;
  const body = coalescedText(buf.memos);
  const sessionKey = buf.sessionKey;
  const last = buf.memos[buf.memos.length - 1];
  const mediaIds = buf.memos.map((m) => m.mediaId).join(",");

  // Serialize through the session lane so concurrent chat turns and
  // concurrent flushes never race on `loop.setHistory` /
  // `sessionManager.appendMessage`. Mirrors `deliverToSession` (used by
  // heartbeat + cron) — direct mutation outside the lane is the exact
  // bug family that pattern exists to prevent.
  await executeInSession(sessionKey, CommandLane.Main, async () => {
    const session = sessions.getOrCreate(sessionKey);

    const chatMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: body }],
      timestamp: new Date().toISOString(),
    };

    // Mirror session.fork's pattern (src/gateway/agent-methods.ts#session.fork):
    // append to in-memory history, then persist to disk. setHistory is O(N) per
    // turn — acceptable while voice:* is interim substrate; revisit alongside
    // the event-log substrate decision.
    const history = session.loop.getHistory();
    session.loop.setHistory([...history, chatMessage]);
    session.sessionManager.appendMessage(chatMessage);

    // Re-publish a normalized ChatPostEvent so other consumers can observe it.
    const chatEvent: ChatPostEvent = {
      session_id: sessionKey,
      role: "user",
      text: body,
      source: {
        kind: "voice_memo",
        media_id: mediaIds,
        backend: last.backend,
      },
    };
    getBus().publish("chat.post", chatEvent);

    // Broadcast session.updated so clients refetch history (same pattern
    // session.fork uses — see src/gateway/agent-methods.ts).
    if (server) {
      try {
        server.broadcast("session.updated", { sessionKey });
      } catch (err) {
        log.warn("broadcast failed (non-fatal)", {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("voice memo posted", {
      sessionKey,
      memos: buf.memos.length,
      media_ids: mediaIds,
      chars: body.length,
    });
  });
}
