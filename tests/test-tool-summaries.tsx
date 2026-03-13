// =============================================================================
// Tests: Tool-Specific Summaries (10.2b)
//
// Tests for formatToolSummary() which generates per-tool one-line summaries
// from tool metadata. Also tests integration with ToolOutput component.
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { formatToolSummary } from "../src/tui/components/tool_output.js";
import { ToolOutput } from "../src/tui/components/tool_output.js";
import type { ToolDisplayData, ToolOutputLine } from "../src/tui/types.js";

// =============================================================================
// Helper
// =============================================================================

function lines(...strs: string[]): ToolOutputLine[] {
  return strs.map((s) => ({ type: "stdout" as const, content: s }));
}

// =============================================================================
// formatToolSummary — bash
// =============================================================================

describe("formatToolSummary — bash", () => {
  test("exit 0 with output returns null (show output)", () => {
    const result = formatToolSummary("bash", { exit_code: 0 }, false, lines("hello"));
    expect(result).toBeNull();
  });

  test("exit 0 with no output returns '(no output)'", () => {
    const result = formatToolSummary("bash", { exit_code: 0 }, false, []);
    expect(result).toBe("(no output)");
  });

  test("exit 0 with only whitespace returns '(no output)'", () => {
    const result = formatToolSummary("bash", { exit_code: 0 }, false, lines("  ", ""));
    expect(result).toBe("(no output)");
  });

  test("non-zero exit code shows error", () => {
    const result = formatToolSummary("bash", { exit_code: 1 }, true, lines("error"));
    expect(result).toBe("Exit 1 (error)");
  });

  test("exit code 127 shows error", () => {
    const result = formatToolSummary("bash", { exit_code: 127 }, true, lines("not found"));
    expect(result).toBe("Exit 127 (error)");
  });

  test("no metadata returns null", () => {
    const result = formatToolSummary("bash", undefined, false, []);
    expect(result).toBeNull();
  });
});

// =============================================================================
// formatToolSummary — glob
// =============================================================================

describe("formatToolSummary — glob", () => {
  test("found files", () => {
    expect(formatToolSummary("glob", { count: 12, pattern: "*.ts" }, false, [])).toBe("Found 12 files");
  });

  test("found 1 file (singular)", () => {
    expect(formatToolSummary("glob", { count: 1, pattern: "*.ts" }, false, [])).toBe("Found 1 file");
  });

  test("no files found", () => {
    expect(formatToolSummary("glob", { count: 0, pattern: "*.xyz" }, false, [])).toBe("No files found");
  });

  test("no metadata returns null", () => {
    expect(formatToolSummary("glob", {}, false, [])).toBeNull();
  });
});

// =============================================================================
// formatToolSummary — grep
// =============================================================================

describe("formatToolSummary — grep", () => {
  test("found matches", () => {
    expect(formatToolSummary("grep", { count: 5, files_searched: 20 }, false, [])).toBe("Found 5 matches in 20 files");
  });

  test("found 1 match (singular)", () => {
    expect(formatToolSummary("grep", { count: 1, files_searched: 3 }, false, [])).toBe("Found 1 match in 3 files");
  });

  test("no matches", () => {
    expect(formatToolSummary("grep", { count: 0, files_searched: 50 }, false, [])).toBe("No matches found");
  });

  test("timed out", () => {
    const result = formatToolSummary("grep", { count: 3, files_searched: 100, timed_out: true }, false, []);
    expect(result).toContain("timed out");
    expect(result).toContain("3 matches");
  });

  test("without files_searched", () => {
    expect(formatToolSummary("grep", { count: 7 }, false, [])).toBe("Found 7 matches");
  });
});

// =============================================================================
// formatToolSummary — read_file
// =============================================================================

describe("formatToolSummary — read_file", () => {
  test("full file read", () => {
    expect(formatToolSummary("read_file", { total_lines: 150 }, false, [])).toBe("Read 150 lines");
  });

  test("partial read with range", () => {
    const result = formatToolSummary("read_file", { total_lines: 500, shown_from: 100, shown_to: 150 }, false, []);
    expect(result).toBe("Read 500 lines (lines 100-150)");
  });

  test("1 line (singular)", () => {
    expect(formatToolSummary("read_file", { total_lines: 1 }, false, [])).toBe("Read 1 line");
  });

  test("binary file", () => {
    expect(formatToolSummary("read_file", { binary: true }, false, [])).toBe("Binary file");
  });
});

// =============================================================================
// formatToolSummary — web_search
// =============================================================================

describe("formatToolSummary — web_search", () => {
  test("found results", () => {
    const result = formatToolSummary("web_search", { count: 10, query: "TypeScript generics" }, false, []);
    expect(result).toBe('10 results for "TypeScript generics"');
  });

  test("1 result (singular)", () => {
    const result = formatToolSummary("web_search", { count: 1, query: "test" }, false, []);
    expect(result).toBe('1 result for "test"');
  });

  test("no results", () => {
    const result = formatToolSummary("web_search", { count: 0, query: "asdfghjkl" }, false, []);
    expect(result).toContain("No results");
  });
});

// =============================================================================
// formatToolSummary — web_fetch
// =============================================================================

describe("formatToolSummary — web_fetch", () => {
  test("successful fetch", () => {
    const result = formatToolSummary("web_fetch", { url: "https://example.com/page", status: 200, length: 5000 }, false, []);
    expect(result).toContain("example.com");
    expect(result).toContain("5K chars");
    expect(result).toContain("HTTP 200");
  });

  test("small page", () => {
    const result = formatToolSummary("web_fetch", { url: "https://api.example.com/data", status: 200, length: 500 }, false, []);
    expect(result).toContain("500 chars");
  });

  test("no url returns null", () => {
    expect(formatToolSummary("web_fetch", { status: 200 }, false, [])).toBeNull();
  });
});

// =============================================================================
// formatToolSummary — edit_file
// =============================================================================

describe("formatToolSummary — edit_file", () => {
  test("added and removed lines", () => {
    const result = formatToolSummary("edit_file", { lines_added: 5, lines_removed: 2 }, false, []);
    expect(result).toBe("Added 5 lines, removed 2 lines");
  });

  test("only added", () => {
    const result = formatToolSummary("edit_file", { lines_added: 3, lines_removed: 0 }, false, []);
    expect(result).toBe("Added 3 lines");
  });

  test("1 line (singular)", () => {
    const result = formatToolSummary("edit_file", { lines_added: 1, lines_removed: 1 }, false, []);
    expect(result).toBe("Added 1 line, removed 1 line");
  });
});

// =============================================================================
// formatToolSummary — write_file
// =============================================================================

describe("formatToolSummary — write_file", () => {
  test("new file", () => {
    const result = formatToolSummary("write_file", { old_content: null, new_content: "a\nb\nc" }, false, []);
    expect(result).toBe("New file, 3 lines");
  });

  test("fallback to lines count", () => {
    const result = formatToolSummary("write_file", { lines: 42, old_content: "__omitted__", new_content: "__omitted__" }, false, []);
    expect(result).toBe("Wrote 42 lines");
  });
});

// =============================================================================
// formatToolSummary — unknown tool
// =============================================================================

describe("formatToolSummary — unknown tool", () => {
  test("returns null for unknown tool", () => {
    expect(formatToolSummary("custom_tool", { foo: "bar" }, false, [])).toBeNull();
  });

  test("returns null with no metadata", () => {
    expect(formatToolSummary("anything", undefined, false, [])).toBeNull();
  });
});

// =============================================================================
// Integration: ToolOutput component with summaries
// =============================================================================

describe("ToolOutput with summaries", () => {
  test("bash success with output shows output lines, no summary", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "ls",
      status: "success", outputLines: lines("file1.txt", "file2.txt"), isError: false,
      metadata: { exit_code: 0 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("file1.txt");
    expect(output).toContain("file2.txt");
    expect(output).not.toContain("(no output)");
  });

  test("bash success with no output shows '(no output)' summary", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "true",
      status: "success", outputLines: [], isError: false,
      metadata: { exit_code: 0 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("(no output)");
  });

  test("bash error shows exit code summary", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "false",
      status: "error", outputLines: lines("command failed"), isError: true,
      metadata: { exit_code: 1 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("Exit 1 (error)");
  });

  test("glob shows file count summary", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "glob", inputPreview: "**/*.ts",
      status: "success", outputLines: lines("a.ts", "b.ts", "c.ts"), isError: false,
      metadata: { count: 3, pattern: "**/*.ts" },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("Found 3 files");
  });

  test("grep shows match count summary", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "grep", inputPreview: '"TODO"',
      status: "success", outputLines: lines("file.ts:1:TODO fix"), isError: false,
      metadata: { count: 5, files_searched: 20 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("Found 5 matches");
  });

  test("read_file shows line count summary, no output lines", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "read_file", inputPreview: "src/index.ts",
      status: "success", outputLines: lines("line1", "line2"), isError: false,
      metadata: { total_lines: 100 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("Read 100 lines");
    // read_file is summary-only — output lines suppressed
    expect(lastFrame()).not.toContain("line1");
  });

  test("web_search shows result count summary and output lines", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "web_search", inputPreview: '"TypeScript"',
      status: "success", outputLines: lines("1. Result Title"), isError: false,
      metadata: { count: 10, query: "TypeScript" },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain('10 results for "TypeScript"');
    expect(lastFrame()).toContain("1. Result Title"); // Output preserved below summary
  });

  test("executing tool shows no summary (still running)", () => {
    const data: ToolDisplayData = {
      toolUseId: "t1", toolName: "bash", inputPreview: "sleep 5",
      status: "executing", outputLines: [], isError: false,
      metadata: { exit_code: 0 },
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).not.toContain("Exit");
    expect(lastFrame()).not.toContain("(no output)");
  });
});
