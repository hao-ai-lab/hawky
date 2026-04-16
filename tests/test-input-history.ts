// =============================================================================
// Tests: Input History Hook + extractUserMessages
// =============================================================================

import { describe, expect, test } from "bun:test";
import { extractUserMessages } from "../src/tui/hooks/use_input_history.js";

// =============================================================================
// extractUserMessages
// =============================================================================

describe("extractUserMessages", () => {
  test("extracts user text messages", () => {
    const messages = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
      { role: "user", text: "bye" },
      { role: "assistant", text: "goodbye" },
    ];
    expect(extractUserMessages(messages)).toEqual(["hello", "bye"]);
  });

  test("skips empty messages", () => {
    const messages = [
      { role: "user", text: "hello" },
      { role: "user", text: "" },
      { role: "user", text: "  " },
      { role: "user", text: "world" },
    ];
    expect(extractUserMessages(messages)).toEqual(["hello", "world"]);
  });

  test("skips non-user messages", () => {
    const messages = [
      { role: "assistant", text: "hi" },
      { role: "system", text: "info" },
      { role: "tool", text: "result" },
    ];
    expect(extractUserMessages(messages)).toEqual([]);
  });

  test("empty array returns empty", () => {
    expect(extractUserMessages([])).toEqual([]);
  });

  test("trims whitespace", () => {
    expect(extractUserMessages([{ role: "user", text: "  hello  " }])).toEqual(["hello"]);
  });
});

// =============================================================================
// useInputHistory — test the hook logic directly
//
// Since hooks can only be called in components, we test by simulating
// the hook's internal logic. The hook is simple enough to verify via
// its exported functions with a mock component pattern.
// =============================================================================

// We can't call hooks directly, but we can test the algorithm
// by reimplementing the core logic as a plain class for testing.

class HistorySimulator {
  history: string[] = [];
  historyIndex = -1;
  draft = "";

  addToHistory(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (this.history.length === 0 || this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }
  }

  goBack(currentDraft: string): string | null {
    if (this.history.length === 0) return null;
    if (this.historyIndex === -1) {
      this.draft = currentDraft;
      this.historyIndex = this.history.length - 1;
      return this.history[this.historyIndex];
    }
    if (this.historyIndex > 0) {
      this.historyIndex--;
      return this.history[this.historyIndex];
    }
    return null; // At oldest
  }

  goForward(): string | null {
    if (this.historyIndex === -1) return null;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      return this.history[this.historyIndex];
    }
    // At end — return draft
    this.historyIndex = -1;
    return this.draft;
  }

  resetNavigation(): void {
    this.historyIndex = -1;
    this.draft = "";
  }
}

describe("Input history navigation", () => {
  test("empty history — goBack returns null", () => {
    const h = new HistorySimulator();
    expect(h.goBack("current")).toBeNull();
  });

  test("goBack returns most recent message first", () => {
    const h = new HistorySimulator();
    h.addToHistory("first");
    h.addToHistory("second");
    h.addToHistory("third");
    expect(h.goBack("draft")).toBe("third");
  });

  test("multiple goBack navigates backwards", () => {
    const h = new HistorySimulator();
    h.addToHistory("first");
    h.addToHistory("second");
    h.addToHistory("third");
    expect(h.goBack("draft")).toBe("third");
    expect(h.goBack("")).toBe("second");
    expect(h.goBack("")).toBe("first");
  });

  test("goBack at oldest returns null", () => {
    const h = new HistorySimulator();
    h.addToHistory("only");
    expect(h.goBack("draft")).toBe("only");
    expect(h.goBack("")).toBeNull(); // Already at oldest
  });

  test("goForward returns to draft", () => {
    const h = new HistorySimulator();
    h.addToHistory("first");
    h.addToHistory("second");
    h.goBack("my draft"); // → "second"
    h.goBack(""); // → "first"
    expect(h.goForward()).toBe("second");
    expect(h.goForward()).toBe("my draft"); // Back to draft
  });

  test("goForward when not navigating returns null", () => {
    const h = new HistorySimulator();
    expect(h.goForward()).toBeNull();
  });

  test("draft is preserved across navigation", () => {
    const h = new HistorySimulator();
    h.addToHistory("old msg");
    h.goBack("unsaved work"); // Saves draft, returns "old msg"
    const restored = h.goForward(); // Returns draft
    expect(restored).toBe("unsaved work");
  });

  test("addToHistory avoids consecutive duplicates", () => {
    const h = new HistorySimulator();
    h.addToHistory("same");
    h.addToHistory("same");
    h.addToHistory("same");
    expect(h.history).toHaveLength(1);
  });

  test("addToHistory allows non-consecutive duplicates", () => {
    const h = new HistorySimulator();
    h.addToHistory("a");
    h.addToHistory("b");
    h.addToHistory("a");
    expect(h.history).toHaveLength(3);
  });

  test("addToHistory ignores empty/whitespace", () => {
    const h = new HistorySimulator();
    h.addToHistory("");
    h.addToHistory("  ");
    expect(h.history).toHaveLength(0);
  });

  test("resetNavigation clears navigation state", () => {
    const h = new HistorySimulator();
    h.addToHistory("msg");
    h.goBack("draft");
    h.resetNavigation();
    // After reset, goForward should return null (not navigating)
    expect(h.goForward()).toBeNull();
  });

  test("full cycle: add, navigate back, forward, add more", () => {
    const h = new HistorySimulator();
    h.addToHistory("msg 1");
    h.addToHistory("msg 2");

    // Navigate back
    expect(h.goBack("current")).toBe("msg 2");
    expect(h.goBack("")).toBe("msg 1");

    // Navigate forward to draft
    expect(h.goForward()).toBe("msg 2");
    expect(h.goForward()).toBe("current");

    // Reset and add more
    h.resetNavigation();
    h.addToHistory("msg 3");

    // New navigation
    expect(h.goBack("new draft")).toBe("msg 3");
    expect(h.goBack("")).toBe("msg 2");
    expect(h.goBack("")).toBe("msg 1");
    expect(h.goBack("")).toBeNull();
  });
});
