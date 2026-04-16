// =============================================================================
// Tests: Markdown & StreamingMarkdown Components
//
// Tests for the React (Ink) markdown rendering components:
// - Token caching (LRU, plain-text fast path)
// - Token formatting (headings, code, lists, inline styles, tables)
// - <Markdown> component (renders to React elements)
// - <StreamingMarkdown> component (stable-prefix optimization)
// - Integration with MessageList (dot alignment, streaming → committed)
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { Box, Text } from "ink";
import {
  Markdown,
  StreamingMarkdown,
  cachedLexer,
  formatToken,
  hashContent,
} from "../src/tui/components/markdown.js";
import { MessageList } from "../src/tui/components/message_list.js";
import type { DisplayMessage } from "../src/tui/types.js";

const tick = (ms = 100) => new Promise<void>((r) => setTimeout(r, ms));

// =============================================================================
// cachedLexer — Token Caching & Fast Path
// =============================================================================

describe("cachedLexer", () => {
  test("plain text returns single paragraph token (fast path)", () => {
    const tokens = cachedLexer("Hello world");
    expect(tokens.length).toBe(1);
    expect(tokens[0].type).toBe("paragraph");
    expect((tokens[0] as any).text).toBe("Hello world");
  });

  test("markdown with heading returns multiple tokens", () => {
    const tokens = cachedLexer("# Title\n\nParagraph");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens[0].type).toBe("heading");
  });

  test("markdown with code fence is parsed", () => {
    const tokens = cachedLexer("```javascript\nconsole.log('hi')\n```");
    const codeToken = tokens.find((t) => t.type === "code");
    expect(codeToken).toBeDefined();
    expect((codeToken as any).text).toContain("console.log");
  });

  test("cache returns same result for same content", () => {
    const a = cachedLexer("# Cached");
    const b = cachedLexer("# Cached");
    expect(a).toBe(b); // Same reference (cache hit)
  });

  test("cache returns different results for different content", () => {
    const a = cachedLexer("# One");
    const b = cachedLexer("# Two");
    expect(a).not.toBe(b);
  });

  test("hash function produces consistent results", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  test("unclosed code fence is parsed as single code token", () => {
    // This is the key property that makes StreamingMarkdown safe
    const tokens = cachedLexer("```python\ndef foo():\n  pass");
    const codeToken = tokens.find((t) => t.type === "code");
    expect(codeToken).toBeDefined();
    expect((codeToken as any).text).toContain("def foo():");
  });
});

// =============================================================================
// formatToken — ANSI String Rendering
// =============================================================================

describe("formatToken", () => {
  test("heading renders bold cyan", () => {
    const tokens = cachedLexer("# Hello");
    const output = formatToken(tokens[0]);
    expect(output).toContain("Hello");
    expect(output).toContain("\x1b[1;36m"); // Bold cyan
    expect(output).toContain("\x1b[0m"); // Reset
  });

  test("paragraph renders plain text with newline", () => {
    const tokens = cachedLexer("Simple text");
    const output = formatToken(tokens[0]);
    expect(output).toContain("Simple text");
    expect(output.endsWith("\n")).toBe(true);
  });

  test("code block renders with syntax highlighting", () => {
    const tokens = cachedLexer("```javascript\nconst x = 1;\n```");
    const codeToken = tokens.find((t) => t.type === "code");
    const output = formatToken(codeToken!);
    expect(output).toContain("const");
    expect(output).toContain("[javascript]"); // Language label
  });

  test("code block without language renders without label", () => {
    const tokens = cachedLexer("```\nplain code\n```");
    const codeToken = tokens.find((t) => t.type === "code");
    const output = formatToken(codeToken!);
    expect(output).toContain("plain code");
    expect(output).not.toContain("[");
  });

  test("inline code renders cyan", () => {
    const tokens = cachedLexer("Use `foo()` here");
    const output = formatToken(tokens[0]);
    expect(output).toContain("\x1b[36m"); // Cyan
    expect(output).toContain("foo()");
  });

  test("bold renders with bold escape", () => {
    const tokens = cachedLexer("**bold text**");
    const output = formatToken(tokens[0]);
    expect(output).toContain("\x1b[1m"); // Bold
    expect(output).toContain("bold text");
  });

  test("italic renders with italic escape", () => {
    const tokens = cachedLexer("*italic text*");
    const output = formatToken(tokens[0]);
    expect(output).toContain("\x1b[3m"); // Italic
    expect(output).toContain("italic text");
  });

  test("unordered list renders with bullets", () => {
    const tokens = cachedLexer("- Item 1\n- Item 2");
    const listToken = tokens.find((t) => t.type === "list");
    const output = formatToken(listToken!);
    expect(output).toContain("- Item 1");
    expect(output).toContain("- Item 2");
  });

  test("ordered list renders with numbers", () => {
    const tokens = cachedLexer("1. First\n2. Second");
    const listToken = tokens.find((t) => t.type === "list");
    const output = formatToken(listToken!);
    expect(output).toContain("1. First");
    expect(output).toContain("2. Second");
  });

  test("blockquote renders with bar", () => {
    const tokens = cachedLexer("> Quoted text");
    const bqToken = tokens.find((t) => t.type === "blockquote");
    const output = formatToken(bqToken!);
    expect(output).toContain("│");
    expect(output).toContain("Quoted text");
  });

  test("link renders with underline and URL", () => {
    const tokens = cachedLexer("[Click here](https://example.com)");
    const output = formatToken(tokens[0]);
    expect(output).toContain("Click here");
    expect(output).toContain("https://example.com");
  });

  test("horizontal rule renders dashes", () => {
    const tokens = cachedLexer("---");
    const hrToken = tokens.find((t) => t.type === "hr");
    const output = formatToken(hrToken!);
    expect(output).toContain("─");
  });
});

// =============================================================================
// <Markdown> Component — React Rendering
// =============================================================================

describe("Markdown component", () => {
  test("renders simple text", () => {
    const { lastFrame } = inkRender(<Markdown>Hello world</Markdown>);
    expect(lastFrame()).toContain("Hello world");
  });

  test("renders heading with formatting", () => {
    const { lastFrame } = inkRender(<Markdown>{"# Title"}</Markdown>);
    expect(lastFrame()).toContain("Title");
  });

  test("renders code block", () => {
    const { lastFrame } = inkRender(
      <Markdown>{"```javascript\nconst x = 1;\n```"}</Markdown>,
    );
    expect(lastFrame()).toContain("const");
    expect(lastFrame()).toContain("[javascript]");
  });

  test("renders inline code", () => {
    const { lastFrame } = inkRender(
      <Markdown>{"Use `foo()` here"}</Markdown>,
    );
    expect(lastFrame()).toContain("foo()");
  });

  test("renders bold text", () => {
    const { lastFrame } = inkRender(<Markdown>{"**bold**"}</Markdown>);
    expect(lastFrame()).toContain("bold");
  });

  test("renders list", () => {
    const { lastFrame } = inkRender(
      <Markdown>{"- Item 1\n- Item 2\n- Item 3"}</Markdown>,
    );
    expect(lastFrame()).toContain("Item 1");
    expect(lastFrame()).toContain("Item 2");
    expect(lastFrame()).toContain("Item 3");
  });

  test("strips leading newlines", () => {
    const { lastFrame } = inkRender(<Markdown>{"\n\nHello"}</Markdown>);
    expect(lastFrame()).toContain("Hello");
  });

  test("renders empty string without error", () => {
    const { lastFrame } = inkRender(<Markdown>{""}</Markdown>);
    expect(lastFrame()).toBeDefined();
  });

  test("renders mixed content (heading + paragraph + code)", () => {
    const content = "# Title\n\nSome text here.\n\n```\ncode\n```";
    const { lastFrame } = inkRender(<Markdown>{content}</Markdown>);
    const output = lastFrame();
    expect(output).toContain("Title");
    expect(output).toContain("Some text here.");
    expect(output).toContain("code");
  });

  test("renders table", () => {
    const content = "| A | B |\n|---|---|\n| 1 | 2 |";
    const { lastFrame } = inkRender(<Markdown>{content}</Markdown>);
    const output = lastFrame();
    expect(output).toContain("A");
    expect(output).toContain("B");
    expect(output).toContain("1");
    expect(output).toContain("2");
  });
});

// =============================================================================
// <StreamingMarkdown> Component — Stable Prefix
// =============================================================================

describe("StreamingMarkdown component", () => {
  test("renders plain streaming text", () => {
    const { lastFrame } = inkRender(
      <StreamingMarkdown>Hello world</StreamingMarkdown>,
    );
    expect(lastFrame()).toContain("Hello world");
  });

  test("renders growing text without flickering", async () => {
    const { lastFrame, rerender } = inkRender(
      <StreamingMarkdown>Hello</StreamingMarkdown>,
    );
    expect(lastFrame()).toContain("Hello");

    rerender(<StreamingMarkdown>Hello world</StreamingMarkdown>);
    await tick(50);
    expect(lastFrame()).toContain("Hello world");
  });

  test("renders markdown during streaming (completed blocks)", async () => {
    // First paragraph is complete (double newline), second is growing
    const { lastFrame } = inkRender(
      <StreamingMarkdown>
        {"# Title\n\nGrowing text"}
      </StreamingMarkdown>,
    );
    const output = lastFrame();
    expect(output).toContain("Title");
    expect(output).toContain("Growing text");
  });

  test("stable prefix advances as blocks complete", async () => {
    const { lastFrame, rerender } = inkRender(
      <StreamingMarkdown>{"First paragraph."}</StreamingMarkdown>,
    );

    // Add a second paragraph (first is now complete)
    rerender(
      <StreamingMarkdown>
        {"First paragraph.\n\nSecond paragraph."}
      </StreamingMarkdown>,
    );
    await tick(50);
    const output = lastFrame();
    expect(output).toContain("First paragraph.");
    expect(output).toContain("Second paragraph.");
  });

  test("handles code blocks during streaming", () => {
    // Unclosed code fence — should be treated as single growing block
    const { lastFrame } = inkRender(
      <StreamingMarkdown>
        {"Some text\n\n```python\ndef foo():"}
      </StreamingMarkdown>,
    );
    const output = lastFrame();
    expect(output).toContain("Some text");
    expect(output).toContain("def foo():");
  });

  test("strips leading newlines", () => {
    const { lastFrame } = inkRender(
      <StreamingMarkdown>{"\n\nHello"}</StreamingMarkdown>,
    );
    expect(lastFrame()).toContain("Hello");
  });

  test("handles empty string", () => {
    const { lastFrame } = inkRender(
      <StreamingMarkdown>{""}</StreamingMarkdown>,
    );
    expect(lastFrame()).toBeDefined();
  });

  test("resets on text replacement (not append)", async () => {
    const { lastFrame, rerender } = inkRender(
      <StreamingMarkdown>Original text</StreamingMarkdown>,
    );

    // Replace text entirely (not an append)
    rerender(<StreamingMarkdown>Completely different</StreamingMarkdown>);
    await tick(50);
    expect(lastFrame()).toContain("Completely different");
    expect(lastFrame()).not.toContain("Original");
  });
});

// =============================================================================
// Integration: MessageList with Markdown Components
// =============================================================================

describe("MessageList with Markdown", () => {
  test("committed assistant message renders formatted markdown", () => {
    const messages: DisplayMessage[] = [
      {
        id: "1",
        role: "assistant",
        text: "**Bold** and `code`",
        timestamp: "2024-01-01",
      },
    ];
    const { lastFrame } = inkRender(
      <MessageList messages={messages} model="claude-sonnet-4-6" />,
    );
    const output = lastFrame();
    expect(output).toContain("⏺");
    expect(output).toContain("Bold");
    expect(output).toContain("code");
  });

  test("streaming message renders with StreamingMarkdown", () => {
    const streaming: DisplayMessage = {
      id: "s1",
      role: "assistant",
      text: "**Bold** streaming",
      timestamp: "2024-01-01",
    };
    const { lastFrame } = inkRender(
      <MessageList
        messages={[streaming]}
        model="claude-sonnet-4-6"
        streamingMessage={streaming}
      />,
    );
    const output = lastFrame();
    expect(output).toContain("⏺");
    expect(output).toContain("Bold");
    expect(output).toContain("streaming");
    expect(output).toContain("▍"); // Cursor
  });

  test("⏺ dot is on same line as text (committed)", () => {
    const messages: DisplayMessage[] = [
      { id: "1", role: "assistant", text: "Hello world", timestamp: "2024-01-01" },
    ];
    const { lastFrame } = inkRender(
      <MessageList messages={messages} model="claude-sonnet-4-6" />,
    );
    const lines = lastFrame().split("\n");
    const dotLine = lines.find((l) => l.includes("⏺"));
    expect(dotLine).toBeDefined();
    expect(dotLine).toContain("Hello world");
  });

  test("⏺ dot is on same line as text (streaming)", () => {
    const streaming: DisplayMessage = {
      id: "s1",
      role: "assistant",
      text: "Live response",
      timestamp: "2024-01-01",
    };
    const { lastFrame } = inkRender(
      <MessageList
        messages={[streaming]}
        model="claude-sonnet-4-6"
        streamingMessage={streaming}
      />,
    );
    const lines = lastFrame().split("\n");
    const dotLine = lines.find((l) => l.includes("⏺"));
    expect(dotLine).toBeDefined();
    expect(dotLine).toContain("Live response");
  });

  test("dot alignment works with leading newlines", () => {
    const messages: DisplayMessage[] = [
      { id: "1", role: "assistant", text: "\nHello world", timestamp: "2024-01-01" },
    ];
    const { lastFrame } = inkRender(
      <MessageList messages={messages} model="claude-sonnet-4-6" />,
    );
    const lines = lastFrame().split("\n");
    const dotLine = lines.find((l) => l.includes("⏺"));
    expect(dotLine).toBeDefined();
    expect(dotLine).toContain("Hello world");
  });

  test("streaming code block renders during streaming", () => {
    const streaming: DisplayMessage = {
      id: "s1",
      role: "assistant",
      text: "Here is code:\n\n```python\nprint('hello')\n```\n\nDone.",
      timestamp: "2024-01-01",
    };
    const { lastFrame } = inkRender(
      <MessageList
        messages={[streaming]}
        model="claude-sonnet-4-6"
        streamingMessage={streaming}
      />,
    );
    const output = lastFrame();
    expect(output).toContain("Here is code:");
    expect(output).toContain("print");
    expect(output).toContain("Done.");
  });
});
