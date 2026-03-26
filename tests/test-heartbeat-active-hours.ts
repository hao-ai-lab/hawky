// =============================================================================
// Tests: Heartbeat Active Hours
// =============================================================================

import { describe, test, expect } from "bun:test";
import {
  isWithinActiveHours,
  parseTimeToMinutes,
  getMinutesOfDay,
  resolveTimezone,
} from "../src/gateway/heartbeat-active-hours.js";

// -----------------------------------------------------------------------------
// parseTimeToMinutes
// -----------------------------------------------------------------------------

describe("parseTimeToMinutes", () => {
  test("parses standard times", () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
    expect(parseTimeToMinutes("08:00")).toBe(480);
    expect(parseTimeToMinutes("12:30")).toBe(750);
    expect(parseTimeToMinutes("22:00")).toBe(1320);
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });

  test("parses 24:00 as end-of-day", () => {
    expect(parseTimeToMinutes("24:00")).toBe(1440);
  });

  test("rejects invalid times", () => {
    expect(parseTimeToMinutes("25:00")).toBe(null);
    expect(parseTimeToMinutes("24:01")).toBe(null);
    expect(parseTimeToMinutes("12:60")).toBe(null);
    expect(parseTimeToMinutes("-1:00")).toBe(null);
    expect(parseTimeToMinutes("abc")).toBe(null);
    expect(parseTimeToMinutes("")).toBe(null);
    expect(parseTimeToMinutes("12")).toBe(null);
    expect(parseTimeToMinutes("12:0")).toBe(null); // needs 2-digit minutes
  });

  test("handles whitespace", () => {
    expect(parseTimeToMinutes("  08:00  ")).toBe(480);
  });

  test("single-digit hours", () => {
    expect(parseTimeToMinutes("8:00")).toBe(480);
    expect(parseTimeToMinutes("0:00")).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// resolveTimezone
// -----------------------------------------------------------------------------

describe("resolveTimezone", () => {
  test("undefined returns local timezone", () => {
    const tz = resolveTimezone(undefined);
    expect(tz).toBeTruthy();
    // Should be a valid IANA timezone
    expect(() => Intl.DateTimeFormat("en-US", { timeZone: tz })).not.toThrow();
  });

  test("'local' returns local timezone", () => {
    const tz = resolveTimezone("local");
    expect(tz).toBeTruthy();
  });

  test("valid IANA timezone is returned as-is", () => {
    expect(resolveTimezone("America/New_York")).toBe("America/New_York");
    expect(resolveTimezone("Europe/London")).toBe("Europe/London");
    expect(resolveTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  test("invalid timezone falls back to local", () => {
    const local = resolveTimezone("local");
    const fallback = resolveTimezone("Invalid/Timezone");
    expect(fallback).toBe(local);
  });
});

// -----------------------------------------------------------------------------
// getMinutesOfDay
// -----------------------------------------------------------------------------

describe("getMinutesOfDay", () => {
  test("returns minutes of day in UTC", () => {
    // 2026-03-15 14:30 UTC
    const ts = new Date("2026-03-15T14:30:00Z").getTime();
    const minutes = getMinutesOfDay(ts, "UTC");
    expect(minutes).toBe(14 * 60 + 30);
  });

  test("respects timezone", () => {
    // 2026-03-15 14:30 UTC = 2026-03-15 10:30 EDT (UTC-4)
    const ts = new Date("2026-03-15T14:30:00Z").getTime();
    const utcMinutes = getMinutesOfDay(ts, "UTC");
    const nyMinutes = getMinutesOfDay(ts, "America/New_York");
    // EDT is UTC-4, so NY should be 4 hours behind
    expect(utcMinutes - nyMinutes).toBe(240);
  });

  test("handles midnight boundary", () => {
    const ts = new Date("2026-03-15T00:05:00Z").getTime();
    const minutes = getMinutesOfDay(ts, "UTC");
    expect(minutes).toBe(5);
  });

  test("falls back on invalid timezone", () => {
    const ts = Date.now();
    // Should not throw, returns local time
    const minutes = getMinutesOfDay(ts, "Invalid/TZ");
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThan(1440);
  });
});

// -----------------------------------------------------------------------------
// isWithinActiveHours
// -----------------------------------------------------------------------------

describe("isWithinActiveHours", () => {
  // Helper: create a timestamp at a specific hour in UTC
  function utcAt(hour: number, minute = 0): number {
    return new Date(`2026-03-15T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`).getTime();
  }

  test("returns true when no config", () => {
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  test("normal range: inside", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "22:00", timezone: "UTC" },
      utcAt(12),
    )).toBe(true);
  });

  test("normal range: at start boundary (inclusive)", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "22:00", timezone: "UTC" },
      utcAt(8, 0),
    )).toBe(true);
  });

  test("normal range: at end boundary (exclusive)", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "22:00", timezone: "UTC" },
      utcAt(22, 0),
    )).toBe(false);
  });

  test("normal range: before start", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "22:00", timezone: "UTC" },
      utcAt(7, 59),
    )).toBe(false);
  });

  test("normal range: after end", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "22:00", timezone: "UTC" },
      utcAt(23),
    )).toBe(false);
  });

  test("overnight range: 22:00-06:00, at 23:00 → inside", () => {
    expect(isWithinActiveHours(
      { start: "22:00", end: "06:00", timezone: "UTC" },
      utcAt(23),
    )).toBe(true);
  });

  test("overnight range: 22:00-06:00, at 02:00 → inside", () => {
    expect(isWithinActiveHours(
      { start: "22:00", end: "06:00", timezone: "UTC" },
      utcAt(2),
    )).toBe(true);
  });

  test("overnight range: 22:00-06:00, at 12:00 → outside", () => {
    expect(isWithinActiveHours(
      { start: "22:00", end: "06:00", timezone: "UTC" },
      utcAt(12),
    )).toBe(false);
  });

  test("zero-width range (start === end) → returns true", () => {
    expect(isWithinActiveHours(
      { start: "10:00", end: "10:00", timezone: "UTC" },
      utcAt(10),
    )).toBe(true);
  });

  test("24:00 end time works as end-of-day", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "24:00", timezone: "UTC" },
      utcAt(23, 59),
    )).toBe(true);
  });

  test("invalid start time → returns true (permissive)", () => {
    expect(isWithinActiveHours(
      { start: "invalid", end: "22:00", timezone: "UTC" },
      utcAt(12),
    )).toBe(true);
  });

  test("invalid end time → returns true (permissive)", () => {
    expect(isWithinActiveHours(
      { start: "08:00", end: "invalid", timezone: "UTC" },
      utcAt(12),
    )).toBe(true);
  });

  test("uses current time when nowMs not provided", () => {
    // Should not throw
    const result = isWithinActiveHours({ start: "00:00", end: "24:00" });
    expect(result).toBe(true);
  });
});
