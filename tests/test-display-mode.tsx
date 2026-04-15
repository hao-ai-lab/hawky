// =============================================================================
// Tests: Display Mode Toggle (10.2c)
//
// Tests for verbose/compact mode in tool output rendering.
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { ToolOutput } from "../src/tui/components/tool_output.js";
import { MessageList } from "../src/tui/components/message_list.js";
import type { ToolDisplayData, ToolOutputLine, DisplayMessage } from "../src/tui/types.js";

function lines(...strs: string[]): ToolOutputLine[] {
  return strs.map((s) => ({ type: "stdout" as const, content: s }));
}

// =============================================================================
// ToolOutput — compact mode (default)
// =============================================================================

describe("ToolOutput compact mode (verbose=false)", () => {
  test("shows max 3 lines of output", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat file",
      status: "success", outputLines: lines("a", "b", "c", "d", "e"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("a");
    expect(output).toContain("b");
    expect(output).toContain("c");
    expect(output).not.toContain("⎿ d");
    expect(output).not.toContain("⎿ e");
  });

  test("shows truncation hint with ctrl+o", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat file",
      status: "success", outputLines: lines("a", "b", "c", "d", "e"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("+2 lines");
    expect(lastFrame()).toContain("ctrl+o to expand");
  });

  test("no hint when output fits in 3 lines", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "echo hi",
      status: "success", outputLines: lines("hi"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).not.toContain("ctrl+o");
    expect(lastFrame()).toContain("hi");
  });

  test("shows exactly 3 lines without hint", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "seq 3",
      status: "success", outputLines: lines("1", "2", "3"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("1");
    expect(lastFrame()).toContain("2");
    expect(lastFrame()).toContain("3");
    expect(lastFrame()).not.toContain("ctrl+o");
  });
});

// =============================================================================
// ToolOutput — expanded mode (verbose=true)
// =============================================================================

describe("ToolOutput expanded mode (verbose=true)", () => {
  test("shows all output lines", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat file",
      status: "success", outputLines: lines("a", "b", "c", "d", "e"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    const output = lastFrame();
    expect(output).toContain("a");
    expect(output).toContain("b");
    expect(output).toContain("c");
    expect(output).toContain("d");
    expect(output).toContain("e");
  });

  test("shows compact hint instead of expand hint in expanded mode", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "cat file",
      status: "success", outputLines: lines("a", "b", "c", "d", "e"), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).not.toContain("to expand");
    expect(lastFrame()).toContain("ctrl+o to compact");
  });

  test("shows many lines without truncation", () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "seq 50",
      status: "success", outputLines: lines(...manyLines), isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} verbose={true} />);
    expect(lastFrame()).toContain("line 1");
    expect(lastFrame()).toContain("line 50");
  });
});

// =============================================================================
// MessageList — verbose prop threading
// =============================================================================

describe("MessageList verbose prop threading", () => {
  test("passes verbose=false by default (compact)", () => {
    const messages: DisplayMessage[] = [{
      id: "1", role: "tool", text: "", timestamp: "t",
      toolData: {
        toolUseId: "t1", toolName: "bash", inputPreview: "seq 10",
        status: "success",
        outputLines: lines("1", "2", "3", "4", "5", "6", "7", "8", "9", "10"),
        isError: false,
      },
    }];
    const { lastFrame } = inkRender(
      <MessageList messages={messages} model="test" />,
    );
    // Compact: should truncate
    expect(lastFrame()).toContain("ctrl+o to expand");
  });

  test("passes verbose=true when set (expanded)", () => {
    const messages: DisplayMessage[] = [{
      id: "1", role: "tool", text: "", timestamp: "t",
      toolData: {
        toolUseId: "t1", toolName: "bash", inputPreview: "seq 10",
        status: "success",
        outputLines: lines("1", "2", "3", "4", "5", "6", "7", "8", "9", "10"),
        isError: false,
      },
    }];
    const { lastFrame } = inkRender(
      <MessageList messages={messages} model="test" verbose={true} />,
    );
    // Expanded: should show all lines, compact hint instead of expand hint
    expect(lastFrame()).not.toContain("to expand");
    expect(lastFrame()).toContain("to compact");
    expect(lastFrame()).toContain("10");
  });
});
