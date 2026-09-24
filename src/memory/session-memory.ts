// Incremental session memory. The checkpoint is authoritative; daily Markdown
// is an idempotent projection that can be repaired after a crash. Source JSONL
// and the running agent's context are never modified here.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SessionInfo } from "../storage/session.js";
import type { WorkspaceManager } from "../storage/workspace.js";
import { formatDate } from "../storage/workspace.js";

const MAX_CHARS = 24_000;
const TOOL_MARKER = "\u2063TOOL\u2063";
const locks = new Map<string, Promise<unknown>>();
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface SessionMemory {
  version: 1;
  sessionId: string;
  revision: number;
  /** JSONL byte offset, plus a text offset for unusually long individual turns. */
  cursor: { byte: number; text: number };
  coveredBytes: number;
  sourceHash: string;
  summary: string;
  daily: { date: string; text: string };
  updatedAt: string;
  model: string;
}

export function sessionMemoryPath(sessionId: string, mock = false): string {
  return `memory/.sessions/${hash(sessionId)}${mock ? ".mock" : ""}.json`;
}

export function readSessionMemory(workspace: WorkspaceManager, sessionId: string, mock = false): SessionMemory | null {
  const raw = workspace.readFile(sessionMemoryPath(sessionId, mock));
  if (!raw) return null;
  // Fail closed on a corrupt checkpoint instead of silently forgetting progress.
  const s = JSON.parse(raw) as SessionMemory;
  if (s.version !== 1 || s.sessionId !== sessionId || !Number.isSafeInteger(s.cursor?.byte)
    || s.cursor.byte < 0 || !Number.isSafeInteger(s.cursor.text) || s.cursor.text < 0
    || !Number.isSafeInteger(s.coveredBytes) || s.coveredBytes < s.cursor.byte
    || typeof s.sourceHash !== "string" || typeof s.summary !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.daily?.date) || typeof s.daily.text !== "string"
    || !Number.isSafeInteger(s.revision) || !Number.isFinite(Date.parse(s.updatedAt))) {
    throw new Error(`Invalid session memory checkpoint for ${sessionId}`);
  }
  return s;
}

/** Shared by scheduled, manual, and iOS session-end requests. Does not lock chat. */
async function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(key, next);
  try { return await next; }
  finally { if (locks.get(key) === next) locks.delete(key); }
}

export function matchesSource(state: SessionMemory, source: Buffer): boolean {
  return state.coveredBytes <= source.length && hash(source.subarray(0, state.coveredBytes)) === state.sourceHash;
}

export function messageText(entry: any): string {
  const m = entry?.message;
  if (entry?.type !== "message" || !["user", "assistant"].includes(m?.role) || !Array.isArray(m.content)) return "";
  return m.content.filter((b: any) => b?.type === "text" && !b.internal_only && typeof b.text === "string")
    .map((b: any) => b.text.trim())
    .filter((t: string) => t && !t.startsWith(TOOL_MARKER)
      && !/^\[(?:image was attached|screenshot was captured|.* was (?:read|attached))\]$/.test(t)).join("\n");
}

function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${formatDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** Consume complete JSONL records, retaining exact progress even for a long turn.
 * One chunk covers one local calendar day. A trailing partial write is retried. */
export function readMemoryChunk(source: Buffer, cursor = { byte: 0, text: 0 }, now = new Date()) {
  let byte = cursor.byte, textOffset = cursor.text, coveredBytes = byte, count = 0, chars = 0;
  let date = "";
  const parts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  while (byte < source.length) {
    const end = source.indexOf(10, byte);
    if (end < 0) break;
    const raw = source.subarray(byte, end).toString("utf8").trim();
    const entry = raw ? JSON.parse(raw) : null;
    const text = messageText(entry);
    if (!text) { byte = end + 1; textOffset = 0; coveredBytes = byte; continue; }
    const stamp = entry.message.timestamp ?? entry.timestamp;
    const parsed = typeof stamp === "string" ? new Date(stamp) : now;
    const timestamp = Number.isFinite(parsed.getTime()) ? parsed : now;
    const day = formatDate(timestamp);
    if (date && day !== date) break;
    date = day;
    const available = MAX_CHARS - chars;
    if (available <= 0) break;
    let length = Math.min(available, text.length - textOffset);
    // Never split a UTF-16 surrogate pair at the chunk boundary.
    const last = text.charCodeAt(textOffset + length - 1);
    if (last >= 0xd800 && last <= 0xdbff) length--;
    if (length <= 0) break;
    // Use the same calendar/zone as the daily filename; UTC can be the next day.
    parts.push(`[${entry.message.role}${textOffset ? " (continued)" : ""} at ${localTimestamp(timestamp)}] ${text.slice(textOffset, textOffset + length)}`);
    messages.push({ role: entry.message.role, text: text.slice(textOffset, textOffset + length) });
    chars += length; count++; coveredBytes = end + 1;
    if (textOffset + length < text.length) { textOffset += length; break; }
    byte = end + 1; textOffset = 0;
  }
  return { text: parts.join("\n"), messages, count, date: date || formatDate(now),
    cursor: { byte, text: textOffset }, coveredBytes,
    hasMore: textOffset > 0 || source.indexOf(10, byte) >= 0 };
}

export function parseSessionMemory(output: string): { summary: string; daily_memory: string } {
  if (!output.trim()) throw new Error("Distillation LLM call returned an empty summary.");
  let result: any;
  try { result = JSON.parse(output); } catch { throw new Error("Session memory must be a JSON record, not a conversational reply."); }
  if (result?.type !== "session_memory" || [result.summary, result.daily_memory].some(v =>
    typeof v !== "string" || !v.trim() || v.length > 8000 || v.includes("<!--") || v.includes("-->"))) {
    throw new Error("Invalid session memory summary or daily entry.");
  }
  return { summary: result.summary.trim(), daily_memory: result.daily_memory.trim() };
}

function projectDaily(workspace: WorkspaceManager, state: SessionMemory, mock: boolean): string {
  const file = `memory/${state.daily.date}.md`;
  const id = hash(state.sessionId) + (mock ? "-mock" : "");
  const start = `<!-- session-memory:${id} -->`, end = `<!-- /session-memory:${id} -->`;
  const title = state.sessionId.replace(/[\r\n<>]/g, " ");
  const block = `${start}\n### Session ${title}\nUpdated ${state.updatedAt} · revision ${state.revision}${mock ? " · mock" : ""}\n\n${state.daily.text}\n${end}`;
  const old = workspace.readFile(file) ?? `# ${state.daily.date}\n`;
  const from = old.indexOf(start), to = from < 0 ? -1 : old.indexOf(end, from);
  if (from >= 0 && to < 0) throw new Error(`Incomplete session memory block in ${file}`);
  const next = from < 0 ? `${old.trimEnd()}\n\n${block}\n` : old.slice(0, from) + block + old.slice(to + end.length);
  if (next !== old) workspace.writeFileAtomic(file, next);
  return file;
}

export interface UpdateSessionMemoryOptions {
  workspace: WorkspaceManager;
  session: SessionInfo;
  now: Date;
  model: string;
  mock?: boolean;
  automatic?: boolean;
  minMessages?: number;
  minIntervalMs?: number;
  idleMs?: number;
  summarize: (prompt: string) => Promise<string>;
}

export async function updateSessionMemory(opts: UpdateSessionMemoryOptions) {
  const { workspace, session, now, mock = false } = opts;
  return serialize(`${workspace.getWorkspacePath()}:${sessionMemoryPath(session.id, mock)}`, async () => {
    let state = readSessionMemory(workspace, session.id, mock);
    const source = await readFile(session.filePath);
    const reset = !!state && !matchesSource(state, source);
    if (reset) state = null; // rewind/compaction: don't carry unsupported old facts into a new snapshot
    if (state) projectDaily(workspace, state, mock); // repair a crash between checkpoint and projection
    const chunk = readMemoryChunk(source, state?.cursor, now);
    const skipped = (note: string) => ({ ok: true, skipped: true, note, state, reset, hasMore: chunk.hasMore });
    if (!chunk.text) return skipped("No new conversation text.");
    if (opts.automatic) {
      if (state && now.getTime() - Date.parse(state.updatedAt) < (opts.minIntervalMs ?? 120_000))
        return skipped("Waiting for the per-session interval.");
      if (chunk.count < (opts.minMessages ?? 6) && now.getTime() - session.lastModified < (opts.idleMs ?? 60_000))
        return skipped("Waiting for more messages or an idle gap.");
    }
    const prompt = JSON.stringify({
      session_id: session.id, day: chunk.date,
      previous_session_memory: state?.summary ?? "",
      previous_daily_memory: state?.daily.date === chunk.date ? state.daily.text : "",
      new_transcript: chunk.text,
    });
    const result = mock ? {
      summary: `(mock) ${session.id}: ${chunk.text.slice(0, 120)}`,
      daily_memory: `(mock) ${session.id}: ${chunk.text.slice(0, 120)}`,
    } : parseSessionMemory(await opts.summarize(prompt));
    const digest = hash(source.subarray(0, chunk.coveredBytes));
    const current = await readFile(session.filePath);
    if (current.length < chunk.coveredBytes || hash(current.subarray(0, chunk.coveredBytes)) !== digest)
      throw new Error("Conversation changed during memory extraction; retry from the last checkpoint.");
    const next: SessionMemory = { version: 1, sessionId: session.id, revision: (state?.revision ?? 0) + 1,
      cursor: chunk.cursor, coveredBytes: chunk.coveredBytes, sourceHash: digest,
      summary: result.summary, daily: { date: chunk.date, text: result.daily_memory },
      updatedAt: now.toISOString(), model: opts.model };
    // Commit first. If projection fails, the next call repairs it without another LLM request.
    workspace.writeFileAtomic(sessionMemoryPath(session.id, mock), JSON.stringify(next, null, 2) + "\n");
    projectDaily(workspace, next, mock);
    return { ok: true, skipped: false, state: next, reset, hasMore: chunk.hasMore, note: undefined };
  });
}
