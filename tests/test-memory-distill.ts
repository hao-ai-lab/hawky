// =============================================================================
// Tests for memory distillation (#653)
//
// Two paths are covered with NO network:
//   1. mock mode (mock: true) — deterministic placeholder content.
//   2. real LLM path — via an injected StubProvider that records the prompt it
//      received and returns canned text, exercising prompt assembly → stream →
//      parse → file write exactly as production does (minus the HTTP call).
//
// Cases:
//   - scope=daily:  seeded realtime session -> memory/YYYY-MM-DD.md
//   - scope=global: daily logs -> MEMORY.md
//   - readMemorySnapshot returns the four tiers
//   - graceful failures (no transcript / no daily logs / empty LLM output)
//   - transcript targeting + truncation
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceManager } from "../src/storage/workspace.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { distillMemory, readMemorySnapshot, resolveDistillModel, DEFAULT_DISTILL_MODEL } from "../src/memory/distill.js";
import { buildMemoryCandidate, InMemoryMemoryCandidateStore } from "../src/memory/candidate.js";
import { buildIdentityCandidate, buildPersonFact, buildPersonProfile } from "../src/identity/person/contracts.js";
import { InMemoryPersonStore } from "../src/identity/person/store.js";
import type { HawkyConfig } from "../src/agent/types.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";

let tempDir: string;
let wsDir: string;
let sessionsDir: string;
let ws: WorkspaceManager;

// Config is unused in mock mode (createProvider is never called), so a stub is
// fine. distillMemory only touches config when mock !== true AND no provider is
// injected.
const STUB_CONFIG = {} as HawkyConfig;

const NOW = new Date(2026, 5, 16, 14, 30); // 2026-06-16 14:30 local
const DATE_STR = "2026-06-16";

// -----------------------------------------------------------------------------
// StubProvider — records the request and emits canned text as a stream, so the
// real (non-mock) distillation path is testable without a network call.
// -----------------------------------------------------------------------------

class StubProvider implements LLMProvider {
  calls: LLMStreamRequest[] = [];
  constructor(private readonly chunks: string[]) {}

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(request);
    for (const text of this.chunks) {
      yield { type: "text_delta", text };
    }
  }

  async countTokens(): Promise<{ input_tokens: number }> {
    return { input_tokens: 0 };
  }
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-distill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed a realtime session jsonl under sessionsDir so listSessions picks it up. */
function seedRealtimeSession(id: string, userText: string, assistantText: string): void {
  const filePath = join(sessionsDir, `${id}.jsonl`);
  mkdirSync(join(sessionsDir, id.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id, created_at: NOW.toISOString(), model: "test" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } }),
  ];
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  tempDir = makeTempDir();
  wsDir = join(tempDir, "workspace");
  sessionsDir = join(tempDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  ws = new WorkspaceManager(wsDir);
  ws.init();
  setSessionsDir(sessionsDir);
});

afterEach(() => {
  resetSessionsDir();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("distillMemory: daily (mock)", () => {
  test("writes a daily log from the most recent realtime session", async () => {
    seedRealtimeSession("realtime/sess-1", "Remember I prefer dark mode.", "Got it — dark mode noted.");

    const result = await distillMemory(STUB_CONFIG, { scope: "daily", mock: true }, { workspace: ws, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("daily");
    expect(result.mocked).toBe(true);
    expect(result.file).toBe(`memory/${DATE_STR}.md`);

    const written = ws.readFile(`memory/${DATE_STR}.md`);
    expect(written).toContain("(mock)");
    // Daily log has the date header from appendToDaily.
    expect(written).toContain(`# ${DATE_STR}`);
  });

  test("does not write memory candidates from mock summaries", async () => {
    seedRealtimeSession("realtime/sess-1", "Remember I prefer dark mode.", "Got it — dark mode noted.");
    const memoryCandidateStore = new InMemoryMemoryCandidateStore();

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", mock: true },
      { workspace: ws, now: NOW, memoryCandidateStore },
    );

    expect(result.ok).toBe(true);
    expect(result.memoryCandidates).toBeUndefined();
    expect(memoryCandidateStore.list()).toEqual([]);
  });

  test("targets a specific session_key when provided", async () => {
    seedRealtimeSession("realtime/old", "old session", "old reply");
    seedRealtimeSession("realtime/wanted", "the wanted session content", "wanted reply");

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", mock: true, session_key: "realtime/wanted" },
      { workspace: ws, now: NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.preview).toContain("realtime/wanted");
  });

  test("targets a non-realtime bridge session_key when provided", async () => {
    seedRealtimeSession("hello-codex", "the active bridge session content", "bridge reply");
    seedRealtimeSession("realtime/older", "older realtime session", "older reply");

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", mock: true, session_key: "hello-codex" },
      { workspace: ws, now: NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.preview).toContain("hello-codex");
    expect(ws.readFile(`memory/${DATE_STR}.md`)).toContain("active bridge session");
  });

  test("matches slash and colon aliases for session_key", async () => {
    seedRealtimeSession("realtime/main", "slash session content", "slash reply");

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", mock: true, session_key: "realtime:main" },
      { workspace: ws, now: NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.preview).toContain("realtime/main");
  });

  test("fails gracefully when there is no realtime transcript", async () => {
    const result = await distillMemory(STUB_CONFIG, { scope: "daily", mock: true }, { workspace: ws, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/no readable realtime transcript/i);
  });
});

describe("distillMemory: global (mock)", () => {
  test("consolidates daily logs into MEMORY.md", async () => {
    // Seed a couple of daily logs.
    ws.writeFile("memory/2026-06-15.md", "# 2026-06-15\n\n- learned X\n");
    ws.writeFile(`memory/${DATE_STR}.md`, `# ${DATE_STR}\n\n- learned Y\n`);

    const before = ws.readFile("MEMORY.md") ?? "";
    const result = await distillMemory(STUB_CONFIG, { scope: "global", mock: true }, { workspace: ws, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("global");
    expect(result.file).toBe("MEMORY.md");

    const after = ws.readFile("MEMORY.md") ?? "";
    expect(after).not.toBe(before);
    expect(after).toContain("(mock) Consolidated");
  });

  test("fails gracefully when there are no daily logs", async () => {
    const result = await distillMemory(STUB_CONFIG, { scope: "global", mock: true }, { workspace: ws, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/no daily logs/i);
  });
});

describe("distillMemory: daily (real LLM path, stub provider)", () => {
  test("sends transcript + daily system prompt and writes the model's summary", async () => {
    seedRealtimeSession("realtime/sess-1", "I just shipped the auth refactor.", "Nice — auth refactor shipped.");
    const provider = new StubProvider(["- Shipped the auth refactor.\n", "- Mood: accomplished."]);

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily" }, // NOT mock
      { workspace: ws, now: NOW, provider },
    );

    expect(result.ok).toBe(true);
    expect(result.mocked).toBe(false);

    // The model was called exactly once, with the daily model + the transcript.
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].model).toMatch(/haiku/i);
    const userMsg = provider.calls[0].messages[0]?.content as string;
    expect(userMsg).toContain("auth refactor");
    expect(provider.calls[0].system).toContain("daily-log entry");

    // The streamed chunks were concatenated and written to the daily log.
    const written = ws.readFile(`memory/${DATE_STR}.md`) ?? "";
    expect(written).toContain("Shipped the auth refactor");
    expect(written).toContain("accomplished");
  });

  test("returns ok:false when the model streams nothing", async () => {
    seedRealtimeSession("realtime/sess-empty", "hello", "hi");
    const provider = new StubProvider([]); // empty stream

    const result = await distillMemory(STUB_CONFIG, { scope: "daily" }, { workspace: ws, now: NOW, provider });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/empty summary/i);
    // Nothing should have been written.
    expect(ws.readFile(`memory/${DATE_STR}.md`)).toBeNull();
  });

  test("passes a bounded person snapshot without unreviewed facts to the daily prompt", async () => {
    seedRealtimeSession("realtime/person", "Kevin said the deploy is done.", "Noted.");
    const personStore = new InMemoryPersonStore();
    personStore.putProfile(buildPersonProfile({
      id: "person_kevin",
      displayName: "Kevin",
      source: "manual",
      sourceSession: { sessionKey: "realtime/person" },
      confidence: 1,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    personStore.putFact(buildPersonFact({
      id: "fact_kevin_updates",
      personId: "person_kevin",
      text: "Kevin prefers short updates.",
      origin: "manual",
      source: "manual",
      sourceSession: { sessionKey: "realtime/older" },
      confidence: 0.95,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    personStore.putFact(buildPersonFact({
      id: "fact_unreviewed",
      personId: "person_kevin",
      text: "Kevin might like espresso.",
      origin: "memory_distill",
      source: "memory_distill",
      sourceSession: { sessionKey: "realtime/person" },
      confidence: 0.5,
      review: { state: "unreviewed" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    const provider = new StubProvider(["- Kevin said the deploy is done."]);

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", session_key: "realtime/person" },
      { workspace: ws, now: NOW, provider, personStore },
    );

    expect(result.ok).toBe(true);
    const userMsg = provider.calls[0].messages[0]?.content as string;
    expect(userMsg).toContain("BOUNDED PERSON SNAPSHOT");
    expect(userMsg).toContain("Kevin prefers short updates");
    expect(userMsg).not.toContain("espresso");
  });

  test("writes a quarantined MemoryCandidate when unconfirmed identity candidates touched the session", async () => {
    seedRealtimeSession("realtime/person", "This unknown face might be Kevin.", "I will keep it for review.");
    const personStore = new InMemoryPersonStore();
    personStore.putCandidate(buildIdentityCandidate({
      id: "cand_face_unknown",
      candidateType: "unknown_face",
      modalities: ["face"],
      label: "unknown face",
      source: "face_service",
      sourceSession: { sessionKey: "realtime/person" },
      confidence: 0.72,
      review: { state: "unreviewed" },
    }));
    const memoryCandidateStore = new InMemoryMemoryCandidateStore();
    const provider = new StubProvider(["- Unknown face was present; identity needs review."]);

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", session_key: "realtime/person" },
      { workspace: ws, now: NOW, provider, personStore, memoryCandidateStore },
    );

    expect(result.ok).toBe(true);
    expect(result.memoryCandidates).toBe(1);
    expect(result.quarantinedMemoryCandidates).toBe(1);
    const candidates = memoryCandidateStore.list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].quarantineReason).toBe("unconfirmed_identity_candidate");
    expect(candidates[0].allowedUses.durableMemory).toBe(false);
    expect(candidates[0].subjects).toEqual([
      { type: "person_candidate", id: "cand_face_unknown", label: "unknown face" },
    ]);
  });
});

describe("distillMemory: global (real LLM path, stub provider)", () => {
  test("feeds existing MEMORY.md + daily logs and replaces MEMORY.md with model output", async () => {
    ws.writeFile("MEMORY.md", "# MEMORY\n\n- old curated fact\n");
    ws.writeFile("memory/2026-06-15.md", "# 2026-06-15\n\n- user prefers dark mode\n");
    const provider = new StubProvider(["# MEMORY\n\n- old curated fact\n- user prefers dark mode\n"]);

    const result = await distillMemory(STUB_CONFIG, { scope: "global" }, { workspace: ws, now: NOW, provider });

    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(1);
    const userMsg = provider.calls[0].messages[0]?.content as string;
    expect(userMsg).toContain("old curated fact"); // existing memory fed in
    expect(userMsg).toContain("dark mode"); // daily log fed in

    const after = ws.readFile("MEMORY.md") ?? "";
    expect(after).toContain("dark mode");
    expect(after).toContain("old curated fact");
  });

  test("leaves MEMORY.md unchanged when the model streams nothing", async () => {
    ws.writeFile("MEMORY.md", "# MEMORY\n\n- keep me\n");
    ws.writeFile("memory/2026-06-15.md", "# 2026-06-15\n\n- something\n");
    const provider = new StubProvider([]);

    const result = await distillMemory(STUB_CONFIG, { scope: "global" }, { workspace: ws, now: NOW, provider });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/empty output/i);
    expect(ws.readFile("MEMORY.md")).toContain("keep me");
  });

  test("keeps quarantined daily summaries out of global consolidation", async () => {
    seedRealtimeSession("realtime/person", "This unknown face might be Kevin.", "I will keep it for review.");
    const personStore = new InMemoryPersonStore();
    personStore.putCandidate(buildIdentityCandidate({
      id: "cand_face_unknown",
      candidateType: "unknown_face",
      modalities: ["face"],
      label: "unknown face",
      source: "face_service",
      sourceSession: { sessionKey: "realtime/person" },
      confidence: 0.72,
      review: { state: "unreviewed" },
    }));
    const memoryCandidateStore = new InMemoryMemoryCandidateStore();
    const dailyProvider = new StubProvider(["- Unknown face might be Kevin."]);

    const daily = await distillMemory(
      STUB_CONFIG,
      { scope: "daily", session_key: "realtime/person" },
      { workspace: ws, now: NOW, provider: dailyProvider, personStore, memoryCandidateStore },
    );
    expect(daily.ok).toBe(true);
    expect(daily.quarantinedMemoryCandidates).toBe(1);
    expect(ws.readFile(`memory/${DATE_STR}.md`)).toContain("Unknown face might be Kevin");

    const globalProvider = new StubProvider(["# MEMORY\n\n- Unknown face might be Kevin.\n"]);
    const global = await distillMemory(
      STUB_CONFIG,
      { scope: "global" },
      { workspace: ws, now: NOW, provider: globalProvider, memoryCandidateStore },
    );

    expect(global.ok).toBe(false);
    expect(global.note).toMatch(/No globally promotable daily log entries/i);
    expect(global.skippedDailyEntries).toBe(1);
    expect(globalProvider.calls).toHaveLength(0);
    expect(ws.readFile("MEMORY.md")).not.toContain("Unknown face might be Kevin");
  });

  test("blocks confirmed-person daily summaries until candidate review allows durable memory", async () => {
    ws.writeFile("memory/2026-06-15.md", "# 2026-06-15\n\n[09:00] Kevin prefers short updates.\n");
    const memoryCandidateStore = new InMemoryMemoryCandidateStore();
    memoryCandidateStore.put(buildMemoryCandidate({
      text: "Kevin prefers short updates.",
      sourceSession: { sessionKey: "realtime/person" },
      subjects: [{ type: "confirmed_person", id: "person_kevin", label: "Kevin" }],
      metadata: { distillScope: "daily", personSnapshotPeople: 1 },
    }));
    const provider = new StubProvider(["# MEMORY\n\n- Kevin prefers short updates.\n"]);

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "global" },
      { workspace: ws, now: NOW, provider, memoryCandidateStore },
    );

    expect(result.ok).toBe(false);
    expect(result.skippedDailyEntries).toBe(1);
    expect(provider.calls).toHaveLength(0);
    expect(ws.readFile("MEMORY.md")).not.toContain("Kevin prefers short updates");
  });

  test("filters quarantined entries while consolidating eligible daily entries", async () => {
    ws.writeFile(
      "memory/2026-06-15.md",
      "# 2026-06-15\n\n[09:00] Safe project update.\n[10:00] Unknown face might be Kevin.\n",
    );
    const memoryCandidateStore = new InMemoryMemoryCandidateStore();
    memoryCandidateStore.put(buildMemoryCandidate({
      text: "Unknown face might be Kevin.",
      sourceSession: { sessionKey: "realtime/person" },
      subjects: [{ type: "person_candidate", id: "cand_face_unknown", label: "unknown face" }],
      quarantineReason: "unconfirmed_identity_candidate",
      metadata: { distillScope: "daily" },
    }));
    const provider = new StubProvider(["# MEMORY\n\n- Safe project update.\n"]);

    const result = await distillMemory(
      STUB_CONFIG,
      { scope: "global" },
      { workspace: ws, now: NOW, provider, memoryCandidateStore },
    );

    expect(result.ok).toBe(true);
    expect(result.skippedDailyEntries).toBe(1);
    const userMsg = provider.calls[0].messages[0]?.content as string;
    expect(userMsg).toContain("Safe project update");
    expect(userMsg).not.toContain("Unknown face might be Kevin");
  });
});

describe("distill model resolution", () => {
  test("defaults to Haiku when unset", () => {
    expect(resolveDistillModel({} as HawkyConfig)).toBe(DEFAULT_DISTILL_MODEL);
    expect(DEFAULT_DISTILL_MODEL).toMatch(/haiku/i);
  });

  test("honors config.memory.distill_model", () => {
    const cfg = { memory: { distill_model: "claude-sonnet-4-6" } } as HawkyConfig;
    expect(resolveDistillModel(cfg)).toBe("claude-sonnet-4-6");
  });

  test("uses the resolved model in the LLM call even when default provider is OpenAI", async () => {
    seedRealtimeSession("realtime/cross", "hi", "hello");
    // Default chat provider is OpenAI, but distillation should still target the
    // (Anthropic) distill model. An injected provider stands in for the real
    // Anthropic provider, so we can assert the model without a network call.
    const provider = new StubProvider(["- ok"]);
    const cfg = {
      provider: "openai",
      api_keys: { anthropic: "sk-ant-test", openai: "sk-openai-test", brave_search: "" },
    } as HawkyConfig;

    const result = await distillMemory(cfg, { scope: "daily" }, { workspace: ws, now: NOW, provider });
    expect(result.ok).toBe(true);
    expect(provider.calls[0].model).toBe(DEFAULT_DISTILL_MODEL); // Haiku, not gpt-4o
  });
});

describe("readMemorySnapshot", () => {
  test("returns the four tiers", async () => {
    ws.writeFile("SOUL.md", "# soul\nbe kind");
    ws.writeFile("IDENTITY.md", "# id\nname: Hawky");
    ws.writeFile("MEMORY.md", "# mem\n- fact");
    ws.writeFile(`memory/${DATE_STR}.md`, `# ${DATE_STR}\n- today`);

    const snap = readMemorySnapshot({ workspace: ws });
    expect(snap.soul).toContain("be kind");
    expect(snap.identity).toContain("Hawky");
    expect(snap.global).toContain("fact");
    expect(snap.daily.length).toBeGreaterThanOrEqual(1);
    expect(snap.daily[0].date).toBe(DATE_STR);
    expect(snap.daily[0].content).toContain("today");
  });

  test("daily entries are newest-first and respect the limit", async () => {
    for (const d of ["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16"]) {
      ws.writeFile(`memory/${d}.md`, `# ${d}\n- entry`);
    }
    const snap = readMemorySnapshot({ workspace: ws, dailyLimit: 3 });
    expect(snap.daily.length).toBe(3);
    expect(snap.daily.map((d) => d.date)).toEqual(["2026-06-16", "2026-06-15", "2026-06-14"]);
  });
});
