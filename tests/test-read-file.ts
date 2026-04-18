// =============================================================================
// Tests for read_file tool
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { executeReadFile, readFileToolDefinition } from "../src/tools/read_file.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let tmpDir: string;

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "test-session",
    working_directory: tmpDir,
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

async function readFile(
  input: { file_path: string; offset?: number; limit?: number },
  ctx?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeReadFile(input, makeContext(ctx));
}

// Create temp directory and test fixtures
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hawky-read-test-"));

  // --- simple.txt: a 5-line file ---
  await writeFile(
    join(tmpDir, "simple.txt"),
    "line one\nline two\nline three\nline four\nline five\n",
  );

  // --- no-newline.txt: file without trailing newline ---
  await writeFile(join(tmpDir, "no-newline.txt"), "alpha\nbeta\ngamma");

  // --- empty.txt ---
  await writeFile(join(tmpDir, "empty.txt"), "");

  // --- binary.bin: file with null bytes ---
  const binaryBuf = Buffer.alloc(256);
  binaryBuf[0] = 0x89; // PNG-like header
  binaryBuf[1] = 0x50;
  binaryBuf[10] = 0x00; // null byte
  await writeFile(join(tmpDir, "binary.bin"), binaryBuf);

  // --- long-lines.txt: file with a very long line ---
  const longLine = "x".repeat(3000);
  await writeFile(join(tmpDir, "long-lines.txt"), `short\n${longLine}\nshort again\n`);

  // --- large.txt: file that will exceed character limit ---
  // Each line ~110 chars, 2000 lines = ~220K chars (exceeds 100K limit)
  const largeLines: string[] = [];
  for (let i = 0; i < 2000; i++) {
    largeLines.push(`line ${String(i + 1).padStart(4, "0")}: ${"a".repeat(100)}`);
  }
  await writeFile(join(tmpDir, "large.txt"), largeLines.join("\n") + "\n");

  // --- many-lines.txt: file with more lines than default limit ---
  const manyLines: string[] = [];
  for (let i = 0; i < 2500; i++) {
    manyLines.push(`row ${i + 1}`);
  }
  await writeFile(join(tmpDir, "many-lines.txt"), manyLines.join("\n") + "\n");

  // --- nested/deep/file.txt ---
  await mkdir(join(tmpDir, "nested", "deep"), { recursive: true });
  await writeFile(join(tmpDir, "nested", "deep", "file.txt"), "deep content\n");

  // --- subdir (directory for testing) ---
  await mkdir(join(tmpDir, "subdir"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Tests
// =============================================================================

describe("read_file tool", () => {
  // ---------------------------------------------------------------------------
  // Basic reading
  // ---------------------------------------------------------------------------

  test("reads a file and includes line numbers", async () => {
    const result = await readFile({ file_path: join(tmpDir, "simple.txt") });
    expect(result.type).toBe("text");
    expect(result.content).toContain("1\tline one");
    expect(result.content).toContain("2\tline two");
    expect(result.content).toContain("5\tline five");
  });

  test("line numbers are right-aligned with tab separator", async () => {
    const result = await readFile({ file_path: join(tmpDir, "simple.txt") });
    // simple.txt has 6 lines (5 content + trailing newline)
    // Line numbers 1-6 need width of 4 (minimum)
    const lines = result.content.split("\n");
    // First line should be right-aligned: "   1\tline one"
    expect(lines[0]).toMatch(/^\s+1\tline one$/);
    // All lines should have tab separator
    for (const line of lines) {
      if (line.startsWith("[")) continue; // skip truncation notice
      expect(line).toContain("\t");
    }
  });

  test("reads file with relative path from working directory", async () => {
    const result = await readFile({ file_path: "simple.txt" });
    expect(result.type).toBe("text");
    expect(result.content).toContain("line one");
  });

  test("reads file in nested directory", async () => {
    const result = await readFile({ file_path: join(tmpDir, "nested/deep/file.txt") });
    expect(result.type).toBe("text");
    expect(result.content).toContain("deep content");
  });

  // ---------------------------------------------------------------------------
  // Offset and limit
  // ---------------------------------------------------------------------------

  test("offset=3 starts reading from line 3", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "simple.txt"),
      offset: 3,
    });
    expect(result.type).toBe("text");
    const lines = result.content.split("\n");
    expect(lines[0]).toMatch(/3\tline three$/);
    // Should NOT contain lines 1 or 2
    expect(result.content).not.toContain("line one");
    expect(result.content).not.toContain("line two");
  });

  test("offset=3, limit=2 returns exactly lines 3-4", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "simple.txt"),
      offset: 3,
      limit: 2,
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("line three");
    expect(result.content).toContain("line four");
    expect(result.content).not.toContain("line five");
    // Should have truncation notice since there are more lines
    expect(result.content).toContain("[Showing lines 3-4 of");
    expect(result.content).toContain("Use offset=5 to read more.]");
  });

  test("limit=3 reads first 3 lines", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "simple.txt"),
      limit: 3,
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line two");
    expect(result.content).toContain("line three");
    expect(result.content).not.toContain("line four");
    expect(result.content).toContain("[Showing lines 1-3 of");
  });

  test("offset beyond file length returns informative text", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "simple.txt"),
      offset: 100,
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("out of range");
    expect(result.content).toContain("offset=1");
  });

  test("offset=0 returns error (must be >= 1)", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "simple.txt"),
      offset: 0,
    });
    expect(result.type).toBe("error");
    expect(result.content).toContain(">= 1");
  });

  test("negative offset returns error", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "simple.txt"),
      offset: -5,
    });
    expect(result.type).toBe("error");
    expect(result.content).toContain(">= 1");
  });

  // ---------------------------------------------------------------------------
  // Default limit truncation with continuation message
  // ---------------------------------------------------------------------------

  test("file exceeding default limit shows continuation message", async () => {
    const result = await readFile({
      file_path: join(tmpDir, "many-lines.txt"),
    });
    expect(result.type).toBe("text");
    // Default limit is 2000, file has 2501 lines (2500 + trailing newline)
    expect(result.content).toContain("[Showing lines 1-2000 of");
    expect(result.content).toContain("Use offset=2001 to read more.]");
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("nonexistent file returns error", async () => {
    const result = await readFile({ file_path: join(tmpDir, "nope.txt") });
    expect(result.type).toBe("error");
    expect(result.content).toContain("File not found");
    expect(result.content).toContain("nope.txt");
  });

  test("reading a directory returns error", async () => {
    const result = await readFile({ file_path: join(tmpDir, "subdir") });
    expect(result.type).toBe("error");
    expect(result.content).toContain("Cannot read directory");
  });

  test("missing file_path returns error", async () => {
    const result = await readFile({ file_path: "" });
    expect(result.type).toBe("error");
    expect(result.content).toContain("Missing required parameter");
  });

  // ---------------------------------------------------------------------------
  // Empty and binary files
  // ---------------------------------------------------------------------------

  test("empty file returns informative message", async () => {
    const result = await readFile({ file_path: join(tmpDir, "empty.txt") });
    expect(result.type).toBe("text");
    expect(result.content).toContain("empty (0 bytes)");
    expect((result as any).metadata?.size).toBe(0);
  });

  test("binary file detected and reported", async () => {
    const result = await readFile({ file_path: join(tmpDir, "binary.bin") });
    expect(result.type).toBe("text");
    expect(result.content).toContain("Binary file");
    expect(result.content).toContain("bytes");
    expect((result as any).metadata?.binary).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Line truncation
  // ---------------------------------------------------------------------------

  test("long lines are truncated at 2000 chars", async () => {
    const result = await readFile({ file_path: join(tmpDir, "long-lines.txt") });
    expect(result.type).toBe("text");
    // The 3000-char line should be truncated
    expect(result.content).toContain("... [truncated]");
    // The short lines should be intact
    expect(result.content).toContain("short");
    expect(result.content).toContain("short again");
  });

  // ---------------------------------------------------------------------------
  // Character limit
  // ---------------------------------------------------------------------------

  test("total output truncated at 100K characters", async () => {
    const result = await readFile({ file_path: join(tmpDir, "large.txt") });
    expect(result.type).toBe("text");
    expect(result.content).toContain("[truncated to 100000 characters]");
    // Should not exceed the limit (plus the truncation message)
    // The truncation message itself adds some chars, so check the content
    // before truncation notice is at most 100K
  });

  // ---------------------------------------------------------------------------
  // File without trailing newline
  // ---------------------------------------------------------------------------

  test("file without trailing newline handled correctly", async () => {
    const result = await readFile({ file_path: join(tmpDir, "no-newline.txt") });
    expect(result.type).toBe("text");
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("beta");
    expect(result.content).toContain("gamma");
    // Should have exactly 3 lines (no empty trailing line since no newline)
    const content_lines = result.content.split("\n");
    // Filter out any truncation notices
    const data_lines = content_lines.filter(l => !l.startsWith("["));
    expect(data_lines.length).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // AbortSignal
  // ---------------------------------------------------------------------------

  test("pre-aborted signal returns error without reading", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await readFile(
      { file_path: join(tmpDir, "simple.txt") },
      { abort_signal: controller.signal },
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("aborted");
  });

  // ---------------------------------------------------------------------------
  // Tool definition
  // ---------------------------------------------------------------------------

  test("tool definition has correct name and schema", () => {
    expect(readFileToolDefinition.name).toBe("read_file");
    expect(readFileToolDefinition.permission).toBe("auto_approve");
    expect(readFileToolDefinition.input_schema.required).toEqual(["file_path"]);
    expect(readFileToolDefinition.input_schema.properties.file_path).toBeDefined();
    expect(readFileToolDefinition.input_schema.properties.offset).toBeDefined();
    expect(readFileToolDefinition.input_schema.properties.limit).toBeDefined();
  });

  test("tool registers and executes via registry", async () => {
    resetToolRegistry();
    const registry = getToolRegistry();
    registry.register(readFileToolDefinition);

    expect(registry.has("read_file")).toBe(true);

    // Execute through registry
    const result = await registry.execute(
      "read_file",
      { file_path: join(tmpDir, "simple.txt") },
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("line one");

    resetToolRegistry();
  });

  test("API definition excludes internal fields", () => {
    resetToolRegistry();
    const registry = getToolRegistry();
    registry.register(readFileToolDefinition);

    const apiDefs = registry.getApiDefinitions();
    expect(apiDefs.length).toBe(1);
    expect(apiDefs[0].name).toBe("read_file");
    // Should NOT have execute, permission
    expect((apiDefs[0] as any).execute).toBeUndefined();
    expect((apiDefs[0] as any).permission).toBeUndefined();

    resetToolRegistry();
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  test("result includes metadata with file info", async () => {
    const result = await readFile({ file_path: join(tmpDir, "simple.txt") });
    expect(result.type).toBe("text");
    const meta = (result as any).metadata;
    expect(meta).toBeDefined();
    expect(meta.file_path).toContain("simple.txt");
    expect(meta.total_lines).toBeGreaterThan(0);
    expect(meta.shown_from).toBe(1);
    expect(meta.shown_to).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // CRLF normalization
  // ---------------------------------------------------------------------------

  test("CRLF line endings are normalized to LF", async () => {
    await writeFile(join(tmpDir, "crlf.txt"), "line1\r\nline2\r\nline3\r\n");
    const result = await readFile({ file_path: join(tmpDir, "crlf.txt") });
    expect(result.type).toBe("text");
    // Lines should not contain \r
    expect(result.content).not.toContain("\r");
    expect(result.content).toContain("line1");
    expect(result.content).toContain("line2");
    expect(result.content).toContain("line3");
  });

  // ---------------------------------------------------------------------------
  // Path resolution with .. and .
  // ---------------------------------------------------------------------------

  test("relative path with .. resolves correctly", async () => {
    // nested/deep/file.txt exists; read from nested/ using ../nested/deep/file.txt
    const result = await readFile(
      { file_path: "nested/../nested/deep/file.txt" },
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("deep content");
  });

  test("relative path with . resolves correctly", async () => {
    const result = await readFile({ file_path: "./simple.txt" });
    expect(result.type).toBe("text");
    expect(result.content).toContain("line one");
  });

  // ---------------------------------------------------------------------------
  // Top-level error catch
  // ---------------------------------------------------------------------------

  test("unexpected errors are caught by top-level handler", async () => {
    // Pass a context with a getter that throws on abort_signal access
    // to simulate an unexpected error in the inner function
    const badContext: any = {
      session_id: "test",
      working_directory: tmpDir,
      emit: () => {},
      get abort_signal(): AbortSignal {
        throw new Error("unexpected context failure");
      },
    };
    const result = await executeReadFile({ file_path: "simple.txt" }, badContext);
    expect(result.type).toBe("error");
    expect(result.content).toContain("unexpected context failure");
  });
});
