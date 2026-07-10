// =============================================================================
// Canonical Transcript Types
//
// The shared "stream events -> rendered transcript" model consumed by all
// TS clients (TUI, web, web-ios). This module is PURE and deployment-neutral:
// it imports ONLY types from src/agent/types.ts (which has zero runtime
// imports), uses no React/Zustand/node APIs, and never touches
// Date.now()/Math.random() — ids and timestamps come from events or are
// injected by adapters. The whole TranscriptState is JSON-serializable so
// golden fixtures (and future gateway-side snapshots) can round-trip it.
// =============================================================================

import type { StreamEvent } from "../agent/types.js";

export type { StreamEvent };

// -----------------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------------

export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptToolStatus = "running" | "ok" | "error";

/** One line of live tool output (canonical storage is TYPED LINES — the TUI
 *  renders them directly; web's selector joins them / falls back to
 *  `meta.resultContent` for exact string fidelity). */
export interface TranscriptOutputLine {
  type: "stdout" | "stderr";
  content: string;
}

export interface TranscriptMessageItem {
  kind: "message";
  /** Deterministic id: `msg-<seq>` from the cursor's monotonic counter for
   *  live items, or a history-index-derived id from `fromHistory`. Stable for
   *  the item's lifetime (safe as a React key — `user_committed` stamps
   *  `backendIndex` as a FIELD instead of rewriting the id, so bubbles never
   *  remount mid-stream). */
  id: string;
  role: TranscriptRole;
  text: string;
  /** False only while this item is the active streaming target. */
  done: boolean;
  /** Absolute append-only index in the backend history (from `user_committed`
   *  live, or `msg.index` in history). Powers edit affordances + pagination. */
  backendIndex?: number;
  /** ISO timestamp — only present for history-derived items. Live items carry
   *  none (the core never calls Date.now(); adapters may stamp their own). */
  timestamp?: string;
  /** Client-neutral extras. Known keys:
   *  - marker: "cancel" | "error" | "queue" | "orphan_tool_error" — lets
   *    selectors restyle/filter reducer-emitted system items.
   *  - subtype: system_message subtype ("compaction" | "heartbeat" | "info").
   *  - code: error code from ErrorStreamEvent.
   *  - position: queue position from QueueMessageEvent.
   *  - images / documents: attachments extracted by fromHistory.
   */
  meta?: Record<string, unknown>;
}

export interface TranscriptToolItem {
  kind: "tool";
  /** Deterministic id = tool_use_id (suffixed `#n` only on the pathological
   *  case of a duplicate tool_use_id in one transcript). */
  id: string;
  toolUseId: string;
  name: string;
  /** Compact, deterministic one-line preview of the input. Clients with
   *  richer formatters can recompute from `meta.input`. */
  inputPreview: string;
  status: TranscriptToolStatus;
  /** Typed output lines: live tool_streaming lines are KEPT when a
   *  tool_result arrives (canonicalized from the TUI — live bash output is
   *  richer than the truncated result); otherwise the result content is
   *  split into lines. Raw result strings live in meta for web fidelity. */
  output: TranscriptOutputLine[];
  /** ISO timestamp — history-derived items only (see message item note). */
  timestamp?: string;
  /** Client-neutral extras. Known keys:
   *  - input: the full tool input record (source for fullInput / metadata
   *    synthesis / richer previews in client selectors).
   *  - approvalReason / batchId / batchSize: from ToolUseStartEvent.
   *  - resultContent: raw ToolResultEvent.content (exact string web renders).
   *  - displayContent: raw ToolResultEvent.display_content.
   *  - metadata: ToolResultEvent.metadata (e.g. diff data).
   *  - isError: raw is_error flag.
   *  - cancelled: true when flipped to "error" by a cancel event.
   *  - aborted: true when flipped to "error" by an error event (the turn
   *    died with this tool still in flight).
   *  - settledByDone: true when flipped to "ok" by a done event (the turn
   *    completed but this tool's result broadcast never arrived).
   */
  meta?: Record<string, unknown>;
}

export type TranscriptItem = TranscriptMessageItem | TranscriptToolItem;

// -----------------------------------------------------------------------------
// Cursor (streaming bookkeeping)
// -----------------------------------------------------------------------------

export interface TranscriptCursor {
  /** Item id of the in-flight streaming assistant message (text deltas append
   *  here), or null when no text is streaming. */
  streamingItemId: string | null;
  /** tool_use_id -> item id for in-flight tools (plain object, not Map, so
   *  the state stays JSON-serializable for fixtures/snapshots). */
  toolUseIdToItem: Record<string, string>;
  /** After tool_use_start commits streaming text, a later `text` event with
   *  replace=true retargets this committed item (in place — canonicalized
   *  from web; the TUI's move-to-end + terminal redraw is an adapter side
   *  effect keyed off `replacedCommitted`). */
  replaceTargetItemId: string | null;
  /** Sentinel-gated error suppression, canonicalized from web (strictly safer
   *  than the TUI's unconditional swallow): set by `cancel`, consumed by the
   *  NEXT `error` (suppressing it only when the content matches the
   *  user-abort sentinel), and cleared by `done`. */
  cancelPending: boolean;
  /** Accumulated extended-thinking deltas for the current turn. Neither
   *  client renders thinking today, but the reducer must cover the full
   *  StreamEvent union — selectors simply ignore this. Cleared on
   *  done/error/cancel. */
  thinkingText: string;
  /** Monotonic counter for deterministic live message-item ids (`msg-<n>`).
   *  Replaces the clients' module-level nextId()/msgId() counters. */
  nextMessageSeq: number;
  /** Transient, valid only immediately after a reduce(): true when that
   *  reduce replaced ALREADY-COMMITTED text (replace=true landing on the
   *  replaceTarget). The TUI adapter uses it to reproduce its Ink <Static>
   *  filter+re-append+redraw; everyone else ignores it. Reset by the next
   *  reduce(). */
  replacedCommitted: boolean;
  /** Unmatched tool_results, keyed by tool_use_id. Populated by fromHistory
   *  (results whose tool_use lives in an older, not-yet-loaded history page —
   *  the pagination adapter applies these when that page arrives, web's
   *  orphanResults cross-page stitching) AND by reduce (a live result that
   *  arrived before its tool_use_start on a replayed/re-broadcast stream —
   *  consumed by the late tool_use_start so the card is created resolved). */
  orphanToolResults: Record<string, { content: string; isError: boolean }>;
}

export interface TranscriptState {
  items: TranscriptItem[];
  cursor: TranscriptCursor;
}

// -----------------------------------------------------------------------------
// History input (gateway `session.history` rows)
// -----------------------------------------------------------------------------

/** Permissive content-block shape, mirroring the tolerance of the client
 *  parsers this replaces (legacy rows, string content, missing fields). */
export interface HistoryBlock {
  type: string;
  // text
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
  display_content?: string;
  // image / document
  source?: { type?: string; media_type?: string; data?: string };
  title?: string;
}

export interface HistoryMessage {
  /** Absolute append-only history position — stable pagination cursor and
   *  the deterministic id source for history-derived items. */
  index?: number;
  role?: string;
  /** ISO timestamp (drives legacy running-tool reclassification). */
  timestamp?: string;
  /** ContentBlock[] normally; plain string for legacy/system rows. */
  content?: string | HistoryBlock[];
}
