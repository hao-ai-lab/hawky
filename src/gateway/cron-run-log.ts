// =============================================================================
// Cron Run Log
//
// Per-job JSONL run history. Append-only with size-based pruning.
// Files at ~/.hawky/cron/runs/<jobId>.jsonl
//
// Pattern: a proven run-log.ts — chained writes, atomic prune.
// =============================================================================

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/cron-run-log");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  durationMs: number;
  nextRunAtMs?: number;
  sessionKey?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_MAX_LINES = 2000;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Append a run log entry for a job.
 */
export function appendRunLog(
  storePath: string,
  jobId: string,
  entry: CronRunLogEntry,
): void {
  const filePath = resolveRunLogPath(storePath, jobId);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const line = JSON.stringify(entry) + "\n";
  appendFileSync(filePath, line, "utf-8");

  // Check if pruning needed
  try {
    const stat = statSync(filePath);
    if (stat.size > DEFAULT_MAX_BYTES) {
      pruneRunLog(filePath, DEFAULT_MAX_LINES);
    }
  } catch { /* stat failure is non-fatal */ }
}

/**
 * Read recent run log entries for a job.
 */
export function readRunLog(
  storePath: string,
  jobId: string,
  limit = 20,
): CronRunLogEntry[] {
  const filePath = resolveRunLogPath(storePath, jobId);
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const entries: CronRunLogEntry[] = [];

    // Read from end (most recent)
    const start = Math.max(0, lines.length - limit);
    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch { /* skip malformed lines */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Delete run log for a job. Available for programmatic cleanup;
 * the reaper currently uses unlinkSync directly.
 */
export function deleteRunLog(storePath: string, jobId: string): boolean {
  const filePath = resolveRunLogPath(storePath, jobId);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

function resolveRunLogPath(storePath: string, jobId: string): string {
  const storeDir = dirname(resolve(storePath));
  const runsDir = join(storeDir, "runs");
  // Safety: sanitize jobId to prevent path traversal
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(runsDir, `${safeId}.jsonl`);
}

function pruneRunLog(filePath: string, keepLines: number): void {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length <= keepLines) return;

    const kept = lines.slice(lines.length - keepLines);
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, kept.join("\n") + "\n", "utf-8");
    renameSync(tmp, filePath);

    log.debug("run log pruned", {
      filePath,
      before: lines.length,
      after: kept.length,
    });
  } catch (err) {
    log.warn("run log prune failed", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Export for testing */
export { resolveRunLogPath as _resolveRunLogPath };
