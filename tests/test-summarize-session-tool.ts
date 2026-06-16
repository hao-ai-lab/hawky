// Tests for the backend summarize_session tool (#537).
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeSummarizeSession } from "../src/tools/summarize_session.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";

function ctx(): any {
  return { session_id: "t", working_directory: "/tmp", abort_signal: new AbortController().signal, emit: () => {} };
}

// Write a realtime session JSONL the way the gateway persists them.
function writeRealtimeSession(dir: string, id: string, turns: Array<[string, string]>, mtimeRecent = true) {
  const sub = join(dir, "realtime");
  mkdirSync(sub, { recursive: true });
  const file = join(sub, `${id}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 1, id: `realtime/${id}`, model: "gpt-4o", created_at: new Date(0).toISOString() }),
  ];
  for (const [role, text] of turns) {
    lines.push(JSON.stringify({ type: "message", timestamp: new Date(0).toISOString(), message: { role, content: [{ type: "text", text }] } }));
  }
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

afterEach(() => resetSessionsDir());

describe("summarize_session backend tool", () => {
  test("no realtime sessions → friendly message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    try {
      setSessionsDir(dir);
      const r = await executeSummarizeSession({ scope: "current_session" }, ctx());
      expect(r.type).toBe("text");
      expect((r as any).content).toContain("No Live");
    } finally { resetSessionsDir(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("current_session assembles transcript + summarize instruction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    try {
      writeRealtimeSession(dir, "aaaa", [["user", "hello there"], ["assistant", "hi, how can I help"]]);
      setSessionsDir(dir);
      const r = await executeSummarizeSession({ scope: "current_session" }, ctx());
      expect(r.type).toBe("text");
      const c = (r as any).content as string;
      expect(c).toContain("Summarize");
      expect(c).toContain("hello there");
      expect(c).toContain("TRANSCRIPT");
    } finally { resetSessionsDir(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("defaults to current_session on bad scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    try {
      writeRealtimeSession(dir, "bbbb", [["user", "yo"], ["assistant", "sup"]]);
      setSessionsDir(dir);
      const r = await executeSummarizeSession({ scope: "garbage" as any }, ctx());
      expect((r as any).content).toContain("current_session");
    } finally { resetSessionsDir(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("past_day includes multiple recent sessions with headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    try {
      writeRealtimeSession(dir, "s1", [["user", "topic one alpha"], ["assistant", "ok"]]);
      writeRealtimeSession(dir, "s2", [["user", "topic two beta"], ["assistant", "sure"]]);
      setSessionsDir(dir);
      const r = await executeSummarizeSession({ scope: "past_day" }, ctx());
      const c = (r as any).content as string;
      // both sessions' content present; multi-session → headers
      expect(c).toContain("topic one alpha");
      expect(c).toContain("topic two beta");
      expect(c).toContain("=== Session:");
    } finally { resetSessionsDir(); rmSync(dir, { recursive: true, force: true }); }
  });
});
