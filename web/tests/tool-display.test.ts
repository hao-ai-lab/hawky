// =============================================================================
// Tool display helper tests — formatToolHeadline and formatStepHeadline.
// These are pure functions and deterministic, so the tests stay tiny.
// =============================================================================

import { describe, test, expect } from "vitest";
import { formatToolHeadline, formatStepHeadline } from "../src/utils/toolDisplay";

describe("formatToolHeadline", () => {
  test("bash with command", () => {
    expect(formatToolHeadline({ name: "bash", inputPreview: "npm test" }))
      .toBe("Run bash: npm test");
  });

  test("bash with empty input", () => {
    expect(formatToolHeadline({ name: "bash", inputPreview: "" })).toBe("Run bash");
  });

  test("read_file with path shows basename", () => {
    expect(formatToolHeadline({ name: "read_file", inputPreview: "src/components/Foo.tsx" }))
      .toBe("Read Foo.tsx");
  });

  test("edit_file with path shows basename", () => {
    expect(formatToolHeadline({ name: "edit_file", inputPreview: "web/src/app.tsx" }))
      .toBe("Edit app.tsx");
  });

  test("write_file with path shows basename", () => {
    expect(formatToolHeadline({ name: "write_file", inputPreview: "/tmp/scratch.txt" }))
      .toBe("Write scratch.txt");
  });

  test("grep pulls pattern from metadata when available", () => {
    expect(formatToolHeadline({
      name: "grep",
      inputPreview: "TODO in src/",
      metadata: { pattern: "TODO" },
    })).toBe('Search "TODO"');
  });

  test("grep falls back to inputPreview when metadata has no pattern", () => {
    expect(formatToolHeadline({ name: "grep", inputPreview: "SomeSymbol" }))
      .toBe('Search "SomeSymbol"');
  });

  test("web_search uses query from metadata", () => {
    expect(formatToolHeadline({
      name: "web_search",
      inputPreview: "claude 4 release",
      metadata: { query: "claude 4 release" },
    })).toBe('Web search "claude 4 release"');
  });

  test("web_fetch shortens URL to hostname", () => {
    expect(formatToolHeadline({
      name: "web_fetch",
      inputPreview: "https://www.anthropic.com/news/x",
      metadata: { url: "https://www.anthropic.com/news/x" },
    })).toBe("Fetch www.anthropic.com");
  });

  test("unknown tool falls back to 'Run <name>'", () => {
    expect(formatToolHeadline({ name: "custom_tool", inputPreview: "x" }))
      .toBe("Run custom_tool: x");
    expect(formatToolHeadline({ name: "custom_tool", inputPreview: "" }))
      .toBe("Run custom_tool");
  });

  test("very long input is clipped with ellipsis", () => {
    const longInput = "a".repeat(200);
    const result = formatToolHeadline({ name: "bash", inputPreview: longInput });
    expect(result.length).toBeLessThan(longInput.length);
    expect(result).toContain("…");
  });

  test("file tools keep basename intact for deeply nested paths", () => {
    // A naive "clip first, then basename" would return an intermediate
    // directory component for deep paths. Make sure the basename survives.
    const deep = "src/components/very/deeply/nested/Foo.tsx";
    expect(formatToolHeadline({ name: "read_file", inputPreview: deep })).toBe("Read Foo.tsx");
    expect(formatToolHeadline({ name: "edit_file", inputPreview: deep })).toBe("Edit Foo.tsx");
    expect(formatToolHeadline({ name: "write_file", inputPreview: deep })).toBe("Write Foo.tsx");
  });

  test("file tools clip the basename itself if it is absurdly long", () => {
    const longName = "a".repeat(80) + ".ts";
    const result = formatToolHeadline({ name: "read_file", inputPreview: `src/${longName}` });
    expect(result.startsWith("Read ")).toBe(true);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(`Read ${longName}`.length);
  });
});

describe("formatStepHeadline", () => {
  test("empty list", () => {
    expect(formatStepHeadline([])).toBe("(empty step)");
  });

  test("single tool delegates to formatToolHeadline", () => {
    const h = formatStepHeadline([{ name: "read_file", inputPreview: "foo.ts" }]);
    expect(h).toBe("Read foo.ts");
  });

  test("multiple tools, all same kind, uses plural noun", () => {
    const h = formatStepHeadline([
      { name: "read_file", inputPreview: "a.ts" },
      { name: "read_file", inputPreview: "b.ts" },
      { name: "read_file", inputPreview: "c.ts" },
    ]);
    expect(h).toBe("3 reads");
  });

  test("multiple edits", () => {
    const h = formatStepHeadline([
      { name: "edit_file", inputPreview: "a.ts" },
      { name: "edit_file", inputPreview: "b.ts" },
    ]);
    expect(h).toBe("2 edits");
  });

  test("bash-only group uses 'bash commands'", () => {
    const h = formatStepHeadline([
      { name: "bash", inputPreview: "ls" },
      { name: "bash", inputPreview: "pwd" },
    ]);
    expect(h).toBe("2 bash commands");
  });

  test("grep-only group pluralizes 'search' → 'searches'", () => {
    const h = formatStepHeadline([
      { name: "grep", inputPreview: "foo" },
      { name: "grep", inputPreview: "bar" },
    ]);
    expect(h).toBe("2 searches");
  });

  test("mixed tools shows N tools + comma-separated verbs", () => {
    const h = formatStepHeadline([
      { name: "read_file", inputPreview: "a.ts" },
      { name: "grep", inputPreview: "x" },
      { name: "bash", inputPreview: "ls" },
    ]);
    expect(h).toBe("3 tools: read, search, bash command");
  });

  test("mixed with >3 unique kinds shows '+N more'", () => {
    const h = formatStepHeadline([
      { name: "read_file", inputPreview: "a.ts" },
      { name: "grep", inputPreview: "x" },
      { name: "bash", inputPreview: "ls" },
      { name: "web_search", inputPreview: "z" },
      { name: "edit_file", inputPreview: "b.ts" },
    ]);
    expect(h).toContain("5 tools:");
    expect(h).toContain("+2 more");
  });
});
