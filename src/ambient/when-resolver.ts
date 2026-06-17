// =============================================================================
// when-resolver.ts — resolve a `when` time-expression to a TriggerPredicate.
//
// Deterministic time resolution shared by the obvious-intention write path
// (create-intention.ts). Handles relative offsets ("in N minutes/hours"),
// wall-clock times ("at 5pm", "17:30"), and day-qualified times ("7am
// tomorrow", "today at 11pm", "Monday at 9am"), resolving each to an absolute
// ISO timestamp in the given IANA timezone (DST-correct: the UTC offset is
// taken at the TARGET instant, not at `nowMs`).
//
// This is pure resolution, NOT recognition: the caller already has the isolated
// time phrase. (The former priority:"timed" free-text string-parse path has been
// retired in favour of the structured create_intention tool.)
// =============================================================================

import type { TriggerPredicate, TriggerWhen } from "./intention.js";

// ---------------------------------------------------------------------------
// When-trigger inference
// ---------------------------------------------------------------------------

// Relative offsets. English accepts a bare word-number ("a"/"an"/"one" → 1) in
// addition to digits; Chinese accepts 秒/分钟/分/小时/钟头 with an optional 后/之后.
// Seconds are supported so reminders can be tested without waiting a full minute.
const IN_SECONDS_RE = /\bin\s+(\d+)\s+second/i;
const IN_MINUTES_RE = /\bin\s+(?:(\d+)|an?|one)\s+minute/i;
const IN_HOURS_RE   = /\bin\s+(?:(\d+)|an?|one)\s+hour/i;
// Chinese: "30秒后" / "5分钟后" / "2小时后" / "半小时后" (后/之后 optional).
const ZH_SECONDS_RE = /(\d+)\s*秒(?:钟)?(?:之?后)?/;
const ZH_MINUTES_RE = /(半|\d+)\s*分(?:钟)?(?:之?后)?/;
const ZH_HOURS_RE   = /(半|\d+)\s*(?:小时|钟头|个小时)(?:之?后)?/;
const AT_TIME_RE    = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)/i;

// Clock fragment: "7am", "7:30 pm", "7", "17:00" etc.
const CLOCK_FRAG = /(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)/i;

// Day-qualified patterns (checked BEFORE AT_TIME_RE so "at 7am tomorrow" doesn't
// match as a bare wall-clock time and lose the day context).

// "7am tomorrow" / "at 7am tomorrow" / "at 7 tomorrow"
const AT_TIME_TOMORROW_RE   = new RegExp(
  `(?:at\\s+)?${CLOCK_FRAG.source}\\s+tomorrow|tomorrow\\s+at\\s+${CLOCK_FRAG.source}`,
  "i",
);
// "today at 11pm" / "at 11pm today"
const AT_TIME_TODAY_RE      = new RegExp(
  `today\\s+at\\s+${CLOCK_FRAG.source}|(?:at\\s+)?${CLOCK_FRAG.source}\\s+today`,
  "i",
);
// weekday: "next Monday at 9am" / "on Friday at 6pm" / "Monday at 9"
const WEEKDAY_NAMES = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const AT_TIME_WEEKDAY_RE    = new RegExp(
  `(?:next\\s+|on\\s+)?(${WEEKDAY_NAMES})\\s+at\\s+${CLOCK_FRAG.source}`,
  "i",
);

/**
 * Parse a wall-clock text (e.g. "5:30 pm", "5pm", "17:00", "5") into
 * { hours24, minutes } using 24h arithmetic.
 * Returns null if parsing fails.
 */
function parseWallClock(clockText: string): { hours24: number; minutes: number } | null {
  // Normalise am/pm markers
  const s = clockText.replace(/\./g, "").trim().toLowerCase();
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return { hours24: hours, minutes };
}

/**
 * Resolve a wall-clock time string (e.g. "5:30 pm", "5pm", "17:00") to the
 * next absolute ISO timestamp at or after `nowMs` in the given IANA `timezone`.
 *
 * Strategy: try today's occurrence; if already in the past, use tomorrow's.
 */
function resolveWallClockToISO(clockText: string, nowMs: number, timezone: string): string {
  const parsed = parseWallClock(clockText);
  if (!parsed) throw new RangeError(`Cannot parse wall-clock time: "${clockText}"`);
  const { hours24, minutes } = parsed;

  // Get today's Y-M-D in the target timezone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const datePart: Record<string, string> = {};
  for (const p of parts) datePart[p.type] = p.value;

  const hh = String(hours24).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const todayStr = `${datePart.year}-${datePart.month}-${datePart.day}`;
  // Iterative offset: compute offset at the target instant, not at nowMs.
  // This handles DST transitions where the target hour may have a different offset.
  const naiveUtcMs = new Date(`${todayStr}T${hh}:${mm}:00Z`).getTime();
  let offset = getTzOffsetMs(timezone, naiveUtcMs);
  let localMs = naiveUtcMs - offset;
  const offset2 = getTzOffsetMs(timezone, localMs);
  if (offset2 !== offset) localMs = naiveUtcMs - offset2;

  // If this occurrence is already in the past (or equal), roll forward one day.
  if (localMs <= nowMs) {
    return new Date(localMs + 24 * 3_600_000).toISOString();
  }
  return new Date(localMs).toISOString();
}

/**
 * Return the UTC offset of `timezone` at `nowMs` in milliseconds.
 * Positive means "timezone is ahead of UTC" (e.g. UTC+9 → +32400000).
 */
function getTzOffsetMs(timezone: string, nowMs: number): number {
  // Derive offset by comparing two Intl-formatted strings.
  const utcParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(nowMs));
  const tzParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(nowMs));

  function toMs(parts: Intl.DateTimeFormatPart[]): number {
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    return new Date(`${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`).getTime();
  }

  return toMs(tzParts) - toMs(utcParts);
}

/**
 * Get the Y-M-D date string for `nowMs` in the given timezone, offset by `dayDelta` days.
 * dayDelta=0 → today, dayDelta=1 → tomorrow.
 */
function getDateString(nowMs: number, timezone: string, dayDelta: number): string {
  const adjusted = new Date(nowMs + dayDelta * 24 * 3_600_000);
  const adjParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(adjusted);
  const a: Record<string, string> = {};
  for (const p of adjParts) a[p.type] = p.value;
  return `${a.year}-${a.month}-${a.day}`;
}

/**
 * Resolve a wall-clock time on an explicit date string (YYYY-MM-DD) in the given
 * timezone to an absolute ISO UTC timestamp.
 */
function resolveWallClockOnDateToISO(
  clockText: string,
  dateStr: string,
  timezone: string,
): string {
  const parsed = parseWallClock(clockText);
  if (!parsed) throw new RangeError(`Cannot parse wall-clock time: "${clockText}"`);
  const { hours24, minutes } = parsed;
  const hh = String(hours24).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  // Iterative offset: compute offset at the target instant, not at a proxy noon time.
  const naiveUtcMs = new Date(`${dateStr}T${hh}:${mm}:00Z`).getTime();
  let offset = getTzOffsetMs(timezone, naiveUtcMs);
  let localMs = naiveUtcMs - offset;
  const offset2 = getTzOffsetMs(timezone, localMs);
  if (offset2 !== offset) localMs = naiveUtcMs - offset2;
  return new Date(localMs).toISOString();
}

/** Map weekday name to 0-indexed Sunday=0 number. */
const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Return the YYYY-MM-DD for the next occurrence of `weekdayName` at or after
 * tomorrow (we never fire "Monday at 9" for today if it's Monday — always
 * the next occurrence).
 */
function nextWeekdayDateString(
  weekdayName: string,
  nowMs: number,
  timezone: string,
): string {
  const target = WEEKDAY_INDEX[weekdayName.toLowerCase()];
  // Get today's weekday in the target timezone.
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).formatToParts(new Date(nowMs));
  const todayShort = todayParts.find(p => p.type === "weekday")?.value ?? "";
  const shortToIndex: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const todayIndex = shortToIndex[todayShort] ?? 0;
  // Days until target: minimum 1 (never today).
  let daysAhead = target - todayIndex;
  if (daysAhead <= 0) daysAhead += 7;
  return getDateString(nowMs, timezone, daysAhead);
}

/**
 * Infer a `when` trigger from a time-expression (e.g. "in 10 minutes", "at 5pm",
 * "tomorrow at 9am"). Returns `{ all: [{ kind: "when", at?, relative? }] }` when
 * parseable, or `null` when no time expression is found (caller treats null as
 * un-fireable / needs clarification).
 *
 * When `nowMs` and `timezone` are provided, `at` is resolved to an absolute ISO
 * timestamp (next occurrence of the wall-clock time). Without them, `at` falls
 * back to the raw matched text.
 */
/**
 * Parse a captured quantity into a number. A missing capture (English bare
 * "a"/"an"/"one minute") → 1; Chinese "半" (half) → 0.5; otherwise the integer.
 */
function parseQuantity(captured: string | undefined): number {
  if (captured === undefined) return 1;
  if (captured === "半") return 0.5;
  return parseInt(captured, 10);
}

/** Build a relative-offset TriggerPredicate, resolving to ISO when nowMs given. */
function relativeTrigger(
  offsetMs: number,
  label: string,
  nowMs: number | undefined,
): TriggerPredicate {
  if (nowMs !== undefined) {
    return { all: [{ kind: "when", at: new Date(nowMs + offsetMs).toISOString(), relative: label } satisfies TriggerWhen] };
  }
  return { all: [{ kind: "when", relative: label } satisfies TriggerWhen] };
}

export function inferTrigger(body: string, nowMs?: number, timezone?: string): TriggerPredicate | null {
  // Relative offsets, most-specific unit first. English + Chinese, incl. seconds.
  const inSec = body.match(IN_SECONDS_RE) ?? body.match(ZH_SECONDS_RE);
  if (inSec) {
    const n = parseQuantity(inSec[1]);
    return relativeTrigger(n * 1_000, `in ${n} seconds`, nowMs);
  }
  const inMin = body.match(IN_MINUTES_RE) ?? body.match(ZH_MINUTES_RE);
  if (inMin) {
    const n = parseQuantity(inMin[1]);
    return relativeTrigger(n * 60_000, `in ${n} minutes`, nowMs);
  }
  const inHr = body.match(IN_HOURS_RE) ?? body.match(ZH_HOURS_RE);
  if (inHr) {
    const n = parseQuantity(inHr[1]);
    return relativeTrigger(n * 3_600_000, `in ${n} hours`, nowMs);
  }
  // Day-qualified: "7am tomorrow" / "at 7am tomorrow" / "tomorrow at 7:30 pm"
  if (nowMs !== undefined && timezone !== undefined) {
    const tmMatch = body.match(AT_TIME_TOMORROW_RE);
    if (tmMatch) {
      // Group 1: "CLOCK tomorrow" form; group 2: "tomorrow at CLOCK" form.
      const clockText = (tmMatch[1] ?? tmMatch[2]).trim();
      const dateStr = getDateString(nowMs, timezone, 1);
      const at = resolveWallClockOnDateToISO(clockText, dateStr, timezone);
      return { all: [{ kind: "when", at, relative: tmMatch[0].trim() } satisfies TriggerWhen] };
    }

    // Day-qualified: "today at 11pm" / "at 11pm today"
    const todayMatch = body.match(AT_TIME_TODAY_RE);
    if (todayMatch) {
      const clockText = (todayMatch[1] ?? todayMatch[2]).trim();
      const dateStr = getDateString(nowMs, timezone, 0);
      let at = resolveWallClockOnDateToISO(clockText, dateStr, timezone);
      // If already past, roll to tomorrow.
      if (new Date(at).getTime() <= nowMs) {
        at = resolveWallClockOnDateToISO(clockText, getDateString(nowMs, timezone, 1), timezone);
      }
      return { all: [{ kind: "when", at, relative: todayMatch[0].trim() } satisfies TriggerWhen] };
    }

    // Weekday-qualified: "next Monday at 9am" / "on Friday at 6pm" / "Monday at 9"
    const wdMatch = body.match(AT_TIME_WEEKDAY_RE);
    if (wdMatch) {
      const weekdayName = wdMatch[1];
      const clockText = wdMatch[2].trim();
      const dateStr = nextWeekdayDateString(weekdayName, nowMs, timezone);
      const at = resolveWallClockOnDateToISO(clockText, dateStr, timezone);
      return { all: [{ kind: "when", at, relative: wdMatch[0].trim() } satisfies TriggerWhen] };
    }
  }

  const atTime = body.match(AT_TIME_RE);
  if (atTime) {
    const rawText = atTime[1].trim();
    const at =
      nowMs !== undefined && timezone !== undefined
        ? resolveWallClockToISO(rawText, nowMs, timezone)
        : rawText;
    return { all: [{ kind: "when", at } satisfies TriggerWhen] };
  }
  return null;
}
