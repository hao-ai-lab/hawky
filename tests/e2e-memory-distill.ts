// =============================================================================
// E2E Tests — Memory distillation pipeline (#653)
//
// In-process, NO real phone and NO network. A real Bun WebSocket client stands
// in for the iOS Live testing tab and drives the production gateway + memory
// RPCs end to end:
//
//   memory.snapshot                      → returns the four tiers
//   memory.distill { scope: "daily" }    → seeded realtime session → daily log
//   memory.distill { scope: "global" }   → daily logs → MEMORY.md
//
// All distill calls run in mock mode (mock: true) so no LLM/network is touched.
//
// Run with: bun test --timeout 30000 --max-concurrency=1 ./tests/e2e-memory-distill.ts
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { registerMemoryMethods } from "../src/gateway/memory-methods.js";
import type { ResponseFrame } from "../src/gateway/protocol.js";
import type { HawkyConfig } from "../src/agent/types.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { setWorkspaceDir, getWorkspaceDir, WorkspaceManager } from "../src/storage/workspace.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Records prompts and emits canned text — lets the e2e drive the REAL
// (non-mock) distillation path through the gateway with no network call.
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

// Per-test provider override consumed by registerMemoryMethods. null = use the
// real provider path (which would need a key — only used to assert mock works).
let stubProvider: StubProvider | null = null;

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "mock", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "mock-model",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
  } as HawkyConfig;
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<ResponseFrame> {
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", { version: "e2e-memory", platform: "ios-sim" });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

/** Seed a realtime session jsonl so distill scope=daily has a transcript. */
function seedRealtimeSession(sessionsDir: string, id: string): void {
  mkdirSync(join(sessionsDir, "realtime"), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id, created_at: new Date().toISOString(), model: "test" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Remember I take my coffee black." }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Noted — coffee black." }] } }),
  ];
  writeFileSync(join(sessionsDir, `${id}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

let server: GatewayServer;
let port: number;
let testDir: string;
let sessionsDir: string;
let wsDir: string;
let prevWorkspace: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-e2e-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionsDir = join(testDir, "sessions");
  wsDir = join(testDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  prevWorkspace = getWorkspaceDir();
  setWorkspaceDir(wsDir);
  new WorkspaceManager(wsDir).init();

  stubProvider = null;
  resetGatewayState();
  server = new GatewayServer();
  port = getTestPort();
  // The provider override is read lazily per call via the getter closure, so a
  // test can set `stubProvider` after the server is already up.
  registerMemoryMethods(server, () => makeConfig(), {
    get provider() {
      return stubProvider ?? undefined;
    },
  } as any);
  server.start(port);
});

afterEach(async () => {
  await server.stop(2000);
  resetGatewayState();
  resetSessionsDir();
  setWorkspaceDir(prevWorkspace);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("memory-distill-pipeline", () => {
  test("memory.snapshot returns the four tiers", async () => {
    const ws = await connect(port);
    try {
      const res = await sendRequest(ws, "memory.snapshot", {});
      expect(res.ok).toBe(true);
      const snap = (res.payload as any).snapshot;
      expect(snap).toBeDefined();
      // init() copies templates, so soul/identity/global are non-empty.
      expect(typeof snap.soul).toBe("string");
      expect(snap.soul.length).toBeGreaterThan(0);
      expect(Array.isArray(snap.daily)).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("daily then global distill (mock) updates the workspace files", async () => {
    seedRealtimeSession(sessionsDir, "realtime/live-1");
    const ws = await connect(port);
    try {
      // scope=daily → writes today's daily log.
      const daily = await sendRequest(ws, "memory.distill", { scope: "daily", mock: true });
      expect(daily.ok).toBe(true);
      const dailyResult = daily.payload as any;
      expect(dailyResult.ok).toBe(true);
      expect(dailyResult.mocked).toBe(true);
      expect(dailyResult.file).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);

      const wsm = new WorkspaceManager(wsDir);
      expect(wsm.readFile(dailyResult.file)).toContain("(mock)");

      // scope=global → consolidates the daily log into MEMORY.md.
      const global = await sendRequest(ws, "memory.distill", { scope: "global", mock: true });
      expect(global.ok).toBe(true);
      const globalResult = global.payload as any;
      expect(globalResult.ok).toBe(true);
      expect(globalResult.file).toBe("MEMORY.md");
      expect(wsm.readFile("MEMORY.md")).toContain("(mock) Consolidated");

      // Snapshot now reflects the new daily log.
      const snap = (await sendRequest(ws, "memory.snapshot", {})).payload as any;
      expect(snap.snapshot.daily.length).toBeGreaterThanOrEqual(1);
    } finally {
      ws.close();
    }
  });

  test("invalid scope is rejected", async () => {
    const ws = await connect(port);
    try {
      const res = await sendRequest(ws, "memory.distill", { scope: "bogus" });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toMatch(/scope must be/i);
    } finally {
      ws.close();
    }
  });

  test("daily distill with no transcript fails gracefully (ok:false, not RPC error)", async () => {
    const ws = await connect(port);
    try {
      const res = await sendRequest(ws, "memory.distill", { scope: "daily", mock: true });
      expect(res.ok).toBe(true); // RPC succeeded
      const result = res.payload as any;
      expect(result.ok).toBe(false); // distillation found nothing
      expect(result.note).toMatch(/no readable realtime transcript/i);
    } finally {
      ws.close();
    }
  });

  // ---------------------------------------------------------------------------
  // REAL LLM path through the gateway (stub provider, no network). This is the
  // path that runs on the phone — exercises prompt assembly + stream parse +
  // file write end-to-end, just with a canned model response.
  // ---------------------------------------------------------------------------

  test("real-path daily distill: model summary is written via the gateway", async () => {
    seedRealtimeSession(sessionsDir, "realtime/live-real");
    stubProvider = new StubProvider("- User takes their coffee black.\n");
    const ws = await connect(port);
    try {
      const res = await sendRequest(ws, "memory.distill", { scope: "daily" }); // no mock
      expect(res.ok).toBe(true);
      const result = res.payload as any;
      expect(result.ok).toBe(true);
      expect(result.mocked).toBe(false);

      // The model was actually invoked through the RPC, with the transcript.
      expect(stubProvider.calls.length).toBe(1);
      expect(stubProvider.calls[0].model).toMatch(/haiku/i);
      expect(stubProvider.calls[0].messages[0]?.content).toContain("coffee black");

      const wsm = new WorkspaceManager(wsDir);
      expect(wsm.readFile(result.file)).toContain("coffee black");
    } finally {
      ws.close();
    }
  });

  test("real-path full pipeline: session → daily → global, snapshot reflects both", async () => {
    seedRealtimeSession(sessionsDir, "realtime/live-full");
    const ws = await connect(port);
    try {
      // 1) daily: model emits a daily-log entry.
      stubProvider = new StubProvider("- Shipped the memory feature today.\n");
      const daily = (await sendRequest(ws, "memory.distill", { scope: "daily" })).payload as any;
      expect(daily.ok).toBe(true);

      // 2) global: model emits a FULL consolidated MEMORY.md that includes the
      // fact. It must be substantial enough to clear the anti-lossy gate against
      // the seeded template MEMORY.md (a one-line output would be rejected as
      // lossy — that guard is the point of Phase A of #14).
      stubProvider = new StubProvider(
        "# MEMORY.md — Long-Term Memory\n\n" +
          "_Your curated memory. Distilled facts, decisions, and lessons — not raw logs._\n\n" +
          "## Facts\n\n- Shipped the memory feature.\n- User is actively building the memory pipeline.\n",
      );
      const global = (await sendRequest(ws, "memory.distill", { scope: "global" })).payload as any;
      expect(global.ok).toBe(true);
      expect(global.file).toBe("MEMORY.md");

      // 3) snapshot shows the consolidated global memory + the daily log.
      const snap = (await sendRequest(ws, "memory.snapshot", {})).payload as any;
      expect(snap.snapshot.global).toContain("Shipped the memory feature");
      expect(snap.snapshot.daily.length).toBeGreaterThanOrEqual(1);
      expect(snap.snapshot.daily[0].content).toContain("memory feature today");
    } finally {
      ws.close();
    }
  });
});
