// =============================================================================
// Gateway Status Aggregation
//
// Aggregates health/status data from all gateway subsystems into a single
// snapshot for the web dashboard. Each field is read from in-memory state —
// no file I/O or API calls.
// =============================================================================

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GatewayServer } from "./server.js";
import type { HeartbeatService } from "./heartbeat.js";
import type { CronService } from "./cron.js";
import type { AgentSessionManager } from "./agent-sessions.js";
import type { NodeRegistry } from "./node-registry.js";
import { getCostTracker, type DailyUsage } from "../agent/cost-tracker.js";
import { getRecentErrors, type ErrorEntry } from "../logging/error-buffer.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface GatewayStatus {
  timestamp: number;
  uptimeSeconds: number;

  // Connections
  connections: {
    count: number;
    clients: Array<{ connId: string; platform: string; sessionKey: string | null }>;
  };

  // Connected node hosts
  nodes: Array<{
    nodeId: string;
    name: string;
    platform: string;
    commands: string[];
    connectedAt: number;
  }>;

  // Sessions
  sessions: {
    count: number;
    keys: string[];
  };

  // Heartbeat
  heartbeat: {
    enabled: boolean;
    lastRunAt: number | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    nextRunAt: number | null;
    running: boolean;
    lastConsolidatedAt: number | null;
  };

  // Cron
  cron: {
    enabled: boolean;
    jobCount: number;
    enabledJobCount: number;
    jobs: Array<{
      id: string;
      name: string;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt: number | null;
      lastStatus: string | null;
      lastDurationMs: number | null;
    }>;
  };

  // Today's usage
  usage: DailyUsage;

  // Recent errors
  recentErrors: ErrorEntry[];
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------

let gatewayStartTime = Date.now();

/** Set the gateway start time (called once at startup). */
export function setGatewayStartTime(t: number): void {
  gatewayStartTime = t;
}

/** Aggregate status from all subsystems. All reads are in-memory. */
export function getGatewayStatus(deps: {
  server: GatewayServer;
  heartbeat: HeartbeatService;
  cronService: CronService;
  sessions: AgentSessionManager;
  nodeRegistry?: NodeRegistry;
}): GatewayStatus {
  const now = Date.now();

  // Heartbeat
  const hbStatus = deps.heartbeat.getStatus();

  // Cron
  const cronStatus = deps.cronService.getStatus();
  const cronJobs = deps.cronService.listJobs(true); // include disabled

  // Cost
  const costTracker = getCostTracker();
  const usage = costTracker?.getDailyUsage() ?? {
    date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUSD: 0,
    byModel: {},
    apiCalls: 0,
  };

  return {
    timestamp: now,
    uptimeSeconds: Math.round((now - gatewayStartTime) / 1000),

    connections: {
      count: deps.server.getConnectionCount(),
      clients: deps.server.getConnectionDetails(),
    },

    nodes: (deps.nodeRegistry?.listConnected() ?? []).map((n) => ({
      nodeId: n.nodeId,
      name: n.name,
      platform: n.platform,
      commands: n.commands,
      connectedAt: n.connectedAt,
    })),

    sessions: {
      count: deps.sessions.size,
      keys: deps.sessions.keys(),
    },

    heartbeat: {
      enabled: hbStatus.enabled,
      lastRunAt: hbStatus.lastRunAt,
      lastStatus: hbStatus.lastStatus,
      lastDurationMs: hbStatus.lastDurationMs ?? null,
      nextRunAt: hbStatus.nextRunAt,
      running: hbStatus.running,
      lastConsolidatedAt: hbStatus.lastConsolidatedAt,
    },

    cron: {
      enabled: cronStatus.enabled,
      jobCount: cronStatus.jobCount,
      enabledJobCount: cronStatus.enabledJobCount,
      jobs: cronJobs.map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        nextRunAt: job.state?.nextRunAtMs ?? null,
        lastRunAt: job.state?.lastRunAtMs ?? null,
        lastStatus: job.state?.lastStatus ?? null,
        lastDurationMs: job.state?.lastDurationMs ?? null,
      })),
    },

    usage,

    recentErrors: getRecentErrors(10),
  };
}

// -----------------------------------------------------------------------------
// Usage history — reads persisted daily JSON files
// -----------------------------------------------------------------------------

export interface UsageHistoryEntry {
  date: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUSD: number;
  apiCalls: number;
  byModel: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number; costUSD: number }>;
}

export interface UsageHistoryResponse {
  range: "7d" | "30d" | "all";
  entries: UsageHistoryEntry[];
  summary: {
    totalCostUSD: number;
    totalTokens: number;
    totalApiCalls: number;
    activeDays: number;
    dailyAvgCost: number;
    peakDay: { date: string; costUSD: number } | null;
    byModel: Record<string, { tokens: number; costUSD: number }>;
  };
}

/** Load usage history for a given range. Reads from ~/.hawky/usage/*.json. */
export function loadUsageHistory(
  range: "7d" | "30d" | "all",
  usageDir?: string,
): UsageHistoryResponse {
  const dir = usageDir ?? join(homedir(), ".hawky", "usage");
  if (!existsSync(dir)) {
    return emptyHistory(range);
  }

  // List all YYYY-MM-DD.json files
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  // Filter by range
  const cutoff = range === "all" ? null : getCutoffDate(range);
  const filtered = cutoff
    ? files.filter((f) => f.replace(".json", "") >= cutoff)
    : files;

  // Also include today's in-memory data (may not be persisted yet)
  const tracker = getCostTracker();
  const todayData = tracker?.getDailyUsage();
  const today = todayData?.date;

  const entries: UsageHistoryEntry[] = [];
  const seenDates = new Set<string>();

  for (const file of filtered) {
    const date = file.replace(".json", "");
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const data = JSON.parse(raw) as DailyUsage;
      // If this is today and we have fresher in-memory data, use that instead
      if (date === today && todayData) {
        entries.push(dailyToEntry(todayData));
      } else {
        entries.push({
          date,
          tokens: data.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          costUSD: data.costUSD ?? 0,
          apiCalls: data.apiCalls ?? 0,
          byModel: data.byModel ?? {},
        });
      }
      seenDates.add(date);
    } catch {
      // Corrupted file — skip
    }
  }

  // Add today if not on disk yet
  if (todayData && !seenDates.has(today!) && (!cutoff || today! >= cutoff)) {
    entries.push(dailyToEntry(todayData));
  }

  // Sort newest first for display
  entries.sort((a, b) => b.date.localeCompare(a.date));

  // Compute summary
  const summary = computeSummary(entries);

  return { range, entries, summary };
}

function dailyToEntry(d: DailyUsage): UsageHistoryEntry {
  return {
    date: d.date,
    tokens: d.tokens,
    costUSD: d.costUSD,
    apiCalls: d.apiCalls,
    byModel: d.byModel,
  };
}

function getCutoffDate(range: "7d" | "30d"): string {
  const d = new Date();
  d.setDate(d.getDate() - (range === "7d" ? 6 : 29)); // inclusive of today
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computeSummary(entries: UsageHistoryEntry[]): UsageHistoryResponse["summary"] {
  let totalCost = 0;
  let totalTokens = 0;
  let totalApiCalls = 0;
  let peakDay: { date: string; costUSD: number } | null = null;
  const byModel: Record<string, { tokens: number; costUSD: number }> = {};

  for (const e of entries) {
    totalCost += e.costUSD;
    // Sum ALL token buckets, not just input + output. With prompt caching
    // engaged the bulk of input shifts to cacheRead; excluding the cache
    // fields here would silently undercount usage on cached workloads and
    // make the per-day rollup disagree with the per-model rollup below
    // (which already includes cacheRead + cacheCreation per PR #190).
    totalTokens +=
      e.tokens.input
      + e.tokens.output
      + (e.tokens.cacheRead ?? 0)
      + (e.tokens.cacheCreation ?? 0);
    totalApiCalls += e.apiCalls;

    if (!peakDay || e.costUSD > peakDay.costUSD) {
      peakDay = { date: e.date, costUSD: e.costUSD };
    }

    for (const [model, data] of Object.entries(e.byModel)) {
      if (!byModel[model]) byModel[model] = { tokens: 0, costUSD: 0 };
      // Per-model `tokens` is total tokens billed at any rate — non-cached
      // input + output + cache reads + cache writes. Excluding cache fields
      // here under-reports cached workloads (the per-day `tokens.input` /
      // `.cacheRead` etc. already include them, so the per-model rollup
      // would mismatch the day total). cacheRead/cacheCreation are
      // optional on legacy entries written before this PR's tracking;
      // missing → 0.
      byModel[model].tokens +=
        data.input +
        data.output +
        (data.cacheRead ?? 0) +
        (data.cacheCreation ?? 0);
      byModel[model].costUSD += data.costUSD;
    }
  }

  const activeDays = entries.filter((e) => e.apiCalls > 0).length;

  return {
    totalCostUSD: totalCost,
    totalTokens,
    totalApiCalls,
    activeDays,
    dailyAvgCost: activeDays > 0 ? totalCost / activeDays : 0,
    peakDay: peakDay && peakDay.costUSD > 0 ? peakDay : null,
    byModel,
  };
}

function emptyHistory(range: "7d" | "30d" | "all"): UsageHistoryResponse {
  return {
    range,
    entries: [],
    summary: { totalCostUSD: 0, totalTokens: 0, totalApiCalls: 0, activeDays: 0, dailyAvgCost: 0, peakDay: null, byModel: {} },
  };
}
