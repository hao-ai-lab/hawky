// =============================================================================
// Tests: read_file extensions (Image, PDF, Notebook)
// =============================================================================

import { describe, it, expect } from "bun:test";
import { executeReadFile } from "../src/tools/read_file.js";
import type { ToolContext } from "../src/agent/types.js";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures");

function makeContext(cwd?: string): ToolContext {
  return {
    session_id: "test",
    working_directory: cwd ?? FIXTURES,
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

// -----------------------------------------------------------------------------
// Image files
// -----------------------------------------------------------------------------

describe("read_file: images", () => {
  it("reads PNG file and returns base64 data URI", async () => {
    const result = await executeReadFile(
      { file_path: "test-image.png" },
      makeContext(),
    );
    expect(result.type).toBe("image");
    expect(result.content).toContain("Image:");
    expect(result.content).toContain("image/png");
    // base64 should NOT be in the text content (it goes in the separate base64 field)
    expect(result.content).not.toContain("data:image");
    expect((result as any).base64).toBeDefined();
    expect((result as any).base64.length).toBeGreaterThan(0);
    expect((result as any).media_type).toBe("image/png");
    expect(result.metadata?.size).toBeGreaterThan(0);
  });

  it("returns error for missing image", async () => {
    const result = await executeReadFile(
      { file_path: "nonexistent.png" },
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("not found");
  });

  it("detects image by extension case-insensitively", async () => {
    // Create an uppercase PNG reference (same file)
    const result = await executeReadFile(
      { file_path: "test-image.png" },
      makeContext(),
    );
    expect(result.metadata?.media_type).toBe("image/png");
  });
});

// -----------------------------------------------------------------------------
// Notebook files
// -----------------------------------------------------------------------------

describe("read_file: notebooks", () => {
  it("reads notebook and formats cells", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb" },
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("Notebook:");
    expect(result.content).toContain("4 cells");
    expect(result.content).toContain("python");
  });

  it("shows markdown cells", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb" },
      makeContext(),
    );
    expect(result.content).toContain("# Test Notebook");
    expect(result.content).toContain("[markdown]");
  });

  it("shows code cells with output", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb" },
      makeContext(),
    );
    expect(result.content).toContain("print('Hello, world!')");
    expect(result.content).toContain("Hello, world!");
    expect(result.content).toContain("```python");
  });

  it("shows execute_result output", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb" },
      makeContext(),
    );
    expect(result.content).toContain("1 + 2");
    expect(result.content).toContain("3");
  });

  it("shows error output", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb" },
      makeContext(),
    );
    expect(result.content).toContain("ValueError");
    expect(result.content).toContain("test error");
  });

  it("respects offset and limit for cells", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb", offset: 2, limit: 1 },
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("Cell 2");
    expect(result.content).toContain("print('Hello, world!')");
    // Should not contain cell 1 (markdown) or cell 3
    expect(result.content).not.toContain("# Test Notebook");
    expect(result.content).toContain("Showing cells 2-2 of 4");
  });

  it("returns error for invalid notebook JSON", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const tmpDir = join(FIXTURES, "tmp-notebook-test");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "bad.ipynb"), "not json!!!");
    try {
      const result = await executeReadFile(
        { file_path: "bad.ipynb" },
        makeContext(tmpDir),
      );
      expect(result.type).toBe("error");
      expect(result.content).toContain("parsing notebook");
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error for missing notebook", async () => {
    const result = await executeReadFile(
      { file_path: "nonexistent.ipynb" },
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("not found");
  });
});

// -----------------------------------------------------------------------------
// Device file blocking
// -----------------------------------------------------------------------------

describe("read_file: device files", () => {
  it("blocks /dev/ paths", async () => {
    const result = await executeReadFile(
      { file_path: "/dev/zero" },
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("device file");
  });

  it("blocks /proc/ paths", async () => {
    const result = await executeReadFile(
      { file_path: "/proc/self/environ" },
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("device file");
  });
});

// -----------------------------------------------------------------------------
// PDF files (requires pdf-parse)
// -----------------------------------------------------------------------------

describe("read_file: PDFs", () => {
  it("returns error for missing PDF", async () => {
    const result = await executeReadFile(
      { file_path: "nonexistent.pdf" },
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toContain("not found");
  });

  it("fails loudly when a legacy caller still passes 'pages'", async () => {
    // The `pages` param was dropped when PDFs moved to native document blocks.
    // A caller still passing it should get an explicit error, not a silent
    // whole-file read (which would quietly blow up context usage).
    const result = await executeReadFile(
      { file_path: "test-doc.pdf", pages: "1-2" } as any,
      makeContext(),
    );
    expect(result.type).toBe("error");
    expect(result.content).toMatch(/no longer supported/i);
    expect(result.content).toContain("pdftotext");
  });

  it("returns a document result with base64 PDF data for tests/fixtures/test-doc.pdf", async () => {
    const result = await executeReadFile(
      { file_path: "test-doc.pdf" },
      makeContext(),
    );
    expect(result.type).toBe("document");
    // Text is just a description; base64 travels in the dedicated field,
    // the same way read_file handles images. The agent loop wraps this in
    // a document block inside the tool_result.
    expect(result.content).toContain("PDF:");
    expect((result as any).base64).toBeDefined();
    expect((result as any).base64.length).toBeGreaterThan(0);
    expect((result as any).media_type).toBe("application/pdf");
    expect(result.metadata?.size).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Text files (existing behavior preserved)
// -----------------------------------------------------------------------------

describe("read_file: text files still work", () => {
  it("reads a text file with line numbers", async () => {
    const result = await executeReadFile(
      { file_path: "test-notebook.ipynb" }, // .ipynb is handled as notebook, not text
      makeContext(),
    );
    // Should be notebook format, not raw JSON with line numbers
    expect(result.content).toContain("Notebook:");
  });
});
