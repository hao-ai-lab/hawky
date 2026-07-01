// =============================================================================
// Tests for edit_file tool — comprehensive coverage of all 6 fuzzy strategies,
// error handling, edge cases, and realistic end-to-end editing scenarios.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { executeEditFile, editFileToolDefinition } from "../src/tools/edit_file.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
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

async function edit(
  input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
  overrides?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeEditFile(input, ctx(overrides));
}

async function disk(path: string): Promise<string> { return readFile(path, "utf-8"); }

async function file(name: string, content: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, content);
  return p;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hawky-edit-test-"));
  await mkdir(join(tmpDir, "sub"));
});

afterAll(async () => { await rm(tmpDir, { recursive: true, force: true }); });

// =============================================================================
// Strategy 1: Verbatim (exact match)
// =============================================================================

describe("Strategy 1: Verbatim", () => {
  test("exact single-line match", async () => {
    const p = await file("v1.txt", "hello world\n");
    const r = await edit({ file_path: p, old_string: "hello", new_string: "goodbye" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toBe("goodbye world\n");
  });

  test("exact multi-line match", async () => {
    const p = await file("v2.txt", "aaa\nbbb\nccc\n");
    const r = await edit({ file_path: p, old_string: "aaa\nbbb", new_string: "XXX\nYYY" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toBe("XXX\nYYY\nccc\n");
  });

  test("exact match preserves surrounding content", async () => {
    const p = await file("v3.txt", "before\ntarget\nafter\n");
    await edit({ file_path: p, old_string: "target", new_string: "REPLACED" });
    const d = await disk(p);
    expect(d).toContain("before");
    expect(d).toContain("REPLACED");
    expect(d).toContain("after");
  });
});

// =============================================================================
// Strategy 2: Flexible indent
// =============================================================================

describe("Strategy 2: Flexible indent", () => {
  test("per-line trim: search without indentation matches indented code", async () => {
    const p = await file("fi1.txt", "class Foo {\n    method() {\n        return 1;\n    }\n}\n");
    const r = await edit({
      file_path: p,
      old_string: "method() {\n    return 1;\n}",
      new_string: "    method() {\n        return 42;\n    }",
    });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("return 42");
  });

  test("per-line trim: extra trailing spaces ignored", async () => {
    const p = await file("fi2.txt", "  line with spaces  \nnext\n");
    const r = await edit({
      file_path: p,
      old_string: "line with spaces",
      new_string: "  cleaned line  ",
    });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("cleaned line");
  });

  test("base-indent removal: 0-indent search matches 4-indent code", async () => {
    const code = "    if (true) {\n        doStuff();\n    }\n";
    const p = await file("fi3.txt", code);
    const r = await edit({
      file_path: p,
      old_string: "if (true) {\n    doStuff();\n}",
      new_string: "    if (false) {\n        doNothing();\n    }",
    });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("doNothing");
  });

  test("base-indent removal: 2-indent search matches 6-indent code", async () => {
    const code = "      const x = 1;\n      const y = 2;\n";
    const p = await file("fi4.txt", code);
    const r = await edit({
      file_path: p,
      old_string: "  const x = 1;\n  const y = 2;",
      new_string: "      const x = 10;\n      const y = 20;",
    });
    expect(r.type).toBe("text");
    const d = await disk(p);
    expect(d).toContain("x = 10");
    expect(d).toContain("y = 20");
  });
});

// =============================================================================
// Strategy 3: Normalized space
// =============================================================================

describe("Strategy 3: Normalized space", () => {
  test("tabs vs spaces", async () => {
    const p = await file("ns1.txt", "key:\t\tvalue\n");
    const r = await edit({ file_path: p, old_string: "key: value", new_string: "key:\t\tnew_value" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("new_value");
  });

  test("multiple spaces collapsed to one", async () => {
    const p = await file("ns2.txt", "foo   bar   baz\n");
    const r = await edit({ file_path: p, old_string: "foo bar baz", new_string: "replaced" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toBe("replaced\n");
  });

  test("multi-line block with whitespace diffs", async () => {
    const p = await file("ns3.txt", "  a  b\n  c  d\n");
    const r = await edit({ file_path: p, old_string: "a b\nc d", new_string: "  x y\n  z w" });
    expect(r.type).toBe("text");
    const d = await disk(p);
    expect(d).toContain("x y");
    expect(d).toContain("z w");
  });
});

// =============================================================================
// Strategy 4: Unescaped
// =============================================================================

describe("Strategy 4: Unescaped", () => {
  test("literal \\n in search matches actual newline", async () => {
    const p = await file("ue1.txt", "line1\nline2\n");
    const r = await edit({ file_path: p, old_string: "line1\\nline2", new_string: "merged" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toBe("merged\n");
  });

  test("literal \\t in search matches actual tab", async () => {
    const p = await file("ue2.txt", "col1\tcol2\n");
    const r = await edit({ file_path: p, old_string: "col1\\tcol2", new_string: "col1\tnewcol2" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("newcol2");
  });

  test("literal \\\\ in search matches actual backslash", async () => {
    const p = await file("ue3.txt", "path\\to\\file\n");
    const r = await edit({ file_path: p, old_string: "path\\\\to\\\\file", new_string: "path/to/file" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toBe("path/to/file\n");
  });
});

// =============================================================================
// Strategy 5: Boundary trimmed
// =============================================================================

describe("Strategy 5: Boundary trimmed", () => {
  test("leading/trailing whitespace in search trimmed", async () => {
    const p = await file("bt1.txt", "target string\nafter\n");
    const r = await edit({ file_path: p, old_string: "  target string  ", new_string: "replaced" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("replaced");
  });

  test("leading newline in search trimmed", async () => {
    const p = await file("bt2.txt", "findme\nkeep\n");
    const r = await edit({ file_path: p, old_string: "\nfindme", new_string: "found" });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("found");
  });
});

// =============================================================================
// Strategy 6: Anchor scan
// =============================================================================

describe("Strategy 6: Anchor scan", () => {
  test("fixed-length: matches by first/last line anchors with >=50% inner match", async () => {
    const code = [
      "function process() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  return a + b + c;",
      "}",
      "",
    ].join("\n");
    const p = await file("as1.txt", code);
    // Search with slightly different inner lines
    const r = await edit({
      file_path: p,
      old_string: "function process() {\n  const a = 1;\n  const b = 2;\n  const c = WRONG;\n  return a + b + c;\n}",
      new_string: "function process() {\n  return 42;\n}",
    });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("return 42");
  });

  test("variable-length: matches span between anchors via similarity", async () => {
    const code = [
      "// start marker",
      "  line A content here",
      "  line B content here",
      "  line C content here",
      "// end marker",
      "",
    ].join("\n");
    const p = await file("as2.txt", code);
    // Search with fewer inner lines but same anchors and similar content
    const r = await edit({
      file_path: p,
      old_string: "// start marker\n  line A content here\n  line B content here\n// end marker",
      new_string: "// start marker\n  replaced content\n// end marker",
    });
    expect(r.type).toBe("text");
    expect(await disk(p)).toContain("replaced content");
  });
});

// =============================================================================
// replace_all
// =============================================================================

describe("replace_all", () => {
  test("replaces all occurrences", async () => {
    const p = await file("ra1.txt", "foo bar foo baz foo\n");
    const r = await edit({ file_path: p, old_string: "foo", new_string: "qux", replace_all: true });
    expect(r.type).toBe("text");
    expect(r.content).toContain("3 occurrence(s)");
    expect(await disk(p)).toBe("qux bar qux baz qux\n");
  });

  test("replace_all with no matches returns error", async () => {
    const p = await file("ra2.txt", "hello\n");
    const r = await edit({ file_path: p, old_string: "nope", new_string: "x", replace_all: true });
    expect(r.type).toBe("error");
    expect(r.content).toContain("not found");
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("Error handling", () => {
  test("not found returns error", async () => {
    const p = await file("err1.txt", "hello world\n");
    const r = await edit({ file_path: p, old_string: "nonexistent", new_string: "x" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("not found");
  });

  test("not found with near-match suggests closest", async () => {
    const p = await file("err1b.txt", "function calculate() {\n  return 42;\n}\n");
    const r = await edit({
      file_path: p,
      old_string: "function calcualte() {\n  return 42;\n}",  // typo in name
      new_string: "x",
    });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Did you mean");
  });

  test("not found truncates long old_string in error", async () => {
    const p = await file("err2.txt", "short\n");
    const r = await edit({ file_path: p, old_string: "x".repeat(100), new_string: "y" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("...");
  });

  test("multiple matches without replace_all returns error", async () => {
    const p = await file("err3.txt", "foo\nbar\nfoo\n");
    const r = await edit({ file_path: p, old_string: "foo", new_string: "baz" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("multiple times");
  });

  test("old_string === new_string returns error", async () => {
    const p = await file("err4.txt", "hello\n");
    const r = await edit({ file_path: p, old_string: "hello", new_string: "hello" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("must be different");
  });

  test("empty old_string returns error", async () => {
    const p = await file("err4b.txt", "hello\n");
    const r = await edit({ file_path: p, old_string: "", new_string: "prefix" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("old_string must be non-empty");
    expect(await disk(p)).toBe("hello\n");
  });

  test("empty old_string with replace_all returns error", async () => {
    const p = await file("err4c.txt", "hello\n");
    const r = await edit({ file_path: p, old_string: "", new_string: "prefix", replace_all: true });
    expect(r.type).toBe("error");
    expect(r.content).toContain("old_string must be non-empty");
    expect(await disk(p)).toBe("hello\n");
  });

  test("non-string old_string returns error", async () => {
    const p = await file("err4d.txt", "hello\n");
    const r = await edit({ file_path: p, old_string: 123 as any, new_string: "hi" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("old_string must be a string");
    expect(await disk(p)).toBe("hello\n");
  });

  test("non-string new_string returns error", async () => {
    const p = await file("err4e.txt", "hello\n");
    const r = await edit({ file_path: p, old_string: "hello", new_string: 123 as any });
    expect(r.type).toBe("error");
    expect(r.content).toContain("new_string must be a string");
    expect(await disk(p)).toBe("hello\n");
  });

  test("non-boolean replace_all returns error", async () => {
    const p = await file("err4f.txt", "hello\nhello\n");
    const r = await edit({ file_path: p, old_string: "hello", new_string: "hi", replace_all: "false" as any });
    expect(r.type).toBe("error");
    expect(r.content).toContain("replace_all must be a boolean");
    expect(await disk(p)).toBe("hello\nhello\n");
  });

  test("missing file_path", async () => {
    const r = await edit({ file_path: "", old_string: "x", new_string: "y" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: file_path");
  });

  test("missing old_string", async () => {
    const r = await edit({ file_path: "f.txt", old_string: undefined as any, new_string: "y" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: old_string");
  });

  test("missing new_string", async () => {
    const r = await edit({ file_path: "f.txt", old_string: "x", new_string: undefined as any });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: new_string");
  });

  test("file not found", async () => {
    const r = await edit({ file_path: join(tmpDir, "nope.txt"), old_string: "x", new_string: "y" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("File not found");
  });

  test("editing a directory", async () => {
    const r = await edit({ file_path: join(tmpDir, "sub"), old_string: "x", new_string: "y" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Cannot edit a directory");
  });
});

// =============================================================================
// Line ending preservation, dollar safety, special chars
// =============================================================================

describe("Special handling", () => {
  test("CRLF preserved after edit", async () => {
    const p = await file("sp1.txt", "hello\r\nworld\r\nfoo\r\n");
    await edit({ file_path: p, old_string: "world", new_string: "WORLD" });
    const d = await disk(p);
    expect(d).toBe("hello\r\nWORLD\r\nfoo\r\n");
  });

  test("dollar signs in new_string preserved", async () => {
    const p = await file("sp2.txt", "price: PLACEHOLDER\n");
    await edit({ file_path: p, old_string: "PLACEHOLDER", new_string: "$100 and $200" });
    expect(await disk(p)).toBe("price: $100 and $200\n");
  });

  test("regex-special chars preserved", async () => {
    const p = await file("sp3.txt", "old value\n");
    await edit({ file_path: p, old_string: "old value", new_string: "$1 $$2 $& $` $'" });
    expect(await disk(p)).toBe("$1 $$2 $& $` $'\n");
  });

  test("empty new_string deletes matched text", async () => {
    const p = await file("sp4.txt", "keep\nremove me\nkeep\n");
    await edit({ file_path: p, old_string: "remove me\n", new_string: "" });
    expect(await disk(p)).toBe("keep\nkeep\n");
  });
});

// =============================================================================
// Context snippet, metadata, abort, top-level catch
// =============================================================================

describe("Result format", () => {
  test("context snippet shows 10 lines around edit", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const p = await file("ctx.txt", lines);
    const r = await edit({ file_path: p, old_string: "line 15", new_string: "EDITED" });
    expect(r.content).toContain("Context after edit:");
    expect(r.content).toContain("EDITED");
    // line 5 should be visible (15 - 10 = 5)
    expect(r.content).toContain("line 5");
    // line 25 should be visible (15 + 10 = 25)
    expect(r.content).toContain("line 25");
  });

  test("metadata includes line counts", async () => {
    const p = await file("meta.txt", "aaa\nbbb\nccc\n");
    const r = await edit({ file_path: p, old_string: "bbb", new_string: "BBB\nDDD" });
    const m = (r as any).metadata;
    expect(m.lines_added).toBe(2);
    expect(m.lines_removed).toBe(1);
    expect(m.replace_all).toBe(false);
  });

  test("pre-aborted signal returns error", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = await file("abort.txt", "hello\n");
    const r = await edit(
      { file_path: p, old_string: "hello", new_string: "bye" },
      { abort_signal: controller.signal },
    );
    expect(r.type).toBe("error");
    expect(await disk(p)).toBe("hello\n"); // unchanged
  });

  test("top-level catch handles unexpected errors", async () => {
    const bad: any = {
      get abort_signal(): AbortSignal { throw new Error("boom"); },
    };
    const r = await executeEditFile({ file_path: "x.txt", old_string: "a", new_string: "b" }, bad);
    expect(r.type).toBe("error");
    expect(r.content).toContain("boom");
  });

  test("relative path resolves from working directory", async () => {
    await writeFile(join(tmpDir, "rel.txt"), "aaa\n");
    const r = await edit({ file_path: "rel.txt", old_string: "aaa", new_string: "bbb" });
    expect(r.type).toBe("text");
    expect(await disk(join(tmpDir, "rel.txt"))).toBe("bbb\n");
  });
});

// =============================================================================
// Tool definition and registry
// =============================================================================

describe("Tool definition", () => {
  test("correct shape", () => {
    expect(editFileToolDefinition.name).toBe("edit_file");
    expect(editFileToolDefinition.permission).toBe("ask_user");
    expect(editFileToolDefinition.input_schema.required).toEqual(["file_path", "old_string", "new_string"]);
    expect(editFileToolDefinition.input_schema.properties.replace_all).toBeDefined();
  });

  test("registry integration", async () => {
    resetToolRegistry();
    const reg = getToolRegistry();
    reg.register(editFileToolDefinition);
    const p = await file("reg.txt", "hello\n");
    const r = await reg.execute("edit_file", { file_path: p, old_string: "hello", new_string: "bye" }, ctx());
    expect(r.type).toBe("text");
    resetToolRegistry();
  });
});

// =============================================================================
// End-to-end: realistic editing scenarios
// =============================================================================

describe("E2E: realistic edits", () => {
  test("fix a bug in a function", async () => {
    const code = "function add(a: number, b: number): number {\n  return a - b; // BUG\n}\n";
    const p = await file("e2e-bug.ts", code);
    await edit({ file_path: p, old_string: "  return a - b; // BUG", new_string: "  return a + b;" });
    const d = await disk(p);
    expect(d).toContain("return a + b;");
    expect(d).not.toContain("BUG");
    expect(d).toContain("function add");
  });

  test("rename a variable across a file", async () => {
    const code = "const oldName = 42;\nconsole.log(oldName);\nfunction use() { return oldName; }\n";
    const p = await file("e2e-rename.ts", code);
    await edit({ file_path: p, old_string: "oldName", new_string: "newName", replace_all: true });
    const d = await disk(p);
    expect(d).not.toContain("oldName");
    expect(d).toContain("const newName = 42;");
    expect(d).toContain("console.log(newName);");
    expect(d).toContain("return newName;");
  });

  test("change an import path", async () => {
    const code = 'import { foo } from "./old-module";\nimport { bar } from "./other";\n\nfoo();\nbar();\n';
    const p = await file("e2e-import.ts", code);
    await edit({
      file_path: p,
      old_string: 'import { foo } from "./old-module";',
      new_string: 'import { foo, baz } from "./new-module";',
    });
    const d = await disk(p);
    expect(d).toContain("./new-module");
    expect(d).toContain("baz");
    expect(d).toContain('import { bar } from "./other";');
  });

  test("add a parameter to a function signature", async () => {
    const code = 'function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n';
    const p = await file("e2e-param.ts", code);
    await edit({
      file_path: p,
      old_string: 'function greet(name: string) {\n  return `Hello, ${name}!`;\n}',
      new_string: 'function greet(name: string, greeting = "Hello") {\n  return `${greeting}, ${name}!`;\n}',
    });
    const d = await disk(p);
    expect(d).toContain('greeting = "Hello"');
    expect(d).toContain("${greeting}");
  });

  test("delete an entire function", async () => {
    const code = "function keep() { return 1; }\n\nfunction remove() {\n  console.log('bye');\n}\n\nfunction alsoKeep() { return 2; }\n";
    const p = await file("e2e-delete.ts", code);
    await edit({
      file_path: p,
      old_string: "\nfunction remove() {\n  console.log('bye');\n}\n",
      new_string: "\n",
    });
    const d = await disk(p);
    expect(d).not.toContain("remove");
    expect(d).toContain("function keep");
    expect(d).toContain("function alsoKeep");
  });

  test("add a method to a class", async () => {
    const code = "class Calculator {\n  add(a: number, b: number) {\n    return a + b;\n  }\n}\n";
    const p = await file("e2e-method.ts", code);
    await edit({
      file_path: p,
      old_string: "  add(a: number, b: number) {\n    return a + b;\n  }\n}",
      new_string: "  add(a: number, b: number) {\n    return a + b;\n  }\n\n  subtract(a: number, b: number) {\n    return a - b;\n  }\n}",
    });
    const d = await disk(p);
    expect(d).toContain("subtract");
    expect(d).toContain("return a - b");
    expect(d).toContain("return a + b");
  });

  test("update a JSON config value", async () => {
    const code = '{\n  "name": "my-app",\n  "version": "1.0.0",\n  "main": "index.js"\n}\n';
    const p = await file("e2e-json.json", code);
    await edit({
      file_path: p,
      old_string: '"version": "1.0.0"',
      new_string: '"version": "2.0.0"',
    });
    const d = await disk(p);
    expect(d).toContain('"version": "2.0.0"');
    expect(d).toContain('"name": "my-app"');
  });

  test("wrap a block in try/catch", async () => {
    const code = "function risky() {\n  doSomething();\n  doMore();\n}\n";
    const p = await file("e2e-trycatch.ts", code);
    await edit({
      file_path: p,
      old_string: "  doSomething();\n  doMore();",
      new_string: "  try {\n    doSomething();\n    doMore();\n  } catch (err) {\n    console.error(err);\n  }",
    });
    const d = await disk(p);
    expect(d).toContain("try {");
    expect(d).toContain("catch (err)");
    expect(d).toContain("console.error");
  });

  test("add an export to an existing file", async () => {
    const code = "const SECRET = 42;\n\nexport function getSecret() {\n  return SECRET;\n}\n";
    const p = await file("e2e-export.ts", code);
    await edit({
      file_path: p,
      old_string: "export function getSecret",
      new_string: "export default function getSecret",
    });
    const d = await disk(p);
    expect(d).toContain("export default function getSecret");
    expect(d).toContain("const SECRET = 42;");
  });

  test("change a CSS property value", async () => {
    const code = ".button {\n  background-color: red;\n  color: white;\n  padding: 10px;\n}\n";
    const p = await file("e2e-css.css", code);
    await edit({
      file_path: p,
      old_string: "  background-color: red;",
      new_string: "  background-color: blue;",
    });
    const d = await disk(p);
    expect(d).toContain("background-color: blue;");
    expect(d).toContain("color: white;");
  });
});
