// =============================================================================
// Tests for write_file tool
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { executeWriteFile, writeFileToolDefinition } from "../src/tools/write_file.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
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

async function doWrite(
  input: { file_path: string; content: string },
  ctx?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeWriteFile(input, makeContext(ctx));
}

/** Read file from disk to verify writes. */
async function diskRead(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hawky-write-test-"));

  // Pre-create a file for overwrite tests
  await writeFile(join(tmpDir, "existing.txt"), "original content\n");

  // Pre-create a directory for the directory-check test
  await mkdir(join(tmpDir, "a-directory"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Tests
// =============================================================================

describe("write_file tool", () => {
  // ---------------------------------------------------------------------------
  // Basic writing
  // ---------------------------------------------------------------------------

  test("writes a new file and returns success message", async () => {
    const result = await doWrite({
      file_path: join(tmpDir, "new.txt"),
      content: "hello world\n",
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("Wrote");
    expect(result.content).toContain("bytes");
    expect(result.content).toContain("lines");

    // Verify on disk
    const disk = await diskRead(join(tmpDir, "new.txt"));
    expect(disk).toBe("hello world\n");
  });

  test("success message includes correct byte count", async () => {
    const content = "abc";
    const result = await doWrite({
      file_path: join(tmpDir, "bytes.txt"),
      content,
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("3 bytes");
  });

  test("success message includes correct line count", async () => {
    const content = "line1\nline2\nline3\n";
    const result = await doWrite({
      file_path: join(tmpDir, "lines.txt"),
      content,
    });
    expect(result.type).toBe("text");
    // "line1\nline2\nline3\n".split("\n") = ["line1","line2","line3",""] = 4 elements
    expect(result.content).toContain("4 lines");
  });

  // ---------------------------------------------------------------------------
  // Overwriting
  // ---------------------------------------------------------------------------

  test("overwrites an existing file", async () => {
    const result = await doWrite({
      file_path: join(tmpDir, "existing.txt"),
      content: "new content\n",
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(join(tmpDir, "existing.txt"));
    expect(disk).toBe("new content\n");
    expect(disk).not.toContain("original");
  });

  // ---------------------------------------------------------------------------
  // Parent directory creation
  // ---------------------------------------------------------------------------

  test("creates nested parent directories automatically", async () => {
    const deepPath = join(tmpDir, "deep", "nested", "dir", "file.txt");
    const result = await doWrite({
      file_path: deepPath,
      content: "deep write\n",
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(deepPath);
    expect(disk).toBe("deep write\n");
  });

  // ---------------------------------------------------------------------------
  // Empty content
  // ---------------------------------------------------------------------------

  test("writes empty content (0 bytes)", async () => {
    const result = await doWrite({
      file_path: join(tmpDir, "empty.txt"),
      content: "",
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("0 bytes");
    expect(result.content).toContain("0 lines");

    const disk = await diskRead(join(tmpDir, "empty.txt"));
    expect(disk).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Path resolution
  // ---------------------------------------------------------------------------

  test("relative path resolves from working directory", async () => {
    const result = await doWrite({
      file_path: "relative.txt",
      content: "relative write\n",
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(join(tmpDir, "relative.txt"));
    expect(disk).toBe("relative write\n");
  });

  test("path with .. resolves correctly", async () => {
    await mkdir(join(tmpDir, "sub"), { recursive: true });
    const result = await doWrite({
      file_path: "sub/../dotdot.txt",
      content: "dotdot\n",
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(join(tmpDir, "dotdot.txt"));
    expect(disk).toBe("dotdot\n");
  });

  test("path with . resolves correctly", async () => {
    const result = await doWrite({
      file_path: "./dot.txt",
      content: "dot\n",
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(join(tmpDir, "dot.txt"));
    expect(disk).toBe("dot\n");
  });

  // ---------------------------------------------------------------------------
  // CRLF preservation (we do NOT normalize on write)
  // ---------------------------------------------------------------------------

  test("CRLF content is preserved as-is on write", async () => {
    const crlf_content = "line1\r\nline2\r\nline3\r\n";
    const result = await doWrite({
      file_path: join(tmpDir, "crlf.txt"),
      content: crlf_content,
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(join(tmpDir, "crlf.txt"));
    expect(disk).toBe(crlf_content);
    expect(disk).toContain("\r\n");
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("missing file_path returns error", async () => {
    const result = await doWrite({ file_path: "", content: "x" });
    expect(result.type).toBe("error");
    expect(result.content).toContain("Missing required parameter: file_path");
  });

  test("missing content (undefined) returns error", async () => {
    const result = await doWrite({ file_path: "foo.txt", content: undefined as any });
    expect(result.type).toBe("error");
    expect(result.content).toContain("Missing required parameter: content");
  });

  test("null content returns error", async () => {
    const result = await doWrite({ file_path: "foo.txt", content: null as any });
    expect(result.type).toBe("error");
    expect(result.content).toContain("Missing required parameter: content");
  });

  test("writing to an existing directory returns error", async () => {
    const result = await doWrite({
      file_path: join(tmpDir, "a-directory"),
      content: "nope",
    });
    expect(result.type).toBe("error");
    expect(result.content).toContain("Cannot write to a directory");
  });

  // ---------------------------------------------------------------------------
  // AbortSignal
  // ---------------------------------------------------------------------------

  test("pre-aborted signal returns error without writing", async () => {
    const controller = new AbortController();
    controller.abort();
    const target = join(tmpDir, "should-not-exist.txt");
    const result = await doWrite(
      { file_path: target, content: "nope" },
      { abort_signal: controller.signal },
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("aborted");

    // Verify file was NOT created
    let exists = true;
    try { await stat(target); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Top-level error catch
  // ---------------------------------------------------------------------------

  test("unexpected errors are caught by top-level handler", async () => {
    const badContext: any = {
      session_id: "test",
      working_directory: tmpDir,
      emit: () => {},
      get abort_signal(): AbortSignal {
        throw new Error("unexpected boom");
      },
    };
    const result = await executeWriteFile(
      { file_path: "foo.txt", content: "x" },
      badContext,
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("unexpected boom");
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  test("result includes metadata", async () => {
    const result = await doWrite({
      file_path: join(tmpDir, "meta.txt"),
      content: "abc\ndef\n",
    });
    expect(result.type).toBe("text");
    const meta = (result as any).metadata;
    expect(meta).toBeDefined();
    expect(meta.file_path).toContain("meta.txt");
    expect(meta.bytes_written).toBe(8); // "abc\ndef\n" = 8 bytes
    expect(meta.lines).toBe(3); // ["abc", "def", ""] = 3
  });

  // ---------------------------------------------------------------------------
  // Tool definition
  // ---------------------------------------------------------------------------

  test("tool definition has correct name and schema", () => {
    expect(writeFileToolDefinition.name).toBe("write_file");
    expect(writeFileToolDefinition.permission).toBe("ask_user");
    expect(writeFileToolDefinition.input_schema.required).toEqual(["file_path", "content"]);
    expect(writeFileToolDefinition.input_schema.properties.file_path).toBeDefined();
    expect(writeFileToolDefinition.input_schema.properties.content).toBeDefined();
  });

  test("registers and executes via registry", async () => {
    resetToolRegistry();
    const registry = getToolRegistry();
    registry.register(writeFileToolDefinition);

    expect(registry.has("write_file")).toBe(true);

    const result = await registry.execute(
      "write_file",
      { file_path: join(tmpDir, "registry.txt"), content: "via registry\n" },
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("Wrote");

    const disk = await diskRead(join(tmpDir, "registry.txt"));
    expect(disk).toBe("via registry\n");

    resetToolRegistry();
  });

  test("API definition excludes internal fields", () => {
    resetToolRegistry();
    const registry = getToolRegistry();
    registry.register(writeFileToolDefinition);

    const apiDefs = registry.getApiDefinitions();
    expect(apiDefs.length).toBe(1);
    expect(apiDefs[0].name).toBe("write_file");
    expect((apiDefs[0] as any).execute).toBeUndefined();
    expect((apiDefs[0] as any).permission).toBeUndefined();

    resetToolRegistry();
  });

  // ---------------------------------------------------------------------------
  // Large content
  // ---------------------------------------------------------------------------

  test("writes large content without issues", async () => {
    const large = "x".repeat(500_000) + "\n";
    const result = await doWrite({
      file_path: join(tmpDir, "large.txt"),
      content: large,
    });
    expect(result.type).toBe("text");
    expect(result.content).toContain("500001 bytes");

    const disk = await diskRead(join(tmpDir, "large.txt"));
    expect(disk.length).toBe(500_001);
  });

  // ---------------------------------------------------------------------------
  // Unicode content
  // ---------------------------------------------------------------------------

  test("writes unicode content correctly", async () => {
    const unicode = "你好世界\néèê\n\u{1F600}\n";
    const result = await doWrite({
      file_path: join(tmpDir, "unicode.txt"),
      content: unicode,
    });
    expect(result.type).toBe("text");

    const disk = await diskRead(join(tmpDir, "unicode.txt"));
    expect(disk).toBe(unicode);
  });
});
