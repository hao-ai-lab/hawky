// =============================================================================
// E2E Tests: Cron Service
//
// Tests with real Anthropic API. Requires ANTHROPIC_API_KEY env var.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CronService } from "../src/gateway/cron.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { AnthropicProvider } from "../src/agent/anthropic_provider.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { readRunLog } from "../src/gateway/cron-run-log.js";
import type { HawkyConfig } from "../src/agent/types.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";

const API_KEY = process.env.ANTHROPIC_API_KEY || "";

let testDir: string;

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: API_KEY, brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    max_iterations: 40,
    max_tool_result_chars: 30_000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
    cron: { enabled: true, max_concurrent_runs: 1, max_missed_on_restart: 3 },
  } as any;
}

function makeMockServer() {
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  return {
    broadcast(event: string, payload?: unknown) { broadcasts.push({ event, payload }); },
    broadcastToSession() {},
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
  };
}

beforeAll(() => {
  if (!API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set — E2E cron tests will fail");
  }
  testDir = join(tmpdir(), `hawky-e2e-cron-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(join(testDir, "sessions"));
  applyDefaultLaneConcurrency();
});

afterAll(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("E2E: Cron job execution", () => {
  test("job fires and agent runs bash", async () => {
    const config = makeConfig();
    const server = makeMockServer();
    const provider = new AnthropicProvider(API_KEY);
    const sessions = new AgentSessionManager({
      provider,
      config,
      workingDirectory: "/tmp",
    });

    const storePath = join(testDir, "e2e-fire", "cron", "jobs.json");
    const svc = new CronService({
      sessions,
      server: server as any,
      config,
      storePath,
    });

    const job = svc.addJob({
      name: "e2e-test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "Say exactly: CRON_E2E_OK" },
    });

    await svc.forceRun(job.id);

    // Check job state updated
    const updated = svc.getJob(job.id);
    expect(updated!.state.lastStatus).toBe("ok");
    expect(updated!.state.lastRunAtMs).toBeGreaterThan(0);
    expect(updated!.state.consecutiveErrors).toBe(0);

    // Check run log created
    const logs = readRunLog(storePath, job.id);
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe("ok");

    // Check broadcast events
    const started = server.broadcasts.find((b) => b.event === "cron.started");
    const completed = server.broadcasts.find((b) => b.event === "cron.completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();

    svc.stop();
    sessions.reset();
  });

  test("one-shot job auto-deletes after success", async () => {
    const config = makeConfig();
    const server = makeMockServer();
    const provider = new AnthropicProvider(API_KEY);
    const sessions = new AgentSessionManager({
      provider,
      config,
      workingDirectory: "/tmp",
    });

    const storePath = join(testDir, "e2e-oneshot", "cron", "jobs.json");
    const svc = new CronService({
      sessions,
      server: server as any,
      config,
      storePath,
    });

    const job = svc.addJob({
      name: "one-shot",
      schedule: { kind: "at", atMs: Date.now() + 86_400_000 }, // Far future so it doesn't fire
      payload: { message: "Say OK" },
      deleteAfterRun: true,
    });

    await svc.forceRun(job.id);

    // Job should be deleted
    expect(svc.getJob(job.id)).toBeUndefined();

    svc.stop();
    sessions.reset();
  });
});
