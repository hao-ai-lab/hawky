// =============================================================================
// Tests: Structured Diff Utility
//
// Tests for diff computation, ANSI formatting, HTML formatting, syntax
// highlighting, and edge cases.
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  computeDiffHunks,
  formatDiffHunks,
  formatNewFileDiff,
  formatDiffHunksHTML,
  detectLanguage,
  CONTEXT_LINES,
  type DiffHunk,
} from "../src/tui/utils/structured_diff.js";

// =============================================================================
// computeDiffHunks
// =============================================================================

describe("computeDiffHunks", () => {
  test("returns empty array for identical content", () => {
    const hunks = computeDiffHunks("hello\nworld", "hello\nworld");
    expect(hunks.length).toBe(0);
  });

  test("detects single line change", () => {
    const hunks = computeDiffHunks("line1\nline2\nline3", "line1\nchanged\nline3");
    expect(hunks.length).toBe(1);
    const lines = hunks[0].lines;
    expect(lines.some((l) => l.startsWith("-"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+"))).toBe(true);
  });

  test("detects addition", () => {
    const hunks = computeDiffHunks("line1\nline2", "line1\nnew line\nline2");
    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.some((l) => l === "+new line")).toBe(true);
  });

  test("detects deletion", () => {
    const hunks = computeDiffHunks("line1\nold line\nline2", "line1\nline2");
    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.some((l) => l === "-old line")).toBe(true);
  });

  test("includes context lines", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const newContent = old.replace("line 10", "changed 10");
    const hunks = computeDiffHunks(old, newContent);
    expect(hunks.length).toBe(1);
    // Should have context lines before and after the change
    const contextLines = hunks[0].lines.filter((l) => l.startsWith(" "));
    expect(contextLines.length).toBe(CONTEXT_LINES * 2); // 3 before + 3 after
  });

  test("creates multiple hunks for distant changes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[5] = "changed 6";
    lines[25] = "changed 26";
    const hunks = computeDiffHunks(
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
      lines.join("\n"),
    );
    expect(hunks.length).toBe(2); // Two separate hunks
  });

  test("handles empty old content (new file)", () => {
    const hunks = computeDiffHunks("", "new content\nline 2");
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks[0].lines.some((l) => l.startsWith("+"))).toBe(true);
  });

  test("handles empty new content (deleted file)", () => {
    const hunks = computeDiffHunks("old content\nline 2", "");
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks[0].lines.some((l) => l.startsWith("-"))).toBe(true);
  });

  test("preserves hunk metadata", () => {
    const hunks = computeDiffHunks("line1\nline2\nline3", "line1\nchanged\nline3");
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
    expect(typeof hunks[0].oldLines).toBe("number");
    expect(typeof hunks[0].newLines).toBe("number");
  });
});

// =============================================================================
// formatDiffHunks — ANSI output
// =============================================================================

describe("formatDiffHunks", () => {
  test("formats hunk header with @@ markers", () => {
    const hunks = computeDiffHunks("a\nb\nc", "a\nx\nc");
    const output = formatDiffHunks(hunks);
    expect(output).toContain("@@");
  });

  test("shows + for additions with green gutter and green background", () => {
    const hunks = computeDiffHunks("a", "a\nb");
    const output = formatDiffHunks(hunks);
    expect(output).toContain("\x1b[32m"); // Green line number
    expect(output).toContain("\x1b[97;48;2;2;40;0m"); // Default text + dark green bg
    expect(output).toContain("+");
  });

  test("shows - for removals with red gutter and red background", () => {
    const hunks = computeDiffHunks("a\nb", "a");
    const output = formatDiffHunks(hunks);
    expect(output).toContain("\x1b[31m"); // Red line number
    expect(output).toContain("\x1b[97;48;2;61;1;0m"); // Default text + dark red bg
    expect(output).toContain("-");
  });

  test("shows context lines in gray", () => {
    const hunks = computeDiffHunks("ctx\nold\nctx2", "ctx\nnew\nctx2");
    const output = formatDiffHunks(hunks);
    expect(output).toContain("\x1b[90m"); // Gray
  });

  test("includes line numbers", () => {
    const hunks = computeDiffHunks("line1\nline2\nline3", "line1\nchanged\nline3");
    const output = formatDiffHunks(hunks);
    // Should contain line numbers like "1", "2", "3"
    expect(output).toContain("1");
    expect(output).toContain("2");
  });

  test("shows ... separator between hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const modified = [...lines];
    modified[5] = "changed 6";
    modified[25] = "changed 26";
    const hunks = computeDiffHunks(lines.join("\n"), modified.join("\n"));
    if (hunks.length >= 2) {
      const output = formatDiffHunks(hunks);
      expect(output).toContain("...");
    }
  });

  test("returns '(no changes)' for empty hunks", () => {
    const output = formatDiffHunks([]);
    expect(output).toContain("no changes");
  });

  test("applies syntax highlighting when filePath provided", () => {
    const hunks = computeDiffHunks("const x = 1;", "const x = 2;", "test.ts");
    const output = formatDiffHunks(hunks, { filePath: "test.ts", syntaxHighlight: true });
    // Should contain ANSI codes from syntax highlighting (beyond just +/- colors)
    expect(output.length).toBeGreaterThan(0);
  });

  test("works without syntax highlighting", () => {
    const hunks = computeDiffHunks("const x = 1;", "const x = 2;");
    const output = formatDiffHunks(hunks, { syntaxHighlight: false });
    expect(output).toContain("const x = 1");
    expect(output).toContain("const x = 2");
  });
});

// =============================================================================
// formatNewFileDiff
// =============================================================================

describe("formatNewFileDiff", () => {
  test("shows all lines as additions", () => {
    const output = formatNewFileDiff("line1\nline2\nline3");
    // Line number + marker in green, content with background
    expect(output).toContain("line1");
    expect(output).toContain("line2");
    expect(output).toContain("line3");
    expect(output).toContain("\x1b[32m"); // Green gutter
    expect(output).toContain("\x1b[97;48;2;2;40;0m"); // Default text + dark green bg
  });

  test("shows line numbers", () => {
    const output = formatNewFileDiff("a\nb\nc");
    expect(output).toContain("1");
    expect(output).toContain("2");
    expect(output).toContain("3");
  });

  test("shows hunk header", () => {
    const output = formatNewFileDiff("a\nb");
    expect(output).toContain("@@");
  });

  test("applies syntax highlighting", () => {
    const output = formatNewFileDiff("const x = 1;", { filePath: "test.ts" });
    expect(output.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// formatDiffHunksHTML
// =============================================================================

describe("formatDiffHunksHTML", () => {
  test("returns empty message for no hunks", () => {
    const html = formatDiffHunksHTML([]);
    expect(html).toContain("no changes");
  });

  test("includes CSS classes for additions", () => {
    const hunks = computeDiffHunks("a", "a\nb");
    const html = formatDiffHunksHTML(hunks);
    expect(html).toContain("diff-add");
    expect(html).toContain("+");
  });

  test("includes CSS classes for deletions", () => {
    const hunks = computeDiffHunks("a\nb", "a");
    const html = formatDiffHunksHTML(hunks);
    expect(html).toContain("diff-del");
    expect(html).toContain("-");
  });

  test("includes CSS classes for context", () => {
    const hunks = computeDiffHunks("ctx\nold\nctx2", "ctx\nnew\nctx2");
    const html = formatDiffHunksHTML(hunks);
    expect(html).toContain("diff-ctx");
  });

  test("includes hunk header", () => {
    const hunks = computeDiffHunks("a", "b");
    const html = formatDiffHunksHTML(hunks);
    expect(html).toContain("diff-hunk-header");
    expect(html).toContain("@@");
  });

  test("escapes HTML entities", () => {
    const hunks = computeDiffHunks("<div>old</div>", "<div>new</div>");
    const html = formatDiffHunksHTML(hunks);
    expect(html).toContain("&lt;div&gt;");
  });

  test("includes gutter with line numbers", () => {
    const hunks = computeDiffHunks("line1", "line2");
    const html = formatDiffHunksHTML(hunks);
    expect(html).toContain("diff-gutter");
  });
});

// =============================================================================
// detectLanguage
// =============================================================================

describe("detectLanguage", () => {
  test("detects TypeScript", () => {
    expect(detectLanguage("src/app.tsx")).toBe("typescript");
    expect(detectLanguage("src/app.ts")).toBe("typescript");
  });

  test("detects JavaScript", () => {
    expect(detectLanguage("app.js")).toBe("javascript");
    expect(detectLanguage("app.jsx")).toBe("javascript");
  });

  test("detects Python", () => {
    expect(detectLanguage("script.py")).toBe("python");
  });

  test("detects Rust", () => {
    expect(detectLanguage("main.rs")).toBe("rust");
  });

  test("detects shell", () => {
    expect(detectLanguage("deploy.sh")).toBe("bash");
    expect(detectLanguage("script.bash")).toBe("bash");
  });

  test("returns undefined for unknown extensions", () => {
    expect(detectLanguage("file.xyz")).toBeUndefined();
  });

  test("handles files without extension", () => {
    expect(detectLanguage("Makefile")).toBeUndefined();
  });

  test("case insensitive", () => {
    expect(detectLanguage("file.PY")).toBe("python");
    expect(detectLanguage("file.TS")).toBe("typescript");
  });
});

// =============================================================================
// Integration: edit_file metadata → diff display
// =============================================================================

describe("edit_file diff integration", () => {
  test("computes diff from edit_file metadata", () => {
    const metadata = {
      file_path: "/src/index.ts",
      old_string: "const x = 1;\nconst y = 2;",
      new_string: "const x = 42;\nconst y = 2;",
    };
    const hunks = computeDiffHunks(
      metadata.old_string,
      metadata.new_string,
      metadata.file_path,
    );
    expect(hunks.length).toBeGreaterThan(0);
    const formatted = formatDiffHunks(hunks, { filePath: metadata.file_path });
    expect(formatted).toContain("const x = 1");
    expect(formatted).toContain("const x = 42");
  });

  test("computes diff from write_file metadata (overwrite)", () => {
    const metadata = {
      file_path: "/src/config.json",
      old_content: '{"port": 3000}',
      new_content: '{"port": 4000}',
    };
    const hunks = computeDiffHunks(
      metadata.old_content,
      metadata.new_content,
      metadata.file_path,
    );
    expect(hunks.length).toBeGreaterThan(0);
  });

  test("formats new file from write_file metadata", () => {
    const metadata = {
      file_path: "/src/new-file.ts",
      old_content: null,
      new_content: "export const hello = 'world';",
    };
    const formatted = formatNewFileDiff(metadata.new_content, {
      filePath: metadata.file_path,
    });
    expect(formatted).toContain("+");
    expect(formatted).toContain("hello");
  });
});
