// =============================================================================
// Tests: Cron Schedule Computation
// =============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import {
  computeNextRunAtMs,
  parseRelativeTime,
  validateCronExpr,
  getNextRunTimes,
  resetCronCache,
} from "../src/gateway/cron-schedule.js";

afterEach(() => resetCronCache());

// -----------------------------------------------------------------------------
// parseRelativeTime
// -----------------------------------------------------------------------------

describe("parseRelativeTime", () => {
  const now = 1000000;

  test("+30m", () => {
    expect(parseRelativeTime("+30m", now)).toBe(now + 30 * 60_000);
  });

  test("+2h", () => {
    expect(parseRelativeTime("+2h", now)).toBe(now + 2 * 3_600_000);
  });

  test("+1d", () => {
    expect(parseRelativeTime("+1d", now)).toBe(now + 86_400_000);
  });

  test("+5s", () => {
    expect(parseRelativeTime("+5s", now)).toBe(now + 5_000);
  });

  test("+10min", () => {
    expect(parseRelativeTime("+10min", now)).toBe(now + 10 * 60_000);
  });

  test("invalid returns null", () => {
    expect(parseRelativeTime("not-a-time", now)).toBe(null);
    expect(parseRelativeTime("+", now)).toBe(null);
    expect(parseRelativeTime("30m", now)).toBe(null); // missing +
  });
});

// -----------------------------------------------------------------------------
// computeNextRunAtMs — "at" schedule
// -----------------------------------------------------------------------------

describe("computeNextRunAtMs: at schedule", () => {
  const now = Date.now();

  test("absolute timestamp in future", () => {
    const future = now + 60_000;
    expect(computeNextRunAtMs({ kind: "at", atMs: future }, now)).toBe(future);
  });

  test("absolute timestamp in past returns undefined", () => {
    const past = now - 60_000;
    expect(computeNextRunAtMs({ kind: "at", atMs: past }, now)).toBeUndefined();
  });

  test("relative time string", () => {
    const result = computeNextRunAtMs({ kind: "at", at: "+1h" }, now);
    expect(result).toBe(now + 3_600_000);
  });

  test("ISO datetime string in future", () => {
    const future = new Date(now + 86_400_000).toISOString();
    const result = computeNextRunAtMs({ kind: "at", at: future }, now);
    expect(result).toBeGreaterThan(now);
  });
});

// -----------------------------------------------------------------------------
// computeNextRunAtMs — "every" schedule
// -----------------------------------------------------------------------------

describe("computeNextRunAtMs: every schedule", () => {
  test("returns now + interval", () => {
    const now = 1000000;
    expect(computeNextRunAtMs({ kind: "every", everyMs: 60_000 }, now)).toBe(now + 60_000);
  });

  test("minimum interval is 1s", () => {
    const now = 1000000;
    expect(computeNextRunAtMs({ kind: "every", everyMs: 100 }, now)).toBe(now + 1000);
  });
});

// -----------------------------------------------------------------------------
// computeNextRunAtMs — "cron" schedule
// -----------------------------------------------------------------------------

describe("computeNextRunAtMs: cron schedule", () => {
  test("basic cron expression returns future time", () => {
    const now = Date.now();
    const result = computeNextRunAtMs(
      { kind: "cron", expr: "* * * * *" }, // Every minute
      now,
    );
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(now);
    expect(result! - now).toBeLessThan(62_000); // Within ~1 minute
  });

  test("cron with timezone", () => {
    const now = Date.now();
    const result = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * 1-5", tz: "America/New_York" },
      now,
    );
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(now);
  });

  test("invalid cron expression returns undefined", () => {
    expect(computeNextRunAtMs(
      { kind: "cron", expr: "invalid cron" },
      Date.now(),
    )).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// validateCronExpr
// -----------------------------------------------------------------------------

describe("validateCronExpr", () => {
  test("valid expression returns null", () => {
    expect(validateCronExpr("0 9 * * 1-5")).toBe(null);
    expect(validateCronExpr("*/5 * * * *")).toBe(null);
    expect(validateCronExpr("0 0 1 * *")).toBe(null);
  });

  test("invalid expression returns error message", () => {
    const err = validateCronExpr("invalid");
    expect(err).toBeTruthy();
    expect(typeof err).toBe("string");
  });
});

// -----------------------------------------------------------------------------
// getNextRunTimes
// -----------------------------------------------------------------------------

describe("getNextRunTimes", () => {
  test("returns multiple future times for cron", () => {
    const times = getNextRunTimes(
      { kind: "cron", expr: "* * * * *" },
      5,
    );
    expect(times.length).toBe(5);
    // Each should be ~1 minute apart
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  test("returns 1 time for one-shot", () => {
    const now = Date.now();
    const times = getNextRunTimes(
      { kind: "at", atMs: now + 60_000 },
      5,
      now,
    );
    expect(times.length).toBe(1);
    expect(times[0]).toBe(now + 60_000);
  });

  test("returns multiple times for interval", () => {
    const now = Date.now();
    const times = getNextRunTimes(
      { kind: "every", everyMs: 60_000 },
      3,
      now,
    );
    expect(times.length).toBe(3);
  });
});
