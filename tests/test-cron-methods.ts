// =============================================================================
// Cron RPC method handlers — back-compat tests
//
// Focuses on the cron.update legacy-only-field code path Codex flagged:
// older clients that still send `delivery_target` (a now-dead field)
// should receive a no-op success, not a hard INVALID_REQUEST.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronService } from "../src/gateway/cron.js";
import { registerCronMethods } from "../src/gateway/cron-methods.js";
import type { HawkyConfig } from "../src/agent/types.js";

function makeConfig(): HawkyConfig {
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
    cron: { enabled: true, max_concurrent_runs: 1, max_missed_on_restart: 3 },
  } as any;
}

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) { methods[name] = handler; },
    call(name: string, params: any) {
      const m = methods[name];
      if (!m) throw new Error(`Method not found: ${name}`);
      return m(null, params, this);
    },
    broadcast() {},
    broadcastToSession() {},
    getConnections() { return new Map(); },
  };
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-cron-methods-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeServiceWithRpc() {
  const server = makeMockServer();
  const svc = new CronService({
    sessions: { getOrCreate: () => ({}) } as any,
    server: server as any,
    config: makeConfig(),
    storePath: join(testDir, "jobs.json"),
  });
  registerCronMethods(server as any, svc);
  return { server, svc };
}

describe("cron.update — back-compat for legacy delivery_target callers", () => {
  test("succeeds as a no-op when the only supplied field is delivery_target", () => {
    // Older TUI / web builds may still send delivery_target on update. The
    // field is dropped at the server before reaching updateJob (PR #188);
    // an empty patch used to throw INVALID_REQUEST, which surfaced as a
    // hard failure for exactly the stale clients we claim to tolerate.
    const { server, svc } = makeServiceWithRpc();
    const job = svc.addJob({
      name: "legacy-only-update",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      sessionTarget: "isolated",
    });

    const result = server.call("cron.update", { jobId: job.id, delivery_target: "web:general" });
    expect(result.job).toBeDefined();
    expect(result.job.id).toBe(job.id);
    // Confirm the dead field was NOT persisted onto the stored job.
    expect(svc.getJob(job.id)?.delivery_target).toBeUndefined();
    svc.stop();
  });

  test("still throws INVALID_REQUEST when no supported AND no legacy fields are supplied", () => {
    const { server, svc } = makeServiceWithRpc();
    const job = svc.addJob({
      name: "empty-update",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      sessionTarget: "isolated",
    });

    expect(() => server.call("cron.update", { jobId: job.id })).toThrow(/No valid fields/);
    svc.stop();
  });

  test("legacy + real field: real field applies, legacy silently dropped", () => {
    const { server, svc } = makeServiceWithRpc();
    const job = svc.addJob({
      name: "mixed-update",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      sessionTarget: "isolated",
    });

    const result = server.call("cron.update", {
      jobId: job.id,
      enabled: false,
      delivery_target: "web:ignored",
    });
    expect(result.job.enabled).toBe(false);
    expect(svc.getJob(job.id)?.delivery_target).toBeUndefined();
    svc.stop();
  });
});
