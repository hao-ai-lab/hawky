// =============================================================================
// Test: when-resolver (M2) — inferTrigger time resolution.
// Run: bun test tests/test-when-resolver.ts
// =============================================================================

import { describe, expect, test } from "bun:test";
import { inferTrigger } from "../src/ambient/when-resolver.js";

type WhenTerm = { kind: "when"; at?: string; relative?: string };
function firstWhen(body: string, now: number, tz = "UTC"): WhenTerm {
  const t = inferTrigger(body, now, tz);
  expect(t).not.toBeNull();
  return t!.all![0] as WhenTerm;
}

describe("inferTrigger — relative offsets", () => {
  const NOW = new Date("2026-06-05T10:00:00Z").getTime();

  test("'in 10 minutes' → relative preserved + at ≈ now + 10m", () => {
    const t = firstWhen("Remind me in 10 minutes to drink water", NOW);
    expect(t.kind).toBe("when");
    expect(t.relative).toBe("in 10 minutes");
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 10 * 60_000))).toBeLessThanOrEqual(1000);
  });

  test("'in 2 hours' → relative in hours", () => {
    const t = firstWhen("Remind me in 2 hours to call the dentist", NOW);
    expect(t.relative).toBe("in 2 hours");
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 2 * 3_600_000))).toBeLessThanOrEqual(1000);
  });

  test("'in 5 seconds' → at ≈ now + 5s (#591)", () => {
    const t = firstWhen("Remind me in 5 seconds to drink water", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 5_000))).toBeLessThanOrEqual(1000);
  });

  test("'in 30 seconds' → at ≈ now + 30s", () => {
    const t = firstWhen("Remind me in 30 seconds", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 30_000))).toBeLessThanOrEqual(1000);
  });

  test("word-number 'in a minute' → +1m (#591)", () => {
    const t = firstWhen("Remind me in a minute", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 60_000))).toBeLessThanOrEqual(1000);
  });

  test("word-number 'in one hour' → +1h", () => {
    const t = firstWhen("Remind me in one hour", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 3_600_000))).toBeLessThanOrEqual(1000);
  });
});

describe("inferTrigger — Chinese relative offsets (#591)", () => {
  const NOW = new Date("2026-06-05T10:00:00Z").getTime();

  test("'30秒后' → +30s", () => {
    const t = firstWhen("30秒后提醒我喝水", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 30_000))).toBeLessThanOrEqual(1000);
  });

  test("'5分钟后' → +5m", () => {
    const t = firstWhen("5分钟后提醒我去跑步", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 5 * 60_000))).toBeLessThanOrEqual(1000);
  });

  test("'2小时后' → +2h", () => {
    const t = firstWhen("2小时后提醒我", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 2 * 3_600_000))).toBeLessThanOrEqual(1000);
  });

  test("'半小时后' → +30m", () => {
    const t = firstWhen("半小时后提醒我", NOW);
    expect(Math.abs(new Date(t.at!).getTime() - (NOW + 30 * 60_000))).toBeLessThanOrEqual(1000);
  });
});

describe("inferTrigger — wall-clock variants (broadened AT_TIME_RE)", () => {
  const NOW = new Date("2026-06-05T10:00:00Z").getTime(); // 10am UTC

  for (const phrase of ["at 5", "at 5pm", "at 5:30", "at 5 pm", "at 5:30 pm"]) {
    test(`'${phrase}' → absolute future ISO`, () => {
      const t = firstWhen(`Remind me ${phrase} to do the thing`, NOW);
      expect(t.at).toBeDefined();
      expect(t.at).toContain("T"); // ISO, not raw clock text
      expect(new Date(t.at!).getTime()).toBeGreaterThan(NOW);
    });
  }

  test("'at 5pm' already past (now 6pm) → next occurrence (tomorrow)", () => {
    const NOW_6PM = new Date("2026-06-05T18:00:00Z").getTime();
    const t = firstWhen("Remind me at 5pm to review notes", NOW_6PM);
    expect(new Date(t.at!).getTime()).toBeGreaterThan(NOW_6PM);
  });
});

describe("inferTrigger — day-qualified times", () => {
  // Reference: 2026-06-05 10:00 UTC — a Friday.
  const NOW = new Date("2026-06-05T10:00:00Z").getTime();

  test("'7am tomorrow' → 2026-06-06 07:00 UTC", () => {
    expect(firstWhen("Set an alarm for 7am tomorrow to take meds", NOW).at).toBe("2026-06-06T07:00:00.000Z");
  });

  test("'tomorrow at 7:30 pm' → 2026-06-06 19:30 UTC", () => {
    expect(firstWhen("Remind me tomorrow at 7:30 pm to call mom", NOW).at).toBe("2026-06-06T19:30:00.000Z");
  });

  test("'today at 11pm' (future) → 2026-06-05 23:00 UTC", () => {
    expect(firstWhen("Remind me today at 11pm to take a pill", NOW).at).toBe("2026-06-05T23:00:00.000Z");
  });

  test("'today at 11pm' already past → rolls to tomorrow 23:00", () => {
    const nowPast = new Date("2026-06-05T23:30:00Z").getTime();
    expect(firstWhen("Remind me today at 11pm to lock the door", nowPast).at).toBe("2026-06-06T23:00:00.000Z");
  });

  test("'next Monday at 9am' → 2026-06-08 09:00 UTC", () => {
    expect(firstWhen("Schedule next Monday at 9am to review the report", NOW).at).toBe("2026-06-08T09:00:00.000Z");
  });

  test("'on Friday at 6pm' (today is Friday) → next Friday 2026-06-12 18:00 UTC", () => {
    expect(firstWhen("on Friday at 6pm pick up the package", NOW).at).toBe("2026-06-12T18:00:00.000Z");
  });
});

describe("inferTrigger — DST correctness (America/Los_Angeles)", () => {
  function laHour(epochMs: number): number {
    return parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date(epochMs)),
      10,
    );
  }

  test("'at 5pm' on spring-forward day (2026-03-08) → wall-clock 17:00 LA preserved", () => {
    const nowMs = new Date("2026-03-08T09:00:00Z").getTime(); // 01:00 LA PST
    const t = firstWhen("Remind me at 5pm to review my notes", nowMs, "America/Los_Angeles");
    expect(laHour(new Date(t.at!).getTime())).toBe(17);
  });

  test("'7am tomorrow' across spring-forward → wall-clock 07:00 LA preserved", () => {
    const nowMs = new Date("2026-03-07T20:00:00Z").getTime();
    const t = firstWhen("Set an alarm for 7am tomorrow", nowMs, "America/Los_Angeles");
    expect(laHour(new Date(t.at!).getTime())).toBe(7);
  });

  test("'at 5pm' on a normal non-DST day → wall-clock 17:00 LA", () => {
    const nowMs = new Date("2026-06-05T10:00:00Z").getTime();
    const t = firstWhen("Remind me at 5pm to go for a walk", nowMs, "America/Los_Angeles");
    expect(laHour(new Date(t.at!).getTime())).toBe(17);
  });
});

describe("inferTrigger — no time expression → null", () => {
  const NOW = new Date("2026-06-05T10:00:00Z").getTime();
  test("'buy groceries' (no time) → null", () => {
    expect(inferTrigger("Remind me to buy groceries", NOW, "UTC")).toBeNull();
  });
  test("'read the book' (no time) → null", () => {
    expect(inferTrigger("Remind me to read the book", NOW, "UTC")).toBeNull();
  });
});
