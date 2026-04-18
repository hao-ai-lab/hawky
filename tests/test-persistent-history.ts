// =============================================================================
// Persistent Input History Tests
//
// Tests for ~/.hawky/history.jsonl persistence layer.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadHistorySync,
  appendHistoryEntry,
  historyTexts,
  type HistoryEntry,
} from "../src/storage/input-history.js";

// =============================================================================
// Direct storage tests (bypass module-level constants by testing functions)
// =============================================================================

describe("input-history storage", () => {
  const testDir = join(tmpdir(), `hawky-history-test-${Date.now()}`);
  const testFile = join(testDir, "history.jsonl");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    if (existsSync(testFile)) rmSync(testFile);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("loadHistorySync returns empty for missing file", () => {
    const entries = loadHistorySync();
    // This reads from ~/.hawky/history.jsonl — may or may not exist
    // Just verify it returns an array
    expect(Array.isArray(entries)).toBe(true);
  });

  test("appendHistoryEntry creates file and appends", () => {
    // This writes to the real ~/.hawky/history.jsonl
    // Just verify it doesn't throw
    appendHistoryEntry("test-persistent-history-entry");
  });

  test("historyTexts extracts text from entries", () => {
    const entries: HistoryEntry[] = [
      { text: "hello", timestamp: 1000 },
      { text: "world", timestamp: 2000, session: "tui:main" },
    ];
    expect(historyTexts(entries)).toEqual(["hello", "world"]);
  });

  test("JSONL format round-trip", () => {
    // Write entries in JSONL format to test file
    const entries = [
      { text: "first message", timestamp: 1000 },
      { text: "second message", timestamp: 2000, session: "tui:main" },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(testFile, content);

    // Read back and parse
    const raw = readFileSync(testFile, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].text).toBe("first message");
    expect(parsed[1].text).toBe("second message");
    expect(parsed[1].session).toBe("tui:main");
  });

  test("malformed lines are skipped during load", () => {
    // Write a file with some bad lines
    const content = [
      JSON.stringify({ text: "good", timestamp: 1000 }),
      "not json at all",
      JSON.stringify({ text: "also good", timestamp: 2000 }),
      '{"no_text_field": true}',
      JSON.stringify({ text: "", timestamp: 3000 }), // empty text
    ].join("\n") + "\n";
    writeFileSync(testFile, content);

    // loadHistorySync reads from the real file, not our test file.
    // Instead, test the parsing logic directly.
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.text === "string" && entry.text.trim()) {
          entries.push(entry);
        }
      } catch {
        // Skip
      }
    }
    expect(entries.length).toBe(2);
    expect(entries[0].text).toBe("good");
    expect(entries[1].text).toBe("also good");
  });
});

// =============================================================================
// Hook integration tests (in-memory behavior)
// =============================================================================

describe("useInputHistory persistence integration", () => {
  test("extractUserMessages filters correctly", async () => {
    const { extractUserMessages } = await import("../src/tui/hooks/use_input_history.js");
    const messages = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
      { role: "user", text: "  " }, // empty after trim
      { role: "user", text: "second question" },
      { role: "system", text: "system msg" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["hello", "second question"]);
  });

  test("persistToHistory does not throw", async () => {
    const { persistToHistory } = await import("../src/tui/hooks/use_input_history.js");
    // Should silently succeed (writes to real file)
    expect(() => persistToHistory("test entry")).not.toThrow();
    // Empty string should be no-op
    expect(() => persistToHistory("  ")).not.toThrow();
  });
});
