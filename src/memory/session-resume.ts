import { readFile } from "node:fs/promises";
import type { SessionInfo } from "../storage/session.js";
import type { WorkspaceManager } from "../storage/workspace.js";
import { matchesSource, messageText, readMemoryChunk, readSessionMemory } from "./session-memory.js";

/** A single source snapshot binds the summary to its exact uncovered tail.
 * Read-only: no model calls and no cursor changes during reconnect. */
export async function sessionResumeContext(workspace: WorkspaceManager, session: SessionInfo) {
  const state = readSessionMemory(workspace, session.id);
  if (!state) return { mode: "history" as const, reason: "missing" };
  const source = await readFile(session.filePath);
  if (!matchesSource(state, source)) return { mode: "history" as const, reason: "stale" };
  // Do not hide a message that is still being appended.
  if (source.length && source.at(-1) !== 10) return { mode: "retry" as const, note: "Conversation is still being saved. Try Start again." };
  let cursor = state.cursor;
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  let chars = 0;
  while (cursor.byte < source.length) {
    const chunk = readMemoryChunk(source, cursor);
    messages.push(...chunk.messages);
    chars += chunk.messages.reduce((n, m) => n + m.text.length, 0);
    if (chars > 24_000 || messages.length > 100 || chunk.cursor.text > 0) {
      return { mode: "needs_update" as const, note: "More history needs summarizing before reconnecting. Click Update session memory, then Start." };
    }
    if (chunk.cursor.byte <= cursor.byte) break;
    cursor = chunk.cursor;
  }
  // Used only to verify crash-recovered recording turns were also persisted.
  const recent: typeof messages = [];
  for (const line of source.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    const text = messageText(entry);
    if (text) { recent.push({ role: entry.message.role, text }); if (recent.length > 30) recent.shift(); }
  }
  return { mode: "summary" as const, summary: state.summary, revision: state.revision,
    updatedAt: state.updatedAt, messages, recent };
}
