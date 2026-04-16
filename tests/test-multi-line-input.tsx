// =============================================================================
// Multi-Line Input Integration Tests
//
// Tests the actual React component with simulated keyboard input via
// ink-testing-library. Covers: typing, wrapping, cursor display, navigation,
// submission, newline insertion, paste, history.
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { Box, Text } from "ink";
import { MultiLineInput } from "../src/tui/components/multi_line_input.js";

// Higher tick for Ink rendering tests — React state updates need time to flush
// when running concurrently with other test files.
const tick = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

// Wrapper that shows the input in a fixed-width container
function TestInput(props: {
  onSubmit?: (text: string) => void;
  onHistoryBack?: (draft: string) => string | null;
  onHistoryForward?: () => string | null;
}) {
  return (
    <Box width={40}>
      <MultiLineInput
        onSubmit={props.onSubmit ?? (() => {})}
        placeholder="Type here..."
        onHistoryBack={props.onHistoryBack}
        onHistoryForward={props.onHistoryForward}
      />
    </Box>
  );
}

// =============================================================================
// Basic rendering
// =============================================================================

describe("MultiLineInput — rendering", () => {
  test("shows placeholder when empty", () => {
    const { lastFrame } = inkRender(<TestInput />);
    expect(lastFrame()).toContain("Type here...");
  });

  test("shows typed text after input", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    stdin.write("hello");
    await tick();
    expect(lastFrame()).toContain("hello");
  });

  test("shows typed text correctly", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    stdin.write("hi");
    await tick();
    expect(lastFrame()).toContain("hi");
  });

  test("placeholder disappears after typing", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    stdin.write("x");
    await tick();
    expect(lastFrame()).not.toContain("Type here...");
  });
});

// =============================================================================
// Submission
// =============================================================================

describe("MultiLineInput — submission", () => {
  test("Enter submits text", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    stdin.write("hello world");
    await tick();
    stdin.write("\r"); // Enter
    await tick();
    expect(submitted).toBe("hello world");
  });

  test("empty input not submitted", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("");
  });

  test("input cleared after submission", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput onSubmit={() => {}} />);
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Type here...");
  });
});

// =============================================================================
// Newline (Ctrl+J)
// =============================================================================

describe("MultiLineInput — newline", () => {
  test("Ctrl+J inserts newline (shows on next line)", async () => {
    let submitted = "";
    const { lastFrame, stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    stdin.write("line1");
    await tick();
    stdin.write("\n"); // Ctrl+J sends \n
    await tick();
    stdin.write("line2");
    await tick();
    // Should show both lines
    const frame = lastFrame();
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    // Submit and check
    stdin.write("\r");
    await tick();
    expect(submitted).toContain("line1");
    expect(submitted).toContain("line2");
    expect(submitted).toContain("\n");
  });
});

// =============================================================================
// Backspace
// =============================================================================

describe("MultiLineInput — backspace", () => {
  test("backspace deletes character", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    stdin.write("hello");
    await tick();
    stdin.write("\x7f"); // Delete/backspace
    await tick();
    expect(lastFrame()).toContain("hell");
    expect(lastFrame()).not.toContain("hello");
  });

  test("backspace at empty does nothing", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    stdin.write("\x7f");
    await tick();
    expect(lastFrame()).toContain("Type here...");
  });
});

// =============================================================================
// Arrow navigation
// =============================================================================

describe("MultiLineInput — arrow navigation", () => {
  test("left arrow moves cursor (insert verifies position)", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    stdin.write("abc");
    await tick();
    stdin.write("\x1b[D"); // Left arrow (cursor now before 'c')
    await tick();
    stdin.write("X"); // Insert 'X' before 'c'
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("abXc");
  });

  test("right arrow moves cursor forward", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    stdin.write("abc");
    await tick();
    stdin.write("\x1b[D"); // Left
    stdin.write("\x1b[D"); // Left (now at position 1)
    await tick();
    stdin.write("\x1b[C"); // Right (now at position 2)
    await tick();
    stdin.write("X");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("abXc");
  });
});

// =============================================================================
// History navigation
// =============================================================================

describe("MultiLineInput — history", () => {
  test("up arrow triggers history back on first line", async () => {
    let historyRequested = false;
    const { stdin } = inkRender(
      <TestInput
        onHistoryBack={() => { historyRequested = true; return "previous msg"; }}
      />,
    );
    stdin.write("draft");
    await tick();
    stdin.write("\x1b[A"); // Up arrow
    await tick();
    expect(historyRequested).toBe(true);
  });

  test("down arrow triggers history forward on last line", async () => {
    let forwardRequested = false;
    const { stdin } = inkRender(
      <TestInput
        onHistoryForward={() => { forwardRequested = true; return "next msg"; }}
      />,
    );
    stdin.write("\x1b[B"); // Down arrow
    await tick();
    expect(forwardRequested).toBe(true);
  });
});

// =============================================================================
// Paste handling
// =============================================================================

describe("MultiLineInput — paste", () => {
  test("short paste inserts text normally", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    // Simulate pasting 3 lines (below threshold)
    stdin.write("line1\nline2\nline3");
    await tick(100); // Wait for paste buffer flush
    stdin.write("\r");
    await tick();
    expect(submitted).toContain("line1");
    expect(submitted).toContain("line2");
    expect(submitted).toContain("line3");
  });

  test("long paste shows compression marker", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    // Simulate pasting 10 lines (above threshold of 5)
    const longPaste = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    stdin.write(longPaste);
    await tick(100);
    expect(lastFrame()).toContain("Pasted");
    expect(lastFrame()).toContain("lines");
  });
});

// =============================================================================
// Text wrapping visual verification
// =============================================================================

describe("MultiLineInput — wrapping", () => {
  test("long text doesn't crash rendering", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    // Type text longer than 40-char container width
    const longText = "The quick brown fox jumps over the lazy dog repeatedly";
    stdin.write(longText);
    await tick();
    // Should not throw, should render something
    const frame = lastFrame();
    expect(frame).toBeTruthy();
    expect(frame.length).toBeGreaterThan(0);
  });

  test("wrapped text preserves all content on submit", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    const longText = "abcdefghij".repeat(5); // 50 chars
    stdin.write(longText);
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe(longText);
  });

  test("long text renders without crash", async () => {
    const { lastFrame, stdin } = inkRender(<TestInput />);
    stdin.write("a".repeat(50));
    await tick();
    // Should render the text across wrapped lines
    const frame = lastFrame();
    expect(frame).toContain("a");
    // At least some text should be visible (viewport limited)
    expect(frame.replace(/[^a]/g, "").length).toBeGreaterThan(10);
  });
});

// =============================================================================
// Undo (Ctrl+Z)
// =============================================================================

describe("MultiLineInput — undo", () => {
  test("Ctrl+Z undoes last edit", async () => {
    let submitted = "";
    const { stdin } = inkRender(<TestInput onSubmit={(t) => { submitted = t; }} />);
    stdin.write("hello");
    await tick();
    stdin.write(" world");
    await tick();
    // Undo
    stdin.write("\x1a"); // Ctrl+Z = 0x1A
    await tick();
    stdin.write("\r");
    await tick();
    // Should have reverted " world" (or at least partially)
    // Undo granularity depends on implementation
    expect(submitted.length).toBeLessThan("hello world".length);
  });
});
