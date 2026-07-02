// =============================================================================
// Tests for grep tool
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { executeGrep, grepToolDefinition } from "../src/tools/grep.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let tmpDir: string;

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "test",
    working_directory: tmpDir,
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

async function grep(
  input: { pattern: string; path?: string; include?: string; context_lines?: number; head_limit?: number },
  overrides?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeGrep(input, ctx(overrides));
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hawky-grep-test-"));

  // File tree:
  // src/
  //   app.ts          — has "function main", "TODO: fix", "import { foo }"
  //   utils.ts        — has "export function helper", "TODO: refactor"
  //   data.json       — has "version"
  //   foo[bar].txt    — tests literal include glob escaping
  //   foob.txt        — must not match foo[bar].txt include
  // tests/
  //   app.test.ts     — has "describe", "expect"
  // node_modules/
  //   dep/index.js    — has "module.exports" (should be skipped)
  // .git/
  //   config          — (should be skipped)
  // binary.bin        — binary file (should be skipped)
  // big.txt           — file with a very long line

  await mkdir(join(tmpDir, "src"), { recursive: true });
  await mkdir(join(tmpDir, "tests"), { recursive: true });
  await mkdir(join(tmpDir, "node_modules", "dep"), { recursive: true });
  await mkdir(join(tmpDir, ".git"), { recursive: true });

  await writeFile(join(tmpDir, "src", "app.ts"), [
    'import { foo } from "./utils";',
    "",
    "function main() {",
    "  // TODO: fix this logic",
    "  const result = foo();",
    "  console.log(result);",
    "}",
    "",
    "main();",
    "",
  ].join("\n"));

  await writeFile(join(tmpDir, "src", "utils.ts"), [
    "export function helper(x: number): number {",
    "  // TODO: refactor this",
    "  return x * 2;",
    "}",
    "",
    "export function foo() {",
    "  return helper(21);",
    "}",
    "",
  ].join("\n"));

  await writeFile(join(tmpDir, "src", "data.json"), '{\n  "version": "1.0.0"\n}\n');
  await writeFile(join(tmpDir, "src", "foo[bar].txt"), "literal bracket token\n");
  await writeFile(join(tmpDir, "src", "foob.txt"), "regex class token\n");

  await writeFile(join(tmpDir, "tests", "app.test.ts"), [
    'import { describe, test, expect } from "bun:test";',
    "",
    'describe("main", () => {',
    '  test("works", () => {',
    "    expect(1 + 1).toBe(2);",
    "  });",
    "});",
    "",
  ].join("\n"));

  await writeFile(join(tmpDir, "node_modules", "dep", "index.js"), "module.exports = {};\n");
  await writeFile(join(tmpDir, ".git", "config"), "[core]\n\tbare = false\n");

  // Binary file
  const binBuf = Buffer.alloc(64);
  binBuf[0] = 0x89;
  binBuf[10] = 0x00;
  await writeFile(join(tmpDir, "binary.bin"), binBuf);

  // File with long line
  const longLine = "x".repeat(1000);
  await writeFile(join(tmpDir, "big.txt"), `short line\n${longLine}\nanother short\n`);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Basic matching
// =============================================================================

describe("Basic matching", () => {
  test("finds a simple pattern across files", async () => {
    const r = await grep({ pattern: "TODO" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/utils.ts");
    expect(r.content).toContain("TODO");
    expect((r as any).metadata?.count).toBe(2);
  });

  test("output format is filepath:linenum: content", async () => {
    const r = await grep({ pattern: "function main" });
    expect(r.type).toBe("text");
    // Should match line 3 of app.ts
    expect(r.content).toMatch(/src\/app\.ts:\d+: function main/);
  });

  test("no matches returns informative message", async () => {
    const r = await grep({ pattern: "ZZZZNONEXISTENT" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No matches found");
    expect((r as any).metadata?.count).toBe(0);
  });

  test("regex patterns work", async () => {
    const r = await grep({ pattern: "export function \\w+" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("helper");
    expect(r.content).toContain("foo");
  });

  test("case-sensitive by default", async () => {
    const r = await grep({ pattern: "todo" }); // lowercase
    expect(r.type).toBe("text");
    expect(r.content).toContain("No matches found");
  });

  test("case-insensitive via (?i) flag", async () => {
    const r = await grep({ pattern: "(?i)todo" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("TODO");
    expect((r as any).metadata?.count).toBe(2);
  });

  test("inline global flag does not skip alternating lines", async () => {
    const r = await grep({ pattern: "(?g)TODO" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/utils.ts");
    expect((r as any).metadata?.count).toBe(2);
  });

  test("inline sticky flag resets for each line", async () => {
    const r = await grep({ pattern: "(?y).*TODO" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/utils.ts");
    expect((r as any).metadata?.count).toBe(2);
  });
});

// =============================================================================
// Include filter
// =============================================================================

describe("Include filter", () => {
  test("include='*.ts' searches only TypeScript files", async () => {
    const r = await grep({ pattern: "function", include: "*.ts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/utils.ts");
    // Should NOT match data.json
    expect(r.content).not.toContain("data.json");
  });

  test("include='*.json' searches only JSON files", async () => {
    const r = await grep({ pattern: "version", include: "*.json" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("data.json");
    expect(r.content).not.toContain(".ts");
  });

  test("include treats regex metacharacters as literal filename characters", async () => {
    const r = await grep({ pattern: "token", include: "foo[bar].txt" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("foo[bar].txt");
    expect(r.content).not.toContain("foob.txt");
  });
});

// =============================================================================
// Context lines
// =============================================================================

describe("Context lines", () => {
  test("context_lines=2 shows lines before and after match", async () => {
    const r = await grep({ pattern: "TODO: fix", context_lines: 2 });
    expect(r.type).toBe("text");
    // The match is on line 4 of app.ts ("  // TODO: fix this logic")
    // Context should include line 2 (empty), line 3 (function main),
    // line 5 (const result), line 6 (console.log)
    expect(r.content).toContain("function main");
    expect(r.content).toContain("const result");
    // Context lines use - separator instead of :
    expect(r.content).toMatch(/:\d+-/);  // context line format
    // Group separator
    expect(r.content).not.toContain("----"); // just -- between groups
  });

  test("context_lines=0 shows no context (default)", async () => {
    const r = await grep({ pattern: "TODO: fix" });
    expect(r.type).toBe("text");
    // Only the match line, no context
    expect(r.content).not.toContain("function main");
    expect(r.content).not.toContain("const result");
  });
});

// =============================================================================
// head_limit
// =============================================================================

describe("head_limit", () => {
  test("head_limit=1 returns only first match", async () => {
    const r = await grep({ pattern: "function", head_limit: 1 });
    expect(r.type).toBe("text");
    expect((r as any).metadata?.count).toBe(1);
    expect(r.content).toContain("capped at 1");
  });
});

// =============================================================================
// Skip directories and binary files
// =============================================================================

describe("Skipping", () => {
  test("skips node_modules", async () => {
    const r = await grep({ pattern: "module.exports" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No matches found");
  });

  test("skips .git", async () => {
    const r = await grep({ pattern: "bare" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No matches found");
  });

  test("skips binary files", async () => {
    // The binary file has bytes but no text matching
    const r = await grep({ pattern: ".*", path: "binary.bin" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No matches found");
  });
});

// =============================================================================
// Single file search
// =============================================================================

describe("Single file search", () => {
  test("searches a single file when path is a file", async () => {
    const r = await grep({ pattern: "function main", path: "src/app.ts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("function main");
    expect((r as any).metadata?.count).toBe(1);
  });
});

// =============================================================================
// Line truncation
// =============================================================================

describe("Line truncation", () => {
  test("long lines truncated at 500 chars", async () => {
    const r = await grep({ pattern: "x{100,}", path: "big.txt" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("...");
    // The matched line should be truncated, not the full 1000 chars
    const matchLine = r.content.split("\n").find(l => l.includes("xxx"));
    expect(matchLine!.length).toBeLessThan(600);
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("Error handling", () => {
  test("missing pattern returns error", async () => {
    const r = await grep({ pattern: "" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: pattern");
  });

  test("invalid regex returns error", async () => {
    const r = await grep({ pattern: "[invalid" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Invalid regex");
  });

  test("nonexistent path returns error", async () => {
    const r = await grep({ pattern: "x", path: "nonexistent" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Path not found");
  });

  test("pre-aborted signal returns error", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await grep({ pattern: "x" }, { abort_signal: controller.signal });
    expect(r.type).toBe("error");
    expect(r.content).toContain("aborted");
  });

  test("top-level catch handles unexpected errors", async () => {
    const bad: any = {
      get abort_signal(): AbortSignal { throw new Error("boom"); },
    };
    const r = await executeGrep({ pattern: "x" }, bad);
    expect(r.type).toBe("error");
    expect(r.content).toContain("boom");
  });
});

// =============================================================================
// Path resolution
// =============================================================================

describe("Path resolution", () => {
  test("relative path resolves from working directory", async () => {
    const r = await grep({ pattern: "TODO", path: "src" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("TODO");
  });

  test("path with .. resolves correctly", async () => {
    const r = await grep({ pattern: "describe", path: "src/../tests" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("describe");
  });
});

// =============================================================================
// Tool definition and registry
// =============================================================================

describe("Tool definition", () => {
  test("correct shape", () => {
    expect(grepToolDefinition.name).toBe("grep");
    expect(grepToolDefinition.permission).toBe("auto_approve");
    expect(grepToolDefinition.input_schema.required).toEqual(["pattern"]);
    expect(grepToolDefinition.input_schema.properties.pattern).toBeDefined();
    expect(grepToolDefinition.input_schema.properties.path).toBeDefined();
    expect(grepToolDefinition.input_schema.properties.include).toBeDefined();
    expect(grepToolDefinition.input_schema.properties.context_lines).toBeDefined();
    expect(grepToolDefinition.input_schema.properties.head_limit).toBeDefined();
  });

  test("registry integration", async () => {
    resetToolRegistry();
    const reg = getToolRegistry();
    reg.register(grepToolDefinition);
    const r = await reg.execute("grep", { pattern: "function" }, ctx());
    expect(r.type).toBe("text");
    expect(r.content).toContain("function");
    resetToolRegistry();
  });
});

// =============================================================================
// E2E: realistic grep scenarios
// =============================================================================

describe("E2E: realistic scenarios", () => {
  test("find all TODO comments in a project", async () => {
    const r = await grep({ pattern: "TODO" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("TODO: fix");
    expect(r.content).toContain("TODO: refactor");
    expect((r as any).metadata?.count).toBe(2);
  });

  test("find function definitions in TypeScript files", async () => {
    const r = await grep({ pattern: "^(export )?function", include: "*.ts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("function main");
    expect(r.content).toContain("export function helper");
    expect(r.content).toContain("export function foo");
  });

  test("find imports with context", async () => {
    const r = await grep({ pattern: "^import", context_lines: 1 });
    expect(r.type).toBe("text");
    // Should find imports in app.ts and app.test.ts
    expect(r.content).toContain("import");
    // Context should show the line after the import
    const lines = r.content.split("\n");
    const contextLines = lines.filter(l => l.includes("-"));
    expect(contextLines.length).toBeGreaterThan(0);
  });

  test("search for a specific string in a single file", async () => {
    const r = await grep({ pattern: "console\\.log", path: "src/app.ts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("console.log(result)");
    expect((r as any).metadata?.count).toBe(1);
  });

  test("search with include filter and head_limit", async () => {
    const r = await grep({ pattern: "\\w+", include: "*.ts", head_limit: 3 });
    expect(r.type).toBe("text");
    expect((r as any).metadata?.count).toBe(3);
    expect(r.content).toContain("capped at 3");
  });
});
