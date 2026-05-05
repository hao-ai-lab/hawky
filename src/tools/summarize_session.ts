// =============================================================================
// summarize_session tool (#537)
//
// Backend counterpart to the iOS Live "Summary" feature. Lets the Hawky agent
// recap Live/realtime session transcripts on its own (e.g. from cron, or when
// reasoning about recent activity). Reads the PERSISTED session history on the
// gateway (~/.hawky/sessions/realtime:*.jsonl) via listSessions +
// extractSessionText, assembles the transcript, and returns it with an
// instruction to summarize — the calling agent produces the recap from the
// tool result (no nested agent spawn).
//
// LIMITATION (documented): the gateway only persists realtime turns that went
// through chat.send (i.e. when the realtime model asked the background agent for
// help). Pure voice turns between the user and the realtime model are NOT on the
// gateway, so a backend summary can be partial. The iOS frontend tool
// (summarize_session in LiveToolRegistry) has the full transcript; prefer it
// when summarizing from a live phone session.
// =============================================================================

import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";
import { listSessions } from "../storage/session.js";
import { extractSessionText } from "../memory/session-extract.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/summarize_session");

const SCOPES = ["current_session", "past_day"] as const;
type Scope = (typeof SCOPES)[number];

// Cap the assembled transcript so a long day can't blow the context window.
const MAX_TRANSCRIPT_CHARS = 24_000;

interface SummarizeSessionInput {
  scope?: Scope;
}

export async function executeSummarizeSession(
  input: SummarizeSessionInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const scope: Scope = SCOPES.includes(input?.scope as Scope) ? (input!.scope as Scope) : "current_session";

  // Realtime/Live sessions only (the Live transcript lives under realtime:*).
  const all = listSessions(200).filter((s) => s.id.startsWith("realtime:") || s.id.startsWith("realtime/"));
  if (all.length === 0) {
    return { type: "text", content: "No Live (realtime) sessions found on the gateway to summarize." };
  }

  // Most-recent first.
  all.sort((a, b) => b.lastModified - a.lastModified);

  let chosen = all;
  if (scope === "current_session") {
    chosen = [all[0]];
  } else {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    chosen = all.filter((s) => s.lastModified >= cutoff);
    if (chosen.length === 0) chosen = [all[0]];
  }

  const blocks: string[] = [];
  let total = 0;
  for (const s of chosen) {
    let text = "";
    try {
      const res = await extractSessionText(s.filePath);
      text = res.text.trim();
    } catch (err) {
      log.debug("extractSessionText failed", { id: s.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!text) continue;
    const header = chosen.length > 1 ? `=== Session: ${s.displayName ?? s.id} (${s.createdAt}) ===\n` : "";
    const block = header + text;
    if (total + block.length > MAX_TRANSCRIPT_CHARS) {
      blocks.push(block.slice(0, Math.max(0, MAX_TRANSCRIPT_CHARS - total)));
      total = MAX_TRANSCRIPT_CHARS;
      break;
    }
    blocks.push(block);
    total += block.length;
  }

  if (blocks.length === 0) {
    return { type: "text", content: "The selected Live session(s) have no readable transcript on the gateway yet." };
  }

  const transcript = blocks.join("\n\n");
  const scopeLabel = scope === "past_day" ? "the past 24 hours of Live sessions" : "the most recent Live session";
  log.info("summarize_session assembled transcript", { scope, sessions: chosen.length, chars: transcript.length });

  return {
    type: "text",
    content:
      `Summarize ${scopeLabel} from the transcript below. Write a concise, readable recap: ` +
      `key topics, decisions/answers, and concrete follow-ups or to-dos. Use short headers and bullets. ` +
      `Ignore system noise and incomplete fragments. If little of substance was said, say so briefly.\n\n` +
      `(Note: only turns persisted on the gateway are included; pure voice turns may be missing.)\n\n` +
      `----- TRANSCRIPT (${scope}, ${chosen.length} session${chosen.length === 1 ? "" : "s"}) -----\n${transcript}`,
  };
}

export const summarizeSessionToolDefinition: ToolDefinition<SummarizeSessionInput> = {
  name: "summarize_session",
  description:
    "Summarize Hawky Live (realtime) session transcripts. scope=current_session recaps the most recent Live session; " +
    "scope=past_day recaps the last 24 hours. Returns the transcript with an instruction to summarize — produce the recap from it. " +
    "Reads gateway-persisted history (pure voice turns may be missing).",
  input_schema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: [...SCOPES],
        description: "current_session (most recent Live session) or past_day (last 24h). Default current_session.",
      },
    },
  },
  permission: "auto_approve",
  execute: executeSummarizeSession as any,
};
