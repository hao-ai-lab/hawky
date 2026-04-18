// =============================================================================
// Tests: Session Fork (session.fork RPC)
//
// Tests the fork logic by calling the RPC method handler directly,
// bypassing WebSocket transport.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import type { HawkyConfig } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;
let server: GatewayServer;
let sessions: AgentSessionManager;

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    max_iterations: 40,
    max_tool_result_chars: 30_000,
    workspace_dir: join(testDir, "workspace"),
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
  } as HawkyConfig;
}

/** Call an RPC method handler directly (no WebSocket needed). */
async function callMethod(method: string, params: any, sessionKey?: string): Promise<any> {
  // Create a mock connection object
  const mockConn = {
    connId: "test-conn",
    sessionKey: sessionKey ?? null,
    isLocalhost: () => true,
    sendResponse: () => {},
    sendEvent: () => true,
    authenticated: true,
    clientPlatform: "test",
    bindSession: (key: string) => { mockConn.sessionKey = key; },
  } as any;

  // Access the method registry via the server's internal dispatch
  // We need to go through the registered handler directly
  return new Promise((resolve, reject) => {
    const frame = { type: "req" as const, id: "test", method, params };

    // Intercept the response
    const origSend = mockConn.sendResponse;
    mockConn.sendResponse = (res: any) => {
      if (res.ok) resolve(res.payload);
      else reject(new Error(res.error?.message ?? "RPC failed"));
    };

    // Use server's internal dispatch
    (server as any).dispatchMethod(mockConn, frame);
  });
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-fork-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "workspace"), { recursive: true });
  mkdirSync(join(testDir, "sessions"), { recursive: true });
  setSessionsDir(join(testDir, "sessions"));
  applyDefaultLaneConcurrency();

  const config = makeConfig();
  server = new GatewayServer();
  sessions = new AgentSessionManager({
    provider: { sendMessage: async () => ({ type: "message", content: [], usage: { input_tokens: 0, output_tokens: 0 } }) } as any,
    config,
    workingDirectory: testDir,
    server,
  });

  // Seed a cron session with two runs (setHistory — getHistory returns a copy)
  const cronSession = sessions.getOrCreate("cron:daily-digest");
  cronSession.loop.setHistory([
    // Run 1
    { role: "user", content: [{ type: "text", text: "Check daily activity and summarize" }], timestamp: "2026-04-10T08:00:00Z" },
    { role: "assistant", content: [{ type: "text", text: "Run 1: 3 PRs merged, 5 commits." }], timestamp: "2026-04-10T08:01:00Z" },
    // Run 2
    { role: "user", content: [{ type: "text", text: "Check daily activity and summarize" }], timestamp: "2026-04-11T08:00:00Z" },
    { role: "assistant", content: [{ type: "text", text: "Run 2: deployment guide shipped." }], timestamp: "2026-04-11T08:01:00Z" },
  ]);

  // Seed a heartbeat session
  const hbSession = sessions.getOrCreate("heartbeat:main");
  hbSession.loop.setHistory([
    { role: "user", content: [{ type: "text", text: "Heartbeat check" }], timestamp: "2026-04-11T09:00:00Z" },
    { role: "assistant", content: [{ type: "text", text: "All systems normal." }], timestamp: "2026-04-11T09:01:00Z" },
  ]);

  // Seed a user session
  const userSession = sessions.getOrCreate("web:general");
  userSession.loop.setHistory([
    { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: "2026-04-11T10:00:00Z" },
  ]);

  registerAgentMethods(server, sessions, config, null as any);
});

afterAll(() => {
  resetGatewayState();
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("session.fork", () => {
  test("forks cron session with last run context only", async () => {
    const result = await callMethod("session.fork", { sourceKey: "cron:daily-digest", platform: "web" });
    expect(result.sessionKey).toMatch(/^web:fork-daily-digest-/);
    expect(result.sourceKey).toBe("cron:daily-digest");
    expect(result.messageCount).toBe(1);

    // Verify the forked session contains the last run's context
    const forked = sessions.get(result.sessionKey);
    expect(forked).toBeTruthy();
    const history = forked!.loop.getHistory();
    expect(history.length).toBe(1);
    const text = (history[0].content[0] as any).text;
    expect(text).toContain("Forked from cron:daily-digest");
    // Should contain last run (run 2), not first run
    expect(text).toContain("deployment guide shipped");
    expect(text).not.toContain("Run 1");
  });

  test("forks heartbeat session", async () => {
    const result = await callMethod("session.fork", { sourceKey: "heartbeat:main", platform: "tui" });
    expect(result.sessionKey).toMatch(/^tui:fork-main-/);
    expect(result.sourceKey).toBe("heartbeat:main");
  });

  test("rejects fork of user session", async () => {
    await expect(
      callMethod("session.fork", { sourceKey: "web:general" }),
    ).rejects.toThrow(/system sessions/);
  });

  test("rejects fork of nonexistent session", async () => {
    await expect(
      callMethod("session.fork", { sourceKey: "cron:nonexistent" }),
    ).rejects.toThrow(/not found/i);
  });

  test("rejects fork of empty session", async () => {
    sessions.getOrCreate("cron:empty-job");
    await expect(
      callMethod("session.fork", { sourceKey: "cron:empty-job" }),
    ).rejects.toThrow(/no messages/i);
  });
});
