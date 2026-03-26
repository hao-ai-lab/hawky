// =============================================================================
// Tests: Heartbeat Gateway Protocol
//
// Tests the full gateway stack:
// - GatewayClient heartbeat event forwarding (protocol boundary)
// - RPC heartbeat.status / heartbeat.trigger on real WebSocket
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GatewayServer } from "../src/gateway/server.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { HeartbeatService } from "../src/gateway/heartbeat.js";
import { registerHeartbeatMethods } from "../src/gateway/heartbeat-methods.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetSystemEvents } from "../src/gateway/system-events.js";
import type { HawkyConfig, StreamEvent } from "../src/agent/types.js";
import type { EventFrame } from "../src/gateway/protocol.js";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

let testDir: string;
let testHBFile: string;
let server: GatewayServer;
let heartbeat: HeartbeatService;
let port: number;

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    max_iterations: 40,
    max_tool_result_chars: 30_000,
    workspace_dir: "/tmp",
    gateway_port: 0, // will use random port
    heartbeat: {
      enabled: true,
      interval_minutes: 30,
      keep_recent_messages: 8,
      active_hours: { start: "00:00", end: "24:00", timezone: "UTC" },
    },
  };
}

/** Connect to gateway via raw WebSocket + handshake */
async function connectWS(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => {
      // Send handshake
      ws.send(JSON.stringify({
        type: "req", id: "hs",
        method: "connect",
        params: { version: "1.0", platform: "test", sessionKey: "test:main" },
      }));
    };
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.type === "res" && data.id === "hs" && data.ok) {
        resolve(ws);
      }
    };
    ws.onerror = reject;
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

/** Send RPC and wait for response */
function rpc(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random()}`;
    const handler = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data));
      if (data.type === "res" && data.id === id) {
        ws.removeEventListener("message", handler);
        if (data.ok) resolve(data.payload);
        else reject(new Error(data.error?.message ?? "RPC failed"));
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("RPC timeout"));
    }, 5000);
  });
}

/** Collect broadcast events for a duration */
function collectEvents(ws: WebSocket, durationMs: number): Promise<EventFrame[]> {
  return new Promise((resolve) => {
    const events: EventFrame[] = [];
    const handler = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data));
      if (data.type === "event") {
        events.push(data);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(events);
    }, durationMs);
  });
}

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-hb-gw-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  testHBFile = join(testDir, "HEARTBEAT.md");

  applyDefaultLaneConcurrency();

  const config = makeConfig();
  server = new GatewayServer(null);

  const sessions = new AgentSessionManager({
    provider: { stream: async function*() {} } as any,
    config,
    workingDirectory: "/tmp",
    server,
  });

  registerAgentMethods(server, sessions);

  heartbeat = new HeartbeatService({
    sessions,
    server,
    config,
    heartbeatFilePath: testHBFile,
  });

  registerHeartbeatMethods(server, heartbeat);

  // Use random port
  server.start(0, "127.0.0.1");
  port = server.getPort();
});

afterAll(async () => {
  heartbeat.stop();
  await server.stop(2000);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// RPC: heartbeat.status
// =============================================================================

describe("heartbeat.status RPC via WebSocket", () => {
  test("returns status with all fields", async () => {
    const ws = await connectWS();
    try {
      const status = await rpc(ws, "heartbeat.status");
      expect(status).toBeDefined();
      expect("lastRunAt" in status).toBe(true);
      expect("lastStatus" in status).toBe(true);
      expect("nextRunAt" in status).toBe(true);
      expect("alertCount" in status).toBe(true);
      expect("running" in status).toBe(true);
      expect("activeHoursStart" in status).toBe(true);
      expect(status.activeHoursStart).toBe("00:00");
    } finally {
      ws.close();
    }
  });
});

// =============================================================================
// RPC: heartbeat.trigger
// =============================================================================

describe("heartbeat.trigger RPC via WebSocket", () => {
  beforeEach(() => {
    try { unlinkSync(testHBFile); } catch {}
    resetSystemEvents();
  });

  test("trigger returns ok and broadcasts events", async () => {
    const ws = await connectWS();
    try {
      // Start collecting events before trigger
      const eventsPromise = collectEvents(ws, 2000);

      // Trigger heartbeat (will skip because no HEARTBEAT.md, but events still broadcast)
      const result = await rpc(ws, "heartbeat.trigger");
      expect(result.triggered).toBe(true);

      // Wait for events to be collected
      const events = await eventsPromise;

      // Should have received heartbeat.started and heartbeat.completed
      const started = events.find((e) => e.event === "heartbeat.started");
      const completed = events.find((e) => e.event === "heartbeat.completed");

      expect(started).toBeDefined();
      expect(completed).toBeDefined();

      const completedPayload = completed!.payload as any;
      expect(completedPayload.status).toBe("skipped");
      expect(completedPayload.reason).toBe("no-tasks");
      expect(completedPayload.activeHoursStart).toBe("00:00");
    } finally {
      ws.close();
    }
  });
});

// =============================================================================
// Protocol boundary: heartbeat events NOT mixed into agent events
// =============================================================================

describe("Heartbeat event protocol boundary", () => {
  test("heartbeat events have heartbeat.* prefix, not agent.*", async () => {
    const ws = await connectWS();
    try {
      const eventsPromise = collectEvents(ws, 2000);

      // Trigger heartbeat
      await rpc(ws, "heartbeat.trigger");

      const events = await eventsPromise;

      // All heartbeat events should use heartbeat.* prefix
      const heartbeatEvents = events.filter((e) => e.event.startsWith("heartbeat."));
      const agentHeartbeatEvents = events.filter((e) => e.event.startsWith("agent.heartbeat"));

      expect(heartbeatEvents.length).toBeGreaterThanOrEqual(2);
      expect(agentHeartbeatEvents.length).toBe(0);
    } finally {
      ws.close();
    }
  });
});
