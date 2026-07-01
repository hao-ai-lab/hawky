// =============================================================================
// Tests for LoopGuard (iteration limits + tool loop detection)
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  LoopGuard,
  _hashInput,
  WARN_THRESHOLD,
  BLOCK_THRESHOLD,
  HISTORY_WINDOW,
} from "../src/agent/loop_guard.js";

// =============================================================================
// Iteration limits
// =============================================================================

describe("Iteration limits", () => {
  test("nextIteration increments from 0", () => {
    const guard = new LoopGuard(10);
    expect(guard.currentIteration).toBe(0);
    expect(guard.nextIteration()).toBe(1);
    expect(guard.currentIteration).toBe(1);
  });

  test("isOverLimit returns false when under limit", () => {
    const guard = new LoopGuard(5);
    guard.nextIteration(); // 1
    guard.nextIteration(); // 2
    expect(guard.isOverLimit()).toBe(false);
  });

  test("isOverLimit returns true at limit", () => {
    const guard = new LoopGuard(3);
    guard.nextIteration(); // 1
    guard.nextIteration(); // 2
    guard.nextIteration(); // 3
    expect(guard.isOverLimit()).toBe(true);
  });

  test("isOverLimit returns true past limit", () => {
    const guard = new LoopGuard(2);
    guard.nextIteration(); // 1
    guard.nextIteration(); // 2
    guard.nextIteration(); // 3
    expect(guard.isOverLimit()).toBe(true);
  });

  test("isApproachingLimit warns 5 before limit", () => {
    const guard = new LoopGuard(40);
    for (let i = 0; i < 34; i++) guard.nextIteration();
    expect(guard.isApproachingLimit()).toBe(false);
    guard.nextIteration(); // 35
    expect(guard.isApproachingLimit()).toBe(true);
  });

  test("isApproachingLimit with small limit", () => {
    const guard = new LoopGuard(3);
    // max_iterations - 5 = -2, so always approaching
    expect(guard.isApproachingLimit()).toBe(true);
  });

  test("maxIterations property is accessible", () => {
    const guard = new LoopGuard(42);
    expect(guard.maxIterations).toBe(42);
  });

  test("reset clears iteration count", () => {
    const guard = new LoopGuard(10);
    guard.nextIteration();
    guard.nextIteration();
    guard.reset();
    expect(guard.currentIteration).toBe(0);
    expect(guard.isOverLimit()).toBe(false);
  });
});

// =============================================================================
// Tool loop detection
// =============================================================================

describe("Tool loop detection", () => {
  test("first call is always ok", () => {
    const guard = new LoopGuard(100);
    const result = guard.recordToolCall("bash", { command: "ls" });
    expect(result.ok).toBe(true);
  });

  test("different tools dont trigger loop", () => {
    const guard = new LoopGuard(100);
    for (let i = 0; i < 15; i++) {
      const result = guard.recordToolCall(`tool_${i}`, { x: i });
      expect(result.ok).toBe(true);
    }
  });

  test("different inputs for same tool dont trigger loop", () => {
    const guard = new LoopGuard(100);
    for (let i = 0; i < 15; i++) {
      const result = guard.recordToolCall("bash", { command: `cmd_${i}` });
      expect(result.ok).toBe(true);
    }
  });

  test("different nested inputs for same tool dont trigger loop", () => {
    const guard = new LoopGuard(100);
    for (let i = 0; i < BLOCK_THRESHOLD + 1; i++) {
      const result = guard.recordToolCall("nodes", {
        params: { command: ["run", String(i)] },
      });
      expect(result.ok).toBe(true);
    }
  });

  test("warns at WARN_THRESHOLD identical calls", () => {
    const guard = new LoopGuard(100);
    let lastResult: any;
    for (let i = 0; i < WARN_THRESHOLD; i++) {
      lastResult = guard.recordToolCall("bash", { command: "ls" });
    }
    expect(lastResult.ok).toBe(false);
    expect(lastResult.warn).toBe(true);
    expect(lastResult.count).toBe(WARN_THRESHOLD);
    expect(lastResult.reason).toContain("possible loop");
  });

  test("blocks at BLOCK_THRESHOLD identical calls", () => {
    const guard = new LoopGuard(100);
    let lastResult: any;
    for (let i = 0; i < BLOCK_THRESHOLD; i++) {
      lastResult = guard.recordToolCall("bash", { command: "ls" });
    }
    expect(lastResult.ok).toBe(false);
    expect(lastResult.warn).toBe(false);
    expect(lastResult.count).toBe(BLOCK_THRESHOLD);
    expect(lastResult.reason).toContain("blocked");
  });

  test("history window limits tracked calls", () => {
    const guard = new LoopGuard(100);
    // Fill with HISTORY_WINDOW different calls
    for (let i = 0; i < HISTORY_WINDOW; i++) {
      guard.recordToolCall("bash", { command: `cmd_${i}` });
    }
    // Now add identical calls — old ones are pushed out
    for (let i = 0; i < WARN_THRESHOLD - 1; i++) {
      const result = guard.recordToolCall("bash", { command: "repeated" });
      expect(result.ok).toBe(true);
    }
    // One more should warn
    const result = guard.recordToolCall("bash", { command: "repeated" });
    expect(result.ok).toBe(false);
    expect(result.warn).toBe(true);
  });

  test("reset clears tool history", () => {
    const guard = new LoopGuard(100);
    for (let i = 0; i < WARN_THRESHOLD; i++) {
      guard.recordToolCall("bash", { command: "ls" });
    }
    guard.reset();
    const result = guard.recordToolCall("bash", { command: "ls" });
    expect(result.ok).toBe(true);
  });

  test("reason includes tool name", () => {
    const guard = new LoopGuard(100);
    for (let i = 0; i < WARN_THRESHOLD; i++) {
      guard.recordToolCall("glob", { pattern: "*.ts" });
    }
    const result = guard.recordToolCall("glob", { pattern: "*.ts" });
    expect((result as any).reason).toContain("glob");
  });
});

// =============================================================================
// hashInput
// =============================================================================

describe("hashInput", () => {
  test("same input produces same hash", () => {
    const a = _hashInput({ command: "ls", timeout: 5000 });
    const b = _hashInput({ command: "ls", timeout: 5000 });
    expect(a).toBe(b);
  });

  test("different input produces different hash", () => {
    const a = _hashInput({ command: "ls" });
    const b = _hashInput({ command: "pwd" });
    expect(a).not.toBe(b);
  });

  test("key order doesn't matter", () => {
    const a = _hashInput({ a: 1, b: 2 });
    const b = _hashInput({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test("nested key order doesn't matter", () => {
    const a = _hashInput({
      params: { cwd: "/tmp/a", command: ["bun", "test"] },
      target: "node-a",
    });
    const b = _hashInput({
      target: "node-a",
      params: { command: ["bun", "test"], cwd: "/tmp/a" },
    });
    expect(a).toBe(b);
  });

  test("nested input values affect hash", () => {
    const a = _hashInput({ params: { command: ["run", "one"] } });
    const b = _hashInput({ params: { command: ["run", "two"] } });
    expect(a).not.toBe(b);
  });

  test("empty input has consistent hash", () => {
    const a = _hashInput({});
    const b = _hashInput({});
    expect(a).toBe(b);
  });
});

// =============================================================================
// Constants
// =============================================================================

describe("Constants", () => {
  test("thresholds are reasonable", () => {
    expect(WARN_THRESHOLD).toBe(5);
    expect(BLOCK_THRESHOLD).toBe(10);
    expect(HISTORY_WINDOW).toBe(20);
    expect(WARN_THRESHOLD).toBeLessThan(BLOCK_THRESHOLD);
    expect(BLOCK_THRESHOLD).toBeLessThanOrEqual(HISTORY_WINDOW);
  });
});
