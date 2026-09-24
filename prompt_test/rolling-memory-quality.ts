/** Opt-in provider check using synthetic conversations and an isolated workspace.
 * bun run prompt_test/rolling-memory-quality.ts --live [--output report.json]
 * Makes four paid model calls; never reads or changes personal session memory. */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/storage/config.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { WorkspaceManager } from "../src/storage/workspace.js";
import { distillMemory, resolveDistillModel } from "../src/memory/distill.js";

if (!process.argv.includes("--live")) throw new Error("Use --live to authorize four synthetic memory API calls.");
const root = mkdtempSync(join(tmpdir(), "hawky-memory-quality-"));
const sessions = join(root, "sessions"); mkdirSync(join(sessions, "web"), { recursive: true });
const workspace = new WorkspaceManager(join(root, "workspace"));
setSessionsDir(sessions);
const config = loadConfig();
// Late local time catches UTC timestamps accidentally shifting the daily entry.
const now = new Date(2026, 8, 23, 23, 30);
const turn = (role: string, text: string) => JSON.stringify({ type: "message", message: {
  role, timestamp: now.toISOString(), content: [{ type: "text", text }],
} }) + "\n";
const cases = [
  {
    id: "meeting-correction",
    first: [turn("user", "I realize I have a mania 3."), turn("assistant", "Feeling depressed can make things heavier. Please contact a clinician.")],
    next: [turn("user", "That was misheard. I said I have a meeting at three. It is tomorrow at 3 PM. I did not say anything about a medical condition."),
      turn("assistant", "Understood. No reminder has been created.")],
    check: (s: string) => /meeting/i.test(s) && /3|three/i.test(s) && /tomorrow|2026-09-24|September 24/i.test(s)
      && !/2026-09-25|September 25/i.test(s)
      && !/user (?:has|is experiencing|is suffering from) (?:mania|depression)/i.test(s)
      && /(?:no reminder|reminder.*(?:not|no )|not.*reminder)/i.test(s),
  },
  {
    id: "task-cancelled",
    first: [turn("user", "Please find alpha.txt and read it."), turn("assistant", "The backend search is running. No result yet.")],
    next: [turn("user", "Cancel the alpha.txt task. We no longer need it. Remember I prefer short answers."),
      turn("assistant", "The backend confirmed the task was cancelled. No file contents were retrieved.")],
    check: (s: string) => /cancel/i.test(s) && /short|brief|concise/i.test(s)
      && !/2026-09-24|September 24/i.test(s)
      && /(?:no file|not.*retriev|no.*retriev|without.*retriev)/i.test(s),
  },
];
const reports: unknown[] = [];
let passed = 0;
try {
  for (const c of cases) {
    const path = join(sessions, `web/${c.id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "session", id: `web/${c.id}`, created_at: now.toISOString() }) + "\n" + c.first.join(""));
    const request = { scope: "daily" as const, session_key: `web/${c.id}` };
    const started = Date.now();
    const first = await distillMemory(config, request, { workspace, now });
    appendFileSync(path, c.next.join(""));
    const next = await distillMemory(config, request, { workspace, now });
    const repeated = await distillMemory(config, request, { workspace, now });
    const ok = first.ok && next.ok && repeated.skipped === true && c.check(next.session_memory ?? "") && c.check(next.preview);
    if (ok) passed++;
    reports.push({ id: c.id, passed: ok, durationMs: Date.now() - started, first, next, repeatSkipped: repeated.skipped });
  }
  const report = { model: resolveDistillModel(config), passed, total: cases.length, reports };
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1]!, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (passed !== cases.length) process.exitCode = 1;
} finally { resetSessionsDir(); rmSync(root, { recursive: true, force: true }); }
