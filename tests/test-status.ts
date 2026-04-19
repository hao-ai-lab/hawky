// =============================================================================
// Tests: Gateway Status Aggregation
//
// Tests for the gateway.status RPC and status aggregation module.
// Uses mock subsystems — no real gateway needed.
// =============================================================================

import { test, describe, expect } from "bun:test";
import { getGatewayStatus, setGatewayStartTime, loadUsageHistory } from "../src/gateway/status.js";
import { CostTracker, setCostTracker } from "../src/agent/cost-tracker.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock subsystems
function makeMockServer() {
  return {
    getConnectionCount() { return 2; },
    getConnectionDetails() {
      return [
        { connId: "conn-1", platform: "web", sessionKey: "web:general" },
        { connId: "conn-2", platform: "tui", sessionKey: "tui:main" },
      ];
    },
  };
}

function makeMockHeartbeat() {
  return {
    getStatus() {
      return {
        enabled: true,
        lastRunAt: Date.now() - 60000,
        lastStatus: "ran" as const,
        lastDurationMs: 2500,
        lastReason: undefined,
        lastSummary: "All good",
        nextRunAt: Date.now() + 1740000,
        alertCount: 0,
        running: false,
        lastConsolidatedAt: Date.now() - 86400000,
      };
    },
  };
}

function makeMockCron() {
  return {
    getStatus() {
      return {
        enabled: true,
        jobCount: 2,
        enabledJobCount: 1,
        nextFireAtMs: Date.now() + 3600000,
        running: false,
      };
    },
    listJobs(_includeDisabled?: boolean) {
      return [
        {
          id: "job-1",
          name: "hn-digest",
          enabled: true,
          state: {
            nextRunAtMs: Date.now() + 3600000,
            lastRunAtMs: Date.now() - 7200000,
            lastStatus: "ok",
            lastDurationMs: 5000,
          },
        },
        {
          id: "job-2",
          name: "local-diff-check",
          enabled: false,
          state: {
            nextRunAtMs: null,
            lastRunAtMs: null,
            lastStatus: null,
            lastDurationMs: null,
          },
        },
      ];
    },
  };
}

function makeMockSessions() {
  return {
    get size() { return 3; },
    keys() { return ["web:general", "tui:main", "heartbeat:main"]; },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("getGatewayStatus", () => {
  test("returns complete status snapshot", () => {
    setGatewayStartTime(Date.now() - 5000);

    const testDir = join(tmpdir(), `status-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    setCostTracker(new CostTracker(testDir));

    const status = getGatewayStatus({
      server: makeMockServer() as any,
      heartbeat: makeMockHeartbeat() as any,
      cronService: makeMockCron() as any,
      sessions: makeMockSessions() as any,
    });

    // Gateway
    expect(status.timestamp).toBeGreaterThan(0);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(4);
    expect(status.uptimeSeconds).toBeLessThan(30);

    // Connections
    expect(status.connections.count).toBe(2);
    expect(status.connections.clients).toHaveLength(2);
    expect(status.connections.clients[0].platform).toBe("web");

    // Sessions
    expect(status.sessions.count).toBe(3);
    expect(status.sessions.keys).toContain("web:general");

    // Heartbeat
    expect(status.heartbeat.enabled).toBe(true);
    expect(status.heartbeat.lastStatus).toBe("ran");
    expect(status.heartbeat.lastDurationMs).toBe(2500);
    expect(status.heartbeat.running).toBe(false);

    // Cron
    expect(status.cron.jobCount).toBe(2);
    expect(status.cron.enabledJobCount).toBe(1);
    expect(status.cron.jobs).toHaveLength(2);
    expect(status.cron.jobs[0].name).toBe("hn-digest");
    expect(status.cron.jobs[0].enabled).toBe(true);
    expect(status.cron.jobs[1].name).toBe("local-diff-check");
    expect(status.cron.jobs[1].enabled).toBe(false);

    // Usage
    expect(status.usage).toBeDefined();
    expect(status.usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(status.usage.apiCalls).toBe(0); // No API calls in this test

    rmSync(testDir, { recursive: true, force: true });
  });

  test("includes cost data when cost tracker has usage", () => {
    setGatewayStartTime(Date.now());

    const testDir = join(tmpdir(), `status-cost-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const tracker = new CostTracker(testDir);
    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 10000, output_tokens: 5000 }, "web:general");
    setCostTracker(tracker);

    const status = getGatewayStatus({
      server: makeMockServer() as any,
      heartbeat: makeMockHeartbeat() as any,
      cronService: makeMockCron() as any,
      sessions: makeMockSessions() as any,
    });

    expect(status.usage.tokens.input).toBe(10000);
    expect(status.usage.tokens.output).toBe(5000);
    expect(status.usage.costUSD).toBeGreaterThan(0);
    expect(status.usage.apiCalls).toBe(1);
    expect(status.usage.byModel["claude-sonnet-4-6"]).toBeDefined();

    rmSync(testDir, { recursive: true, force: true });
  });

  test("uptime reflects gateway start time", () => {
    setGatewayStartTime(Date.now() - 120000); // 2 minutes ago

    const testDir = join(tmpdir(), `status-uptime-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    setCostTracker(new CostTracker(testDir));

    const status = getGatewayStatus({
      server: makeMockServer() as any,
      heartbeat: makeMockHeartbeat() as any,
      cronService: makeMockCron() as any,
      sessions: makeMockSessions() as any,
    });

    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(119);
    expect(status.uptimeSeconds).toBeLessThan(125);

    rmSync(testDir, { recursive: true, force: true });
  });
});

// =============================================================================
// Usage history
// =============================================================================

describe("loadUsageHistory", () => {
  test("returns empty for nonexistent directory", () => {
    setCostTracker(null as any);
    const result = loadUsageHistory("7d", "/nonexistent/path");
    expect(result.entries).toHaveLength(0);
    expect(result.summary.totalCostUSD).toBe(0);
  });

  test("loads and aggregates daily usage files", () => {
    setCostTracker(null as any);
    const dir = join(tmpdir(), `usage-hist-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    // Create 3 days of usage
    for (let i = 0; i < 3; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      writeFileSync(join(dir, `${date}.json`), JSON.stringify({
        date,
        tokens: { input: 10000 * (i + 1), output: 5000, cacheRead: 0, cacheCreation: 0 },
        costUSD: 0.10 * (i + 1),
        apiCalls: 5 * (i + 1),
        byModel: { "claude-sonnet-4-6": { input: 10000 * (i + 1), output: 5000, costUSD: 0.10 * (i + 1) } },
      }));
    }

    const result = loadUsageHistory("7d", dir);
    expect(result.entries).toHaveLength(3);
    expect(result.summary.totalCostUSD).toBeCloseTo(0.60, 2);
    expect(result.summary.totalApiCalls).toBe(30);
    expect(result.summary.activeDays).toBe(3);
    expect(result.summary.peakDay).toBeDefined();
    expect(result.summary.byModel["claude-sonnet-4-6"]).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });

  test("totalTokens summary includes cacheRead + cacheCreation, not just input + output", () => {
    // Regression: with prompt caching engaged, the bulk of input tokens
    // shifts to cacheRead. If totalTokens excluded cache buckets, the
    // dashboard's headline number would suddenly look ~10× smaller and
    // disagree with the per-model rollup (which already includes them).
    setCostTracker(null as any);
    const dir = join(tmpdir(), `usage-cache-tot-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    writeFileSync(join(dir, `${date}.json`), JSON.stringify({
      date,
      tokens: { input: 5_000, output: 200, cacheRead: 50_000, cacheCreation: 2_000 },
      costUSD: 0.05,
      apiCalls: 1,
      byModel: { "claude-opus-4-7": { input: 5_000, output: 200, cacheRead: 50_000, cacheCreation: 2_000, costUSD: 0.05 } },
    }));

    const result = loadUsageHistory("7d", dir);
    expect(result.summary.totalTokens).toBe(5_000 + 200 + 50_000 + 2_000);

    rmSync(dir, { recursive: true, force: true });
  });

  test("entries sorted newest first", () => {
    setCostTracker(null as any);
    const dir = join(tmpdir(), `usage-sort-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "2026-04-01.json"), JSON.stringify({
      date: "2026-04-01", tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
      costUSD: 0.01, apiCalls: 1, byModel: {},
    }));
    writeFileSync(join(dir, "2026-04-03.json"), JSON.stringify({
      date: "2026-04-03", tokens: { input: 2000, output: 1000, cacheRead: 0, cacheCreation: 0 },
      costUSD: 0.02, apiCalls: 2, byModel: {},
    }));

    const result = loadUsageHistory("all", dir);
    expect(result.entries[0].date).toBe("2026-04-03");
    expect(result.entries[1].date).toBe("2026-04-01");

    rmSync(dir, { recursive: true, force: true });
  });

  test("7d range filters old entries", () => {
    setCostTracker(null as any);
    const dir = join(tmpdir(), `usage-range-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    // Today
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(join(dir, `${todayStr}.json`), JSON.stringify({
      date: todayStr, tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
      costUSD: 0.01, apiCalls: 1, byModel: {},
    }));

    // 30 days ago
    writeFileSync(join(dir, "2025-01-01.json"), JSON.stringify({
      date: "2025-01-01", tokens: { input: 99999, output: 99999, cacheRead: 0, cacheCreation: 0 },
      costUSD: 99.99, apiCalls: 999, byModel: {},
    }));

    const result7d = loadUsageHistory("7d", dir);
    expect(result7d.entries).toHaveLength(1); // Only today
    expect(result7d.entries[0].date).toBe(todayStr);

    const resultAll = loadUsageHistory("all", dir);
    expect(resultAll.entries).toHaveLength(2); // Both

    rmSync(dir, { recursive: true, force: true });
  });

  test("computes daily average correctly", () => {
    setCostTracker(null as any);
    const dir = join(tmpdir(), `usage-avg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const today = new Date();
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      writeFileSync(join(dir, `${date}.json`), JSON.stringify({
        date, tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
        costUSD: 1.00, apiCalls: 10, byModel: {},
      }));
    }

    const result = loadUsageHistory("7d", dir);
    expect(result.summary.dailyAvgCost).toBeCloseTo(1.00, 2);
    expect(result.summary.activeDays).toBe(5);

    rmSync(dir, { recursive: true, force: true });
  });
});
