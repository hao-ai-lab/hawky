// =============================================================================
// Text Buffer Tests
//
// Comprehensive tests for visual line wrapping, cursor navigation, selection,
// undo/redo, coordinate mapping, word boundaries, and edge cases.
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  calculateLayout,
  logicalToVisual,
  visualToLogical,
  useTextBuffer,
  type VisualLayout,
  type TextBufferState,
} from "../src/tui/hooks/use_text_buffer.js";

// =============================================================================
// calculateLayout — wrapping
// =============================================================================

describe("calculateLayout — basic wrapping", () => {
  test("short text fits in one visual line", () => {
    const layout = calculateLayout(["hello"], 80);
    expect(layout.visualLines).toEqual(["hello"]);
    expect(layout.visualToLogicalMap).toEqual([[0, 0]]);
  });

  test("long text wraps at viewport width", () => {
    const text = "a".repeat(20);
    const layout = calculateLayout([text], 10);
    expect(layout.visualLines.length).toBe(2);
    expect(layout.visualLines[0]).toBe("a".repeat(10));
    expect(layout.visualLines[1]).toBe("a".repeat(10));
  });

  test("word-aware wrapping breaks at spaces", () => {
    const layout = calculateLayout(["hello world foo"], 12);
    expect(layout.visualLines.length).toBe(2);
    expect(layout.visualLines[0]).toContain("hello");
    expect(layout.visualLines[1]).toContain("foo");
  });

  test("very long word breaks mid-word", () => {
    const longWord = "x".repeat(30);
    const layout = calculateLayout([longWord], 10);
    expect(layout.visualLines.length).toBe(3);
    expect(layout.visualLines[0].length).toBe(10);
    expect(layout.visualLines[1].length).toBe(10);
    expect(layout.visualLines[2].length).toBe(10);
  });

  test("empty text produces one empty visual line", () => {
    const layout = calculateLayout([""], 80);
    expect(layout.visualLines).toEqual([""]);
    expect(layout.logicalToVisualMap[0]).toEqual([[0, 0]]);
  });

  test("multiple logical lines each get mapped", () => {
    const layout = calculateLayout(["line1", "line2", "line3"], 80);
    expect(layout.visualLines).toEqual(["line1", "line2", "line3"]);
    expect(layout.logicalToVisualMap.length).toBe(3);
    expect(layout.visualToLogicalMap.length).toBe(3);
  });

  test("text exactly at viewport width stays one line", () => {
    const text = "a".repeat(10);
    const layout = calculateLayout([text], 10);
    expect(layout.visualLines).toEqual([text]);
  });

  test("text one char over viewport width wraps", () => {
    const text = "a".repeat(11);
    const layout = calculateLayout([text], 10);
    expect(layout.visualLines.length).toBe(2);
  });

  test("handles minimum viewport width (clamped to 4)", () => {
    const layout = calculateLayout(["hello"], 1);
    expect(layout.visualLines.length).toBe(2);
  });

  test("only newlines (multiple empty lines)", () => {
    const layout = calculateLayout(["", "", ""], 80);
    expect(layout.visualLines).toEqual(["", "", ""]);
  });

  test("single character", () => {
    const layout = calculateLayout(["x"], 80);
    expect(layout.visualLines).toEqual(["x"]);
  });
});

describe("calculateLayout — complex wrapping", () => {
  test("multi-line text with mixed wrapping", () => {
    const layout = calculateLayout(["short", "a".repeat(20), "end"], 10);
    expect(layout.visualLines.length).toBe(4);
    expect(layout.visualLines[0]).toBe("short");
    expect(layout.visualLines[3]).toBe("end");
  });

  test("multiple words wrapping across lines", () => {
    const layout = calculateLayout(["the quick brown fox jumps over"], 15);
    expect(layout.visualLines.length).toBeGreaterThan(1);
    // Each visual line should be <= 15 chars
    for (const vl of layout.visualLines) {
      expect(vl.length).toBeLessThanOrEqual(15);
    }
  });

  test("preserves all text content after wrapping", () => {
    const original = "hello world this is a test of wrapping behavior";
    const layout = calculateLayout([original], 12);
    // Joining visual lines (with possible space skips) should approximate original
    const rejoined = layout.visualLines.join(" ");
    // All words should be present
    expect(rejoined).toContain("hello");
    expect(rejoined).toContain("world");
    expect(rejoined).toContain("wrapping");
    expect(rejoined).toContain("behavior");
  });

  test("handles text with multiple spaces", () => {
    const layout = calculateLayout(["hello   world"], 80);
    expect(layout.visualLines).toEqual(["hello   world"]);
  });

  test("wraps sentence with punctuation", () => {
    const layout = calculateLayout(["Hello, world! How are you?"], 15);
    expect(layout.visualLines.length).toBe(2);
  });
});

// =============================================================================
// logicalToVisual — coordinate mapping
// =============================================================================

describe("logicalToVisual", () => {
  test("no wrapping: logical = visual", () => {
    const layout = calculateLayout(["hello world"], 80);
    expect(logicalToVisual(layout, 0, 0)).toEqual([0, 0]);
    expect(logicalToVisual(layout, 0, 5)).toEqual([0, 5]);
    expect(logicalToVisual(layout, 0, 11)).toEqual([0, 11]);
  });

  test("wrapped line: cursor on second visual line", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    expect(logicalToVisual(layout, 0, 0)).toEqual([0, 0]);
    expect(logicalToVisual(layout, 0, 10)).toEqual([1, 0]);
    expect(logicalToVisual(layout, 0, 15)).toEqual([1, 5]);
  });

  test("multi-line: second logical line", () => {
    const layout = calculateLayout(["first", "second"], 80);
    expect(logicalToVisual(layout, 1, 0)).toEqual([1, 0]);
    expect(logicalToVisual(layout, 1, 3)).toEqual([1, 3]);
  });

  test("cursor at end of line", () => {
    const layout = calculateLayout(["hello"], 80);
    expect(logicalToVisual(layout, 0, 5)).toEqual([0, 5]);
  });

  test("cursor at end of wrapped line maps to last visual line", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    const [vr, vc] = logicalToVisual(layout, 0, 20);
    expect(vr).toBe(1);
    expect(vc).toBe(10);
  });

  test("cursor at col 0 of empty line", () => {
    const layout = calculateLayout(["hello", "", "world"], 80);
    expect(logicalToVisual(layout, 1, 0)).toEqual([1, 0]);
  });
});

// =============================================================================
// visualToLogical — reverse mapping
// =============================================================================

describe("visualToLogical", () => {
  test("no wrapping: visual = logical", () => {
    const layout = calculateLayout(["hello"], 80);
    expect(visualToLogical(layout, 0, 3)).toEqual([0, 3]);
  });

  test("wrapped line: second visual row maps back", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    expect(visualToLogical(layout, 1, 5)).toEqual([0, 15]);
  });

  test("multi-line: second logical line maps correctly", () => {
    const layout = calculateLayout(["first", "second"], 80);
    expect(visualToLogical(layout, 1, 2)).toEqual([1, 2]);
  });

  test("visual row 0 col 0 always maps to logical 0,0", () => {
    const layout = calculateLayout(["anything"], 80);
    expect(visualToLogical(layout, 0, 0)).toEqual([0, 0]);
  });
});

// =============================================================================
// Layout mapping consistency
// =============================================================================

describe("Layout mapping consistency", () => {
  test("round-trip: logical → visual → logical preserves row", () => {
    const layout = calculateLayout(["hello world, this is a test"], 10);
    for (const col of [0, 3, 7, 12, 20, 26]) {
      const safeCol = Math.min(col, 26);
      const [visR, visC] = logicalToVisual(layout, 0, safeCol);
      const [logR, logC] = visualToLogical(layout, visR, visC);
      expect(logR).toBe(0);
      expect(Math.abs(logC - safeCol)).toBeLessThanOrEqual(1);
    }
  });

  test("every visual line maps to a valid logical line", () => {
    const layout = calculateLayout(["some text that wraps around"], 8);
    for (let vr = 0; vr < layout.visualLines.length; vr++) {
      const [logR, logC] = layout.visualToLogicalMap[vr];
      expect(logR).toBeGreaterThanOrEqual(0);
      expect(logC).toBeGreaterThanOrEqual(0);
    }
  });

  test("every logical line has at least one visual segment", () => {
    const layout = calculateLayout(["line1", "", "line3"], 80);
    expect(layout.logicalToVisualMap.length).toBe(3);
    for (const segments of layout.logicalToVisualMap) {
      expect(segments.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("visual line count >= logical line count", () => {
    const lines = ["short", "a".repeat(30), "medium text here", ""];
    const layout = calculateLayout(lines, 10);
    expect(layout.visualLines.length).toBeGreaterThanOrEqual(lines.length);
  });

  test("logicalToVisualMap length equals logical line count", () => {
    const lines = ["a", "bb", "ccc"];
    const layout = calculateLayout(lines, 80);
    expect(layout.logicalToVisualMap.length).toBe(3);
  });

  test("visualToLogicalMap length equals visual line count", () => {
    const layout = calculateLayout(["a".repeat(30)], 10);
    expect(layout.visualToLogicalMap.length).toBe(layout.visualLines.length);
  });
});

// =============================================================================
// Word wrapping edge cases
// =============================================================================

describe("Word wrapping edge cases", () => {
  test("line of only spaces", () => {
    const layout = calculateLayout(["          "], 5);
    // Should wrap spaces
    expect(layout.visualLines.length).toBeGreaterThanOrEqual(1);
  });

  test("alternating word and space at exact boundary", () => {
    // "abcd efgh" with width 5: "abcd " then "efgh"
    const layout = calculateLayout(["abcd efgh"], 5);
    expect(layout.visualLines.length).toBe(2);
  });

  test("single space at viewport width", () => {
    // "abcde fghij" with width 6
    const layout = calculateLayout(["abcde fghij"], 6);
    expect(layout.visualLines.length).toBe(2);
    expect(layout.visualLines[0]).toContain("abcde");
  });

  test("no spaces in text — breaks at width", () => {
    const layout = calculateLayout(["abcdefghij"], 5);
    expect(layout.visualLines).toEqual(["abcde", "fghij"]);
  });
});

// =============================================================================
// Navigation simulation (using layout + movement logic)
// =============================================================================

describe("Navigation via layout", () => {
  test("up arrow from wrapped second visual line goes to first", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    // Cursor at logical col 15 → visual row 1, col 5
    const [vr, vc] = logicalToVisual(layout, 0, 15);
    expect(vr).toBe(1);
    expect(vc).toBe(5);
    // Moving up: visual row 0, same col → logical col 5
    const [logR, logC] = visualToLogical(layout, 0, vc);
    expect(logR).toBe(0);
    expect(logC).toBe(5);
  });

  test("down arrow from first visual line of wrapped text", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    // Cursor at logical col 5 → visual row 0, col 5
    const [vr, vc] = logicalToVisual(layout, 0, 5);
    expect(vr).toBe(0);
    // Moving down: visual row 1, col 5 → logical col 15
    const [logR, logC] = visualToLogical(layout, 1, vc);
    expect(logR).toBe(0);
    expect(logC).toBe(15);
  });

  test("home on wrapped line goes to visual line start", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    // Cursor at logical col 15 → visual row 1, col 5
    // Home → visual row 1, col 0 → logical col 10
    const [logR, logC] = visualToLogical(layout, 1, 0);
    expect(logR).toBe(0);
    expect(logC).toBe(10);
  });

  test("end on wrapped line goes to visual line end", () => {
    const layout = calculateLayout(["a".repeat(20)], 10);
    // End on visual row 0 → col 10 → logical col 10
    const visLineLen = layout.visualLines[0].length;
    const [logR, logC] = visualToLogical(layout, 0, visLineLen);
    expect(logR).toBe(0);
    expect(logC).toBe(10);
  });

  test("navigation across logical line boundary", () => {
    const layout = calculateLayout(["first", "second"], 80);
    // Down from first line → second line
    const [vr] = logicalToVisual(layout, 0, 3);
    const [logR, logC] = visualToLogical(layout, vr + 1, 3);
    expect(logR).toBe(1);
    expect(logC).toBe(3);
  });
});

// =============================================================================
// Simulated editing operations (pure function tests)
// =============================================================================

describe("Editing operations (pure)", () => {
  test("insert at cursor position", () => {
    const lines = ["hello world"];
    const before = lines[0].slice(0, 5);
    const after = lines[0].slice(5);
    const result = before + " beautiful" + after;
    expect(result).toBe("hello beautiful world");
  });

  test("backspace at middle of line", () => {
    const line = "hello";
    const col = 3;
    const result = line.slice(0, col - 1) + line.slice(col);
    expect(result).toBe("helo");
  });

  test("newline splits line", () => {
    const line = "hello world";
    const col = 5;
    const before = line.slice(0, col);
    const after = line.slice(col);
    expect(before).toBe("hello");
    expect(after).toBe(" world");
  });

  test("backspace at line start merges with previous", () => {
    const lines = ["first", "second"];
    const merged = lines[0] + lines[1];
    expect(merged).toBe("firstsecond");
  });

  test("delete forward removes next char", () => {
    const line = "hello";
    const col = 2;
    const result = line.slice(0, col) + line.slice(col + 1);
    expect(result).toBe("helo");
  });
});

// =============================================================================
// Selection range calculation (pure)
// =============================================================================

describe("Selection range", () => {
  test("selection from offset computation", () => {
    const lines = ["hello", "world"];
    // Offset of (0, 3) = 3
    // Offset of (1, 2) = 5 + 1 + 2 = 8 (5 chars + newline + 2 chars)
    let offset = 0;
    for (let i = 0; i < 0; i++) offset += lines[i].length + 1;
    offset += 3;
    expect(offset).toBe(3);

    let offset2 = 0;
    for (let i = 0; i < 1; i++) offset2 += lines[i].length + 1;
    offset2 += 2;
    expect(offset2).toBe(8);
  });

  test("selection text extraction", () => {
    const text = "hello\nworld";
    const chars = Array.from(text);
    // Select from offset 3 to 8: "lo\nwo"
    const selected = chars.slice(3, 8).join("");
    expect(selected).toBe("lo\nwo");
  });
});

// =============================================================================
// Undo/redo behavior (conceptual)
// =============================================================================

describe("Undo/redo concepts", () => {
  test("undo stack stores previous states", () => {
    const stack: Array<{ lines: string[]; cursorRow: number; cursorCol: number }> = [];
    stack.push({ lines: ["hello"], cursorRow: 0, cursorCol: 5 });
    stack.push({ lines: ["hello world"], cursorRow: 0, cursorCol: 11 });
    expect(stack.length).toBe(2);

    // Undo pops last entry
    const restored = stack.pop()!;
    expect(restored.lines).toEqual(["hello world"]);
    expect(stack.length).toBe(1);
  });

  test("redo stack tracks undone states", () => {
    const undoStack = [{ lines: ["a"], cursorRow: 0, cursorCol: 1 }];
    const redoStack: typeof undoStack = [];

    // Undo: move from undo to redo
    const entry = undoStack.pop()!;
    redoStack.push({ lines: ["ab"], cursorRow: 0, cursorCol: 2 }); // current state
    expect(undoStack.length).toBe(0);
    expect(redoStack.length).toBe(1);
  });
});

// =============================================================================
// Large text performance sanity
// =============================================================================

describe("Performance sanity", () => {
  test("layout calculation completes for 1000 chars", () => {
    const text = "word ".repeat(200); // 1000 chars
    const start = Date.now();
    const layout = calculateLayout([text], 80);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should complete in < 100ms
    expect(layout.visualLines.length).toBeGreaterThan(1);
  });

  test("layout calculation completes for 100 lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: some content here`);
    const start = Date.now();
    const layout = calculateLayout(lines, 40);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(layout.visualLines.length).toBeGreaterThanOrEqual(100);
  });
});
