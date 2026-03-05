// =============================================================================
// Error Ring Buffer + Error Log
//
// Captures error and warn level log entries into:
// 1. In-memory ring buffer (last 50, queryable by dashboard/TUI)
// 2. Daily JSONL file (~/.hawky/logs/errors/YYYY-MM-DD.jsonl)
//
// Integrated via a hook in the structured logger — every existing
// log.error() and log.warn() call is captured automatically.
// =============================================================================

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ErrorEntry {
  timestamp: number;
  subsystem: string;
  level: "error" | "warn";
  message: string;
  details?: string;
}

// -----------------------------------------------------------------------------
// Ring buffer
// -----------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 50;
const buffer: ErrorEntry[] = [];

/** Push an error into the ring buffer + persist to JSONL. */
export function pushError(entry: ErrorEntry): void {
  // Ring buffer: evict oldest if full
  if (buffer.length >= MAX_BUFFER_SIZE) {
    buffer.shift();
  }
  buffer.push(entry);

  // Persist to daily JSONL (fire-and-forget)
  try {
    appendToErrorLog(entry);
  } catch {
    // Non-fatal — in-memory buffer still has it
  }
}

/** Get recent errors (newest first). */
export function getRecentErrors(limit = 10): ErrorEntry[] {
  return buffer.slice(-limit).reverse();
}

/** Get all errors in the buffer (newest first). */
export function getAllErrors(): ErrorEntry[] {
  return [...buffer].reverse();
}

/** Get the total count of errors in the buffer. */
export function getErrorCount(): number {
  return buffer.length;
}

/** Clear the buffer (for testing). */
export function resetErrorBuffer(): void {
  buffer.length = 0;
}

// -----------------------------------------------------------------------------
// JSONL persistence
// -----------------------------------------------------------------------------

let errorLogDir: string | null = null;

/** Set the error log directory (called at gateway startup). */
export function setErrorLogDir(dir: string): void {
  errorLogDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function appendToErrorLog(entry: ErrorEntry): void {
  if (!errorLogDir) return;

  const d = new Date(entry.timestamp);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const filePath = join(errorLogDir, `${date}.jsonl`);

  const line = JSON.stringify({
    ts: entry.timestamp,
    subsystem: entry.subsystem,
    level: entry.level,
    message: entry.message,
    ...(entry.details ? { details: entry.details } : {}),
  });

  appendFileSync(filePath, line + "\n", "utf-8");
}

// -----------------------------------------------------------------------------
// Logger hook
//
// Called by the structured logger for every error/warn entry.
// This is the integration point — no manual pushError() calls needed
// in heartbeat, cron, agent loop, etc.
// -----------------------------------------------------------------------------

/** Hook for the structured logger. Call this from logger.ts on error/warn. */
export function onLogEntry(
  level: string,
  subsystem: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (level !== "error" && level !== "warn") return;

  const details = meta?.error
    ? String(meta.error)
    : meta?.reason
      ? String(meta.reason)
      : undefined;

  pushError({
    timestamp: Date.now(),
    subsystem,
    level: level as "error" | "warn",
    message,
    details: details?.slice(0, 500), // Truncate long stack traces
  });
}
