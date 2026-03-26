// =============================================================================
// E2E Tests: Heartbeat Service
//
// Tests with real Anthropic API calls. Requires ANTHROPIC_API_KEY env var.
// Tests the full heartbeat decision flow (Phase 1) and execution (Phase 2).
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HeartbeatService, HEARTBEAT_SESSION_KEY } from "../src/gateway/heartbeat.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { AnthropicProvider } from "../src/agent/anthropic_provider.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetSystemEvents } from "../src/gateway/system-events.js";
import type { HawkyConfig } from "../src/agent/types.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Use temp directory for heartbeat file — never touch real ~/.hawky/
let testDir: string;
let testHeartbeatFile: string;

function makeConfig(overrides: Partial<HawkyConfig["heartbeat"]> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: API_KEY, brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    max_iterations: 40,
    max_tool_result_chars: 30_000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: {
      enabled: true,
      interval_minutes: 30,
      keep_recent_messages: 8,
      active_hours: { start: "00:00", end: "24:00", timezone: "UTC" },
      ...overrides,
    },
  };
}

function makeMockServer() {
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const sessionBroadcasts: Array<{ sessionKey: string; event: string; payload: unknown }> = [];

  return {
    broadcast(event: string, payload?: unknown) {
      broadcasts.push({ event, payload });
    },
    broadcastToSession(sessionKey: string, event: string, payload?: unknown) {
      sessionBroadcasts.push({ sessionKey, event, payload });
    },
    registerMethod() {},
    start() {},
    stop() { return Promise.resolve(); },
    getConnections() { return new Map(); },
    getConnectionCount() { return 0; },
    getPort() { return 4242; },
    getActiveSessionCount() { return 0; },
    setActiveSessionCounter() {},
    nodeRegistry: { listConnected() { return []; } },
    broadcasts,
    sessionBroadcasts,
  };
}

beforeAll(() => {
  if (!API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set — E2E heartbeat tests will fail");
  }
  applyDefaultLaneConcurrency();
  testDir = join(tmpdir(), `hawky-e2e-hb-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(join(testDir, "sessions"));
  testHeartbeatFile = join(testDir, "HEARTBEAT.md");
});

afterAll(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function writeHeartbeatFile(content: string) {
  writeFileSync(testHeartbeatFile, content);
}

function removeHeartbeatFile() {
  try { unlinkSync(testHeartbeatFile); } catch {}
}

function makeTestService(opts: { server: any; config: HawkyConfig; sessions?: any }) {
  return new HeartbeatService({
    sessions: opts.sessions ?? ({} as any),
    server: opts.server,
    config: opts.config,
    heartbeatFilePath: testHeartbeatFile,
  });
}

// -----------------------------------------------------------------------------
// E2E Tests
// -----------------------------------------------------------------------------

describe("E2E: Heartbeat Decision Phase", () => {
  beforeEach(() => resetSystemEvents());

  test("skips when HEARTBEAT.md has only empty tasks", async () => {
    const server = makeMockServer();
    const config = makeConfig();
    const provider = new AnthropicProvider(API_KEY);
    const sessions = new AgentSessionManager({
      provider,
      config,
      workingDirectory: "/tmp",
    });

    const service = makeTestService({
      sessions,
      server: server as any,
      config,
    });

    writeHeartbeatFile("# Heartbeat Tasks\n\n- [ ]\n- [ ]\n");
    (service as any).stopped = false;

    const result = await service.executeHeartbeat();

    // Should skip because content is effectively empty (no API call)
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no-tasks");

    service.stop();
    sessions.reset();
  });

  test("makes real LLM call when HEARTBEAT.md has tasks", async () => {
    const server = makeMockServer();
    const config = makeConfig();
    const provider = new AnthropicProvider(API_KEY);
    const sessions = new AgentSessionManager({
      provider,
      config,
      workingDirectory: "/tmp",
    });

    const service = makeTestService({
      sessions,
      server: server as any,
      config,
    });

    // Write a heartbeat file with a simple, clearly-skippable task
    writeHeartbeatFile("# Heartbeat Tasks\n\n- Nothing urgent, no tasks right now. All is well.\n");
    (service as any).stopped = false;

    const result = await service.executeHeartbeat();

    // The LLM should call the heartbeat_decision tool
    // Whether it skips or runs depends on the model's interpretation
    // But it should not error
    expect(result.status === "ran" || result.status === "skipped").toBe(true);
    expect(result.reason).toBeTruthy();

    // Should have broadcast events
    expect(server.broadcasts.length).toBeGreaterThanOrEqual(2);
    expect(server.broadcasts[0].event).toBe("heartbeat.started");
    expect(server.broadcasts[server.broadcasts.length - 1].event).toBe("heartbeat.completed");

    service.stop();
    sessions.reset();
  });

  test("executes tasks when HEARTBEAT.md has actionable content", async () => {
    const server = makeMockServer();
    const config = makeConfig();
    const provider = new AnthropicProvider(API_KEY);
    const sessions = new AgentSessionManager({
      provider,
      config,
      workingDirectory: "/tmp",
    });

    const service = makeTestService({
      sessions,
      server: server as any,
      config,
    });

    // Write a heartbeat file with clearly actionable tasks
    writeHeartbeatFile("# Heartbeat Tasks\n\n- URGENT: Run the command `echo HEARTBEAT_TEST_OK` and report the output\n");
    (service as any).stopped = false;

    const result = await service.executeHeartbeat();

    // Should either run (Phase 2) or at minimum not crash
    expect(["ran", "skipped"]).toContain(result.status);

    // If it ran, there should be session broadcasts (agent events)
    if (result.status === "ran") {
      expect(server.sessionBroadcasts.length).toBeGreaterThan(0);
      // Summary may be empty if agent used tools without text output
    }

    service.stop();
    sessions.reset();
  });

  test("no API call when HEARTBEAT.md missing", async () => {
    const server = makeMockServer();
    const config = makeConfig();
    const service = makeTestService({
      server: server as any,
      config,
    });

    removeHeartbeatFile();
    (service as any).stopped = false;

    const startTime = Date.now();
    const result = await service.executeHeartbeat();
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no-tasks");
    // Should be very fast (< 100ms) since no API call
    expect(elapsed).toBeLessThan(500);

    service.stop();
  });
});

describe("E2E: Heartbeat Active Hours", () => {
  test("skips when outside active hours", async () => {
    const server = makeMockServer();
    // Set active hours to a tiny window that's definitely not now
    // 02:00-02:01 UTC — extremely unlikely to match
    const config = makeConfig({
      active_hours: { start: "02:00", end: "02:01", timezone: "UTC" },
    });

    const service = makeTestService({
      server: server as any,
      config,
    });

    writeHeartbeatFile("- Check email (urgent!)");
    (service as any).stopped = false;

    // Check if it's actually 02:00 UTC right now (extremely unlikely)
    const nowUTC = new Date().getUTCHours();
    if (nowUTC !== 2) {
      const result = await service.executeHeartbeat();
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("quiet-hours");
    }

    service.stop();
  });
});
