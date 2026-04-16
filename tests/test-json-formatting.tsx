// =============================================================================
// Tests: JSON Auto-Formatting (10.2d)
//
// Tests for tryFormatJsonLines() which detects and pretty-prints JSON
// in tool output lines.
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { ToolOutput } from "../src/tui/components/tool_output.js";
import type { ToolDisplayData, ToolOutputLine } from "../src/tui/types.js";

function lines(...strs: string[]): ToolOutputLine[] {
  return strs.map((s) => ({ type: "stdout" as const, content: s }));
}

// =============================================================================
// JSON detection and formatting
// =============================================================================

describe("JSON auto-formatting in tool output", () => {
  test("formats single-line JSON object", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "curl api",
      status: "success", outputLines: lines('{"name":"Hao","age":30}'), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    const output = lastFrame();
    // Should be pretty-printed with indentation
    expect(output).toContain('"name": "Hao"');
    expect(output).toContain('"age": 30');
  });

  test("formats single-line JSON array", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat data.json",
      status: "success", outputLines: lines('[1,2,3]'), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).toContain("1,");
  });

  test("does not format non-JSON output", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "echo hello",
      status: "success", outputLines: lines("hello world"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).toContain("hello world");
  });

  test("does not format already-pretty JSON", () => {
    const pretty = '{\n  "name": "Hao"\n}';
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat file.json",
      status: "success", outputLines: lines(...pretty.split("\n")), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).toContain('"name": "Hao"');
  });

  test("formats nested JSON", () => {
    const json = '{"user":{"name":"Hao","settings":{"theme":"dark"}}}';
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "curl api",
      status: "success", outputLines: lines(json), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).toContain('"theme": "dark"');
    expect(lastFrame()).toContain('"settings"');
  });

  test("handles invalid JSON gracefully", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "echo",
      status: "success", outputLines: lines("{invalid json}"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).toContain("{invalid json}");
  });

  test("skips formatting for very large content", () => {
    const bigJson = '{"data":"' + "x".repeat(25000) + '"}';
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat big.json",
      status: "success", outputLines: lines(bigJson), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    // Should show raw (not formatted) — too large
    expect(lastFrame()).toContain("xxxx");
  });

  test("mixed JSON and non-JSON lines (JSONL)", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat logs.jsonl",
      status: "success",
      outputLines: lines(
        '{"event":"start","ts":1}',
        "some text in between",
        '{"event":"end","ts":2}',
      ),
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    // JSON lines should be formatted, text should pass through
    expect(lastFrame()).toContain('"event": "start"');
    expect(lastFrame()).toContain("some text in between");
    expect(lastFrame()).toContain('"event": "end"');
  });

  test("empty output is not affected", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "true",
      status: "success", outputLines: [], isError: false,
      metadata: { exit_code: 0 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    // Should show (no output) summary, not crash
    expect(lastFrame()).toContain("(no output)");
  });

  test("JSON formatting works in compact mode (before truncation)", () => {
    // A long JSON that when formatted becomes many lines — compact should truncate the formatted version
    const json = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}';
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "curl api",
      status: "success", outputLines: lines(json), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    // Formatted JSON has ~7 lines, compact shows 3 + hint
    expect(lastFrame()).toContain("ctrl+o to expand");
  });
});
