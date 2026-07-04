// =============================================================================
// Cron Job Store
//
// JSON file persistence for cron jobs. Atomic writes via temp file + rename.
// Automatic backup before structural changes.
//
// Pattern: a proven cron/store.ts — atomic rename, secure permissions,
// cache validation, retry on EBUSY.
// =============================================================================

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createSubsystemLogger } from "../logging/index.js";
import { getConfigDir } from "../storage/config.js";
import type { CronSchedule } from "./cron-schedule.js";

const log = createSubsystemLogger("gateway/cron-store");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;

  schedule: CronSchedule;
  payload: {
    message: string;
    model?: string;
  };
  sessionTarget: "isolated" | "current" | `session:${string}`;
  /** Captured session key for "current" target */
  sessionKey?: string;

  delivery?: {
    mode: "none" | "push" | "announce" | "webhook";
    channel?: string;
    to?: string;
  };
  /**
   * @deprecated No longer honored at runtime. Cron results live in their
   * own `cron:<name>` session — the user opens that session to read or
   * chat about the result, instead of having it injected into another
   * session. Field retained on the type and the JSON store so existing
   * cron jobs keep loading; new jobs should not set it. See cron.ts:
   * the proactive-delivery branch was removed when cron sessions became
   * chattable.
   */
  delivery_target?: string;
  /** Enqueue result to heartbeat system event queue after completion */
  heartbeatBridge?: boolean;

  state: CronJobState;
}

export interface CronJobState {
  nextRunAtMs: number | null;
  runningAtMs?: number;
  lastRunAtMs: number | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors: number;
  runHistory: CronRunRecord[];
}

export interface CronRunRecord {
  runAtMs: number;
  status: "ok" | "error" | "skipped";
  durationMs: number;
  error?: string;
  summary?: string;
}

export interface CronJobCreate {
  name: string;
  description?: string;
  schedule: CronSchedule;
  payload: { message: string; model?: string };
  sessionTarget?: "isolated" | "current" | `session:${string}`;
  sessionKey?: string;
  delivery?: CronJob["delivery"];
  delivery_target?: string;
  heartbeatBridge?: boolean;
  deleteAfterRun?: boolean;
}

export interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: { message?: string; model?: string };
  delivery?: CronJob["delivery"];
  delivery_target?: string;
  heartbeatBridge?: boolean;
  deleteAfterRun?: boolean;
}

export interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export class CronStore {
  private storePath: string;
  private cache: CronStoreFile | null = null;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  load(): CronStoreFile {
    if (this.cache) return this.cache;

    if (!existsSync(this.storePath)) {
      this.cache = { version: 1, jobs: [] };
      return this.cache;
    }

    try {
      const raw = readFileSync(this.storePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
        log.warn("invalid cron store format, starting fresh", { path: this.storePath });
        this.cache = { version: 1, jobs: [] };
        return this.cache;
      }
      this.cache = { version: 1, jobs: parsed.jobs.filter(Boolean) };
      return this.cache;
    } catch (err) {
      log.error("failed to load cron store", {
        path: this.storePath,
        error: err instanceof Error ? err.message : String(err),
      });
      this.cache = { version: 1, jobs: [] };
      return this.cache;
    }
  }

  getJobs(): CronJob[] {
    return this.load().jobs;
  }

  getJob(id: string): CronJob | undefined {
    return this.load().jobs.find((j) => j.id === id);
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  addJob(create: CronJobCreate): CronJob {
    const store = this.load();

    // Enforce unique job names (needed for human-readable session keys)
    if (store.jobs.some((j) => j.name === create.name)) {
      throw new Error(`A cron job named "${create.name}" already exists. Use a unique name.`);
    }

    const id = generateJobId();
    const now = Date.now();

    const job: CronJob = {
      id,
      name: create.name,
      description: create.description,
      enabled: true,
      deleteAfterRun: create.deleteAfterRun,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: create.schedule,
      payload: create.payload,
      sessionTarget: create.sessionTarget ?? "isolated",
      sessionKey: create.sessionKey,
      delivery: create.delivery,
      delivery_target: create.delivery_target,
      heartbeatBridge: create.heartbeatBridge,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        consecutiveErrors: 0,
        runHistory: [],
      },
    };

    store.jobs.push(job);
    this.save();

    log.info("cron job added", { jobId: id, name: create.name });
    return job;
  }

  updateJob(id: string, patch: CronJobPatch): CronJob | null {
    const store = this.load();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return null;

    if (patch.name !== undefined) {
      // Enforce unique names (same invariant as addJob)
      if (store.jobs.some((j) => j.id !== id && j.name === patch.name)) {
        throw new Error(`A cron job named "${patch.name}" already exists. Use a unique name.`);
      }
      job.name = patch.name;
    }
    if (patch.description !== undefined) job.description = patch.description;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.delivery !== undefined) job.delivery = patch.delivery;
    if (patch.delivery_target !== undefined) job.delivery_target = patch.delivery_target;
    if (patch.heartbeatBridge !== undefined) job.heartbeatBridge = patch.heartbeatBridge;
    if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;
    if (patch.payload) {
      if (patch.payload.message !== undefined) job.payload.message = patch.payload.message;
      if (patch.payload.model !== undefined) job.payload.model = patch.payload.model;
    }
    job.updatedAtMs = Date.now();

    this.save();
    log.info("cron job updated", { jobId: id });
    return job;
  }

  removeJob(id: string): boolean {
    const store = this.load();
    const index = store.jobs.findIndex((j) => j.id === id);
    if (index < 0) return false;

    store.jobs.splice(index, 1);
    this.save();

    log.info("cron job removed", { jobId: id });
    return true;
  }

  /** Update job state (after execution). Does not create backup (runtime-only change). */
  updateJobState(id: string, update: Partial<CronJobState>): void {
    const store = this.load();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return;

    Object.assign(job.state, update);
    job.updatedAtMs = Date.now();
    this.save(true); // skipBackup for runtime-only changes
  }

  /** Semantic alias for removeJob — used by one-shot auto-delete in applyJobResult. */
  deleteJob(id: string): boolean {
    return this.removeJob(id);
  }

  /**
   * Update any job field that references `oldKey` to point at `newKey`.
   * Covers `sessionTarget` (both the `session:<key>` form and the raw key
   * form used by `sessionKey`) and `delivery_target`. Saves once at the end.
   * Returns the number of jobs mutated.
   */
  rebindSessionKey(oldKey: string, newKey: string): number {
    if (oldKey === newKey) return 0;
    const store = this.load();
    const oldTarget = `session:${oldKey}` as const;
    const newTarget = `session:${newKey}` as const;
    let count = 0;
    for (const job of store.jobs) {
      let changed = false;
      if (job.sessionTarget === oldTarget) {
        job.sessionTarget = newTarget;
        changed = true;
      }
      if (job.sessionKey === oldKey) {
        job.sessionKey = newKey;
        changed = true;
      }
      if (job.delivery_target === oldKey) {
        job.delivery_target = newKey;
        changed = true;
      }
      if (changed) {
        job.updatedAtMs = Date.now();
        count++;
      }
    }
    if (count > 0) {
      this.save();
      log.info("cron jobs rebound to renamed session", { oldKey, newKey, count });
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  save(skipBackup = false): void {
    const store = this.load();
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(store, null, 2);

    // Backup before structural changes (not for runtime state updates)
    if (!skipBackup && existsSync(this.storePath)) {
      try {
        copyFileSync(this.storePath, `${this.storePath}.bak`);
      } catch { /* best-effort */ }
    }

    // Atomic write: temp file → rename
    const tmp = `${this.storePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, json, "utf-8");
      renameSync(tmp, this.storePath);
    } catch (err) {
      // Fallback: direct write
      try {
        writeFileSync(this.storePath, json, "utf-8");
      } catch {
        log.error("failed to save cron store", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Cleanup temp
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Force reload from disk (for testing or after external edits). */
  reload(): void {
    this.cache = null;
  }

  /** Get store path (for testing). */
  getStorePath(): string {
    return this.storePath;
  }

  /** Reset (for testing). */
  reset(): void {
    this.cache = { version: 1, jobs: [] };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateJobId(): string {
  return randomBytes(6).toString("hex");
}

/** Default store path */
export function defaultCronStorePath(): string {
  return join(getConfigDir(), "cron", "jobs.json");
}
