// =============================================================================
// Canonical Transcript → DisplayMessage Selector (TUI adapter layer)
//
// The TUI's thin binding on top of the shared transcript reducer
// (src/transcript). The reducer owns ALL transition logic ("stream events →
// rendered transcript"); this module only maps canonical TranscriptItems to
// the TUI's DisplayMessage shape and layers the TUI-only presentation fields
// that the pure core deliberately does not track:
//   - wall-clock timestamps + tool startedAt (stamped by the hook, since the
//     core never calls Date.now())
//   - the " [cancelled]" suffix on text that was streaming when a cancel hit
//   - TUI wording for reducer-emitted marker items (cancel / queue hints)
//   - the Ink <Static> move-to-end order override used when replace=true
//     lands on already-committed text (cursor.replacedCommitted)
// =============================================================================

import {
  fromHistory,
  selectFlat,
  type HistoryMessage,
  type TranscriptItem,
  type TranscriptState,
} from "../../transcript/index.js";
import type { DisplayMessage, ToolDisplayStatus } from "../types.js";
import { formatToolPreview } from "./format_tool_preview.js";

/** TUI wording for the reducer's cancel marker item (COCO pattern). */
const CANCEL_HINT = "■ Interrupted — tell Hawky what to do next.";

/** TUI wording for the reducer's queue marker item. */
const QUEUE_HINT = "Message queued — agent is busy.";

/**
 * Per-item TUI-only presentation state, keyed by canonical item id.
 * Owned by the useAgentLoop hook (side-effect land) — never by the core.
 */
export interface DisplayOverlay {
  /** ISO timestamp stamped when the item first appeared (live items only —
   *  history items carry their own canonical timestamp). */
  timestamp?: string;
  /** Date.now() when a tool item was created (drives the elapsed timer). */
  startedAt?: number;
  /** True when this message was the streaming target when a cancel event
   *  landed — renders with the " [cancelled]" suffix. */
  cancelled?: boolean;
  /** Order override: fractional sort key that moves this item to what was
   *  the end of the list at override time (Ink <Static> re-append rule for
   *  replace-of-committed-text). Unset items sort by canonical index. */
  sortKey?: number;
}

/**
 * Map one canonical transcript item to the TUI's DisplayMessage shape,
 * layering the TUI-only overlay fields on top.
 */
export function toDisplayMessage(item: TranscriptItem, overlay?: DisplayOverlay): DisplayMessage {
  const timestamp = item.timestamp ?? overlay?.timestamp ?? "";

  if (item.kind === "tool") {
    const meta = item.meta ?? {};
    const input = (meta.input as Record<string, unknown> | undefined) ?? {};
    const status: ToolDisplayStatus =
      item.status === "running" ? "executing"
      : item.status === "ok" ? "success"
      : meta.cancelled === true ? "canceled"
      : "error";
    return {
      id: item.id,
      role: "tool",
      text: "",
      timestamp,
      toolData: {
        toolUseId: item.toolUseId,
        toolName: item.name,
        // Recompute with the TUI's richer formatter from the full input the
        // core preserves in meta (the core's inputPreview is deliberately
        // minimal and client-neutral).
        inputPreview: formatToolPreview(item.name, input),
        status,
        outputLines: item.output,
        isError: meta.isError === true,
        metadata: meta.metadata as Record<string, unknown> | undefined,
        startedAt: overlay?.startedAt,
        approvalReason: meta.approvalReason as string | undefined,
        batchId: meta.batchId as string | undefined,
        batchSize: meta.batchSize as number | undefined,
      },
    };
  }

  // Message item — reword reducer marker items to the TUI's fixed strings.
  let text = item.text;
  const marker = item.meta?.marker;
  if (marker === "cancel") text = CANCEL_HINT;
  else if (marker === "queue") text = QUEUE_HINT;
  if (overlay?.cancelled) text = `${text} [cancelled]`;

  return { id: item.id, role: item.role, text, timestamp };
}

/**
 * Derive the full ordered DisplayMessage list from canonical state.
 * Overlay sortKeys (move-to-end after replace-of-committed) override the
 * canonical index; the sort is stable so everything else keeps its order.
 */
export function deriveDisplayMessages(
  state: TranscriptState,
  overlays?: ReadonlyMap<string, DisplayOverlay>,
): DisplayMessage[] {
  const keyed = selectFlat(state).map((item, index) => {
    const overlay = overlays?.get(item.id);
    return { key: overlay?.sortKey ?? index, msg: toDisplayMessage(item, overlay) };
  });
  keyed.sort((a, b) => a.key - b.key);
  return keyed.map((k) => k.msg);
}

/**
 * Fold persisted history rows straight to DisplayMessages (session resume).
 * Replaces the deleted src/tui/utils/history_to_display.ts — the transition
 * logic now lives in the shared core's fromHistory.
 */
export function historyToDisplay(rows: HistoryMessage[]): DisplayMessage[] {
  return deriveDisplayMessages(fromHistory(rows));
}
