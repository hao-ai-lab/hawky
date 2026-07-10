// =============================================================================
// Canonical Transcript → SessionMessage Selector (web adapter layer)
//
// The web client's thin binding on top of the shared transcript reducer
// (@hawky/transcript → src/transcript). The reducer owns ALL transition
// logic ("stream events → rendered transcript"); this module only maps
// canonical TranscriptItems to the web store's SessionMessage shape and
// layers the web-only presentation fields the pure core deliberately does
// not track:
//   - tool startedAt (stamped by the store, since the core never calls
//     Date.now())
//   - the slash-command chip on system messages (addSystemMessage)
//   - inputPreview / fullInput recomputed with the web's own formatters
//     from the full input the core preserves in item meta
//   - diff-metadata synthesis for history-restored edit_file/write_file
//     (synthesizeMetadataFromInput), derived at selection time so it can
//     never go stale when a tool's status flips
//   - web wording for the reducer's cancel marker item
// =============================================================================

import { selectFlat, type TranscriptItem, type TranscriptState } from "@hawky/transcript";
import type { SessionMessage } from "./session-store";

/** Web wording for the reducer's cancel marker item. */
const CANCEL_NOTICE = "■ Generation stopped.";

/**
 * Per-item web-only presentation state, keyed by canonical item id.
 * Owned by the session store (side-effect land) — never by the core.
 */
export interface SessionOverlay {
  /** Date.now() when a live tool item was created (drives elapsed time). */
  startedAt?: number;
  /** True for items created from live stream events (vs history restore).
   *  Live tools take `meta.metadata` verbatim from the tool_result event;
   *  history-restored tools synthesize diff metadata from the preserved
   *  input on success. */
  live?: boolean;
  /** Slash-command chip for system messages added via addSystemMessage. */
  command?: string;
}

/**
 * The old web handler had no queue_message case and silently ignored orphan
 * tool_results — filter the reducer's marker items for those, keeping the
 * rendered transcript identical.
 */
export function shouldDisplay(item: TranscriptItem): boolean {
  if (item.kind !== "message") return true;
  const marker = item.meta?.marker;
  return marker !== "queue" && marker !== "orphan_tool_error";
}

/**
 * Map one canonical transcript item to the web store's SessionMessage shape,
 * layering the web-only overlay fields on top.
 */
export function toSessionMessage(item: TranscriptItem, overlay?: SessionOverlay): SessionMessage {
  if (item.kind === "tool") {
    const meta = item.meta ?? {};
    const input = (meta.input as Record<string, unknown> | undefined) ?? {};
    const status: "running" | "success" | "error" =
      item.status === "running" ? "running" : item.status === "ok" ? "success" : "error";
    // Exact result string once a result has arrived (the raw content the old
    // handlers stored verbatim); before that, the live streamed lines joined
    // exactly as the old tool_streaming handler accumulated them.
    const output =
      typeof meta.resultContent === "string"
        ? meta.resultContent
        : item.output.map((line) => line.content + "\n").join("");
    // Live tools carry the tool_result event's metadata verbatim. History
    // tools synthesize diff metadata from the preserved input — but only on
    // success, so a failed or in-flight edit never renders a fake diff.
    const metadata = overlay?.live
      ? (meta.metadata as Record<string, unknown> | undefined)
      : item.status === "ok"
        ? ((meta.metadata as Record<string, unknown> | undefined) ?? synthesizeMetadataFromInput(item.name, input))
        : undefined;
    return {
      id: item.id,
      role: "tool",
      content: "",
      timestamp: item.timestamp,
      tool: {
        toolUseId: item.toolUseId,
        name: item.name,
        inputPreview: formatToolPreview(item.name, input),
        fullInput: buildFullInput(item.name, input),
        status,
        output,
        isError: meta.isError === true,
        metadata,
        startedAt: overlay?.startedAt,
        batchId: meta.batchId as string | undefined,
      },
    };
  }

  const meta = item.meta ?? {};
  let content = item.text;
  if (meta.marker === "cancel") content = CANCEL_NOTICE;
  const msg: SessionMessage = {
    id: item.id,
    role: item.role,
    content,
    timestamp: item.timestamp,
    backendIndex: item.backendIndex,
    images: meta.images as SessionMessage["images"],
    documents: meta.documents as SessionMessage["documents"],
  };
  if (overlay?.command) msg.command = overlay.command;
  return msg;
}

/** Full ordered projection of a canonical transcript (fresh history load). */
export function deriveSessionMessages(
  state: TranscriptState,
  overlays: Record<string, SessionOverlay>,
): SessionMessage[] {
  return selectFlat(state)
    .filter(shouldDisplay)
    .map((item) => toSessionMessage(item, overlays[item.id]));
}

/**
 * Mirror a canonical transition into an existing SessionMessage[]
 * INCREMENTALLY: re-render rows whose canonical item changed, append items
 * that are new relative to `prev`. Never removes or reorders — matching the
 * old per-event handlers, and preserving any rows the client (or a test)
 * placed in the array outside the canonical state.
 */
export function syncMessages(
  messages: SessionMessage[],
  prev: TranscriptState,
  next: TranscriptState,
  overlays: Record<string, SessionOverlay>,
): SessionMessage[] {
  if (prev.items === next.items) return messages;
  const prevById = new Map<string, TranscriptItem>();
  for (const item of prev.items) prevById.set(item.id, item);

  const changed = new Map<string, SessionMessage>();
  const appended: SessionMessage[] = [];
  for (const item of next.items) {
    const before = prevById.get(item.id);
    if (before === item) continue; // untouched by this transition
    if (!shouldDisplay(item)) continue;
    const msg = toSessionMessage(item, overlays[item.id]);
    if (before === undefined) appended.push(msg);
    else changed.set(item.id, msg);
  }
  if (changed.size === 0 && appended.length === 0) return messages;

  const updated = changed.size > 0 ? messages.map((m) => changed.get(m.id) ?? m) : messages;
  return appended.length > 0 ? [...updated, ...appended] : updated;
}

// -----------------------------------------------------------------------------
// Input formatting + diff-metadata synthesis (web-specific presentation,
// recomputed from the full tool input the core preserves in item meta)
// -----------------------------------------------------------------------------

/** Format tool input as a short preview string */
export function formatToolPreview(name: string, input: Record<string, unknown>): string {
  if (name === "bash" && typeof input.command === "string") {
    return input.command.length > 80 ? input.command.slice(0, 80) + "..." : input.command;
  }
  if (name === "read_file" && typeof input.file_path === "string") {
    return input.file_path as string;
  }
  if (name === "edit_file" && typeof input.file_path === "string") {
    return input.file_path as string;
  }
  if (name === "write_file" && typeof input.file_path === "string") {
    return input.file_path as string;
  }
  if (name === "glob" && typeof input.pattern === "string") {
    return input.pattern as string;
  }
  if (name === "grep" && typeof input.pattern === "string") {
    return input.pattern as string;
  }
  return JSON.stringify(input).slice(0, 60);
}

// Bounded display string for the expanded ToolLine row. We deliberately do
// NOT store the raw `block.input` object on every tool message — for
// edit_file/write_file that would keep the full old_string/new_string /
// content text in the Zustand store and per-session cache indefinitely,
// and long sessions with large file operations could eat megabytes of RAM.
// Instead, pre-extract just the field the UI actually renders, apply a
// generous cap, and throw away the rest.
const MAX_FULL_INPUT_CHARS = 10_000;
export function buildFullInput(name: string | undefined, input: unknown): string | undefined {
  if (!name) return undefined;
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  let text: string | undefined;
  switch (name) {
    case "bash":
    case "shell":
      if (typeof inp.command === "string") text = inp.command;
      break;
    case "read_file":
    case "read":
    case "edit_file":
    case "edit":
    case "write_file":
    case "write":
      if (typeof inp.file_path === "string") text = inp.file_path as string;
      break;
    case "glob":
      if (typeof inp.pattern === "string") text = inp.pattern as string;
      break;
    case "grep": {
      if (typeof inp.pattern === "string") {
        const p = typeof inp.path === "string" ? `  (in ${inp.path as string})` : "";
        text = `${inp.pattern as string}${p}`;
      }
      break;
    }
    case "web_search":
      if (typeof inp.query === "string") text = inp.query as string;
      break;
    case "web_fetch":
      if (typeof inp.url === "string") text = inp.url as string;
      break;
  }
  if (text === undefined) {
    // Unknown/custom tool — pretty-print so nothing is hidden, but still
    // bounded by the char cap below.
    try {
      text = JSON.stringify(inp, null, 2);
    } catch {
      return undefined;
    }
  }
  return text.length > MAX_FULL_INPUT_CHARS
    ? text.slice(0, MAX_FULL_INPUT_CHARS) + "\n… (truncated)"
    : text;
}

// Mirrors MAX_DIFF_METADATA_CHARS in src/tools/edit_file.ts and write_file.ts:
// the live tool path nulls out diff strings above this cap so structuredPatch
// doesn't lock the UI on a giant edit. Reload synthesis must respect the same
// budget — without it, an edit that streamed safely could freeze the page after
// a refresh because the full input text is still in the JSONL.
const MAX_DIFF_METADATA_CHARS = 50_000;

// Reconstruct enough metadata from a tool_use's input to keep DiffView and
// summary text working after a page reload. Live streaming sets `metadata`
// from the tool's result payload, but the JSONL `tool_result` block (Anthropic
// API format) carries only content/is_error/tool_use_id — `metadata` is lost.
// The assistant's tool_use block, however, still has the input fields, so we
// can resurrect old_string/new_string for edit_file and the new content for
// write_file. Line numbers in the diff start at 1 (no match_line on reload),
// which is cosmetic — colors and content are correct.
export function synthesizeMetadataFromInput(
  name: string | undefined,
  input: unknown,
): Record<string, unknown> | undefined {
  if (!name || !input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  if (name === "edit_file") {
    const oldStr = inp.old_string;
    const newStr = inp.new_string;
    if (typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
    if (oldStr.length > MAX_DIFF_METADATA_CHARS || newStr.length > MAX_DIFF_METADATA_CHARS) {
      return undefined;
    }
    return {
      file_path: typeof inp.file_path === "string" ? inp.file_path : "file",
      old_string: oldStr,
      new_string: newStr,
      lines_added: newStr.split("\n").length,
      lines_removed: oldStr.split("\n").length,
    };
  }
  if (name === "write_file") {
    const content = inp.content;
    if (typeof content !== "string") return undefined;
    if (content.length > MAX_DIFF_METADATA_CHARS) return undefined;
    return {
      file_path: typeof inp.file_path === "string" ? inp.file_path : "file",
      // We can't tell on reload whether the write was an overwrite or a
      // new file. Use `old_content: null` rather than "" — the renderer
      // (computeDiffLines) maps null → "" for the diff so it shows the
      // full content as added (new-file form), AND formatToolSummary
      // checks `old_content === null` specifically to emit the
      // "New file, N lines" summary on reload. With "" neither branch
      // fires and the row loses its summary line on refresh.
      old_content: null,
      new_content: content,
    };
  }
  return undefined;
}
