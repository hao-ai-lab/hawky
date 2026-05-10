// =============================================================================
// Unit tests for src/consumers/asr/failure-policy.ts.
//
// Covers retry-then-dead-letter only (the sole policy after the slim-down):
// dead-letter file shape, recovery on retry, and exponential backoff timing
// (initial_ms=1, jitter_ms=0 to keep tests fast and deterministic-ish).
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFailurePolicy, type FailureCtx } from "../../src/consumers/asr/failure-policy.js";

// -----------------------------------------------------------------------------
// Per-test tmp workspace for dead-letter dir.
// -----------------------------------------------------------------------------

let workDir: string;
let deadletterDir: string;
let prevDeadletterDir: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-failure-policy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  deadletterDir = join(workDir, "deadletter");
  mkdirSync(deadletterDir, { recursive: true });
  prevDeadletterDir = process.env.HAWKY_ASR_DEADLETTER_DIR;
  process.env.HAWKY_ASR_DEADLETTER_DIR = deadletterDir;
});

afterEach(() => {
  if (prevDeadletterDir === undefined) delete process.env.HAWKY_ASR_DEADLETTER_DIR;
  else process.env.HAWKY_ASR_DEADLETTER_DIR = prevDeadletterDir;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ctx(media_id = "c-test"): FailureCtx {
  return { media_id, wav_path: `/tmp/${media_id}.wav`, mime: "audio/wav", backend: "mock" };
}

function listDeadFiles(): string[] {
  if (!existsSync(deadletterDir)) return [];
  return readdirSync(deadletterDir).filter((n) => n.endsWith(".json"));
}

// -----------------------------------------------------------------------------
// retry-then-dead-letter
// -----------------------------------------------------------------------------

describe("failure-policy: retry-then-dead-letter", () => {
  test("op throws max_attempts times → writes dead-letter file with full shape", async () => {
    const policy = createFailurePolicy("retry-then-dead-letter", {
      max_attempts: 2,
      initial_ms: 1,
      multiplier: 1,
      jitter_ms: 0,
    });
    let calls = 0;
    const result = await policy.execute(async () => {
      calls++;
      throw new Error("permanent");
    }, ctx("c-dead"));
    expect(result).toBeNull();
    expect(calls).toBe(2);

    const files = listDeadFiles();
    expect(files.length).toBe(1);
    const entry = JSON.parse(readFileSync(join(deadletterDir, files[0]), "utf-8"));
    expect(entry.media_id).toBe("c-dead");
    expect(entry.wav_path).toBe("/tmp/c-dead.wav");
    expect(entry.mime).toBe("audio/wav");
    expect(entry.backend).toBe("mock");
    expect(entry.attempts).toBe(2);
    expect(entry.last_error).toBe("permanent");
    expect(typeof entry.ts_iso).toBe("string");
    // Validate ISO timestamp parseability.
    expect(Number.isNaN(Date.parse(entry.ts_iso))).toBe(false);
  });

  test("op succeeds on attempt 2 → returns value, no dead-letter file", async () => {
    const policy = createFailurePolicy("retry-then-dead-letter", {
      max_attempts: 3,
      initial_ms: 1,
      multiplier: 1,
      jitter_ms: 0,
    });
    let calls = 0;
    const result = await policy.execute(async () => {
      calls++;
      if (calls < 2) throw new Error("once");
      return "ok";
    }, ctx("c-recover"));
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(listDeadFiles().length).toBe(0);
  });

  test("op succeeds on first attempt → returns value, no dead-letter", async () => {
    const policy = createFailurePolicy("retry-then-dead-letter");
    const result = await policy.execute(async () => 42, ctx());
    expect(result).toBe(42);
    expect(listDeadFiles().length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Backoff timing: initial_ms * multiplier^(attempt-1)
// With jitter_ms=0, the delays between attempts should be exactly the base.
// -----------------------------------------------------------------------------

describe("failure-policy: backoff timing", () => {
  test("delays follow initial_ms * multiplier^(attempt-1) (jitter=0)", async () => {
    const policy = createFailurePolicy("retry-then-dead-letter", {
      max_attempts: 4,
      initial_ms: 30,
      multiplier: 2,
      jitter_ms: 0,
    });
    const timestamps: number[] = [];
    await policy.execute(async () => {
      timestamps.push(Date.now());
      throw new Error("x");
    }, ctx());
    // With max_attempts=4, 4 call timestamps, 3 gaps.
    expect(timestamps.length).toBe(4);
    const gaps = [
      timestamps[1] - timestamps[0],
      timestamps[2] - timestamps[1],
      timestamps[3] - timestamps[2],
    ];
    // Expected gaps: 30, 60, 120. Allow generous upper bound for CI jitter
    // but ensure each gap is at least its base minus a small skew.
    expect(gaps[0]).toBeGreaterThanOrEqual(25);
    expect(gaps[1]).toBeGreaterThanOrEqual(55);
    expect(gaps[2]).toBeGreaterThanOrEqual(115);
    // And each subsequent gap should be greater than the previous (exponential).
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
  });
});
