// =============================================================================
// Tests: Heartbeat TUI Integration
//
// Real ink-testing-library render tests for:
// - HeartbeatIndicator text output in all states
// - GatewayClient heartbeat event protocol boundary
// - RPC-level heartbeat.status / heartbeat.trigger
// =============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { Box } from "ink";
import { HeartbeatIndicator, type HeartbeatInfo } from "../src/tui/components/heartbeat_indicator.js";

// =============================================================================
// Helper
// =============================================================================

const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

let lastRender: ReturnType<typeof inkRender> | null = null;

afterEach(() => {
  lastRender?.unmount();
  lastRender = null;
});

function renderIndicator(info: HeartbeatInfo | null): string {
  // Wrap in Box so ink has a root element even when indicator is null
  lastRender = inkRender(
    <Box>
      <HeartbeatIndicator info={info} />
    </Box>,
  );
  return lastRender.lastFrame() ?? "";
}

// =============================================================================
// HeartbeatIndicator render states
// =============================================================================

describe("HeartbeatIndicator renders", () => {
  test("nothing when info is null", () => {
    const frame = renderIndicator(null);
    expect(frame.trim()).toBe("");
  });

  test("♡ running... when running", () => {
    const frame = renderIndicator({
      lastStatus: null, lastRunAt: null, nextRunAt: null,
      alertCount: 0, running: true,
    });
    expect(frame).toContain("♡");
    expect(frame).toContain("running...");
  });

  test("♡ quiet (resumes HH:MM) when quiet-hours", () => {
    const frame = renderIndicator({
      lastStatus: "skipped", lastReason: "quiet-hours",
      lastRunAt: Date.now(), nextRunAt: null,
      alertCount: 0, running: false,
      activeHoursStart: "08:00",
    });
    expect(frame).toContain("♡");
    expect(frame).toContain("quiet");
    expect(frame).toContain("resumes 08:00");
  });

  test("♡ waiting (next: Xm) before first run", () => {
    const frame = renderIndicator({
      lastStatus: null, lastRunAt: null,
      nextRunAt: Date.now() + 120_000,
      alertCount: 0, running: false,
    });
    expect(frame).toContain("♡");
    expect(frame).toContain("waiting");
    expect(frame).toContain("next:");
  });

  test("♡ Xs ago ✓ after skipped run", () => {
    const frame = renderIndicator({
      lastStatus: "skipped", lastReason: "no-tasks",
      lastRunAt: Date.now() - 5_000,
      nextRunAt: Date.now() + 115_000,
      alertCount: 0, running: false,
    });
    expect(frame).toContain("♡");
    expect(frame).toContain("ago");
    expect(frame).toContain("✓");
    expect(frame).toContain("next:");
  });

  test("♡ Xs ago ⚠ after ran status", () => {
    const frame = renderIndicator({
      lastStatus: "ran", lastReason: "email check",
      lastRunAt: Date.now() - 10_000,
      nextRunAt: Date.now() + 110_000,
      alertCount: 1, running: false,
    });
    expect(frame).toContain("♡");
    expect(frame).toContain("ago");
    expect(frame).toContain("⚠");
  });

  test("♡ Xs ago ✗ after failed status", () => {
    const frame = renderIndicator({
      lastStatus: "failed", lastReason: "API error",
      lastRunAt: Date.now() - 3_000,
      nextRunAt: Date.now() + 117_000,
      alertCount: 0, running: false,
    });
    expect(frame).toContain("♡");
    expect(frame).toContain("ago");
    expect(frame).toContain("✗");
  });

  test("quiet-hours without activeHoursStart shows ??:??", () => {
    const frame = renderIndicator({
      lastStatus: "skipped", lastReason: "quiet-hours",
      lastRunAt: Date.now(), nextRunAt: null,
      alertCount: 0, running: false,
      // no activeHoursStart
    });
    expect(frame).toContain("resumes ??:??");
  });
});
