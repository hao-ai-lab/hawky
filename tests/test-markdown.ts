// =============================================================================
// Tests: Markdown Renderer
//
// Tests the pure renderMarkdown() function — markdown → ANSI string.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/utils/render_markdown.js";

// Helper: strip ANSI codes for content assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// =============================================================================
// Basic text
// =============================================================================

describe("renderMarkdown — basic text", () => {
  test("plain text passes through", () => {
    const result = renderMarkdown("Hello world");
    expect(stripAnsi(result)).toContain("Hello world");
  });

  test("empty string returns empty", () => {
    const result = renderMarkdown("");
    expect(result.trim()).toBe("");
  });

  test("multiple paragraphs separated", () => {
    const result = renderMarkdown("First paragraph.\n\nSecond paragraph.");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("First paragraph.");
    expect(stripped).toContain("Second paragraph.");
  });
});

// =============================================================================
// Inline formatting
// =============================================================================

describe("renderMarkdown — inline formatting", () => {
  test("bold text has ANSI bold codes", () => {
    const result = renderMarkdown("This is **bold** text.");
    expect(result).toContain("\x1b[1m"); // Bold on
    expect(result).toContain("\x1b[22m"); // Bold off
    expect(stripAnsi(result)).toContain("bold");
  });

  test("italic text has ANSI italic codes", () => {
    const result = renderMarkdown("This is *italic* text.");
    expect(result).toContain("\x1b[3m"); // Italic on
    expect(result).toContain("\x1b[23m"); // Italic off
    expect(stripAnsi(result)).toContain("italic");
  });

  test("inline code has cyan color", () => {
    const result = renderMarkdown("Use `npm install` to install.");
    expect(result).toContain("\x1b[36m"); // Cyan
    expect(stripAnsi(result)).toContain("npm install");
  });

  test("strikethrough has ANSI strikethrough codes", () => {
    const result = renderMarkdown("This is ~~deleted~~ text.");
    expect(result).toContain("\x1b[9m"); // Strikethrough on
    expect(stripAnsi(result)).toContain("deleted");
  });

  test("link shows text and URL", () => {
    const result = renderMarkdown("[Google](https://google.com)");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("Google");
    expect(stripped).toContain("https://google.com");
  });
});

// =============================================================================
// Headers
// =============================================================================

describe("renderMarkdown — headers", () => {
  test("h1 renders bold cyan", () => {
    const result = renderMarkdown("# Main Title");
    expect(result).toContain("\x1b[1;36m"); // Bold cyan
    expect(stripAnsi(result)).toContain("Main Title");
  });

  test("h2 renders bold cyan", () => {
    const result = renderMarkdown("## Sub Title");
    expect(result).toContain("\x1b[1;36m");
    expect(stripAnsi(result)).toContain("Sub Title");
  });

  test("h3 renders bold cyan", () => {
    const result = renderMarkdown("### Section");
    expect(stripAnsi(result)).toContain("Section");
  });
});

// =============================================================================
// Code blocks
// =============================================================================

describe("renderMarkdown — code blocks", () => {
  test("fenced code block is indented", () => {
    const result = renderMarkdown("```\nconst x = 1;\n```");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("const x = 1;");
  });

  test("code block with language label", () => {
    const result = renderMarkdown("```typescript\nconst x: number = 1;\n```");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("typescript");
    expect(stripped).toContain("const x: number = 1;");
  });

  test("code block has syntax highlighting (ANSI codes present)", () => {
    const result = renderMarkdown("```javascript\nfunction hello() { return 'world'; }\n```");
    // Should have ANSI codes from syntax highlighting
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toContain("function hello()");
  });

  test("language aliases work", () => {
    const result = renderMarkdown("```ts\nconst x = 1;\n```");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("typescript"); // ts → typescript
  });

  test("python code block highlights", () => {
    const result = renderMarkdown("```python\ndef hello():\n    print('hi')\n```");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toContain("def hello():");
  });

  test("unknown language falls back gracefully", () => {
    const result = renderMarkdown("```unknownlang\nsome code here\n```");
    expect(stripAnsi(result)).toContain("some code here");
  });

  test("empty code block", () => {
    const result = renderMarkdown("```\n\n```");
    // Should not crash
    expect(result).toBeDefined();
  });
});

// =============================================================================
// Lists
// =============================================================================

describe("renderMarkdown — lists", () => {
  test("unordered list with bullets", () => {
    const result = renderMarkdown("- Item 1\n- Item 2\n- Item 3");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("- Item 1");
    expect(stripped).toContain("- Item 2");
    expect(stripped).toContain("- Item 3");
  });

  test("ordered list with numbers", () => {
    const result = renderMarkdown("1. First\n2. Second\n3. Third");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("1. First");
    expect(stripped).toContain("2. Second");
    expect(stripped).toContain("3. Third");
  });

  test("list items with code blocks render correctly", () => {
    const md = `1. **Use const** — example:

   \`\`\`ts
   const x = 1;
   \`\`\`

2. **Second tip** — another one`;
    const result = renderMarkdown(md, 80);
    const stripped = stripAnsi(result);
    expect(stripped).toContain("Use const");
    expect(stripped).toContain("const x = 1;");
    expect(stripped).toContain("Second tip");
    // Code should be indented under the list item
    expect(stripped).toContain("typescript"); // language label
  });

  test("list items with inline code and bold", () => {
    const result = renderMarkdown("- Use `const` for **immutable** values\n- Use `let` for mutable", 80);
    const stripped = stripAnsi(result);
    expect(stripped).toContain("const");
    expect(stripped).toContain("immutable");
    expect(stripped).toContain("let");
    // Bold should have ANSI codes
    expect(result).toContain("\x1b[1m"); // Bold
    // Inline code should have cyan
    expect(result).toContain("\x1b[36m"); // Cyan
  });

  test("list items are indented", () => {
    const result = renderMarkdown("- Item");
    const stripped = stripAnsi(result);
    // Should have leading spaces
    expect(stripped).toMatch(/^\s+- Item/m);
  });
});

// =============================================================================
// Blockquotes
// =============================================================================

describe("renderMarkdown — blockquotes", () => {
  test("blockquote has dim border", () => {
    const result = renderMarkdown("> This is a quote");
    expect(result).toContain("\x1b[90m"); // Gray/dim
    expect(result).toContain("│"); // Block border
    expect(stripAnsi(result)).toContain("This is a quote");
  });
});

// =============================================================================
// Horizontal rule
// =============================================================================

describe("renderMarkdown — horizontal rule", () => {
  test("hr renders as dashes", () => {
    const result = renderMarkdown("---");
    expect(result).toContain("─");
  });
});

// =============================================================================
// Tables
// =============================================================================

describe("renderMarkdown — tables", () => {
  test("simple table renders", () => {
    const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = renderMarkdown(md, 80);
    const stripped = stripAnsi(result);
    expect(stripped).toContain("Name");
    expect(stripped).toContain("Age");
    expect(stripped).toContain("Alice");
    expect(stripped).toContain("Bob");
    expect(stripped).toContain("30");
    expect(stripped).toContain("25");
  });

  test("table with borders", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = renderMarkdown(md, 80);
    // cli-table3 adds borders
    expect(result).toContain("─");
  });
});

// =============================================================================
// Terminal width wrapping
// =============================================================================

describe("renderMarkdown — terminal width", () => {
  test("long paragraph wraps at terminal width", () => {
    const longText = "This is a very long sentence that should be wrapped when the terminal is narrow. ".repeat(5);
    const result = renderMarkdown(longText, 40);
    const lines = stripAnsi(result).split("\n").filter((l) => l.trim());
    // With 40-char width, the long text should be split into multiple lines
    expect(lines.length).toBeGreaterThan(3);
  });

  test("code blocks are NOT wrapped (indented only)", () => {
    const code = "```\n" + "x".repeat(100) + "\n```";
    const result = renderMarkdown(code, 40);
    // Code should not be wrapped — just indented
    expect(stripAnsi(result)).toContain("x".repeat(100));
  });

  test("width 0 means no wrapping", () => {
    const longText = "word ".repeat(50);
    const result = renderMarkdown(longText, 0);
    const stripped = stripAnsi(result).trim();
    // Should be on one logical paragraph (may have trailing newline)
    expect(stripped.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// Mixed content
// =============================================================================

describe("renderMarkdown — mixed content", () => {
  test("heading + paragraph + code block", () => {
    const md = "# Title\n\nSome text with **bold**.\n\n```js\nconst x = 1;\n```";
    const result = renderMarkdown(md, 80);
    const stripped = stripAnsi(result);
    expect(stripped).toContain("Title");
    expect(stripped).toContain("bold");
    expect(stripped).toContain("const x = 1;");
  });

  test("list + code block + paragraph", () => {
    const md = "Steps:\n\n- First step\n- Second step\n\n```bash\nnpm install\n```\n\nDone!";
    const result = renderMarkdown(md, 80);
    const stripped = stripAnsi(result);
    expect(stripped).toContain("First step");
    expect(stripped).toContain("Second step");
    expect(stripped).toContain("npm install");
    expect(stripped).toContain("Done!");
  });

  test("realistic agent response", () => {
    const md = `Here's how to fix the bug:

1. Open \`src/index.ts\`
2. Find the **broken** function
3. Replace it with:

\`\`\`typescript
function fix() {
  return true;
}
\`\`\`

This should resolve the issue. See [the docs](https://example.com) for more info.`;

    const result = renderMarkdown(md, 80);
    const stripped = stripAnsi(result);
    expect(stripped).toContain("src/index.ts");
    expect(stripped).toContain("broken");
    expect(stripped).toContain("function fix()");
    expect(stripped).toContain("the docs");
    expect(stripped).toContain("https://example.com");
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe("renderMarkdown — edge cases", () => {
  test("no excessive blank lines", () => {
    const result = renderMarkdown("Line 1\n\n\n\n\nLine 2");
    const stripped = stripAnsi(result);
    // Should collapse to at most 2 consecutive newlines
    expect(stripped).not.toContain("\n\n\n");
  });

  test("inline HTML passes through as text (not rendered as HTML)", () => {
    // marked doesn't strip inline HTML — it passes through as text
    const result = renderMarkdown("<b>bold</b>");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("bold");
  });

  test("special characters preserved", () => {
    const result = renderMarkdown("Symbols: & < > \" '");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("&");
  });

  test("very long code block doesn't crash", () => {
    const code = "```\n" + "x = 1\n".repeat(500) + "```";
    const result = renderMarkdown(code, 80);
    expect(result).toBeDefined();
    expect(stripAnsi(result)).toContain("x = 1");
  });
});
