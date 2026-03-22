// =============================================================================
// Cron Schedule Computation
//
// Computes next run time for three schedule types: cron expression, interval,
// and one-shot. Uses croner for cron expressions with timezone support.
//
// Pattern: a proven schedule.ts — cached Cron instances, timezone resolution,
// workaround for croner year-rollback bug.
// =============================================================================

import { Cron } from "croner";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/cron");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "at"; at: string }  // Relative: "+30m", "+2h", or ISO datetime
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string };

// -----------------------------------------------------------------------------
// Cron expression cache (LRU, max 256 entries)
// -----------------------------------------------------------------------------

const CACHE_MAX = 256;
const cronCache = new Map<string, Cron>();

function getCachedCron(expr: string, tz: string): Cron {
  const key = `${tz}\0${expr}`;
  const cached = cronCache.get(key);
  if (cached) return cached;

  if (cronCache.size >= CACHE_MAX) {
    const oldest = cronCache.keys().next().value;
    if (oldest) cronCache.delete(oldest);
  }

  const cron = new Cron(expr, { timezone: tz });
  cronCache.set(key, cron);
  return cron;
}

// -----------------------------------------------------------------------------
// Timezone resolution
// -----------------------------------------------------------------------------

function resolveTimezone(tz?: string): string {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (!trimmed) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Validate
  try {
    Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

// -----------------------------------------------------------------------------
// Relative time parsing (+30m, +2h, +1d)
// -----------------------------------------------------------------------------

const RELATIVE_RE = /^\+(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/i;

export function parseRelativeTime(input: string, nowMs: number): number | null {
  const match = input.trim().match(RELATIVE_RE);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  let ms: number;
  switch (unit) {
    case "s": case "sec": ms = amount * 1000; break;
    case "m": case "min": ms = amount * 60_000; break;
    case "h": case "hr": case "hour": ms = amount * 3_600_000; break;
    case "d": case "day": ms = amount * 86_400_000; break;
    default: return null;
  }

  return nowMs + ms;
}

// -----------------------------------------------------------------------------
// Resolve absolute time from "at" schedule
// -----------------------------------------------------------------------------

export function resolveAtMs(schedule: CronSchedule & { kind: "at" }, nowMs: number): number | null {
  if ("atMs" in schedule && typeof schedule.atMs === "number") {
    return schedule.atMs > nowMs ? schedule.atMs : null;
  }
  if ("at" in schedule && typeof schedule.at === "string") {
    const at = schedule.at.trim();
    // Try relative time first
    const relative = parseRelativeTime(at, nowMs);
    if (relative !== null) return relative;
    // Try ISO datetime
    const parsed = new Date(at).getTime();
    if (!Number.isNaN(parsed) && parsed > nowMs) return parsed;
    return null;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Main: compute next run time
// -----------------------------------------------------------------------------

/**
 * Compute the next run time for a schedule.
 * Returns undefined if the schedule has no future runs (e.g., past one-shot).
 */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "at": {
      const atMs = resolveAtMs(schedule as CronSchedule & { kind: "at" }, nowMs);
      return atMs !== null ? atMs : undefined;
    }

    case "every": {
      const everyMs = Math.max(1000, Math.floor(schedule.everyMs)); // Min 1s
      // Next tick from now
      return nowMs + everyMs;
    }

    case "cron": {
      const tz = resolveTimezone(schedule.tz);
      try {
        const cron = getCachedCron(schedule.expr, tz);
        const next = cron.nextRun(new Date(nowMs));
        if (!next) return undefined;
        const nextMs = next.getTime();
        if (!Number.isFinite(nextMs)) return undefined;

        // Workaround: croner timezone bug — sometimes returns past timestamp
        if (nextMs <= nowMs) {
          const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
          const retry = cron.nextRun(new Date(nextSecondMs));
          if (retry) {
            const retryMs = retry.getTime();
            if (Number.isFinite(retryMs) && retryMs > nowMs) return retryMs;
          }
          return undefined;
        }

        return nextMs;
      } catch (err) {
        log.warn("cron expression evaluation failed", {
          expr: schedule.expr,
          tz,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }
  }
}

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateCronExpr(expr: string, tz?: string): string | null {
  try {
    const timezone = resolveTimezone(tz);
    new Cron(expr, { timezone });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Get the next N run times for a schedule (for display/validation).
 */
export function getNextRunTimes(
  schedule: CronSchedule,
  count: number,
  nowMs?: number,
): number[] {
  const times: number[] = [];
  let cursor = nowMs ?? Date.now();
  for (let i = 0; i < count; i++) {
    const next = computeNextRunAtMs(schedule, cursor);
    if (next === undefined) break;
    times.push(next);
    cursor = next;
  }
  return times;
}

/** Reset cron cache (for testing) */
export function resetCronCache(): void {
  cronCache.clear();
}
