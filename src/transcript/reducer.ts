// =============================================================================
// Canonical Transcript Reducer
//
// ONE pure fold from StreamEvents to a rendered transcript. It replaced the
// per-client transition switches (TUI live + history fold, web live active +
// background + history parse, web-ios history flatten); each client now binds
// it through a thin selector + side-effect adapter:
//   - TUI:     src/tui/hooks/use_agent_loop.ts + src/tui/utils/transcript_display.ts
//   - web:     web/src/store/session-store.ts  + web/src/store/transcript-view.ts
//   - web-ios: web-ios/src/lib/useRealtime.ts  + web-ios/src/lib/transcript-view.ts
//
// PURITY CONTRACT: reduce/fromHistory are deterministic. No Date.now(),
// Math.random(), React, Zustand, node/browser APIs. Ids derive from event
// data (tool_use_id / history index) or a monotonic counter carried in the
// cursor. All side effects (throttled flush, badges, unread counts,
// pagination, terminal redraws, dialog state) belong to client adapters.
//
// CANONICAL BEHAVIOR CHOICES (where the old copies diverged — see the
// per-case comments for details):
//   1. tool output is stored as TYPED LINES (TUI shape); web joins them or
//      reads meta.resultContent for exact strings.
//   2. tool_result KEEPS streamed lines when present and prefers
//      display_content over content for the fallback lines (TUI rule); the
//      raw content/display_content are preserved in item meta so web's
//      selector can render exactly what it does today.
//   3. cancel finalizes streaming text UNSUFFIXED (web rule), flips in-flight
//      tools to status "error" with meta.cancelled=true, and emits a marker
//      system item; the " [cancelled]" suffix and "■ ..." wording are
//      selector concerns.
//   4. error-after-cancel suppression is sentinel-gated (web rule: only a
//      /aborted by (the )?user/i error right after a cancel is swallowed) —
//      strictly safer than the TUI's unconditional swallow.
//   5. user_committed stamps backendIndex on the last un-stamped user item
//      (web rule); the item ID stays stable so React keys never remount.
//   6. queue_message emits a system item (TUI rule); web's selector may
//      filter on meta.marker === "queue".
//   7. thinking accumulates in the cursor (full-union coverage); no client
//      renders it today.
//   8. permission/ask_user request+result events are transcript no-ops —
//      they are ephemeral dialog state with client-specific payload
//      normalization, and stay in adapters.
//   9. history tool_use defaults to "running" with a trailing-turn
//      reclassification pass and orphan-result stitching (web rule — strictly
//      more correct than the TUI history fold's "success" default).
//  10. replace of committed text happens IN PLACE (web rule); the reducer
//      reports the transition via cursor.replacedCommitted so the TUI
//      adapter can reproduce its Ink <Static> move-to-end + redraw.
// =============================================================================

import type { StreamEvent } from "../agent/types.js";
import type {
  HistoryBlock,
  HistoryMessage,
  TranscriptCursor,
  TranscriptItem,
  TranscriptMessageItem,
  TranscriptOutputLine,
  TranscriptRole,
  TranscriptState,
  TranscriptToolItem,
} from "./types.js";

// -----------------------------------------------------------------------------
// Construction
// -----------------------------------------------------------------------------

export function initialState(): TranscriptState {
  return {
    items: [],
    cursor: {
      streamingItemId: null,
      toolUseIdToItem: {},
      replaceTargetItemId: null,
      cancelPending: false,
      thinkingText: "",
      nextMessageSeq: 0,
      replacedCommitted: false,
      orphanToolResults: {},
    },
  };
}

/**
 * Append a user message (optimistic send bubble). There is no "user message"
 * StreamEvent — clients create the bubble at send time — but it must live in
 * the canonical state so `user_committed` can stamp its backendIndex.
 * Pure: the id comes from the cursor counter unless supplied.
 */
export function appendUserMessage(
  state: TranscriptState,
  text: string,
  opts?: { id?: string; backendIndex?: number; timestamp?: string; meta?: Record<string, unknown> },
): TranscriptState {
  const seq = state.cursor.nextMessageSeq;
  let id = opts?.id ?? `msg-${seq}`;
  let nextSeq = opts?.id !== undefined ? seq : seq + 1;
  if (opts?.id !== undefined) {
    // Caller-supplied ids must not collide with future seq-minted ids
    // (`msg-<n>`) — a shared id would make reduceText's append branch write
    // deltas into BOTH items. Advance the counter past a `msg-<n>`-shaped id,
    // and #n-suffix an id that already exists (same guard as tool ids).
    const m = /^msg-(\d+)$/.exec(opts.id);
    if (m) nextSeq = Math.max(nextSeq, Number(m[1]) + 1);
    if (state.items.some((it) => it.id === id)) {
      let n = 2;
      while (state.items.some((it) => it.id === `${opts.id}#${n}`)) n++;
      id = `${opts.id}#${n}`;
    }
  }
  const item: TranscriptMessageItem = {
    kind: "message",
    id,
    role: "user",
    text,
    done: true,
  };
  if (opts?.backendIndex !== undefined) item.backendIndex = opts.backendIndex;
  if (opts?.timestamp !== undefined) item.timestamp = opts.timestamp;
  if (opts?.meta !== undefined) item.meta = opts.meta;
  return {
    items: [...state.items, item],
    cursor: {
      ...state.cursor,
      nextMessageSeq: nextSeq,
    },
  };
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

/** Flat, ordered view of the transcript. Client selectors (toDisplayMessage /
 *  toSessionMessage) layer their own fields on top of these items. */
export function selectFlat(state: TranscriptState): TranscriptItem[] {
  return state.items.slice();
}

// -----------------------------------------------------------------------------
// Small pure helpers
// -----------------------------------------------------------------------------

/** Matches the backend user-abort sentinel ("Request aborted by user" and
 *  close variants). Mirrors web's isUserAbortError. */
export function isUserAbortError(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return /aborted by (the )?user/i.test(content);
}

/** Compact, deterministic one-line preview of a tool input. Deliberately
 *  minimal — clients with richer formatters recompute from meta.input. The
 *  tool name is accepted (and kept in the signature) for clients that key
 *  previews per-tool, but the default preview is name-agnostic — underscore
 *  so `noUnusedParameters` client tsconfigs can compile the core. */
export function formatInputPreview(_name: string, input: Record<string, unknown>): string {
  const pick = (key: string): string | null =>
    typeof input[key] === "string" && (input[key] as string).length > 0 ? (input[key] as string) : null;
  const raw =
    pick("command") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ??
    pick("query") ?? pick("url") ?? pick("question") ?? safeJson(input);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** Split result text into non-empty typed lines (both old copies drop empty
 *  lines here; raw strings survive in meta.resultContent). */
function splitResultLines(text: string, isError: boolean): TranscriptOutputLine[] {
  if (!text) return [];
  const type: "stdout" | "stderr" = isError ? "stderr" : "stdout";
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({ type, content: line }));
}

function coerceRole(role: unknown, fallback: TranscriptRole): TranscriptRole {
  return role === "user" || role === "assistant" || role === "system" ? role : fallback;
}

function newMessageId(cursor: TranscriptCursor): { id: string; cursor: TranscriptCursor } {
  const id = `msg-${cursor.nextMessageSeq}`;
  return { id, cursor: { ...cursor, nextMessageSeq: cursor.nextMessageSeq + 1 } };
}

function appendSystemItem(
  state: TranscriptState,
  text: string,
  meta?: Record<string, unknown>,
): TranscriptState {
  const { id, cursor } = newMessageId(state.cursor);
  const item: TranscriptMessageItem = { kind: "message", id, role: "system", text, done: true };
  if (meta !== undefined) item.meta = meta;
  return { items: [...state.items, item], cursor };
}

/** Mark the current streaming message (if any) done and clear the streaming
 *  cursor fields. Shared by tool_use_start / done / error / cancel. */
function finalizeStreaming(state: TranscriptState, opts?: { keepReplaceTarget?: boolean }): TranscriptState {
  const sid = state.cursor.streamingItemId;
  const items = sid
    ? state.items.map((it) => (it.id === sid && it.kind === "message" ? { ...it, done: true } : it))
    : state.items;
  return {
    items,
    cursor: {
      ...state.cursor,
      streamingItemId: null,
      replaceTargetItemId: opts?.keepReplaceTarget ? (sid ?? state.cursor.replaceTargetItemId) : null,
    },
  };
}

// -----------------------------------------------------------------------------
// reduce — the canonical live-event fold (covers the ENTIRE StreamEvent union)
// -----------------------------------------------------------------------------

export function reduce(state: TranscriptState, event: StreamEvent): TranscriptState {
  // replacedCommitted is a one-reduce transient signal: clear it up front so
  // it is only ever true immediately after the reduce that replaced
  // committed text.
  const base: TranscriptState = state.cursor.replacedCommitted
    ? { items: state.items, cursor: { ...state.cursor, replacedCommitted: false } }
    : state;

  switch (event.type) {
    case "text":
      return reduceText(base, event.content, event.replace === true);

    case "thinking":
      // Choice 7: accumulate for union coverage; no transcript item.
      return {
        items: base.items,
        cursor: { ...base.cursor, thinkingText: base.cursor.thinkingText + event.content },
      };

    case "tool_use_start": {
      // Commit any in-flight streaming text FIRST (both clients do this) so
      // the assistant message settles before the tool card; keep it as the
      // replace target so a later replace=true can still retarget it.
      const s = finalizeStreaming(base, { keepReplaceTarget: true });
      // Deterministic tool item id = tool_use_id (suffix only on the
      // pathological duplicate-id case, to keep ids unique for React keys).
      let id = event.tool_use_id;
      if (s.items.some((it) => it.id === id)) {
        let n = 2;
        while (s.items.some((it) => it.id === `${event.tool_use_id}#${n}`)) n++;
        id = `${event.tool_use_id}#${n}`;
      }
      const meta: Record<string, unknown> = { input: event.input };
      if (event.approvalReason !== undefined) meta.approvalReason = event.approvalReason;
      if (event.batchId !== undefined) meta.batchId = event.batchId;
      if (event.batchSize !== undefined) meta.batchSize = event.batchSize;
      const tool: TranscriptToolItem = {
        kind: "tool",
        id,
        toolUseId: event.tool_use_id,
        name: event.name,
        inputPreview: formatInputPreview(event.name, event.input),
        status: "running",
        output: [],
        meta,
      };
      // A tool_result for this id already arrived (out-of-order replayed /
      // re-broadcast stream) and was stashed as an orphan: consume it and
      // create the card already resolved — otherwise the earlier result is
      // permanently lost and the card would spin until the next done.
      const orphan = s.cursor.orphanToolResults[event.tool_use_id];
      if (orphan) {
        const resolved: TranscriptToolItem = {
          ...tool,
          status: orphan.isError ? "error" : "ok",
          output: splitResultLines(orphan.content, orphan.isError),
          meta: { ...meta, resultContent: orphan.content, isError: orphan.isError },
        };
        const orphans = { ...s.cursor.orphanToolResults };
        delete orphans[event.tool_use_id];
        return {
          items: [...s.items, resolved],
          cursor: { ...s.cursor, orphanToolResults: orphans },
        };
      }
      return {
        items: [...s.items, tool],
        cursor: {
          ...s.cursor,
          toolUseIdToItem: { ...s.cursor.toolUseIdToItem, [event.tool_use_id]: id },
        },
      };
    }

    case "tool_streaming": {
      const itemId = base.cursor.toolUseIdToItem[event.tool_use_id];
      if (!itemId) return base; // unknown tool — both clients no-op
      const line: TranscriptOutputLine = { type: event.stream_type, content: event.content };
      return {
        items: base.items.map((it) =>
          it.id === itemId && it.kind === "tool" ? { ...it, output: [...it.output, line] } : it,
        ),
        cursor: base.cursor,
      };
    }

    case "tool_result": {
      const itemId = base.cursor.toolUseIdToItem[event.tool_use_id];
      if (!itemId) {
        // Duplicate result (e.g. a replayed gateway broadcast) for a tool
        // that already resolved — the first result deleted the map entry,
        // but the item is retained, so look it up before declaring an
        // orphan. Drop it; the resolved card is the source of truth.
        if (base.items.some((it) => it.kind === "tool" && it.toolUseId === event.tool_use_id)) {
          return base;
        }
        // Orphan result (no matching tool_use_start). Stash it in the
        // cursor — the same mechanism fromHistory uses for cross-page
        // stitching — so an out-of-order tool_use_start (replayed /
        // re-broadcast gateway stream) can still resolve instead of
        // spinning forever with the result silently lost. TUI's safety
        // net kept: errors also surface as a system item; successes emit
        // nothing. Web (which ignored orphans) can filter on meta.marker.
        const stashed: TranscriptState = {
          items: base.items,
          cursor: {
            ...base.cursor,
            orphanToolResults: {
              ...base.cursor.orphanToolResults,
              [event.tool_use_id]: { content: event.content, isError: event.is_error },
            },
          },
        };
        if (!event.is_error) return stashed;
        return appendSystemItem(
          stashed,
          `Tool ${event.name} failed: ${event.content.slice(0, 200)}`,
          { marker: "orphan_tool_error" },
        );
      }
      // Choice 2: keep streamed lines when present, else split
      // display_content || content; preserve raw strings in meta.
      const resultLines = splitResultLines(event.display_content || event.content, event.is_error);
      const items = base.items.map((it) => {
        if (it.id !== itemId || it.kind !== "tool") return it;
        const meta: Record<string, unknown> = {
          ...it.meta,
          resultContent: event.content,
          isError: event.is_error,
        };
        if (event.display_content !== undefined) meta.displayContent = event.display_content;
        if (event.metadata !== undefined) meta.metadata = event.metadata;
        return {
          ...it,
          status: event.is_error ? ("error" as const) : ("ok" as const),
          output: it.output.length > 0 ? it.output : resultLines,
          meta,
        };
      });
      const toolUseIdToItem = { ...base.cursor.toolUseIdToItem };
      delete toolUseIdToItem[event.tool_use_id];
      return { items, cursor: { ...base.cursor, toolUseIdToItem } };
    }

    case "done": {
      let s = finalizeStreaming(base);
      // Settle tools still in flight, same as error/cancel do — done wipes
      // toolUseIdToItem below, so a tool left "running" here could NEVER
      // resolve (a late tool_result would hit the duplicate-result drop): a
      // permanent spinner in all three clients. A result-less tool at `done`
      // means the broadcast was dropped/never persisted, but the turn
      // COMPLETED — the model only continues past a tool once its result
      // came back — so settle as "ok" (matching fromHistory's reclassify
      // pass and the old TUI history default), tagged for selectors.
      // This also settles fromHistory-restored trailing "running" tools of a
      // dead session once the next turn completes.
      const inFlight = new Set(Object.values(s.cursor.toolUseIdToItem));
      if (inFlight.size > 0) {
        s = {
          items: s.items.map((it) =>
            it.kind === "tool" && inFlight.has(it.id) && it.status === "running"
              ? { ...it, status: "ok" as const, meta: { ...it.meta, settledByDone: true } }
              : it,
          ),
          cursor: s.cursor,
        };
      }
      return {
        items: s.items,
        cursor: {
          ...s.cursor,
          toolUseIdToItem: {},
          cancelPending: false, // web rule: done clears a stale cancel flag
          thinkingText: "",
        },
      };
    }

    case "error": {
      // Choice 4: sentinel-gated suppression. The cancel flag is consumed
      // either way so a stale flag can't leak into the next turn.
      const hadRecentCancel = base.cursor.cancelPending;
      const suppress = hadRecentCancel && isUserAbortError(event.content);
      let s = finalizeStreaming(base);
      // Settle in-flight tools (same as cancel, but marked aborted instead of
      // cancelled). The subsequent `done` wipes toolUseIdToItem, so a tool
      // left "running" here could never resolve — a permanent spinner.
      const inFlight = new Set(Object.values(s.cursor.toolUseIdToItem));
      if (inFlight.size > 0) {
        s = {
          items: s.items.map((it) =>
            it.kind === "tool" && inFlight.has(it.id) && it.status === "running"
              ? { ...it, status: "error" as const, meta: { ...it.meta, aborted: true } }
              : it,
          ),
          cursor: s.cursor,
        };
      }
      s = {
        items: s.items,
        cursor: { ...s.cursor, toolUseIdToItem: {}, cancelPending: false, thinkingText: "" },
      };
      if (suppress) return s;
      const meta: Record<string, unknown> = { marker: "error" };
      if (event.code !== undefined) meta.code = event.code;
      return appendSystemItem(s, `Error: ${event.content}`, meta);
    }

    case "cancel": {
      // Choice 3: finalize text unsuffixed, flip in-flight tools to "error"
      // with meta.cancelled=true, emit a marker item, arm cancelPending.
      let s = finalizeStreaming(base);
      const inFlight = new Set(Object.values(s.cursor.toolUseIdToItem));
      if (inFlight.size > 0) {
        s = {
          items: s.items.map((it) =>
            it.kind === "tool" && inFlight.has(it.id) && it.status === "running"
              ? { ...it, status: "error" as const, meta: { ...it.meta, cancelled: true } }
              : it,
          ),
          cursor: s.cursor,
        };
      }
      s = {
        items: s.items,
        cursor: { ...s.cursor, toolUseIdToItem: {}, cancelPending: true, thinkingText: "" },
      };
      return appendSystemItem(s, event.content, { marker: "cancel" });
    }

    case "queue_message":
      // Choice 6: emit the system item; selectors may reword or filter.
      return appendSystemItem(base, event.content, { marker: "queue", position: event.position });

    case "system_message": {
      const meta = event.subtype !== undefined ? { subtype: event.subtype } : undefined;
      return appendSystemItem(base, event.content, meta);
    }

    case "user_committed": {
      // Choice 5 (amended): commits arrive in SEND order, so stamping is
      // FIFO — the FIRST user item lacking a backendIndex is the oldest
      // pending send. (The old web code scanned backward, which cross-
      // stamped indices when two sends were pending — e.g. a queued message.)
      // History-derived items are explicitly SKIPPED (id prefix `msg-h`):
      // gateway rows normally carry msg.index, but fromHistory tolerates
      // legacy index-less rows, and stamping one of those would land the
      // commit on an old message while the real pending optimistic bubble
      // stays unstamped. The id stays stable — no React-key remount.
      for (let i = 0; i < base.items.length; i++) {
        const it = base.items[i];
        if (
          it.kind === "message" &&
          it.role === "user" &&
          it.backendIndex === undefined &&
          !it.id.startsWith("msg-h")
        ) {
          const items = base.items.slice();
          items[i] = { ...it, backendIndex: event.message_index };
          return { items, cursor: base.cursor };
        }
      }
      return base;
    }

    // Choice 8: ephemeral dialog traffic — transcript no-ops by design.
    case "permission_request":
    case "permission_result":
    case "ask_user_request":
    case "ask_user_response":
      return base;
  }
}

function reduceText(state: TranscriptState, content: string, replace: boolean): TranscriptState {
  const cursor = state.cursor;

  if (replace) {
    const targetId = cursor.streamingItemId ?? cursor.replaceTargetItemId;
    if (targetId) {
      // Choice 10: replace IN PLACE; report committed-text replacement via
      // the transient replacedCommitted flag (TUI redraw hook).
      const replacedCommitted = cursor.streamingItemId === null;
      const exists = state.items.some((it) => it.id === targetId);
      const items = exists
        ? state.items.map((it) =>
            it.id === targetId && it.kind === "message" ? { ...it, text: content, done: false } : it,
          )
        : [
            ...state.items,
            { kind: "message" as const, id: targetId, role: "assistant" as const, text: content, done: false },
          ];
      return {
        items,
        cursor: {
          ...cursor,
          streamingItemId: targetId,
          replaceTargetItemId: null,
          replacedCommitted,
        },
      };
    }
    // No target: fall through — a replace with nothing to replace starts a
    // fresh streaming message with the full content (both clients).
  }

  if (!cursor.streamingItemId) {
    const { id, cursor: c } = newMessageId(cursor);
    return {
      items: [...state.items, { kind: "message", id, role: "assistant", text: content, done: false }],
      cursor: { ...c, streamingItemId: id, replaceTargetItemId: null },
    };
  }

  // Plain delta append (replace=true never reaches here: an active stream is
  // always caught by the replace branch above).
  const sid = cursor.streamingItemId;
  return {
    items: state.items.map((it) =>
      it.id === sid && it.kind === "message" ? { ...it, text: it.text + content } : it,
    ),
    cursor,
  };
}

// -----------------------------------------------------------------------------
// fromHistory — the canonical persisted-history fold
//
// Replaces web's parseHistoryMessages + reclassifyLegacyRunningTools and the
// TUI's historyToDisplayMessages, and feeds web-ios's history selector.
// Semantics are canonicalized from web (choice 9): tool_use defaults to
// "running", flipped by a matching tool_result (same page, or a later page
// via cursor.orphanToolResults), with a trailing-turn timestamp pass flipping
// stale "running" tools in earlier turns to "ok". Diff-metadata synthesis
// (synthesizeMetadataFromInput) stays in the web selector — the full input is
// preserved in tool meta.input for it.
// -----------------------------------------------------------------------------

export function fromHistory(
  rows: HistoryMessage[],
  opts?: {
    /** Adapter-supplied namespace for LEGACY index-less rows. Row ids and
     *  synthesized batch ids derive from `msg.index` when present (already
     *  transcript-unique); index-less rows fall back to the row ORDINAL,
     *  which is only page-unique — an adapter folding multiple pages into
     *  one transcript (web pagination) must pass a per-page namespace
     *  (e.g. the beforeIndex cursor) so legacy ids can never collide
     *  across folds. */
    idNamespace?: string;
  },
): TranscriptState {
  const items: TranscriptItem[] = [];
  const orphanToolResults: Record<string, { content: string; isError: boolean }> = {};
  const ns = opts?.idNamespace ? `${opts.idNamespace}.` : "";

  for (let ri = 0; ri < rows.length; ri++) {
    const msg = rows[ri] ?? {};
    // Deterministic ids: prefer the absolute backend index (stable across
    // pagination folds); fall back to the (namespaced) row ordinal for
    // legacy rows.
    const rowBase = typeof msg.index === "number" ? `i${msg.index}` : `${ns}r${ri}`;
    let emit = 0;
    const nextId = () => `msg-h${rowBase}.${emit++}`;
    const itemCountBeforeRow = items.length;

    if (typeof msg.content === "string") {
      const item: TranscriptMessageItem = {
        kind: "message",
        id: nextId(),
        role: coerceRole(msg.role, "system"),
        text: msg.content,
        done: true,
      };
      if (msg.timestamp !== undefined) item.timestamp = msg.timestamp;
      if (typeof msg.index === "number") item.backendIndex = msg.index;
      items.push(item);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const blocks: HistoryBlock[] = msg.content;
    const hasToolResult = blocks.some((b) => b?.type === "tool_result");

    // Synthesize batchIds for ADJACENT runs of 2+ tool_use blocks only —
    // a run with no text between the tool_uses is what the model emits for
    // a parallel call. Interleaved text means a sequential narrated turn.
    // Batch ids are seeded from ROW IDENTITY (rowBase + run start), not a
    // per-call counter: separate fromHistory calls folded into one
    // transcript (web pagination) must never mint the same batch id for
    // unrelated turns — the web groups every message sharing a batchId
    // into a single ToolStep.
    const blockBatchIds: Array<string | undefined> = new Array(blocks.length).fill(undefined);
    let runStart = -1;
    for (let bi = 0; bi <= blocks.length; bi++) {
      const isToolUse = bi < blocks.length && blocks[bi]?.type === "tool_use";
      if (isToolUse) {
        if (runStart < 0) runStart = bi;
      } else if (runStart >= 0) {
        if (bi - runStart >= 2) {
          const bid = `hist-b${rowBase}.${runStart}`;
          for (let k = runStart; k < bi; k++) blockBatchIds[k] = bid;
        }
        runStart = -1;
      }
    }

    let textContent = "";
    const images: Array<{ base64: string; media_type: string }> = [];
    const documents: Array<{ media_type: string; filename: string; sizeBytes: number }> = [];

    const flushText = (opts: { trailing: boolean }) => {
      const fallbackText = images.length > 0 ? "(image attached)" : documents.length > 0 ? "(PDF attached)" : "";
      const text = textContent.trim() ? textContent : fallbackText;
      if (!textContent.trim() && images.length === 0 && documents.length === 0) return;
      const item: TranscriptMessageItem = {
        kind: "message",
        id: nextId(),
        role: coerceRole(msg.role, "assistant"),
        text,
        done: true,
      };
      if (msg.timestamp !== undefined) item.timestamp = msg.timestamp;
      // web stamps backendIndex only on the row's trailing flush (and on
      // string-content rows), not on interleaved narration segments.
      if (opts.trailing && typeof msg.index === "number") item.backendIndex = msg.index;
      const meta: Record<string, unknown> = {};
      if (images.length > 0) meta.images = images.slice();
      if (documents.length > 0) meta.documents = documents.slice();
      if (Object.keys(meta).length > 0) item.meta = meta;
      items.push(item);
      textContent = "";
      images.length = 0;
      documents.length = 0;
    };

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      if (!block || typeof block.type !== "string") continue;

      if (block.type === "image" && block.source?.type === "base64") {
        images.push({ base64: block.source.data ?? "", media_type: block.source.media_type ?? "" });
        continue;
      }
      if (block.type === "document" && block.source?.type === "base64") {
        const dataLen = typeof block.source.data === "string" ? block.source.data.length : 0;
        documents.push({
          media_type: block.source.media_type ?? "application/pdf",
          filename: typeof block.title === "string" && block.title ? block.title : "document",
          // Estimate raw bytes from base64 length so the pill can show size.
          sizeBytes: Math.ceil((dataLen * 3) / 4),
        });
        continue;
      }

      if (block.type === "text" && !hasToolResult) {
        // Text inside a tool_result turn is plumbing, not a bubble (web rule).
        textContent += block.text ?? "";
      } else if (block.type === "tool_use") {
        flushText({ trailing: false });
        const toolUseId = block.id ?? "";
        const name = block.name ?? "tool";
        const input = (block.input ?? {}) as Record<string, unknown>;
        const meta: Record<string, unknown> = { input };
        if (blockBatchIds[bi] !== undefined) meta.batchId = blockBatchIds[bi];
        // Same duplicate-id guard as the live path (reduce/tool_use_start):
        // ids must stay unique for React keys, and fromHistory must match
        // what the live fold would have produced for the same conversation.
        let toolItemId = toolUseId || nextId();
        if (items.some((it) => it.id === toolItemId)) {
          let n = 2;
          while (items.some((it) => it.id === `${toolItemId}#${n}`)) n++;
          toolItemId = `${toolItemId}#${n}`;
        }
        const tool: TranscriptToolItem = {
          kind: "tool",
          id: toolItemId,
          toolUseId,
          name,
          inputPreview: formatInputPreview(name, input),
          // Default "running" — flipped by a matching tool_result (this page
          // or a later one via orphan stitching) or the reclassify pass.
          status: "running",
          output: [],
          meta,
        };
        if (msg.timestamp !== undefined) tool.timestamp = msg.timestamp;
        items.push(tool);
      } else if (block.type === "tool_result") {
        const content =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((b) => b?.text ?? "").join("")
              : "";
        const isError = block.is_error === true;
        let tool: TranscriptToolItem | undefined;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.toolUseId === block.tool_use_id) {
            tool = it;
            break;
          }
        }
        if (tool) {
          const displayText = block.display_content || content;
          tool.status = isError ? "error" : "ok";
          tool.output = splitResultLines(displayText, isError);
          tool.meta = { ...tool.meta, resultContent: content, isError };
          if (block.display_content !== undefined) tool.meta.displayContent = block.display_content;
        } else if (block.tool_use_id) {
          // Orphan: the tool_use lives in an older, not-yet-loaded page.
          orphanToolResults[block.tool_use_id] = { content, isError };
        }
      }
      // thinking blocks (and unknown types) are not displayed on restore.
    }

    flushText({ trailing: true });

    // Legacy fallback (web line ~825): a non-tool-result turn that produced
    // nothing gets one joined-text bubble if there is anything to show.
    // Intent-preserving fix of web's old guard (`last.timestamp !==
    // msg.timestamp`), which silently dropped a legacy row whenever the
    // PREVIOUS row's items shared its timestamp (realistic for adjacent
    // same-second rows). "This row emitted nothing" is what it meant.
    if (!hasToolResult && items.length === itemCountBeforeRow) {
      const fallback = blocks
        .map((b) => b?.text ?? (typeof b?.content === "string" ? b.content : "") ?? "")
        .join("");
      if (fallback.trim()) {
        const item: TranscriptMessageItem = {
          kind: "message",
          id: nextId(),
          role: coerceRole(msg.role, "system"),
          text: fallback,
          done: true,
        };
        if (msg.timestamp !== undefined) item.timestamp = msg.timestamp;
        items.push(item);
      }
    }
  }

  reclassifyLegacyRunningTools(items);

  // Register tools still "running" after the reclassify pass (the trailing
  // turn's genuinely in-flight tools) so a LIVE tool_result reduced on top of
  // this state resolves the restored card — the reconnect/reload-mid-turn
  // path all three clients exercise. Without this, the result would hit the
  // orphan branch: success silently dropped, error adding a bogus system
  // item, and the spinner never settling. Last id wins on (pathological)
  // duplicate toolUseIds, matching the live map's behavior.
  const toolUseIdToItem: Record<string, string> = {};
  for (const it of items) {
    if (it.kind === "tool" && it.status === "running" && it.toolUseId) {
      toolUseIdToItem[it.toolUseId] = it.id;
    }
  }

  return {
    items,
    cursor: { ...initialState().cursor, toolUseIdToItem, orphanToolResults },
  };
}

/**
 * Flip stale "running" tools in NON-TRAILING historical turns to "ok".
 * The trailing turn (identified by the timestamp of the last timestamped
 * item) is the only one that can contain genuinely in-flight tools, because
 * the agent cannot start a new turn until the previous one's tools resolve.
 * Timestamp-less tools are live-streamed and untouched (web's Codex-P1
 * guard). Mutates `items` in place — called only on freshly built arrays.
 */
function reclassifyLegacyRunningTools(items: TranscriptItem[]): void {
  let trailingTs: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].timestamp !== undefined) {
      trailingTs = items[i].timestamp;
      break;
    }
  }
  if (trailingTs === undefined) return;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "tool" || it.status !== "running") continue;
    if (it.timestamp === undefined) continue; // live tool — leave alone
    if (it.timestamp === trailingTs) continue; // trailing turn — in flight
    items[i] = { ...it, status: "ok" };
  }
}
