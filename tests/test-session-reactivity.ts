// =============================================================================
// Tests: Session List Reactivity
//
// Verifies that session.updated events are broadcast when new sessions
// are created, enabling real-time sidebar updates.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import type { HawkyConfig } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

let testDir: string;
let server: GatewayServer;
let sessions: AgentSessionManager;
let broadcastedEvents: Array<{ event: string; payload: unknown }>;

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

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-reactivity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "workspace"), { recursive: true });
  mkdirSync(join(testDir, "sessions"), { recursive: true });
  setSessionsDir(join(testDir, "sessions"));
  applyDefaultLaneConcurrency();

  // Create server with broadcast spy
  broadcastedEvents = [];
  server = new GatewayServer();
  const origBroadcast = server.broadcast.bind(server);
  server.broadcast = (event: string, payload?: unknown) => {
    broadcastedEvents.push({ event, payload });
    origBroadcast(event, payload);
  };

  sessions = new AgentSessionManager({
    provider: { sendMessage: async () => ({ type: "message", content: [], usage: { input_tokens: 0, output_tokens: 0 } }) } as any,
    config: makeConfig(),
    workingDirectory: testDir,
    server,
  });
});

afterAll(() => {
  resetGatewayState();
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("session.updated broadcast", () => {
  test("broadcasts session.updated when a new session is created", () => {
    broadcastedEvents.length = 0;
    sessions.getOrCreate("web:new-channel");

    const updates = broadcastedEvents.filter((e) => e.event === "session.updated");
    expect(updates.length).toBe(1);
    expect((updates[0].payload as any).sessionKey).toBe("web:new-channel");
  });

  test("does not broadcast when returning an existing session", () => {
    // First call creates the session
    sessions.getOrCreate("web:existing");
    broadcastedEvents.length = 0;

    // Second call returns existing — should NOT broadcast
    sessions.getOrCreate("web:existing");
    const updates = broadcastedEvents.filter((e) => e.event === "session.updated");
    expect(updates.length).toBe(0);
  });

  test("broadcasts for cron sessions", () => {
    broadcastedEvents.length = 0;
    sessions.getOrCreate("cron:my-job");

    const updates = broadcastedEvents.filter((e) => e.event === "session.updated");
    expect(updates.length).toBe(1);
    expect((updates[0].payload as any).sessionKey).toBe("cron:my-job");
  });

  test("broadcasts for heartbeat sessions", () => {
    broadcastedEvents.length = 0;
    sessions.getOrCreate("heartbeat:main");

    const updates = broadcastedEvents.filter((e) => e.event === "session.updated");
    expect(updates.length).toBe(1);
    expect((updates[0].payload as any).sessionKey).toBe("heartbeat:main");
  });

  test("broadcasts for fork sessions", () => {
    broadcastedEvents.length = 0;
    sessions.getOrCreate("web:fork-daily-digest-0411-x3k2");

    const updates = broadcastedEvents.filter((e) => e.event === "session.updated");
    expect(updates.length).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Session eviction
// -----------------------------------------------------------------------------

describe("session eviction", () => {
  test("evict removes session from memory", () => {
    sessions.getOrCreate("cron:evict-test");
    expect(sessions.has("cron:evict-test")).toBe(true);

    sessions.evict("cron:evict-test");
    expect(sessions.has("cron:evict-test")).toBe(false);
  });

  test("evict is safe for nonexistent sessions", () => {
    sessions.evict("cron:does-not-exist");
    // No error thrown
    expect(sessions.has("cron:does-not-exist")).toBe(false);
  });
});
