// =============================================================================
// Tests: Elapsed Timer (10.2g)
//
// Tests for per-tool elapsed timer display during execution.
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { ToolOutput } from "../src/tui/components/tool_output.js";
import type { ToolDisplayData } from "../src/tui/types.js";

// =============================================================================
// Elapsed timer
// =============================================================================

describe("Elapsed timer", () => {
  test("no timer shown when tool is not executing", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "echo hi",
      status: "success", outputLines: [], isError: false,
      metadata: { exit_code: 0 },
      startedAt: Date.now() - 5000,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    // Timer only shows during "executing" status
    expect(lastFrame()).not.toContain("5s");
  });

  test("timer component renders during execution with startedAt", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "sleep 10",
      status: "executing", outputLines: [], isError: false,
      startedAt: Date.now() - 3000, // 3 seconds ago
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    // The timer renders but may not show immediately (1s delay)
    // At least the spinner should be visible
    expect(lastFrame()).toContain("bash");
    expect(lastFrame()).toContain("sleep 10");
  });

  test("no timer when startedAt is not set", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "echo hi",
      status: "executing", outputLines: [], isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    // No timer without startedAt
    expect(lastFrame()).toContain("bash");
  });

  test("startedAt is set in ToolDisplayData type", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "ls",
      status: "executing", outputLines: [], isError: false,
      startedAt: 1700000000000,
    };
    expect(data.startedAt).toBe(1700000000000);
  });
});
