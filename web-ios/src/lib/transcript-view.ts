// =============================================================================
// Transcript view adapter — binds web-ios's Live history to the canonical
// transcript core (@hawky/transcript).
//
// The shared core owns the TRANSITION LOGIC: folding gateway `session.history`
// rows into ordered canonical items with stable ids, roles and timestamps
// (`fromHistory` — the same fold the TUI and web use). This module owns the
// web-ios PRESENTATION layered on top:
//   - decoding persisted ⁣TOOL⁣ marker turns back into tool bubbles (Live
//     persists tool calls as marker-encoded assistant text because the
//     gateway only accepts user/assistant turns),
//   - dropping bridge/system plumbing noise from the user's conversation,
//   - deduping consecutive identical turns (legacy double-persist),
//   - formatting wall-clock times for the bubbles.
//
// NOTE: web-ios's LIVE path is NOT bound to reduce(). Live entries come from
// the OpenAI Realtime data channel (`response.output_text.delta`,
// `response.output_audio_transcript.*`, …), which is a different event
// vocabulary from the agent StreamEvent union the core reduces over — web-ios
// never subscribes to the gateway's `agent.*` broadcast. Those handlers (and
// all side effects: turn persistence batching, insert-before-assistant
// ordering, the 200-entry cap) stay in useRealtime.
// =============================================================================

import { fromHistory, selectFlat } from "@hawky/transcript";
import type { HistoryMessage } from "@hawky/transcript";
import type { ToolStatus, TranscriptEntry } from "./useRealtime";

// Marker prefixing a persisted tool record (stored as an assistant turn so the
// gateway accepts it; decoded back into a tool bubble on history load).
export const TOOL_MARKER = "⁣TOOL⁣"; // invisible separators — won't show if ever rendered raw

/** Text that is backend/agent plumbing, not part of the user's conversation. */
function isNoiseText(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("[From web-ios Live]") ||
    t.startsWith("[From desktop Live") ||
    t.startsWith("[No remote nodes") ||
    t.startsWith("<system-reminder>") ||
    t.includes("workspace/memory/") ||
    t.startsWith("[After completing the task")
  );
}

function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

/** The shape persisted inside a ⁣TOOL⁣ marker turn (see persistTool). */
interface PersistedToolRecord {
  label: string;
  status: ToolStatus;
  detail?: string;
  ms?: number;
  image?: string;
  imageTitle?: string;
}

/**
 * Fold session.history rows into Live transcript entries via the canonical
 * reducer, then apply web-ios presentation. Text turns → user/assistant
 * bubbles; persisted ⁣TOOL⁣ markers → finished tool bubbles; raw backend tool
 * blocks (which only exist in the separate bridge channel, but guard anyway)
 * and internal/empty/noise turns are skipped.
 */
export function historyToTranscript(
  rows: Array<{ role: string; content: unknown; timestamp?: string }>,
): TranscriptEntry[] {
  const state = fromHistory(rows as HistoryMessage[]);
  const out: TranscriptEntry[] = [];
  for (const item of selectFlat(state)) {
    // Canonical tool items come from raw backend tool_use blocks — bridge
    // channel plumbing, never part of the Live conversation. Skip them
    // (Live's own tool bubbles arrive as marker-encoded TEXT turns below).
    if (item.kind !== "message") continue;
    const rawText = item.text.trim();
    if (!rawText) continue;
    const at = fmtTime(item.timestamp);

    // A persisted tool record → restore the tool bubble (with its status, and
    // its image if it carried one, e.g. a chart).
    if (rawText.startsWith(TOOL_MARKER)) {
      try {
        const t = JSON.parse(rawText.slice(TOOL_MARKER.length)) as PersistedToolRecord;
        out.push({ id: item.id, kind: "tool", text: t.label, at, toolStatus: t.status, toolDetail: t.detail, toolMs: t.ms, imageData: t.image, imageTitle: t.imageTitle });
      } catch { /* ignore a malformed marker */ }
      continue;
    }

    // Plain user/assistant text. Drop bridge/system plumbing noise, plus
    // consecutive duplicate turns (legacy double-persist).
    if (isNoiseText(rawText)) continue;
    const kind = item.role === "user" ? "user" : "assistant";
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind && prev.text === rawText) continue;
    out.push({ id: item.id, kind, text: rawText, at });
  }
  return out;
}
