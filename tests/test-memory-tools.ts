// =============================================================================
// Tests for Memory Tools (memory_get, memory_search)
//
// Tests tool execution with real workspace files in temp directories.
// Covers: file reading, line ranges, security boundaries, search matching,
// result formatting, edge cases.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryGetToolDefinition, memorySearchToolDefinition } from "../src/tools/memory.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { WorkspaceManager } from "../src/storage/workspace.js";
import { resetGlobalMemoryIndex, getGlobalMemoryIndex } from "../src/memory/global.js";
import type { ToolContext } from "../src/agent/types.js";

// =============================================================================
// Helpers
// =============================================================================

let tempDir: string;
let wsDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeContext(): ToolContext {
  return {
    session_id: "test",
    working_directory: tempDir,
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

async function runMemoryGet(input: Record<string, unknown>): Promise<{ type: string; content: string }> {
  return memoryGetToolDefinition.execute(input as any, makeContext()) as any;
}

async function runMemorySearch(input: Record<string, unknown>): Promise<{ type: string; content: string }> {
  return memorySearchToolDefinition.execute(input as any, makeContext()) as any;
}

beforeEach(() => {
  resetGlobalMemoryIndex(); // Reset singleton so each test gets fresh index
  tempDir = makeTempDir();
  wsDir = join(tempDir, "workspace");
  const ws = new WorkspaceManager(wsDir);
  ws.init();
  setWorkspaceDir(wsDir);
  // Pre-create the global index with an isolated DB so tests don't
  // interfere with each other or the production database.
  getGlobalMemoryIndex(wsDir, undefined, join(tempDir, "test-memory.db"));
});

afterEach(() => {
  resetGlobalMemoryIndex();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
// memory_get — basic reads
// =============================================================================

describe("memory_get — basic reads", () => {
  test("reads SOUL.md from workspace", async () => {
    const result = await runMemoryGet({ path: "SOUL.md" });
    expect(result.type).toBe("text");
    const parsed = JSON.parse(result.content);
    expect(parsed.path).toBe("SOUL.md");
    expect(parsed.text).toContain("genuinely helpful");
  });

  test("reads USER.md from workspace", async () => {
    const result = await runMemoryGet({ path: "USER.md" });
    expect(result.type).toBe("text");
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain("Name:");
  });

  test("reads daily log by relative path", async () => {
    writeFileSync(join(wsDir, "memory", "2026-03-14.md"), "# 2026-03-14\nMet with John\nDiscussed project", "utf-8");

    const result = await runMemoryGet({ path: "memory/2026-03-14.md" });
    expect(result.type).toBe("text");
    const parsed = JSON.parse(result.content);
    expect(parsed.path).toBe("memory/2026-03-14.md");
    expect(parsed.text).toContain("Met with John");
  });

  test("returns error info for non-existent file", async () => {
    const result = await runMemoryGet({ path: "memory/9999-01-01.md" });
    expect(result.type).toBe("text");
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("not found");
  });

  test("returns full file when no range specified", async () => {
    const result = await runMemoryGet({ path: "AGENTS.md" });
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain("Session Startup");
    expect(parsed.text).toContain("Red Lines");
  });
});

// =============================================================================
// memory_get — line ranges
// =============================================================================

describe("memory_get — line ranges", () => {
  test("from parameter reads from specific line", async () => {
    writeFileSync(join(wsDir, "memory", "test.md"), "line1\nline2\nline3\nline4\nline5", "utf-8");

    const result = await runMemoryGet({ path: "memory/test.md", from: 3 });
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain("line3");
    expect(parsed.text).toContain("line4");
    expect(parsed.text).toContain("line5");
    expect(parsed.from).toBe(3);
  });

  test("lines parameter limits output", async () => {
    writeFileSync(join(wsDir, "memory", "test.md"), "line1\nline2\nline3\nline4\nline5", "utf-8");

    const result = await runMemoryGet({ path: "memory/test.md", from: 2, lines: 2 });
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toBe("line2\nline3");
    expect(parsed.lines).toBe(2);
    expect(parsed.total_lines).toBe(5);
  });

  test("from beyond file length returns empty", async () => {
    writeFileSync(join(wsDir, "memory", "test.md"), "line1\nline2", "utf-8");

    const result = await runMemoryGet({ path: "memory/test.md", from: 100 });
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toBe("");
    expect(parsed.lines).toBe(0);
  });
});

// =============================================================================
// memory_get — security
// =============================================================================

describe("memory_get — security", () => {
  test("rejects absolute paths", async () => {
    const result = await runMemoryGet({ path: "/etc/passwd" });
    expect(result.type).toBe("error");
    expect(result.content).toContain("relative");
  });

  test("rejects directory traversal", async () => {
    const result = await runMemoryGet({ path: "../../../etc/passwd" });
    expect(result.type).toBe("error");
    expect(result.content).toContain("traverse");
  });

  test("rejects traversal via intermediate segments", async () => {
    // Bypass pattern: normalize("memory/../../etc/passwd") doesn't start with ".."
    const result = await runMemoryGet({ path: "memory/../../etc/passwd.md" });
    expect(result.type).toBe("error");
    expect(result.content).toContain("traverse");
  });

  test("rejects traversal via dot-slash prefix", async () => {
    const result = await runMemoryGet({ path: "./../../etc/passwd.md" });
    expect(result.type).toBe("error");
    expect(result.content).toContain("traverse");
  });

  test("rejects non-.md files", async () => {
    const result = await runMemoryGet({ path: "config.json" });
    expect(result.type).toBe("error");
    expect(result.content).toContain(".md");
  });
});

// =============================================================================
// memory_search — basic matching
// =============================================================================

describe("memory_search — basic matching", () => {
  test("finds keyword in MEMORY.md", async () => {
    writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\nFavorite color: blue\nFavorite food: pizza", "utf-8");

    const result = await runMemorySearch({ query: "blue" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].path).toBe("MEMORY.md");
    expect(parsed.results[0].snippet).toContain("blue");
  });

  test("finds keyword in daily logs", async () => {
    // Test daily log search using a direct MemoryIndex instance
    // (bypasses the global singleton which has complex lifecycle issues in test suites).
    const { MemoryIndex } = await import("../src/memory/index.js");
    const dailyDir = makeTempDir();
    const dailyWs = join(dailyDir, "workspace");
    mkdirSync(join(dailyWs, "memory"), { recursive: true });
    writeFileSync(join(dailyWs, "memory", "2026-03-14.md"), "# 2026-03-14\n[10:00] Met with Zygmunt about quantum teleportation", "utf-8");

    const idx = new MemoryIndex({
      workspacePath: dailyWs,
      dbPath: join(dailyDir, "test.db"),
      enableWatcher: false,
    });
    await idx.sync();
    const results = await idx.search("Zygmunt");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("memory/2026-03-14.md");
    expect(results[0].snippet).toContain("Zygmunt");

    idx.close();
    rmSync(dailyDir, { recursive: true, force: true });
  });

  test("returns path, line_number, and snippet", async () => {
    writeFileSync(join(wsDir, "MEMORY.md"), "line1\nline2\ntarget keyword here\nline4", "utf-8");

    const result = await runMemorySearch({ query: "target keyword" });
    const parsed = JSON.parse(result.content);
    const match = parsed.results[0];
    expect(match.path).toBe("MEMORY.md");
    expect(typeof match.line_number).toBe("number");
    expect(match.line_number).toBeGreaterThanOrEqual(1);
    expect(match.snippet).toContain("target keyword");
  });

  test("returns context lines in snippet", async () => {
    writeFileSync(join(wsDir, "MEMORY.md"), "before\nmatch line\nafter", "utf-8");

    const result = await runMemorySearch({ query: "match line" });
    const parsed = JSON.parse(result.content);
    const snippet = parsed.results[0].snippet;
    expect(snippet).toContain("before");
    expect(snippet).toContain("match line");
    expect(snippet).toContain("after");
  });

  test("searches across multiple files", async () => {
    // Use a highly unique token unlikely to appear in any workspace template
    writeFileSync(join(wsDir, "MEMORY.md"), "xyzzy_unique_token_7f9a2b in memory", "utf-8");
    writeFileSync(join(wsDir, "memory", "2026-03-14.md"), "xyzzy_unique_token_7f9a2b in daily log", "utf-8");

    const result = await runMemorySearch({ query: "xyzzy_unique_token_7f9a2b" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBe(2);
    const paths = parsed.results.map((r: any) => r.path);
    expect(paths).toContain("MEMORY.md");
    expect(paths).toContain("memory/2026-03-14.md");
  });
});

// =============================================================================
// memory_search — limits and edge cases
// =============================================================================

describe("memory_search — limits and edge cases", () => {
  test("respects max_results limit", async () => {
    // Create many files so we get many chunks
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(wsDir, "memory", `note-${i}.md`), `Match item ${i} with some extra content to ensure chunking`, "utf-8");
    }

    const result = await runMemorySearch({ query: "Match item", max_results: 3 });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeLessThanOrEqual(3);
  });

  test("clamps negative max_results to one result", async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(wsDir, "memory", `negative-${i}.md`), `Negative limit match ${i}`, "utf-8");
    }

    const result = await runMemorySearch({ query: "Negative limit match", max_results: -10 });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBe(1);
  });

  test("caps very large max_results", async () => {
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(wsDir, "memory", `huge-${i}.md`), `Huge limit match ${i}`, "utf-8");
    }

    const result = await runMemorySearch({ query: "Huge limit match", max_results: 5_000 });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeLessThanOrEqual(50);
  });

  test("default max_results caps results", async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(wsDir, "memory", `hit-${i}.md`), `Hit number ${i} plus more words`, "utf-8");
    }

    const result = await runMemorySearch({ query: "Hit number" });
    const parsed = JSON.parse(result.content);
    // Default max is 6, but we may get fewer if FTS ranks some below minScore
    expect(parsed.results.length).toBeLessThanOrEqual(6);
  });

  test("returns empty for no matches", async () => {
    const result = await runMemorySearch({ query: "xyznonexistent123" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results).toEqual([]);
  });

  test("case-insensitive search", async () => {
    writeFileSync(join(wsDir, "MEMORY.md"), "User likes TypeScript", "utf-8");

    const result = await runMemorySearch({ query: "typescript" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  test("handles regex special chars in query (escapes them)", async () => {
    writeFileSync(join(wsDir, "MEMORY.md"), "Price is $100 (USD)", "utf-8");

    const result = await runMemorySearch({ query: "$100 (USD)" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  test("empty query returns error", async () => {
    const result = await runMemorySearch({ query: "" });
    expect(result.type).toBe("error");
  });

  test("reports result count", async () => {
    const result = await runMemorySearch({ query: "anything" });
    const parsed = JSON.parse(result.content);
    expect(typeof parsed.result_count).toBe("number");
  });
});

// =============================================================================
// memory_search — also searches workspace root files
// =============================================================================

describe("memory_search — workspace root files", () => {
  test("searches SOUL.md", async () => {
    const result = await runMemorySearch({ query: "genuinely helpful" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].path).toBe("SOUL.md");
  });

  test("searches AGENTS.md", async () => {
    const result = await runMemorySearch({ query: "Session Startup" });
    const parsed = JSON.parse(result.content);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].path).toBe("AGENTS.md");
  });
});

// =============================================================================
// Tool definitions
// =============================================================================

describe("Tool definitions", () => {
  test("memory_get has correct name and permission", () => {
    expect(memoryGetToolDefinition.name).toBe("memory_get");
    expect(memoryGetToolDefinition.permission).toBe("auto_approve");
  });

  test("memory_search has correct name and permission", () => {
    expect(memorySearchToolDefinition.name).toBe("memory_search");
    expect(memorySearchToolDefinition.permission).toBe("auto_approve");
  });

  test("memory_get requires path parameter", () => {
    expect(memoryGetToolDefinition.input_schema.required).toContain("path");
  });

  test("memory_search requires query parameter", () => {
    expect(memorySearchToolDefinition.input_schema.required).toContain("query");
  });
});
