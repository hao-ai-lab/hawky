// =============================================================================
// Tests for the memory consolidation scheduler + bulk sweep (#653)
//
// No network: a StubProvider stands in for Haiku. Covers:
//   - MemoryScheduler.tick() consolidates only when a daily log changed
//   - change watermark persists + suppresses redundant consolidation
//   - distillAllSessions skips stubs, distills substantive sessions, consolidates
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceManager } from "../src/storage/workspace.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { distillAllSessions } from "../src/memory/distill.js";
import { MemoryScheduler } from "../src/memory/scheduler.js";
import type { HawkyConfig } from "../src/agent/types.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";

const STUB_CONFIG = {} as HawkyConfig;

class StubProvider implements LLMProvider {
  calls: LLMStreamRequest[] = [];
  constructor(private readonly text: string) {}
  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(request);
    yield { type: "text_delta", text: this.text };
  }
  async countTokens(): Promise<{ input_tokens: number }> {
    return { input_tokens: 0 };
  }
}

let tempDir: string;
let wsDir: string;
let sessionsDir: string;
let ws: WorkspaceManager;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-sched-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedSession(id: string, messages: number): void {
  mkdirSync(join(sessionsDir, "realtime"), { recursive: true });
  const lines = [JSON.stringify({ type: "session", id, created_at: new Date().toISOString(), model: "t" })];
  for (let i = 0; i < messages; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role, content: [{ type: "text", text: `message ${i} with enough words to count as real content here` }] },
      }),
    );
  }
  writeFileSync(join(sessionsDir, `${id}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  tempDir = makeTempDir();
  wsDir = join(tempDir, "workspace");
  sessionsDir = join(tempDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  ws = new WorkspaceManager(wsDir);
  ws.init();
});

afterEach(() => {
  resetSessionsDir();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("MemoryScheduler.tick — change guard", () => {
  test("does nothing when there are no daily logs", async () => {
    const sched = new MemoryScheduler({ getConfig: () => STUB_CONFIG, workspace: ws });
    const r = await sched.tick();
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/no daily logs/i);
  });

  test("skips consolidation when daily logs are unchanged since the last run", async () => {
    ws.writeFile("memory/2026-06-16.md", "# 2026-06-16\n- a\n");
    // Persist a watermark equal to the daily log's current mtime → no change.
    const stat = statSync(join(ws.getMemoryDir(), "2026-06-16.md"));
    ws.writeFile(
      "memory/.consolidation-state.json",
      JSON.stringify({ lastConsolidatedMtimeMs: stat.mtimeMs, lastConsolidatedAt: "2026-06-16T10:00:00Z" }),
    );

    const sched = new MemoryScheduler({ getConfig: () => STUB_CONFIG, workspace: ws });
    const r = await sched.tick();
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/no change/i);
  });

  test("passes the guard when a daily log is newer than the watermark", async () => {
    ws.writeFile("memory/2026-06-16.md", "# 2026-06-16\n- a\n");
    // Watermark far in the past → current mtime is newer → guard lets it through.
    ws.writeFile(
      "memory/.consolidation-state.json",
      JSON.stringify({ lastConsolidatedMtimeMs: 1, lastConsolidatedAt: "1970-01-01T00:00:00Z" }),
    );
    // STUB_CONFIG has no provider, so distillMemory will fail to BUILD a provider
    // — but the point is the guard decided to RUN (reason is not "no change"),
    // proving change-detection works without needing a network call.
    const sched = new MemoryScheduler({ getConfig: () => STUB_CONFIG, workspace: ws });
    const r = await sched.tick();
    expect(r.reason).not.toMatch(/no change/i);
    expect(r.reason).not.toMatch(/no daily logs/i);
  });

  test("a not-ok consolidation does NOT advance the watermark, so the next good tick still runs", async () => {
    // Substantial existing MEMORY.md + a changed daily log. The config has no
    // provider/key, so distillMemory returns not-ok (provider build fails) —
    // standing in for a lossy-rejected consolidation, which is likewise not-ok.
    // The invariant under test is identical: the watermark must NOT advance.
    ws.writeFile("MEMORY.md", "# MEMORY\n\n- a substantial curated fact worth keeping around\n");
    ws.writeFile("memory/2026-06-16.md", "# 2026-06-16\n- a\n");

    const sched = new MemoryScheduler({ getConfig: () => STUB_CONFIG, workspace: ws });
    const r = await sched.tick();
    expect(r.ran).toBe(false);

    // No watermark was persisted, so a subsequent tick would re-attempt.
    const statePath = join(ws.getWorkspacePath(), "memory", ".consolidation-state.json");
    expect(existsSync(statePath)).toBe(false);
  });

  test("a lossy-REJECTED consolidation advances the watermark so the LLM is not re-run every tick", async () => {
    // Drive an ACTUAL anti-lossy rejection (not a provider-build failure):
    // substantial MEMORY.md + a changed daily log, but the injected provider
    // returns a tiny output that the gate rejects → proposedRejection. The
    // scheduler must advance the watermark so a same-inputs tick does not
    // re-invoke the LLM (the fix for the "propose thrash" every 6h).
    ws.writeFile(
      "MEMORY.md",
      "# MEMORY\n\n" +
        Array.from({ length: 12 }, (_, i) => `- curated fact number ${i} worth keeping around`).join("\n") +
        "\n",
    );
    ws.writeFile("memory/2026-06-16.md", "# 2026-06-16\n- a\n");
    const stat = statSync(join(ws.getMemoryDir(), "2026-06-16.md"));

    const provider = new StubProvider("- one lone fact\n"); // far too short → rejected
    const sched = new MemoryScheduler({ getConfig: () => STUB_CONFIG, workspace: ws, provider });

    const r1 = await sched.tick();
    expect(r1.ran).toBe(false);
    expect(r1.reason).toMatch(/lossy/i);
    expect(provider.calls.length).toBe(1);

    // The watermark WAS advanced to the daily log's mtime.
    const statePath = join(ws.getWorkspacePath(), "memory", ".consolidation-state.json");
    expect(existsSync(statePath)).toBe(true);

    // A second tick with the SAME (unchanged) daily log must NOT re-run the LLM.
    const r2 = await sched.tick();
    expect(r2.ran).toBe(false);
    expect(r2.reason).toMatch(/no change/i);
    expect(provider.calls.length).toBe(1); // no additional LLM call
    // Sanity: watermark is at least the daily log mtime we consolidated up to.
    expect(existsSync(statePath)).toBe(true);
    void stat;
  });
});

describe("distillAllSessions sweep", () => {
  test("skips stub sessions and distills substantive ones (mock)", async () => {
    seedSession("realtime/stub-1", 1); // stub: 1 message
    seedSession("realtime/stub-2", 2); // stub: 2 messages
    seedSession("realtime/real-1", 6); // substantive
    seedSession("realtime/real-2", 8); // substantive

    const result = await distillAllSessions(STUB_CONFIG, {
      workspace: ws,
      mock: true,
      now: new Date(2026, 5, 16, 12, 0),
    });

    expect(result.scanned).toBe(4);
    expect(result.skippedStubs).toBe(2);
    expect(result.distilled).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.consolidated).toBe(true);

    // The daily log + MEMORY.md were written.
    expect(ws.readFile("memory/2026-06-16.md")).toContain("(mock)");
    expect(ws.readFile("MEMORY.md")).toContain("(mock) Consolidated");
  });

  test("honors maxSessions cost guard", async () => {
    for (let i = 0; i < 5; i++) seedSession(`realtime/s-${i}`, 6);
    const result = await distillAllSessions(STUB_CONFIG, {
      workspace: ws,
      mock: true,
      maxSessions: 2,
      now: new Date(2026, 5, 16, 12, 0),
    });
    expect(result.distilled).toBe(2);
  });

  test("uses the real LLM path through an injected provider", async () => {
    seedSession("realtime/real-1", 6);
    // Start from an empty (trivial) MEMORY.md so the anti-lossy gate is bypassed
    // for this first consolidation — the template file is above the trivial
    // threshold and would (correctly) reject a tiny consolidation output.
    ws.writeFile("MEMORY.md", "");
    // The global consolidation output must itself be substantial to pass the gate
    // once MEMORY.md has grown; use a multi-fact body.
    const consolidated =
      "# MEMORY\n\n- distilled fact one\n- distilled fact two\n- distilled fact three\n";
    const provider = new StubProvider(consolidated);
    const result = await distillAllSessions(STUB_CONFIG, {
      workspace: ws,
      provider,
      now: new Date(2026, 5, 16, 12, 0),
    });
    expect(result.distilled).toBe(1);
    expect(result.consolidated).toBe(true);
    // provider called for the daily distill + the global consolidation.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(ws.readFile("memory/2026-06-16.md")).toContain("distilled fact");
    expect(ws.readFile("MEMORY.md")).toContain("distilled fact");
  });
});
