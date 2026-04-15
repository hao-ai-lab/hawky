// =============================================================================
// Tests for glob tool
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { executeGlob, globToolDefinition } from "../src/tools/glob.js";
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

async function glob(
  input: { pattern: string; path?: string },
  overrides?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeGlob(input, ctx(overrides));
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hawky-glob-test-"));

  // Create a file tree:
  // tmpDir/
  //   src/
  //     app.ts
  //     utils.ts
  //     components/
  //       Button.tsx
  //       Modal.tsx
  //   tests/
  //     app.test.ts
  //   package.json
  //   README.md
  //   .eslintrc.json
  //   node_modules/
  //     dep/
  //       index.js
  //   .git/
  //     config
  //   dist/
  //     bundle.js

  await mkdir(join(tmpDir, "src", "components"), { recursive: true });
  await mkdir(join(tmpDir, "tests"), { recursive: true });
  await mkdir(join(tmpDir, "node_modules", "dep"), { recursive: true });
  await mkdir(join(tmpDir, ".git"), { recursive: true });
  await mkdir(join(tmpDir, "dist"), { recursive: true });

  await writeFile(join(tmpDir, "src", "app.ts"), "export {};\n");
  await writeFile(join(tmpDir, "src", "utils.ts"), "export {};\n");
  await writeFile(join(tmpDir, "src", "components", "Button.tsx"), "export {};\n");
  await writeFile(join(tmpDir, "src", "components", "Modal.tsx"), "export {};\n");
  await writeFile(join(tmpDir, "tests", "app.test.ts"), "test('x', () => {});\n");
  await writeFile(join(tmpDir, "package.json"), "{}\n");
  await writeFile(join(tmpDir, "README.md"), "# hi\n");
  await writeFile(join(tmpDir, ".eslintrc.json"), "{}\n");
  await writeFile(join(tmpDir, "node_modules", "dep", "index.js"), "module.exports = {};\n");
  await writeFile(join(tmpDir, ".git", "config"), "[core]\n");
  await writeFile(join(tmpDir, "dist", "bundle.js"), "// compiled\n");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Basic matching
// =============================================================================

describe("Basic matching", () => {
  test("**/*.ts finds all TypeScript files", async () => {
    const r = await glob({ pattern: "**/*.ts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/utils.ts");
    expect(r.content).toContain("tests/app.test.ts");
    expect(r.content).toContain("file(s) found");
  });

  test("**/*.tsx finds TSX files only", async () => {
    const r = await glob({ pattern: "**/*.tsx" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Button.tsx");
    expect(r.content).toContain("Modal.tsx");
    expect(r.content).not.toContain("app.ts");
  });

  test("*.json finds only top-level JSON files", async () => {
    const r = await glob({ pattern: "*.json" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("package.json");
    // Should NOT find nested .eslintrc.json if using non-recursive pattern
    // But .eslintrc.json IS at the top level, so it should be found
    expect(r.content).toContain(".eslintrc.json");
  });

  test("src/**/* finds all files under src/", async () => {
    const r = await glob({ pattern: "src/**/*" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/components/Button.tsx");
    expect(r.content).not.toContain("tests/");
    expect(r.content).not.toContain("package.json");
  });
});

// =============================================================================
// Noise directory skipping
// =============================================================================

describe("Noise directory skipping", () => {
  test("skips node_modules", async () => {
    const r = await glob({ pattern: "**/*.js" });
    expect(r.type).toBe("text");
    expect(r.content).not.toContain("node_modules");
  });

  test("skips .git", async () => {
    const r = await glob({ pattern: "**/*" });
    expect(r.type).toBe("text");
    expect(r.content).not.toContain(".git/config");
  });

  test("skips dist", async () => {
    const r = await glob({ pattern: "**/*.js" });
    expect(r.type).toBe("text");
    expect(r.content).not.toContain("dist/bundle.js");
  });
});

// =============================================================================
// Empty results
// =============================================================================

describe("Empty results", () => {
  test("no matches returns informative message (not error)", async () => {
    const r = await glob({ pattern: "**/*.xyz" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No files found");
    expect(r.content).toContain("*.xyz");
    expect((r as any).metadata?.count).toBe(0);
  });
});

// =============================================================================
// Sorting
// =============================================================================

describe("Sorting", () => {
  test("results are sorted alphabetically", async () => {
    const r = await glob({ pattern: "**/*.ts" });
    expect(r.type).toBe("text");
    const lines = r.content.split("\n").filter(l => l.includes(".ts"));
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i] >= lines[i - 1]).toBe(true);
    }
  });
});

// =============================================================================
// Result cap
// =============================================================================

describe("Result cap", () => {
  test("results capped at 500 with truncation notice", async () => {
    // Create 600 files
    const manyDir = join(tmpDir, "manyfiles");
    await mkdir(manyDir, { recursive: true });
    for (let i = 0; i < 600; i++) {
      await writeFile(join(manyDir, `file${String(i).padStart(4, "0")}.txt`), "x\n");
    }

    const r = await glob({ pattern: "manyfiles/**/*.txt" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("[Results limited to 500 matches");
    expect((r as any).metadata?.truncated).toBe(true);
    expect((r as any).metadata?.count).toBe(500);
  });
});

// =============================================================================
// Relative paths
// =============================================================================

describe("Relative paths", () => {
  test("output contains relative paths, not absolute", async () => {
    const r = await glob({ pattern: "**/*.ts" });
    expect(r.type).toBe("text");
    // Should not start with / or contain the tmpDir path
    const lines = r.content.split("\n").filter(l => l.includes(".ts"));
    for (const line of lines) {
      expect(line.startsWith("/")).toBe(false);
    }
  });
});

// =============================================================================
// Path parameter
// =============================================================================

describe("Path parameter", () => {
  test("path narrows search to subdirectory", async () => {
    const r = await glob({ pattern: "**/*.tsx", path: "src/components" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Button.tsx");
    expect(r.content).toContain("Modal.tsx");
    // Should only have 2 files
    expect((r as any).metadata?.count).toBe(2);
  });

  test("nonexistent path returns error", async () => {
    const r = await glob({ pattern: "**/*", path: "nonexistent" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Path not found");
  });

  test("path with .. resolves correctly", async () => {
    const r = await glob({ pattern: "*.ts", path: "src/../tests" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("app.test.ts");
  });
});

// =============================================================================
// Dotfiles
// =============================================================================

describe("Dotfiles", () => {
  test("dotfiles are included", async () => {
    const r = await glob({ pattern: "*.json" });
    expect(r.type).toBe("text");
    expect(r.content).toContain(".eslintrc.json");
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("Error handling", () => {
  test("missing pattern returns error", async () => {
    const r = await glob({ pattern: "" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: pattern");
  });

  test("pre-aborted signal returns error", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await glob({ pattern: "**/*" }, { abort_signal: controller.signal });
    expect(r.type).toBe("error");
    expect(r.content).toContain("aborted");
  });

  test("top-level catch handles unexpected errors", async () => {
    const bad: any = {
      get abort_signal(): AbortSignal { throw new Error("boom"); },
    };
    const r = await executeGlob({ pattern: "**/*" }, bad);
    expect(r.type).toBe("error");
    expect(r.content).toContain("boom");
  });
});

// =============================================================================
// Tool definition and registry
// =============================================================================

describe("Tool definition", () => {
  test("correct shape", () => {
    expect(globToolDefinition.name).toBe("glob");
    expect(globToolDefinition.permission).toBe("auto_approve");
    expect(globToolDefinition.input_schema.required).toEqual(["pattern"]);
    expect(globToolDefinition.input_schema.properties.pattern).toBeDefined();
    expect(globToolDefinition.input_schema.properties.path).toBeDefined();
  });

  test("registry integration", async () => {
    resetToolRegistry();
    const reg = getToolRegistry();
    reg.register(globToolDefinition);

    const r = await reg.execute("glob", { pattern: "**/*.ts" }, ctx());
    expect(r.type).toBe("text");
    expect(r.content).toContain(".ts");

    resetToolRegistry();
  });
});

// =============================================================================
// E2E: realistic glob scenarios
// =============================================================================

describe("E2E: realistic scenarios", () => {
  test("find all test files", async () => {
    const r = await glob({ pattern: "**/*.test.ts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("app.test.ts");
    expect((r as any).metadata?.count).toBe(1);
  });

  test("find all files in components/", async () => {
    const r = await glob({ pattern: "src/components/*" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Button.tsx");
    expect(r.content).toContain("Modal.tsx");
  });

  test("find markdown files at root", async () => {
    const r = await glob({ pattern: "*.md" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("README.md");
  });

  test("find all TypeScript + TSX files", async () => {
    const r = await glob({ pattern: "**/*.{ts,tsx}" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("app.ts");
    expect(r.content).toContain("Button.tsx");
    expect(r.content).toContain("app.test.ts");
  });
});

// =============================================================================
// list_dir replacement: glob("*") covers directory listing use cases
// =============================================================================

describe("list_dir via glob", () => {
  test("glob('*') lists top-level files (like ls)", async () => {
    const r = await glob({ pattern: "*" });
    expect(r.type).toBe("text");
    // Should find top-level files
    expect(r.content).toContain("package.json");
    expect(r.content).toContain("README.md");
    expect(r.content).toContain(".eslintrc.json");
    // Should NOT find nested files
    expect(r.content).not.toContain("app.ts");
    expect(r.content).not.toContain("Button.tsx");
  });

  test("glob('*', { path: 'src' }) lists files in src/ (like ls src/)", async () => {
    const r = await glob({ pattern: "*", path: "src" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("app.ts");
    expect(r.content).toContain("utils.ts");
    // Should NOT include nested components files
    expect(r.content).not.toContain("Button.tsx");
  });

  test("glob('*', { path: 'src/components' }) lists component files", async () => {
    const r = await glob({ pattern: "*", path: "src/components" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Button.tsx");
    expect(r.content).toContain("Modal.tsx");
    expect((r as any).metadata?.count).toBe(2);
  });

  test("glob('*') on empty directory returns no files message", async () => {
    await mkdir(join(tmpDir, "emptydir"), { recursive: true });
    const r = await glob({ pattern: "*", path: "emptydir" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No files found");
  });

  test("glob('src/*') from root lists src contents without path param", async () => {
    const r = await glob({ pattern: "src/*" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("src/app.ts");
    expect(r.content).toContain("src/utils.ts");
  });
});
