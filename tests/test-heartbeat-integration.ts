// =============================================================================
// Tests: Heartbeat Integration
//
// Integration-level tests covering:
// 1. TUI HeartbeatIndicator rendering states
// 2. Gateway client heartbeat event forwarding
// 3. RPC heartbeat.status / heartbeat.trigger payloads
// 4. Restart survival for trimmed heartbeat history
// 5. Template/onboarding ensureHeartbeatFile
// 6. Quiet-hours payload shape
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HeartbeatService, HEARTBEAT_SESSION_KEY } from "../src/gateway/heartbeat.js";
import type { HeartbeatCompletedEvent } from "../src/gateway/heartbeat.js";
import type { HawkyConfig, ChatMessage } from "../src/agent/types.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { SessionManager } from "../src/storage/session.js";
import { resetSystemEvents } from "../src/gateway/system-events.js";
import { isHeartbeatContentEffectivelyEmpty } from "../src/gateway/heartbeat-prompt.js";
import { HeartbeatIndicator } from "../src/tui/components/heartbeat_indicator.js";
import type { HeartbeatInfo } from "../src/tui/components/heartbeat_indicator.js";

// -----------------------------------------------------------------------------
// Shared test infrastructure
// -----------------------------------------------------------------------------

let testDir: string;
let testHeartbeatFile: string;

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-hb-integ-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  testHeartbeatFile = join(testDir, "HEARTBEAT.md");
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeConfig(overrides: Partial<HawkyConfig["heartbeat"]> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "", openai: "" },
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
      active_hours: { start: "08:00", end: "22:00" },
      ...overrides,
    },
  };
}

function makeMockServer() {
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const sessionBroadcasts: Array<{ sessionKey: string; event: string; payload: unknown }> = [];
  return {
    broadcast(event: string, payload?: unknown) { broadcasts.push({ event, payload }); },
    broadcastToSession(sessionKey: string, event: string, payload?: unknown) { sessionBroadcasts.push({ sessionKey, event, payload }); },
    registerMethod() {},
    start() {},
    stop() { return Promise.resolve(); },
    getConnections() { return new Map(); },
    getConnectionCount() { return 0; },
    getPort() { return 4242; },
    getActiveSessionCount() { return 0; },
    setActiveSessionCounter() {},
    broadcasts,
    sessionBroadcasts,
  };
}

function makeService(opts: { server?: any; config?: HawkyConfig; sessions?: any }) {
  return new HeartbeatService({
    sessions: opts.sessions ?? ({} as any),
    server: opts.server ?? makeMockServer(),
    config: opts.config ?? makeConfig(),
    heartbeatFilePath: testHeartbeatFile,
  });
}

function writeHBFile(content: string) {
  writeFileSync(testHeartbeatFile, content);
}

function removeHBFile() {
  try { unlinkSync(testHeartbeatFile); } catch {}
}

// =============================================================================
// 1. HeartbeatIndicator rendering states (unit-level, component data)
// =============================================================================

describe("HeartbeatIndicator state mapping", () => {
  // These test the data→display contract without React rendering.
  // The component reads HeartbeatInfo and produces specific text.
  // We test the data shapes that produce each documented state.

  test("null info renders nothing", () => {
    expect(HeartbeatIndicator({ info: null })).toBeNull();
  });

  test("running state", () => {
    const info = {
      lastStatus: null, lastRunAt: null, nextRunAt: null,
      alertCount: 0, running: true,
    };
    // Component should render ♡ running...
    const el = HeartbeatIndicator({ info });
    expect(el).not.toBeNull();
  });

  test("quiet-hours state includes resume time", () => {
    const info = {
      lastStatus: "skipped" as const, lastReason: "quiet-hours",
      lastRunAt: Date.now(), nextRunAt: null,
      alertCount: 0, running: false,
      activeHoursStart: "08:00",
    };
    const el = HeartbeatIndicator({ info });
    expect(el).not.toBeNull();
    // The rendered element should reference the resume time
    // (Deep render check would require ink-testing-library,
    // but we verify the component doesn't crash and returns an element)
  });

  test("waiting state (no runs yet)", () => {
    const info = {
      lastStatus: null, lastRunAt: null,
      nextRunAt: Date.now() + 120_000,
      alertCount: 0, running: false,
    };
    const el = HeartbeatIndicator({ info });
    expect(el).not.toBeNull();
  });

  test("skipped state (after a run)", () => {
    const info = {
      lastStatus: "skipped" as const, lastReason: "no-tasks",
      lastRunAt: Date.now() - 60_000,
      nextRunAt: Date.now() + 60_000,
      alertCount: 0, running: false,
    };
    const el = HeartbeatIndicator({ info });
    expect(el).not.toBeNull();
  });

  test("ran state (alert)", () => {
    const info = {
      lastStatus: "ran" as const, lastReason: "email check",
      lastRunAt: Date.now() - 30_000,
      nextRunAt: Date.now() + 90_000,
      alertCount: 1, running: false,
    };
    const el = HeartbeatIndicator({ info });
    expect(el).not.toBeNull();
  });

  test("failed state", () => {
    const info = {
      lastStatus: "failed" as const, lastReason: "API error",
      lastRunAt: Date.now() - 10_000,
      nextRunAt: Date.now() + 110_000,
      alertCount: 0, running: false,
    };
    const el = HeartbeatIndicator({ info });
    expect(el).not.toBeNull();
  });
});

// =============================================================================
// 2. Gateway client heartbeat event forwarding
// =============================================================================

describe("GatewayClient heartbeat event forwarding", () => {
  test("heartbeat events call onHeartbeatEvent, not agent subscribers", () => {
    // Import the handleEvent logic by constructing a minimal client scenario
    // We test the contract: heartbeat.started/completed → onHeartbeatEvent
    // and NOT emitted to stream subscribers

    const { GatewayClient } = require("../src/gateway/gateway-client.js");

    const heartbeatEvents: Array<{ event: string; payload: unknown }> = [];
    const streamEvents: any[] = [];

    const client = new GatewayClient({
      url: "ws://localhost:9999", // won't connect
      sessionKey: "test",
      workingDirectory: "/tmp",
      onHeartbeatEvent: (event: string, payload: unknown) => {
        heartbeatEvents.push({ event, payload });
      },
    });

    // Subscribe to stream events
    client.subscribe((event: any) => {
      streamEvents.push(event);
    });

    // Simulate receiving heartbeat events by calling handleEvent directly
    const handleEvent = (client as any).handleEvent.bind(client);

    handleEvent({ type: "event", event: "heartbeat.started", payload: { timestamp: 123 } });
    handleEvent({ type: "event", event: "heartbeat.completed", payload: { status: "skipped", reason: "no-tasks" } });

    // heartbeat events should go to onHeartbeatEvent
    expect(heartbeatEvents.length).toBe(2);
    expect(heartbeatEvents[0].event).toBe("heartbeat.started");
    expect(heartbeatEvents[1].event).toBe("heartbeat.completed");

    // Should NOT leak into agent stream subscribers
    expect(streamEvents.length).toBe(0);
  });
});

// =============================================================================
// 3. RPC heartbeat.status payload shape
// =============================================================================

describe("heartbeat.status RPC payload", () => {
  beforeEach(() => {
    removeHBFile();
    resetSystemEvents();
  });

  test("initial status has all required fields", () => {
    const service = makeService({
      config: makeConfig({ active_hours: { start: "08:00", end: "22:00" } }),
    });

    const status = service.getStatus();
    expect("lastRunAt" in status).toBe(true);
    expect("lastStatus" in status).toBe(true);
    expect("nextRunAt" in status).toBe(true);
    expect("alertCount" in status).toBe(true);
    expect("running" in status).toBe(true);
    expect("activeHoursStart" in status).toBe(true);
    expect(status.activeHoursStart).toBe("08:00");
    expect(status.lastRunAt).toBe(null);
    expect(status.running).toBe(false);
  });

  test("status updates after execution", async () => {
    const server = makeMockServer();
    const service = makeService({ server, config: makeConfig({
      active_hours: { start: "00:00", end: "24:00", timezone: "UTC" },
    }) });

    removeHBFile();
    (service as any).stopped = false;
    await service.executeHeartbeat();

    const status = service.getStatus();
    expect(status.lastStatus).toBe("skipped");
    expect(status.lastReason).toBe("no-tasks");
    expect(status.lastRunAt).toBeGreaterThan(0);
    expect(status.running).toBe(false);
    service.stop();
  });
});

// =============================================================================
// 4. heartbeat.trigger broadcasts events
// =============================================================================

describe("heartbeat.trigger event broadcasting", () => {
  beforeEach(() => {
    removeHBFile();
    resetSystemEvents();
  });

  test("trigger broadcasts started + completed", async () => {
    const server = makeMockServer();
    const service = makeService({ server, config: makeConfig({
      active_hours: { start: "00:00", end: "24:00", timezone: "UTC" },
    }) });

    removeHBFile();
    (service as any).stopped = false;
    await service.executeHeartbeat();

    expect(server.broadcasts.length).toBe(2);
    expect(server.broadcasts[0].event).toBe("heartbeat.started");
    expect(server.broadcasts[1].event).toBe("heartbeat.completed");

    const completed = server.broadcasts[1].payload as HeartbeatCompletedEvent;
    expect(completed.status).toBe("skipped");
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    service.stop();
  });
});

// =============================================================================
// 5. Restart survival for trimmed heartbeat history
// =============================================================================

describe("Heartbeat history survives restart after trimming", () => {
  test("trimmed session reloads with bounded messages", () => {
    const sessionDir = join(testDir, "sessions-restart");
    mkdirSync(sessionDir, { recursive: true });

    // Create a session with 20 messages
    const sm1 = new SessionManager("gw-heartbeat-main", sessionDir);
    sm1.initSession("claude-sonnet-4-6", "/tmp");

    const allMessages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      const msg: ChatMessage = {
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `msg-${i}` }],
      };
      allMessages.push(msg);
      sm1.appendMessage(msg);
    }

    // Verify full load
    expect(sm1.loadSession()!.messages.length).toBe(20);

    // Simulate trim: keep last 8 messages, then rewrite
    const trimmed = allMessages.slice(12);
    sm1.rewriteMessages(trimmed, "claude-sonnet-4-6");

    // Simulate gateway restart: new SessionManager, same ID and dir
    const sm2 = new SessionManager("gw-heartbeat-main", sessionDir);
    const reloaded = sm2.loadSession();

    expect(reloaded!.messages.length).toBe(8);
    expect((reloaded!.messages[0].content[0] as any).text).toBe("msg-12");
    expect((reloaded!.messages[7].content[0] as any).text).toBe("msg-19");
  });
});

// =============================================================================
// 6. Template/onboarding: ensureHeartbeatFile
// =============================================================================

describe("ensureHeartbeatFile onboarding", () => {
  test("creates HEARTBEAT.md from template when missing", () => {
    const hbPath = join(testDir, "onboard-test", "HEARTBEAT.md");
    // Ensure it doesn't exist
    try { unlinkSync(hbPath); } catch {}

    const service = new HeartbeatService({
      sessions: {} as any,
      server: makeMockServer() as any,
      config: makeConfig(),
      heartbeatFilePath: hbPath,
    });

    // start() calls ensureHeartbeatFile
    service.start();

    expect(existsSync(hbPath)).toBe(true);
    const content = readFileSync(hbPath, "utf-8");
    expect(content).toContain("Heartbeat Tasks");
    expect(content).toContain("Active Tasks");
    // Template should be effectively empty (no actionable tasks)
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);

    service.stop();
  });

  test("does not overwrite existing HEARTBEAT.md", () => {
    const hbPath = join(testDir, "onboard-existing", "HEARTBEAT.md");
    mkdirSync(join(testDir, "onboard-existing"), { recursive: true });
    writeFileSync(hbPath, "- My custom task\n");

    const service = new HeartbeatService({
      sessions: {} as any,
      server: makeMockServer() as any,
      config: makeConfig(),
      heartbeatFilePath: hbPath,
    });

    service.start();

    // Should not overwrite
    const content = readFileSync(hbPath, "utf-8");
    expect(content).toBe("- My custom task\n");

    service.stop();
  });
});

// =============================================================================
// 7. Quiet-hours payload includes activeHoursStart
// =============================================================================

describe("Quiet-hours broadcast payload", () => {
  beforeEach(() => resetSystemEvents());

  test("heartbeat.completed includes activeHoursStart when quiet-hours", async () => {
    const server = makeMockServer();
    const service = new HeartbeatService({
      sessions: {} as any,
      server: server as any,
      config: makeConfig({
        // Window that's definitely not now (02:00-02:01 UTC)
        active_hours: { start: "02:00", end: "02:01", timezone: "UTC" },
      }),
      heartbeatFilePath: testHeartbeatFile,
    });

    writeHBFile("- Check email");
    (service as any).stopped = false;

    // Only test if we're not at 02:00 UTC
    const nowUTC = new Date().getUTCHours();
    if (nowUTC !== 2) {
      await service.executeHeartbeat();

      const completed = server.broadcasts.find(
        (b) => b.event === "heartbeat.completed",
      )?.payload as HeartbeatCompletedEvent;

      expect(completed).toBeDefined();
      expect(completed.status).toBe("skipped");
      expect(completed.reason).toBe("quiet-hours");
      expect(completed.activeHoursStart).toBe("02:00");
    }

    service.stop();
  });
});
