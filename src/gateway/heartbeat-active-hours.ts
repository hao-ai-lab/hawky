// =============================================================================
// Heartbeat Active Hours
//
// Timezone-aware window checker for heartbeat scheduling. Framework-enforced
// (not LLM-driven) to avoid wasting API calls outside configured hours.
//
// Pattern: a proven heartbeat-active-hours.ts — permissive defaults,
// timezone resolution with fallbacks, overnight range support.
// =============================================================================

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ActiveHoursConfig {
  /** Start time in HH:MM format (inclusive). Default: "08:00" */
  start: string;
  /** End time in HH:MM format (exclusive). "24:00" allowed. Default: "22:00" */
  end: string;
  /** IANA timezone, "local", or undefined. Default: "local" */
  timezone?: string;
}

// -----------------------------------------------------------------------------
// Time parsing
// -----------------------------------------------------------------------------

/**
 * Parse HH:MM string into total minutes since midnight (0–1440).
 * Returns null on invalid input.
 */
export function parseTimeToMinutes(time: string): number | null {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  // Allow 24:00 as end-of-day marker
  if (hours === 24 && minutes === 0) return 1440;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
}

// -----------------------------------------------------------------------------
// Timezone resolution
// -----------------------------------------------------------------------------

/**
 * Resolve the minutes-of-day for a given timestamp in a target timezone.
 *
 * Falls back to local timezone if the IANA timezone is invalid.
 */
export function getMinutesOfDay(
  timestampMs: number,
  timezone?: string,
): number {
  const tz = resolveTimezone(timezone);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(timestampMs));
    const hour = parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10,
    );
    const minute = parseInt(
      parts.find((p) => p.type === "minute")?.value ?? "0",
      10,
    );
    // Intl may return hour=24 at midnight in some locales; normalize
    return (hour % 24) * 60 + minute;
  } catch {
    // Fallback: use local Date
    const d = new Date(timestampMs);
    return d.getHours() * 60 + d.getMinutes();
  }
}

/**
 * Resolve timezone string to IANA name.
 * - "local" or undefined → host timezone
 * - IANA name → validated, falls back to host timezone if invalid
 */
export function resolveTimezone(tz?: string): string {
  if (!tz || tz === "local") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // Validate the IANA timezone
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    // Invalid timezone — fall back to local
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

// -----------------------------------------------------------------------------
// Main check
// -----------------------------------------------------------------------------

/**
 * Check if the given timestamp falls within the configured active hours.
 *
 * Returns true (permissive) if:
 * - Config is undefined or incomplete
 * - Timezone parsing fails
 * - start === end (zero-width window → always inactive, so we return true to not block)
 *
 * Supports overnight ranges: start=22:00, end=06:00 means active from 10pm to 6am.
 */
export function isWithinActiveHours(
  config: ActiveHoursConfig | undefined,
  nowMs?: number,
): boolean {
  if (!config) return true;

  const startMin = parseTimeToMinutes(config.start);
  const endMin = parseTimeToMinutes(config.end);

  // Invalid times → permissive (don't block)
  if (startMin === null || endMin === null) return true;

  // Zero-width window: start === end → always outside, but we return true
  // to avoid accidentally blocking all heartbeats
  if (startMin === endMin) return true;

  const now = getMinutesOfDay(nowMs ?? Date.now(), config.timezone);

  // Normal range: start < end (e.g., 08:00–22:00)
  if (startMin < endMin) {
    return now >= startMin && now < endMin;
  }

  // Overnight range: start > end (e.g., 22:00–06:00)
  // Active if now >= start OR now < end
  return now >= startMin || now < endMin;
}
