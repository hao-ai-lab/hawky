import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/storage/workspace.js";
import { resetSessionsDir, setSessionsDir } from "../src/storage/session.js";
import { distillMemory } from "../src/memory/distill.js";
import { readMemoryChunk, readSessionMemory, sessionMemoryPath } from "../src/memory/session-memory.js";
import { SessionMemoryScheduler } from "../src/memory/session-memory-scheduler.js";
import type { HawkyConfig } from "../src/agent/types.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";

const now = new Date(2026, 8, 23, 15, 0);
let root: string, sessions: string, workspace: WorkspaceManager;
const config = { memory: { distill_model: "fixture-model" } } as HawkyConfig;
const record = (text: string) => JSON.stringify({ type: "session_memory", summary: text, daily_memory: text });
class Provider implements LLMProvider {
  calls: LLMStreamRequest[] = [];
  finish = "end_turn";
  stop = true;
  constructor(public output: string | ((r: LLMStreamRequest) => Promise<string>) = record("- Meeting at 3; date is unconfirmed.")) {}
  async *stream(r: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(r);
    yield { type: "text_delta", text: typeof this.output === "string" ? this.output : await this.output(r) };
    yield { type: "message_delta", stop_reason: this.finish, usage: { output_tokens: 25 } };
    if (this.stop) yield { type: "message_stop" };
  }
  async countTokens() { return { input_tokens: 0 }; }
}
function line(text: string, date = now, role = "user") {
  return JSON.stringify({ type: "message", message: { role, timestamp: date.toISOString(), content: [{ type: "text", text }] } }) + "\n";
}
function seed(id = "web/meeting", text = "I have a meeting at three.") {
  const path = join(sessions, id + ".jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "session", id, created_at: now.toISOString() }) + "\n" + line(text));
  return path;
}
function run(provider: LLMProvider, id = "web/meeting", date = now) {
  return distillMemory(config, { scope: "daily", session_key: id }, { workspace, provider, now: date });
}
function input(provider: Provider, i = 0) { return JSON.parse(provider.calls[i]!.messages[0]!.content as string); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hawky-session-memory-"));
  sessions = join(root, "sessions"); mkdirSync(sessions);
  setSessionsDir(sessions);
  workspace = new WorkspaceManager(join(root, "workspace")); workspace.init();
});
afterEach(() => { resetSessionsDir(); rmSync(root, { recursive: true, force: true }); });

test("resumes saved progress, merges corrections, replaces one daily block, preserves transcript and manual notes", async () => {
  const path = seed("web/meeting", "I have a meeting at three.");
  workspace.writeFile("memory/2026-09-23.md", "# Today\n- Handwritten note\n");
  const p = new Provider();
  expect((await run(p)).revision).toBe(1);
  const first = readSessionMemory(workspace, "web/meeting")!;
  workspace = new WorkspaceManager(workspace.getWorkspacePath()); // simulate reloading after restart
  appendFileSync(path, line("Actually, it is tomorrow at four. No reminder was created."));
  const raw = readFileSync(path, "utf8");
  p.output = record("- Meeting tomorrow at 4, correcting 3. No reminder created.");
  expect((await run(p)).revision).toBe(2);
  expect(input(p, 1).previous_session_memory).toContain("Meeting at 3");
  expect(input(p, 1).new_transcript).not.toContain("I have a meeting at three");
  expect(input(p, 1).new_transcript).toContain("tomorrow at four");
  const daily = workspace.readFile("memory/2026-09-23.md")!;
  expect(daily.match(/### Session /g)).toHaveLength(1);
  expect(daily).toContain("Handwritten note"); expect(daily).not.toContain("Meeting at 3;");
  expect(readFileSync(path, "utf8")).toBe(raw);
  expect(readSessionMemory(workspace, "web/meeting")!.cursor.byte).toBeGreaterThan(first.cursor.byte);
  expect((await run(p)).skipped).toBe(true); expect(p.calls).toHaveLength(2);
});

test("simultaneous manual/session-end requests share progress and do not call the model twice", async () => {
  seed(); const p = new Provider();
  const outcomes = await Promise.all([run(p), run(p)]);
  expect(outcomes.every(r => r.ok)).toBe(true); expect(p.calls).toHaveLength(1);
  expect(outcomes.filter(r => r.skipped)).toHaveLength(1);
});

test("new turns arriving during the model call are left for the next update", async () => {
  const path = seed();
  const p = new Provider(async () => { appendFileSync(path, line("Bring the budget spreadsheet.")); return record("- Meeting at 3."); });
  await run(p);
  p.output = record("- Bring budget spreadsheet to the meeting.");
  await run(p);
  expect(input(p, 0).new_transcript).not.toContain("budget");
  expect(input(p, 1).new_transcript).toContain("budget");
  expect(input(p, 1).new_transcript).not.toContain("meeting at three");
});

test("rewind during summarization rejects stale output; rewriting before next call rebuilds memory", async () => {
  const path = seed(); const p = new Provider(); await run(p);
  const checkpoint = workspace.readFile(sessionMemoryPath("web/meeting"));
  appendFileSync(path, line("Discuss the budget."));
  p.output = async () => { writeFileSync(path, line("No meeting. The event is cancelled.")); return record("- Stale meeting fact."); };
  const failed = await run(p);
  expect(failed.ok).toBe(false); expect(failed.note).toContain("changed");
  expect(workspace.readFile(sessionMemoryPath("web/meeting"))).toBe(checkpoint);
  p.output = record("- Event cancelled."); await run(p);
  expect(input(p, 2).previous_session_memory).toBe("");
  expect(workspace.readFile("memory/2026-09-23.md")).not.toContain("Stale meeting");
});

test("failure and invalid/unfinished outputs leave the cursor unchanged and permit retry", async () => {
  seed(); const p = new Provider(); await run(p);
  appendFileSync(join(sessions, "web/meeting.jsonl"), line("Correct that to four."));
  const checkpoint = workspace.readFile(sessionMemoryPath("web/meeting"));
  for (const output of ["Thanks for sharing. Contact a clinician.", "", JSON.stringify({ type: "session_memory", summary: "x" })]) {
    p.output = output; expect((await run(p)).ok).toBe(false);
    expect(workspace.readFile(sessionMemoryPath("web/meeting"))).toBe(checkpoint);
  }
  p.output = async () => { throw new Error("rate limit"); };
  expect((await run(p)).ok).toBe(false);
  p.output = record("- Meeting at 4."); p.finish = "max_tokens";
  expect((await run(p)).ok).toBe(false);
  p.finish = "end_turn"; p.stop = false; expect((await run(p)).ok).toBe(false);
  expect(workspace.readFile(sessionMemoryPath("web/meeting"))).toBe(checkpoint);
  p.stop = true; expect((await run(p)).revision).toBe(2);
});

test("a crash after checkpoint commit repairs daily memory without regenerating", async () => {
  seed(); const p = new Provider();
  const write = workspace.writeFileAtomic.bind(workspace);
  workspace.writeFileAtomic = (path, text) => { if (path.endsWith(".md")) throw new Error("disk full"); write(path, text); };
  expect((await run(p)).ok).toBe(false);
  expect(readSessionMemory(workspace, "web/meeting")!.revision).toBe(1);
  workspace = new WorkspaceManager(workspace.getWorkspacePath());
  expect((await run(p)).skipped).toBe(true);
  expect(workspace.readFile("memory/2026-09-23.md")).toContain("Meeting at 3");
  expect(p.calls).toHaveLength(1);
});

test("two sessions keep separate summaries and daily entries", async () => {
  seed(); seed("web/other", "I prefer green tea.");
  const a = new Provider(), b = new Provider(record("- Prefers green tea."));
  await Promise.all([run(a), run(b, "web/other")]);
  expect(input(b).previous_session_memory).toBe("");
  expect(readSessionMemory(workspace, "web/other")!.summary).not.toContain("Meeting");
  expect(workspace.readFile("memory/2026-09-23.md")!.match(/### Session /g)).toHaveLength(2);
});

test("splits across calendar days and keeps the session memory across midnight", async () => {
  const path = seed(); const tomorrow = new Date(2026, 8, 24, 9);
  appendFileSync(path, line("Today the meeting was cancelled.", tomorrow));
  const p = new Provider(); expect((await run(p)).has_more).toBe(true);
  p.output = record("- Meeting cancelled today."); await run(p, "web/meeting", tomorrow);
  expect(input(p, 1).day).toBe("2026-09-24");
  expect(input(p, 1).previous_daily_memory).toBe("");
  expect(input(p, 1).previous_session_memory).toContain("Meeting at 3");
  expect(workspace.readFile("memory/2026-09-23.md")).toContain("Meeting at 3");
  expect(workspace.readFile("memory/2026-09-24.md")).toContain("cancelled");
});

test("long Unicode turns are processed in bounded chunks without losing their tail", async () => {
  seed("web/meeting", "早".repeat(23999) + "😀" + "later fact ".repeat(1000));
  const p = new Provider(); let outcome = await run(p);
  expect(outcome.has_more).toBe(true);
  expect(input(p).new_transcript).not.toContain("\ufffd");
  outcome = await run(p);
  expect(outcome.has_more).toBe(false);
  expect(input(p, 1).new_transcript).toContain("😀later fact");
  expect(readSessionMemory(workspace, "web/meeting")!.cursor.text).toBe(0);
});

test("transcript timestamps use the same local calendar as the daily entry", () => {
  const late = new Date(2026, 8, 23, 23, 30);
  const chunk = readMemoryChunk(Buffer.from(line("Tomorrow at three.", late)), undefined, late);
  expect(chunk.date).toBe("2026-09-23");
  expect(chunk.text).toMatch(/at 2026-09-23T23:30:00[+-]\d{2}:\d{2}/);
});

test("partial JSONL appends wait for completion; tool bubbles and media placeholders are excluded", () => {
  const first = line("Hello"); const second = line("Second fact");
  const partial = Buffer.from(first + second.slice(0, -2));
  const chunk = readMemoryChunk(partial, undefined, now);
  expect(chunk.cursor.byte).toBe(Buffer.byteLength(first));
  const completed = readMemoryChunk(Buffer.from(first + second), chunk.cursor, now);
  expect(completed.text).toContain("Second fact"); expect(completed.text).not.toContain("Hello");
  const markers = line("\u2063TOOL\u2063{\"image\":\"base64\"}") + line("[image was attached]") + line("No reminder was created.");
  const filtered = readMemoryChunk(Buffer.from(markers), undefined, now);
  expect(filtered.count).toBe(1); expect(filtered.text).not.toContain("base64");
});

test("mock runs never consume production progress", async () => {
  seed(); const p = new Provider();
  await distillMemory(config, { scope: "daily", session_key: "web/meeting", mock: true }, { workspace, now });
  expect(readSessionMemory(workspace, "web/meeting")).toBeNull();
  expect((await run(p)).revision).toBe(1); expect(p.calls).toHaveLength(1);
});

test("scheduler handles idle short sessions, skips maintenance/workers, and persists restart progress", async () => {
  seed(); seed("heartbeat/distillation"); seed("web/meeting-codex-bridge"); seed("web/meeting-work-task");
  const p = new Provider(); const time = () => Date.now() + 120_000;
  const options = { getConfig: () => config, workspace, provider: p, now: time };
  const first = await new SessionMemoryScheduler(options).tick();
  expect(first.updated).toBe(1); expect(p.calls).toHaveLength(1);
  expect((await new SessionMemoryScheduler(options).tick()).updated).toBe(0);
  expect(p.calls).toHaveLength(1);
});

test("scheduler waits for active small batches, observes disable switch, and bounds model calls", async () => {
  seed(); const p = new Provider();
  const recentTime = statSync(join(sessions, "web/meeting.jsonl")).mtimeMs + 100;
  const active = new SessionMemoryScheduler({ getConfig: () => config, workspace, provider: p, now: () => recentTime });
  expect((await active.tick()).updated).toBe(0); expect(p.calls).toHaveLength(0);
  for (let i = 0; i < 5; i++) seed(`web/other-${i}`);
  const disabled = new SessionMemoryScheduler({ getConfig: () => ({ memory: { session_enabled: false } }) as HawkyConfig, workspace, provider: p });
  expect((await disabled.tick()).updated).toBe(0);
  const idle = new SessionMemoryScheduler({ getConfig: () => config, workspace, provider: p, now: () => Date.now() + 120_000 });
  expect((await idle.tick()).updated).toBe(2); expect(p.calls).toHaveLength(2);
  expect((await idle.tick()).updated).toBe(2); // no starvation behind unchanged first sessions
});
