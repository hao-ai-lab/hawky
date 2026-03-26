// =============================================================================
// Tests: Cron Service
//
// Integration tests for CronService: lifecycle, execution, failure handling,
// heartbeat bridge, run log, delivery, nesting prevention.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronService, errorBackoffMs, isTransientError } from "../src/gateway/cron.js";
import { setCronServiceRef, cronToolDefinition } from "../src/tools/cron.js";
import { resetSystemEvents, peekSystemEvents } from "../src/gateway/system-events.js";
import { readRunLog, _resolveRunLogPath } from "../src/gateway/cron-run-log.js";
import { existsSync } from "node:fs";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import type { HawkyConfig } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Test setup
// -----------------------------------------------------------------------------

let testDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-cron-svc-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  applyDefaultLaneConcurrency();
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeConfig(cronOverrides: any = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    max_iterations: 40,
    max_tool_result_chars: 30_000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
    cron: { enabled: true, max_concurrent_runs: 1, max_missed_on_restart: 3, ...cronOverrides },
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
    nodeRegistry: { listConnected: () => [] },
    broadcasts,
  };
}

function makeService(name: string, config?: HawkyConfig) {
  const storePath = join(testDir, name, "cron", "jobs.json");
  return new CronService({
    sessions: { getOrCreate: () => ({ loop: { sendMessage: async () => {}, getHistory: () => [], setHistory: () => {}, subscribe: () => () => {} }, sessionManager: { appendMessage: () => {}, rewriteMessages: () => {} } }) } as any,
    server: makeMockServer() as any,
    config: config ?? makeConfig(),
    storePath,
  });
}

// -----------------------------------------------------------------------------
// Config resolution
// -----------------------------------------------------------------------------

describe("CronService.resolveConfig", () => {
  test("resolves defaults", () => {
    const config = CronService.resolveConfig(makeConfig());
    expect(config.enabled).toBe(true);
    expect(config.maxConcurrentRuns).toBe(1);
    expect(config.maxMissedOnRestart).toBe(3);
    expect(config.retention.sessionDays).toBe(7);
  });

  test("resolves overrides", () => {
    const config = CronService.resolveConfig(makeConfig({
      max_concurrent_runs: 5,
      max_missed_on_restart: 10,
    }));
    expect(config.maxConcurrentRuns).toBe(5);
    expect(config.maxMissedOnRestart).toBe(10);
  });
});

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

describe("CronService lifecycle", () => {
  test("start does nothing when disabled", () => {
    const svc = makeService("lifecycle-disabled", makeConfig({ enabled: false }));
    svc.start();
    const status = svc.getStatus();
    expect(status.enabled).toBe(false);
    svc.stop();
  });

  test("start loads jobs and arms timer", () => {
    const svc = makeService("lifecycle-start");
    // Add a job before start
    svc.addJob({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });
    svc.start();
    const status = svc.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.jobCount).toBe(1);
    expect(status.nextFireAtMs).toBeGreaterThan(Date.now());
    svc.stop();
  });

  test("getStatus returns correct counts", () => {
    const svc = makeService("lifecycle-status");
    svc.addJob({ name: "enabled", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "1" } });
    const j2 = svc.addJob({ name: "disabled", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "2" } });
    svc.updateJob(j2.id, { enabled: false });

    const status = svc.getStatus();
    expect(status.jobCount).toBe(2);
    expect(status.enabledJobCount).toBe(1);
    svc.stop();
  });
});

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

describe("CronService CRUD", () => {
  test("addJob computes nextRunAtMs", () => {
    const svc = makeService("crud-add");
    const job = svc.addJob({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });
    expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now());
    svc.stop();
  });

  test("listJobs filters disabled by default", () => {
    const svc = makeService("crud-list");
    svc.addJob({ name: "enabled", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "1" } });
    const j2 = svc.addJob({ name: "disabled", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "2" } });
    svc.updateJob(j2.id, { enabled: false });

    expect(svc.listJobs().length).toBe(1);
    expect(svc.listJobs(true).length).toBe(2);
    svc.stop();
  });

  test("removeJob works", () => {
    const svc = makeService("crud-remove");
    const job = svc.addJob({ name: "test", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "test" } });
    expect(svc.removeJob(job.id)).toBe(true);
    expect(svc.getJob(job.id)).toBeUndefined();
    svc.stop();
  });

  test("removeJob deletes the per-job run history file", async () => {
    const svc = makeService("crud-remove-runlog");
    const job = svc.addJob({ name: "to-remove", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "test" } });
    await svc.forceRun(job.id);

    const runLogPath = _resolveRunLogPath(svc.getStore().getStorePath(), job.id);
    expect(existsSync(runLogPath)).toBe(true);

    svc.removeJob(job.id);
    expect(existsSync(runLogPath)).toBe(false);
    svc.stop();
  });

  test("updateJob re-computes nextRunAtMs on schedule change", () => {
    const svc = makeService("crud-schedule-change");
    const job = svc.addJob({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });
    const originalNext = job.state.nextRunAtMs;

    svc.updateJob(job.id, { schedule: { kind: "every", everyMs: 120_000 } });
    const updated = svc.getJob(job.id);
    expect(updated!.state.nextRunAtMs).not.toBe(originalNext);
    svc.stop();
  });
});

// -----------------------------------------------------------------------------
// Error handling helpers
// -----------------------------------------------------------------------------

describe("errorBackoffMs", () => {
  test("escalates with consecutive errors", () => {
    expect(errorBackoffMs(1)).toBe(30_000);
    expect(errorBackoffMs(2)).toBe(60_000);
    expect(errorBackoffMs(3)).toBe(5 * 60_000);
    expect(errorBackoffMs(4)).toBe(15 * 60_000);
    expect(errorBackoffMs(5)).toBe(60 * 60_000);
    expect(errorBackoffMs(100)).toBe(60 * 60_000); // Capped
  });
});

describe("isTransientError", () => {
  test("detects rate limit", () => {
    expect(isTransientError("429 Too Many Requests")).toBe(true);
    expect(isTransientError("rate_limit_exceeded")).toBe(true);
  });

  test("detects overload", () => {
    expect(isTransientError("529 overloaded")).toBe(true);
  });

  test("detects network errors", () => {
    expect(isTransientError("ECONNREFUSED")).toBe(true);
    expect(isTransientError("fetch failed")).toBe(true);
  });

  test("detects timeout", () => {
    expect(isTransientError("ETIMEDOUT")).toBe(true);
  });

  test("non-transient returns false", () => {
    expect(isTransientError("Invalid API key")).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Heartbeat bridge
// -----------------------------------------------------------------------------

describe("Heartbeat bridge", () => {
  beforeEach(() => resetSystemEvents());

  test("heartbeatBridge enqueues system event", async () => {
    const svc = makeService("hb-bridge");
    const job = svc.addJob({
      name: "bridge-test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "check PRs" },
      heartbeatBridge: true,
    });

    // Force-run the job
    await svc.forceRun(job.id);

    // Check system events were enqueued for heartbeat
    const events = peekSystemEvents("heartbeat:main");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].text).toContain("bridge-test");
    svc.stop();
  });

  test("no bridge when heartbeatBridge is false", async () => {
    const svc = makeService("hb-no-bridge");
    const job = svc.addJob({
      name: "no-bridge",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
      heartbeatBridge: false,
    });

    await svc.forceRun(job.id);

    const events = peekSystemEvents("heartbeat:main");
    expect(events.length).toBe(0);
    svc.stop();
  });
});

// -----------------------------------------------------------------------------
// Run log
// -----------------------------------------------------------------------------

describe("Run log integration", () => {
  test("forceRun creates run log entry", async () => {
    const svc = makeService("run-log");
    const job = svc.addJob({
      name: "logged-job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });

    await svc.forceRun(job.id);

    const logs = readRunLog(svc.getStore().getStorePath(), job.id);
    expect(logs.length).toBe(1);
    expect(logs[0].jobId).toBe(job.id);
    expect(logs[0].status).toBe("ok");
    expect(logs[0].durationMs).toBeGreaterThanOrEqual(0);
    svc.stop();
  });
});

// -----------------------------------------------------------------------------
// Broadcast events
// -----------------------------------------------------------------------------

describe("Broadcast events", () => {
  test("forceRun broadcasts started + completed", async () => {
    const server = makeMockServer();
    const storePath = join(testDir, "broadcast", "cron", "jobs.json");
    const svc = new CronService({
      sessions: { getOrCreate: () => ({ loop: { sendMessage: async () => {}, getHistory: () => [], setHistory: () => {}, subscribe: () => () => {} }, sessionManager: { appendMessage: () => {}, rewriteMessages: () => {} } }) } as any,
      server: server as any,
      config: makeConfig(),
      storePath,
    });

    const job = svc.addJob({
      name: "broadcast-test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });

    await svc.forceRun(job.id);

    const started = server.broadcasts.find((b) => b.event === "cron.started");
    const completed = server.broadcasts.find((b) => b.event === "cron.completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect((completed!.payload as any).status).toBe("ok");
    svc.stop();
  });
});

// -----------------------------------------------------------------------------
// Regression: session_target "current" captures real session key
// -----------------------------------------------------------------------------

describe("session_target: current", () => {
  test("resolveSessionKey uses stored sessionKey for current target", () => {
    const svc = makeService("session-current");
    const job = svc.addJob({
      name: "reminder",
      schedule: { kind: "at", at: "+1h" },
      payload: { message: "reminder" },
      sessionTarget: "current",
      sessionKey: "tui:main",
    });

    // Access the private method via the prototype
    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("tui:main");
  });

  test("resolveSessionKey falls back to cron:<name> if no sessionKey", () => {
    const svc = makeService("session-current-fallback");
    const job = svc.addJob({
      name: "reminder",
      schedule: { kind: "at", at: "+1h" },
      payload: { message: "reminder" },
      sessionTarget: "current",
      // No sessionKey
    });

    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("cron:reminder");
  });

  test("resolveSessionKey for named session", () => {
    const svc = makeService("session-named");
    const job = svc.addJob({
      name: "standup",
      schedule: { kind: "cron", expr: "0 17 * * 1-5" },
      payload: { message: "standup" },
      sessionTarget: "session:standup",
    });

    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("cron:standup");
  });
});

// -----------------------------------------------------------------------------
// Session key name sanitization
// -----------------------------------------------------------------------------

describe("resolveSessionKey name sanitization", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    const svc = makeService("sanitize-spaces");
    const job = svc.addJob({
      name: "My Daily Digest",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { message: "digest" },
    });
    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("cron:my-daily-digest");
  });

  test("strips special characters", () => {
    const svc = makeService("sanitize-special");
    const job = svc.addJob({
      name: "job@v2!#test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });
    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("cron:jobv2test");
  });

  test("preserves hyphens and underscores", () => {
    const svc = makeService("sanitize-hyphens");
    const job = svc.addJob({
      name: "hn-digest_v2",
      schedule: { kind: "every", everyMs: 3_600_000 },
      payload: { message: "hn" },
    });
    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("cron:hn-digest_v2");
  });

  test("isolated target uses sanitized name", () => {
    const svc = makeService("sanitize-isolated");
    const job = svc.addJob({
      name: "Email Check",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "check" },
      sessionTarget: "isolated",
    });
    const resolved = (svc as any).resolveSessionKey(job);
    expect(resolved).toBe("cron:email-check");
  });
});

// -----------------------------------------------------------------------------
// Regression: nesting prevention
// -----------------------------------------------------------------------------

describe("Nesting prevention", () => {
  test("cron tool rejects add in headless context", async () => {
    const { cronToolDefinition } = await import("../src/tools/cron.js");
    const { setCronServiceRef } = await import("../src/tools/cron.js");

    // Set up a mock cron service
    setCronServiceRef({
      getStatus: () => ({ enabled: true }),
      addJob: () => ({ id: "test", name: "test", state: { nextRunAtMs: null } }),
      listJobs: () => [],
    });

    const result = await cronToolDefinition.execute(
      { action: "add", name: "nested", message: "test", schedule_kind: "every", every_minutes: 5 },
      {
        session_id: "cron:parent-job",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
        headless: true, // Simulates headless cron/heartbeat context
      },
    );

    expect(result.type).toBe("error");
    expect(result.content).toContain("Cannot create cron jobs");

    setCronServiceRef(null);
  });

  test("cron tool allows add in interactive context", async () => {
    const { cronToolDefinition } = await import("../src/tools/cron.js");
    const { setCronServiceRef } = await import("../src/tools/cron.js");

    setCronServiceRef({
      addJob: () => ({ id: "test123", name: "test-job", state: { nextRunAtMs: Date.now() + 60000 } }),
      listJobs: () => [],
      getJob: () => null,
    });

    const result = await cronToolDefinition.execute(
      { action: "add", name: "interactive", message: "test", schedule_kind: "every", every_minutes: 5 },
      {
        session_id: "tui:main",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
        headless: false,
      },
    );

    expect(result.type).toBe("text");
    expect(result.content).toContain("Created cron job");

    setCronServiceRef(null);
  });

  test("cron tool with session_target=current captures context.session_id as sessionKey", async () => {
    const { cronToolDefinition } = await import("../src/tools/cron.js");
    const { setCronServiceRef } = await import("../src/tools/cron.js");

    // Capture what addJob receives
    let capturedCreate: any = null;
    setCronServiceRef({
      addJob: (create: any) => {
        capturedCreate = create;
        return { id: "cap123", name: create.name, state: { nextRunAtMs: Date.now() + 60000 } };
      },
      listJobs: () => [],
      getJob: () => null,
    });

    await cronToolDefinition.execute(
      {
        action: "add",
        name: "reminder",
        message: "remind me",
        schedule_kind: "at",
        at: "+2h",
        session_target: "current",
      },
      {
        session_id: "tui:main",  // This is the real session key from AgentLoop
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
        headless: false,
      },
    );

    // The cron tool should have passed "tui:main" as the sessionKey
    expect(capturedCreate).not.toBeNull();
    expect(capturedCreate.sessionTarget).toBe("current");
    expect(capturedCreate.sessionKey).toBe("tui:main");

    setCronServiceRef(null);
  });
});

// -----------------------------------------------------------------------------
// Regression: history action
// -----------------------------------------------------------------------------

describe("Cron tool history action", () => {
  test("history returns run log entries", async () => {
    const svc = makeService("history-action");
    const job = svc.addJob({
      name: "history-test",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });

    // Force-run to create history
    await svc.forceRun(job.id);

    const { cronToolDefinition } = await import("../src/tools/cron.js");
    const { setCronServiceRef } = await import("../src/tools/cron.js");
    setCronServiceRef(svc);

    const result = await cronToolDefinition.execute(
      { action: "history", job_id: job.id },
      {
        session_id: "test",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.type).toBe("text");
    expect(result.content).toContain("Run history");
    expect(result.content).toContain("ok");

    setCronServiceRef(null);
    svc.stop();
  });

  test("history works with job name", async () => {
    const svc = makeService("history-by-name");
    const job = svc.addJob({
      name: "named-job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "test" },
    });

    await svc.forceRun(job.id);

    const { cronToolDefinition } = await import("../src/tools/cron.js");
    const { setCronServiceRef } = await import("../src/tools/cron.js");
    setCronServiceRef(svc);

    const result = await cronToolDefinition.execute(
      { action: "history", job_id: "named-job" },
      {
        session_id: "test",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.type).toBe("text");
    expect(result.content).toContain("Run history");

    setCronServiceRef(null);
    svc.stop();
  });
});

// -----------------------------------------------------------------------------
// Cron tool update action — comprehensive tests
// -----------------------------------------------------------------------------

describe("Cron tool update action", () => {
  const makeCtx = () => ({
    session_id: "tui:main",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
    headless: false,
  });

  function setupUpdateTest() {
    const svc = makeService(`update-${Date.now()}-${Math.random().toString(36).slice(2)}`, makeConfig({ enabled: false }));
    setCronServiceRef(svc);
    svc.addJob({
      name: "test-job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "original message" },
      sessionTarget: "isolated",
    });
    return svc;
  }

  test("update schedule with every_minutes changes everyMs", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    const result = await cronToolDefinition.execute(
      { action: "update", job_id: job.id, every_minutes: 30 },
      makeCtx(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("Schedule changed");
    expect(svc.getJob(job.id).schedule.everyMs).toBe(30 * 60_000);
    svc.stop();
  });

  test("update schedule from every to cron expression", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    const result = await cronToolDefinition.execute(
      { action: "update", job_id: job.id, schedule_kind: "cron", cron_expr: "0 9 * * 1-5" },
      makeCtx(),
    );
    expect(result.content).toContain("Schedule changed");
    expect(svc.getJob(job.id).schedule.kind).toBe("cron");
    expect(svc.getJob(job.id).schedule.expr).toBe("0 9 * * 1-5");
    svc.stop();
  });

  test("update message changes payload", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    await cronToolDefinition.execute({ action: "update", job_id: job.id, message: "new message" }, makeCtx());
    expect(svc.getJob(job.id).payload.message).toBe("new message");
    svc.stop();
  });

  test("update name changes job name", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    await cronToolDefinition.execute({ action: "update", job_id: job.id, name: "renamed-job" }, makeCtx());
    expect(svc.getJob(job.id).name).toBe("renamed-job");
    svc.stop();
  });

  test("update enabled toggles job", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    await cronToolDefinition.execute({ action: "update", job_id: job.id, enabled: false }, makeCtx());
    expect(svc.getJob(job.id).enabled).toBe(false);
    await cronToolDefinition.execute({ action: "update", job_id: job.id, enabled: true }, makeCtx());
    expect(svc.getJob(job.id).enabled).toBe(true);
    svc.stop();
  });

  test("update silently drops delivery_target (dead field, not persisted)", async () => {
    // Pre-cron-chattable, the agent tool let the LLM set delivery_target
    // to inject cron output into another session. That path was removed
    // when cron sessions became chattable on their own — the cron run
    // already lives in cron:<name>, no second injection needed. The tool
    // now strips the field at the input layer before it reaches addJob/
    // updateJob, so a model still sending it produces no on-disk state.
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    await cronToolDefinition.execute(
      { action: "update", job_id: job.id, delivery_target: "web:email-triage" },
      makeCtx(),
    );
    expect(svc.getJob(job.id).delivery_target).toBeUndefined();
    svc.stop();
  });

  test("update with no fields warns user", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    const result = await cronToolDefinition.execute({ action: "update", job_id: job.id }, makeCtx());
    expect(result.content).toContain("No fields to update");
    svc.stop();
  });

  test("update by name (not just ID)", async () => {
    const svc = setupUpdateTest();
    const result = await cronToolDefinition.execute({ action: "update", job_id: "test-job", every_minutes: 15 }, makeCtx());
    expect(result.content).toContain("Schedule changed");
    svc.stop();
  });

  test("update nonexistent job returns error", async () => {
    const svc = setupUpdateTest();
    const result = await cronToolDefinition.execute({ action: "update", job_id: "nonexistent", every_minutes: 5 }, makeCtx());
    expect(result.type).toBe("error");
    expect(result.content).toContain("not found");
    svc.stop();
  });

  test("update every_minutes < 1 returns error", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    const result = await cronToolDefinition.execute({ action: "update", job_id: job.id, every_minutes: 0.5 }, makeCtx());
    expect(result.type).toBe("error");
    expect(result.content).toContain("every_minutes must be >= 1");
    svc.stop();
  });

  test("update multiple fields at once", async () => {
    const svc = setupUpdateTest();
    const job = svc.listJobs(true)[0];
    const result = await cronToolDefinition.execute(
      { action: "update", job_id: job.id, name: "multi-update", every_minutes: 45, message: "updated msg" },
      makeCtx(),
    );
    expect(result.content).toContain("Schedule changed");
    const updated = svc.getJob(job.id);
    expect(updated.name).toBe("multi-update");
    expect(updated.schedule.everyMs).toBe(45 * 60_000);
    expect(updated.payload.message).toBe("updated msg");
    svc.stop();
  });
});

// =============================================================================
// findJobsBySessionKey — used by session.delete to clean up backing job(s).
// Codex regressions covered here:
//   1. "Nightly Digest" runtime key is `cron:nightly-digest` (sanitized);
//      old matcher used the raw form and missed it.
//   2. Multiple jobs can share one runtime session key (two `current`-target
//      jobs in the same chat, several jobs at the same named session). All
//      matches must be returned so session.delete can remove every backing
//      job — single-match would leak orphans firing into a recreated thread.
// =============================================================================

describe("CronService.findJobsBySessionKey", () => {
  test("matches isolated job by sanitized name (lowercase + dash)", () => {
    const svc = makeService("find-isolated");
    const job = svc.addJob({
      name: "Nightly Digest",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "go" },
      sessionTarget: "isolated",
    });
    expect(svc.findJobsBySessionKey("cron:nightly-digest")).toEqual([
      expect.objectContaining({ id: job.id }),
    ]);
    expect(svc.findJobsBySessionKey("cron:Nightly Digest")).toEqual([]);
    svc.stop();
  });

  test("matches job whose sessionTarget points at a named session", () => {
    const svc = makeService("find-session-target");
    const job = svc.addJob({
      name: "team standup digest",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "go" },
      sessionTarget: "session:standup",
    });
    // resolveSessionKey for session:<x> returns `cron:<x>` (NOT the
    // sanitized job name) — exercise that branch.
    expect(svc.findJobsBySessionKey("cron:standup")[0]?.id).toBe(job.id);
    svc.stop();
  });

  test("matches job whose sessionTarget is `current` (uses captured sessionKey)", () => {
    const svc = makeService("find-current");
    const job = svc.addJob({
      name: "follow-up",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "go" },
      sessionTarget: "current",
      sessionKey: "cron:custom-key",
    });
    expect(svc.findJobsBySessionKey("cron:custom-key")[0]?.id).toBe(job.id);
    svc.stop();
  });

  test("returns empty array for an unknown session key (orphan cleanup OK)", () => {
    const svc = makeService("find-miss");
    svc.addJob({
      name: "real-job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "go" },
      sessionTarget: "isolated",
    });
    expect(svc.findJobsBySessionKey("cron:does-not-exist")).toEqual([]);
    svc.stop();
  });

  test("walks both enabled and disabled jobs", () => {
    const svc = makeService("find-disabled");
    const job = svc.addJob({
      name: "paused-cron",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "go" },
      sessionTarget: "isolated",
    });
    svc.updateJob(job.id, { enabled: false });
    expect(svc.findJobsBySessionKey("cron:paused-cron")[0]?.id).toBe(job.id);
    svc.stop();
  });

  // Codex's "multi-match" regression: two jobs sharing one runtime session
  // key (named-session targets pointing at the same chat). session.delete
  // must remove BOTH or the survivor keeps firing into a recreated thread.
  test("returns ALL jobs that share a session key (named-session targets)", () => {
    const svc = makeService("find-multi-session");
    const a = svc.addJob({
      name: "standup-1",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "a" },
      sessionTarget: "session:standup",
    });
    const b = svc.addJob({
      name: "standup-2",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "b" },
      sessionTarget: "session:standup",
    });
    const matches = svc.findJobsBySessionKey("cron:standup");
    expect(matches.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
    svc.stop();
  });

  test("returns ALL jobs that share a captured `current` sessionKey", () => {
    const svc = makeService("find-multi-current");
    const a = svc.addJob({
      name: "reminder-a",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "a" },
      sessionTarget: "current",
      sessionKey: "cron:my-chat",
    });
    const b = svc.addJob({
      name: "reminder-b",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "b" },
      sessionTarget: "current",
      sessionKey: "cron:my-chat",
    });
    const matches = svc.findJobsBySessionKey("cron:my-chat");
    expect(matches).toHaveLength(2);
    expect(matches.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
    svc.stop();
  });
});
