// =============================================================================
// Tests: Error Ring Buffer
//
// Unit tests for the in-memory error ring buffer and JSONL persistence.
// =============================================================================

import { test, describe, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pushError,
  getRecentErrors,
  getAllErrors,
  getErrorCount,
  resetErrorBuffer,
  setErrorLogDir,
  onLogEntry,
  type ErrorEntry,
} from "../src/logging/error-buffer.js";

const testDir = join(tmpdir(), `hawky-error-buf-${Date.now()}`);

beforeEach(() => {
  resetErrorBuffer();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// =============================================================================
// Ring buffer
// =============================================================================

describe("ring buffer", () => {
  test("starts empty", () => {
    expect(getErrorCount()).toBe(0);
    expect(getRecentErrors()).toHaveLength(0);
  });

  test("pushError adds entries", () => {
    pushError({ timestamp: 1000, subsystem: "test", level: "error", message: "fail" });
    expect(getErrorCount()).toBe(1);
  });

  test("getRecentErrors returns newest first", () => {
    pushError({ timestamp: 1000, subsystem: "a", level: "error", message: "first" });
    pushError({ timestamp: 2000, subsystem: "b", level: "error", message: "second" });
    pushError({ timestamp: 3000, subsystem: "c", level: "warn", message: "third" });

    const recent = getRecentErrors(3);
    expect(recent[0].message).toBe("third");
    expect(recent[1].message).toBe("second");
    expect(recent[2].message).toBe("first");
  });

  test("getRecentErrors respects limit", () => {
    for (let i = 0; i < 10; i++) {
      pushError({ timestamp: i, subsystem: "test", level: "error", message: `err-${i}` });
    }
    expect(getRecentErrors(3)).toHaveLength(3);
    expect(getRecentErrors(3)[0].message).toBe("err-9");
  });

  test("evicts oldest when buffer is full (50 max)", () => {
    for (let i = 0; i < 60; i++) {
      pushError({ timestamp: i, subsystem: "test", level: "error", message: `err-${i}` });
    }
    expect(getErrorCount()).toBe(50);
    // Oldest should be err-10 (first 10 evicted)
    const all = getAllErrors();
    expect(all[all.length - 1].message).toBe("err-10");
    expect(all[0].message).toBe("err-59");
  });

  test("resetErrorBuffer clears everything", () => {
    pushError({ timestamp: 1, subsystem: "test", level: "error", message: "x" });
    resetErrorBuffer();
    expect(getErrorCount()).toBe(0);
  });

  test("preserves details field", () => {
    pushError({ timestamp: 1, subsystem: "test", level: "error", message: "fail", details: "stack trace here" });
    expect(getRecentErrors(1)[0].details).toBe("stack trace here");
  });
});

// =============================================================================
// Logger hook
// =============================================================================

describe("onLogEntry hook", () => {
  test("captures error level entries", () => {
    onLogEntry("error", "gateway/cron", "Job failed", { error: "timeout" });
    expect(getErrorCount()).toBe(1);
    const entry = getRecentErrors(1)[0];
    expect(entry.subsystem).toBe("gateway/cron");
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("Job failed");
    expect(entry.details).toBe("timeout");
  });

  test("captures warn level entries", () => {
    onLogEntry("warn", "gateway/delivery", "Push delivery failed", { reason: "endpoint unreachable" });
    expect(getErrorCount()).toBe(1);
    expect(getRecentErrors(1)[0].level).toBe("warn");
    expect(getRecentErrors(1)[0].details).toBe("endpoint unreachable");
  });

  test("ignores info/debug/trace levels", () => {
    onLogEntry("info", "gateway", "started", {});
    onLogEntry("debug", "gateway", "processing", {});
    onLogEntry("trace", "agent", "token", {});
    expect(getErrorCount()).toBe(0);
  });

  test("truncates long details to 500 chars", () => {
    const longError = "x".repeat(1000);
    onLogEntry("error", "test", "fail", { error: longError });
    expect(getRecentErrors(1)[0].details!.length).toBe(500);
  });

  test("handles missing meta gracefully", () => {
    onLogEntry("error", "test", "fail");
    expect(getRecentErrors(1)[0].details).toBeUndefined();
  });
});

// =============================================================================
// JSONL persistence
// =============================================================================

describe("JSONL persistence", () => {
  test("writes errors to daily JSONL file", () => {
    const dir = join(testDir, `jsonl-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    setErrorLogDir(dir);

    pushError({ timestamp: Date.now(), subsystem: "test", level: "error", message: "test error", details: "details" });

    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const filePath = join(dir, `${date}.jsonl`);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.subsystem).toBe("test");
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("test error");
    expect(entry.details).toBe("details");
  });

  test("appends multiple entries to same file", () => {
    const dir = join(testDir, `jsonl-multi-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    setErrorLogDir(dir);

    pushError({ timestamp: Date.now(), subsystem: "a", level: "error", message: "err1" });
    pushError({ timestamp: Date.now(), subsystem: "b", level: "warn", message: "warn1" });

    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const filePath = join(dir, `${date}.jsonl`);

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
