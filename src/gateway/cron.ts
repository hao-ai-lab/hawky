// =============================================================================
// Cron Service
//
// Persistent job scheduler. Fires jobs on schedule, executes in headless agent
// sessions, persists run history, delivers results.
//
// Pattern: a proven cron/service — single timer, locked phases, concurrent
// execution, exponential backoff, startup catch-up.
// =============================================================================

import type { AgentSessionManager } from "./agent-sessions.js";
import type { GatewayServer } from "./server.js";
import type { HawkyConfig } from "../agent/types.js";
import { CommandLane } from "./types.js";
import { triggerAgentTurn } from "./agent-turn.js";
import { CronStore, defaultCronStorePath } from "./cron-store.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronRunRecord } from "./cron-store.js";
import { computeNextRunAtMs } from "./cron-schedule.js";
import { appendRunLog, readRunLog, deleteRunLog } from "./cron-run-log.js";
import type { CronRunLogEntry } from "./cron-run-log.js";
import { deliver } from "./delivery.js";
import { enqueueSystemEvent } from "./system-events.js";
import { buildCronDistillationPrefix, buildNodeContextPrefix } from "./heartbeat-prompt.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/cron");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIN_REFIRE_GAP_MS = 2_000;
const MAX_TIMER_DELAY_MS = 60_000;
const MAX_RUN_HISTORY = 20;

const BACKOFF_SCHEDULE_MS = [
  30_000,       // 1st error → 30s
  60_000,       // 2nd → 1min
  5 * 60_000,   // 3rd → 5min
  15 * 60_000,  // 4th → 15min
  60 * 60_000,  // 5th+ → 60min
];

// Transient error patterns (retry for one-shot jobs)
const TRANSIENT_PATTERNS = [
  /rate[_ ]limit|too many requests|429/i,
  /\b529\b|overloaded|high demand/i,
  /(network|econnreset|econnrefused|fetch failed|socket)/i,
  /(timeout|etimedout)/i,
  /\b5\d{2}\s+(internal|server|bad gateway|service unavailable|gateway timeout)/i,
];

const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CronConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
  maxMissedOnRestart: number;
  retention: {
    sessionDays: number;
    runLogMaxLines: number;
    runLogMaxBytes: number;
    reaperIntervalMinutes: number;
  };
}

export interface CronStatus {
  enabled: boolean;
  jobCount: number;
  enabledJobCount: number;
  nextFireAtMs: number | null;
  running: boolean;
}

// Broadcast events
export interface CronStartedEvent {
  type: "cron.started";
  jobId: string;
  jobName: string;
  timestamp: number;
}

export interface CronCompletedEvent {
  type: "cron.completed";
  jobId: string;
  jobName: string;
  timestamp: number;
  status: "ok" | "error" | "skipped";
  durationMs: number;
  error?: string;
  summary?: string;
}

// -----------------------------------------------------------------------------
// CronService
// -----------------------------------------------------------------------------

export class CronService {
  private _store!: CronStore;
  get store(): CronStore { return this._store; }
  private sessions: AgentSessionManager;
  private server: GatewayServer;
  private fullConfig: HawkyConfig;
  private config: CronConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(opts: {
    sessions: AgentSessionManager;
    server: GatewayServer;
    config: HawkyConfig;
    /** Override store path (for testing) */
    storePath?: string;
  }) {
    this.sessions = opts.sessions;
    this.server = opts.server;
    this.fullConfig = opts.config;
    this.config = CronService.resolveConfig(opts.config);
    this._store = new CronStore(opts.storePath ?? defaultCronStorePath());
  }

  // ---------------------------------------------------------------------------
  // Config resolution
  // ---------------------------------------------------------------------------

  static resolveConfig(config: HawkyConfig): CronConfig {
    const cron = config.cron ?? {};
    return {
      enabled: cron.enabled ?? false,
      maxConcurrentRuns: cron.max_concurrent_runs ?? 1,
      maxMissedOnRestart: cron.max_missed_on_restart ?? 3,
      retention: {
        sessionDays: cron.retention?.session_days ?? 7,
        runLogMaxLines: cron.retention?.run_log_max_lines ?? 2000,
        runLogMaxBytes: cron.retention?.run_log_max_bytes ?? 2 * 1024 * 1024,
        reaperIntervalMinutes: cron.retention?.reaper_interval_minutes ?? 60,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): void {
    if (!this.config.enabled) {
      log.info("cron scheduler disabled in config");
      return;
    }

    this.stopped = false;

    // Load store and compute initial nextRunAtMs for all jobs
    const jobs = this._store.getJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (job.enabled && job.state.nextRunAtMs === null) {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now) ?? null;
      }
      // Clear stale running markers (from interrupted gateway)
      if (job.state.runningAtMs) {
        job.state.runningAtMs = undefined;
      }
    }
    this._store.save(true);

    // Run missed jobs (startup catch-up)
    this.runMissedJobs(now);

    // Arm timer
    this.armTimer();

    log.info("cron scheduler started", {
      jobCount: jobs.length,
      enabledCount: jobs.filter((j) => j.enabled).length,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("cron scheduler stopped");
  }

  getStatus(): CronStatus {
    const jobs = this._store.getJobs();
    const enabled = jobs.filter((j) => j.enabled);
    const nextFireAtMs = this.findNextWakeMs();
    return {
      enabled: this.config.enabled,
      jobCount: jobs.length,
      enabledJobCount: enabled.length,
      nextFireAtMs,
      running: this.running,
    };
  }

  // ---------------------------------------------------------------------------
  // CRUD (delegated to store)
  // ---------------------------------------------------------------------------

  addJob(create: CronJobCreate): CronJob {
    const job = this._store.addJob(create);
    // Compute initial nextRunAtMs
    job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now()) ?? null;
    this._store.save(true);
    this.armTimer();
    return job;
  }

  updateJob(id: string, patch: CronJobPatch): CronJob | null {
    const job = this._store.updateJob(id, patch);
    if (!job) return null;

    // Recompute nextRunAtMs if schedule or enabled changed (single save at the end)
    let needsSave = false;
    if (patch.schedule) {
      job.state.nextRunAtMs = job.enabled
        ? (computeNextRunAtMs(job.schedule, Date.now()) ?? null)
        : null;
      needsSave = true;
    }
    if (patch.enabled !== undefined) {
      job.state.nextRunAtMs = patch.enabled
        ? (computeNextRunAtMs(job.schedule, Date.now()) ?? null)
        : null;
      needsSave = true;
    }
    if (needsSave) {
      this._store.save(true);
    }
    this.armTimer();
    return job;
  }

  removeJob(id: string): boolean {
    const result = this._store.removeJob(id);
    if (result) {
      // Clean up the per-job run history file (otherwise orphaned on disk)
      deleteRunLog(this._store.getStorePath(), id);
    }
    this.armTimer();
    return result;
  }

  rebindSessionKey(oldKey: string, newKey: string): number {
    return this._store.rebindSessionKey(oldKey, newKey);
  }

  /**
   * Find every cron job whose runtime session key matches `sessionKey`.
   *
   * Uses the same `resolveSessionKey()` logic the scheduler runs at fire
   * time, so a job named "Nightly Digest" (runtime key
   * `cron:nightly-digest`) is found whether the caller has the sanitized
   * key or one of the legacy raw-name lookups.
   *
   * Returns ALL matches because multiple jobs can legitimately share
   * one runtime session key — two reminders both created with
   * `session_target: "current"` in the same chat, or several jobs
   * pointed at the same named session (`session:standup` →
   * `cron:standup`). The old single-match form was a regression Codex
   * flagged: deleting the session removed only one job and left the
   * others firing into a recreated orphan thread.
   *
   * Walks both enabled and disabled jobs so a Delete on a paused cron
   * session still cleans up its backing job(s).
   */
  findJobsBySessionKey(sessionKey: string): CronJob[] {
    const matches: CronJob[] = [];
    for (const job of this._store.getJobs()) {
      if (this.resolveSessionKey(job) === sessionKey) matches.push(job);
    }
    return matches;
  }

  getJob(id: string): CronJob | undefined {
    return this._store.getJob(id);
  }

  listJobs(includeDisabled = false): CronJob[] {
    const jobs = this._store.getJobs();
    return includeDisabled ? jobs : jobs.filter((j) => j.enabled);
  }

  getRunHistory(jobId: string, limit = 20): CronRunLogEntry[] {
    return readRunLog(this._store.getStorePath(), jobId, limit);
  }

  /** Force-run a job immediately (bypasses schedule). */
  async forceRun(jobId: string): Promise<void> {
    const job = this._store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    // Skip if this job is already running (prevents duplicate execution
    // when user force-runs a job that's still executing from a prior
    // trigger or scheduled run).
    if (job.state.runningAtMs) {
      log.info("forceRun skipped: job already running", {
        jobId,
        name: job.name,
        runningAtMs: job.state.runningAtMs,
      });
      return;
    }

    await this.executeJob(job);
  }

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------

  private armTimer(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextMs = this.findNextWakeMs();
    if (nextMs === null) return;

    const now = Date.now();
    const delay = Math.max(nextMs - now, 0);
    const clamped = Math.min(Math.max(delay, MIN_REFIRE_GAP_MS), MAX_TIMER_DELAY_MS);

    this.timer = setTimeout(() => {
      void this.onTimer().catch((err) => {
        log.error("cron timer tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, clamped);
  }

  private findNextWakeMs(): number | null {
    const jobs = this._store.getJobs();
    let earliest: number | null = null;
    for (const job of jobs) {
      if (!job.enabled || job.state.nextRunAtMs === null) continue;
      if (earliest === null || job.state.nextRunAtMs < earliest) {
        earliest = job.state.nextRunAtMs;
      }
    }
    return earliest;
  }

  // ---------------------------------------------------------------------------
  // Timer tick
  // ---------------------------------------------------------------------------

  private async onTimer(): Promise<void> {
    if (this.stopped || this.running) {
      this.armTimer();
      return;
    }

    this.running = true;
    try {
      const now = Date.now();
      const dueJobs = this.collectDueJobs(now);

      if (dueJobs.length === 0) {
        this.armTimer();
        return;
      }

      // Execute due jobs (up to max concurrent)
      const batch = dueJobs.slice(0, this.config.maxConcurrentRuns);
      await Promise.all(batch.map((job) => this.executeJob(job)));
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  private collectDueJobs(nowMs: number): CronJob[] {
    return this._store.getJobs().filter((job) =>
      job.enabled &&
      job.state.nextRunAtMs !== null &&
      job.state.nextRunAtMs <= nowMs &&
      !job.state.runningAtMs,
    );
  }

  // ---------------------------------------------------------------------------
  // Job execution
  // ---------------------------------------------------------------------------

  private async executeJob(job: CronJob): Promise<void> {
    const startMs = Date.now();

    // Mark as running
    this._store.updateJobState(job.id, { runningAtMs: startMs });

    // Broadcast started
    this.server.broadcast("cron.started", {
      type: "cron.started",
      jobId: job.id,
      jobName: job.name,
      timestamp: startMs,
    } satisfies CronStartedEvent);

    // System message to cron session: mark start with timestamp
    const sessionKey = this.resolveSessionKey(job);
    const timeStr = new Date(startMs).toLocaleTimeString();
    this.server.broadcastToSession(sessionKey, "agent.system_message", {
      type: "system_message",
      content: `[${timeStr}] Cron "${job.name}" started`,
      subtype: "info",
    });

    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    let summary = "";
    let fullSummary = "";

    try {
      // Build message with node context + memory distillation instruction
      const workspace = new WorkspaceManager();
      const nodes = this.server.nodeRegistry.listConnected().map((n) => ({
        name: n.name, platform: n.platform, commands: n.commands,
      }));
      const nodePrefix = buildNodeContextPrefix(nodes);
      const distillationPrefix = buildCronDistillationPrefix(workspace.getWorkspacePath());
      const message = nodePrefix + distillationPrefix + job.payload.message;

      const result = await triggerAgentTurn(
        {
          sessionKey,
          message,
          lane: CommandLane.Cron,
          origin: `cron:${job.name}`,
        },
        { sessions: this.sessions, server: this.server },
      );

      summary = result.summary;
      fullSummary = result.fullSummary;
      if (result.status === "error") {
        status = "error";
        error = result.error;
      }
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      log.error("cron job execution failed", { jobId: job.id, error });
    }

    const endMs = Date.now();
    const durationMs = endMs - startMs;
    const truncatedSummary = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;

    // Update job state
    this.applyJobResult(job, status, error, startMs, endMs);

    // Append to run log
    appendRunLog(this._store.getStorePath(), job.id, {
      ts: startMs,
      jobId: job.id,
      status,
      error,
      summary: truncatedSummary || undefined,
      durationMs,
      nextRunAtMs: job.state.nextRunAtMs ?? undefined,
      sessionKey: this.resolveSessionKey(job),
    });

    // Heartbeat bridge
    if (job.heartbeatBridge && status === "ok") {
      enqueueSystemEvent(
        "heartbeat:main",
        `Cron "${job.name}" completed${truncatedSummary ? `: ${truncatedSummary}` : ""}`,
        `cron:${job.id}`,
      );
    }

    // Delivery (web push to all subscriptions)
    deliver({
      config: job.delivery ?? { mode: "push" },
      title: `Hawky: ${job.name}`,
      message: status === "error"
        ? `Failed: ${error?.slice(0, 200) ?? "unknown error"}`
        : truncatedSummary || "Completed (no output)",
      isError: status === "error",
      sessionKey,
    });

    // Proactive delivery into another session is intentionally gone now that
    // cron sessions are chattable on their own. Each cron job's results live
    // in cron:<name>.jsonl as a normal conversation thread; the user opens
    // that thread to read or follow up on a result. The legacy
    // `delivery_target` field is preserved on existing CronJob objects for
    // back-compat (so the store still loads), but is otherwise ignored —
    // see cron-store.ts. We keep the `deliver()` push above (OS banner /
    // configured webhook): it's a notification, not a history fork.

    // Broadcast completed
    this.server.broadcast("cron.completed", {
      type: "cron.completed",
      jobId: job.id,
      jobName: job.name,
      timestamp: endMs,
      status,
      durationMs,
      error,
      summary: truncatedSummary || undefined,
    } satisfies CronCompletedEvent);

    log.info("cron job completed", {
      jobId: job.id,
      name: job.name,
      status,
      durationMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Result application
  // ---------------------------------------------------------------------------

  private applyJobResult(
    job: CronJob,
    status: "ok" | "error",
    error: string | undefined,
    startMs: number,
    endMs: number,
  ): void {
    const durationMs = endMs - startMs;

    // Update state
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startMs;
    job.state.lastStatus = status;
    job.state.lastError = error;
    job.state.lastDurationMs = durationMs;

    // Track consecutive errors
    if (status === "error") {
      job.state.consecutiveErrors++;
    } else {
      job.state.consecutiveErrors = 0;
    }

    // Update run history (in-memory, last N)
    const record: CronRunRecord = { runAtMs: startMs, status, durationMs, error };
    job.state.runHistory.push(record);
    if (job.state.runHistory.length > MAX_RUN_HISTORY) {
      job.state.runHistory = job.state.runHistory.slice(-MAX_RUN_HISTORY);
    }

    // Compute next run
    if (job.schedule.kind === "at") {
      // One-shot
      if (status === "ok") {
        if (job.deleteAfterRun) {
          this._store.deleteJob(job.id);
          return;
        }
        job.enabled = false;
        job.state.nextRunAtMs = null;
      } else if (status === "error") {
        const transient = isTransientError(error);
        if (transient && job.state.consecutiveErrors <= DEFAULT_MAX_TRANSIENT_RETRIES) {
          const backoff = errorBackoffMs(job.state.consecutiveErrors);
          job.state.nextRunAtMs = endMs + backoff;
        } else {
          job.enabled = false;
          job.state.nextRunAtMs = null;
        }
      }
    } else {
      // Recurring
      if (status === "error" && job.enabled) {
        const backoff = errorBackoffMs(job.state.consecutiveErrors);
        const naturalNext = computeNextRunAtMs(job.schedule, endMs);
        const backoffNext = endMs + backoff;
        job.state.nextRunAtMs = naturalNext !== undefined
          ? Math.max(naturalNext, backoffNext)
          : backoffNext;
      } else if (job.enabled) {
        const naturalNext = computeNextRunAtMs(job.schedule, endMs);
        if (naturalNext !== undefined) {
          job.state.nextRunAtMs = Math.max(naturalNext, endMs + MIN_REFIRE_GAP_MS);
        } else {
          job.state.nextRunAtMs = null;
        }
      } else {
        job.state.nextRunAtMs = null;
      }
    }

    this._store.save(true); // Runtime-only update, no backup
  }

  // ---------------------------------------------------------------------------
  // Session helpers
  // ---------------------------------------------------------------------------

  private resolveSessionKey(job: CronJob): string {
    // Use human-readable job name for session keys (not hex IDs).
    // Name uniqueness is enforced by CronStore.addJob().
    const sanitizedName = job.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
    switch (job.sessionTarget) {
      case "current":
        return job.sessionKey ?? `cron:${sanitizedName}`;
      case "isolated":
        return `cron:${sanitizedName}`;
      default:
        // session:<name>
        if (job.sessionTarget.startsWith("session:")) {
          return `cron:${job.sessionTarget.slice(8)}`;
        }
        return `cron:${sanitizedName}`;
    }
  }

  private trimSessionHistory(
    session: { loop: { getHistory(): any[]; setHistory(m: any[]): void }; sessionManager: { rewriteMessages(m: any[], model?: string): void } },
    keepRecent: number,
  ): void {
    const history = session.loop.getHistory();
    if (history.length <= keepRecent) return;

    let cutIndex = history.length - keepRecent;
    while (cutIndex < history.length) {
      const msg = history[cutIndex];
      if (msg.role === "user") break;
      if (msg.role === "assistant") {
        const firstBlock = msg.content?.[0];
        if (!firstBlock || (firstBlock as any).type !== "tool_result") break;
      }
      cutIndex++;
    }

    if (cutIndex > 0 && cutIndex < history.length) {
      const trimmed = history.slice(cutIndex);
      session.loop.setHistory(trimmed);
      session.sessionManager.rewriteMessages(trimmed, this.fullConfig.model);
    }
  }

  // ---------------------------------------------------------------------------
  // Startup catch-up
  // ---------------------------------------------------------------------------

  private runMissedJobs(nowMs: number): void {
    const missed = this.collectDueJobs(nowMs);
    if (missed.length === 0) return;

    const batch = missed.slice(0, this.config.maxMissedOnRestart);
    log.info("running missed cron jobs after restart", {
      total: missed.length,
      running: batch.length,
    });

    // Execute missed jobs asynchronously (don't block startup)
    void (async () => {
      for (const job of batch) {
        try {
          await this.executeJob(job);
        } catch (err) {
          log.error("missed job execution failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Accessors (for testing)
  // ---------------------------------------------------------------------------

  getStore(): CronStore {
    return this.store;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function errorBackoffMs(consecutiveErrors: number): number {
  const index = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[Math.max(0, index)];
}

function isTransientError(error?: string): boolean {
  if (!error) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(error));
}

// Export for testing
export { errorBackoffMs, isTransientError };
