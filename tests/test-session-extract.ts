import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSessionText, extractTextFromContent } from "../src/memory/session-extract.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `hawky-session-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

/** Write a JSONL session file with the given lines. Returns the file path. */
function writeSessionFile(name: string, entries: any[]): string {
  const filePath = join(tempDir, name);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content);
  return filePath;
}

function makeHeader(): any {
  return {
    type: "session",
    version: 1,
    id: "test-session-1",
    model: "claude-sonnet-4-6",
    working_directory: "/tmp/test",
    created_at: "2026-04-12T10:00:00Z",
  };
}

function makeMessage(role: "user" | "assistant", text: string, timestamp?: string): any {
  return {
    type: "message",
    timestamp: timestamp ?? "2026-04-12T10:01:00Z",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

function makeToolUseMessage(): any {
  return {
    type: "message",
    timestamp: "2026-04-12T10:02:00Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "read_file",
          input: { path: "/tmp/test.ts" },
        },
      ],
    },
  };
}

function makeToolResultMessage(): any {
  return {
    type: "message",
    timestamp: "2026-04-12T10:03:00Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "file contents here",
        },
      ],
    },
  };
}

function makeMixedMessage(): any {
  return {
    type: "message",
    timestamp: "2026-04-12T10:04:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think about this" },
        { type: "text", text: "Here is my answer" },
        {
          type: "tool_use",
          id: "tool_2",
          name: "bash",
          input: { command: "ls" },
        },
        { type: "text", text: "And some more text" },
      ],
    },
  };
}

function makePermissionCache(): any {
  return {
    type: "permission_cache",
    timestamp: "2026-04-12T10:05:00Z",
    data: { allowedApps: [], deniedApps: [] },
  };
}

// -----------------------------------------------------------------------------
// extractTextFromContent
// -----------------------------------------------------------------------------

describe("extractTextFromContent", () => {
  test("text-only content blocks return text", () => {
    const content = [
      { type: "text" as const, text: "Hello world" },
      { type: "text" as const, text: "Second block" },
    ];
    expect(extractTextFromContent(content)).toBe("Hello world\nSecond block");
  });

  test("tool_use blocks return empty string", () => {
    const content = [
      {
        type: "tool_use" as const,
        id: "t1",
        name: "bash",
        input: { command: "ls" },
      },
    ];
    expect(extractTextFromContent(content)).toBe("");
  });

  test("tool_result blocks return empty string", () => {
    const content = [
      {
        type: "tool_result" as const,
        tool_use_id: "t1",
        content: "output here",
      },
    ];
    expect(extractTextFromContent(content)).toBe("");
  });

  test("mixed blocks return only text parts", () => {
    const content = [
      { type: "thinking" as const, thinking: "hmm" },
      { type: "text" as const, text: "visible answer" },
      {
        type: "tool_use" as const,
        id: "t1",
        name: "read_file",
        input: { path: "/x" },
      },
      { type: "text" as const, text: "more text" },
    ];
    expect(extractTextFromContent(content)).toBe("visible answer\nmore text");
  });

  test("empty text blocks are skipped", () => {
    const content = [
      { type: "text" as const, text: "  " },
      { type: "text" as const, text: "real content" },
      { type: "text" as const, text: "" },
    ];
    expect(extractTextFromContent(content)).toBe("real content");
  });
});

// -----------------------------------------------------------------------------
// extractSessionText — basic
// -----------------------------------------------------------------------------

describe("extractSessionText", () => {
  test("well-formed JSONL returns correct text, messageCount, byteLength", async () => {
    const filePath = writeSessionFile("session.jsonl", [
      makeHeader(),
      makeMessage("user", "What is TypeScript?"),
      makeMessage("assistant", "TypeScript is a typed superset of JavaScript."),
    ]);

    const result = await extractSessionText(filePath);
    expect(result.messageCount).toBe(2);
    expect(result.text).toContain("[user] What is TypeScript?");
    expect(result.text).toContain("[assistant] TypeScript is a typed superset of JavaScript.");
    expect(result.fromOffset).toBe(0);

    // byteLength should match actual file size
    const fileSize = Bun.file(filePath).size;
    expect(result.byteLength).toBe(fileSize);
  });

  test("header-only file returns messageCount=0", async () => {
    const filePath = writeSessionFile("header-only.jsonl", [makeHeader()]);
    const result = await extractSessionText(filePath);
    expect(result.messageCount).toBe(0);
    expect(result.text).toBe("");
  });

  test("tool-only session returns messageCount=0", async () => {
    const filePath = writeSessionFile("tools-only.jsonl", [
      makeHeader(),
      makeToolUseMessage(),
      makeToolResultMessage(),
    ]);
    const result = await extractSessionText(filePath);
    expect(result.messageCount).toBe(0);
    expect(result.text).toBe("");
  });

  test("mixed content blocks extract only text parts", async () => {
    const filePath = writeSessionFile("mixed.jsonl", [
      makeHeader(),
      makeMixedMessage(),
    ]);
    const result = await extractSessionText(filePath);
    expect(result.messageCount).toBe(1);
    expect(result.text).toContain("Here is my answer");
    expect(result.text).toContain("And some more text");
    expect(result.text).not.toContain("let me think");
    expect(result.text).not.toContain("bash");
  });

  test("permission_cache entries are skipped", async () => {
    const filePath = writeSessionFile("with-cache.jsonl", [
      makeHeader(),
      makeMessage("user", "Hello"),
      makePermissionCache(),
      makeMessage("assistant", "Hi there"),
    ]);
    const result = await extractSessionText(filePath);
    expect(result.messageCount).toBe(2);
  });

  test("corrupted JSONL lines are skipped gracefully", async () => {
    const filePath = join(tempDir, "corrupted.jsonl");
    const lines = [
      JSON.stringify(makeHeader()),
      "this is not json",
      JSON.stringify(makeMessage("user", "Valid message")),
      "{broken json",
      JSON.stringify(makeMessage("assistant", "Also valid")),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const result = await extractSessionText(filePath);
    expect(result.messageCount).toBe(2);
    expect(result.text).toContain("[user] Valid message");
    expect(result.text).toContain("[assistant] Also valid");
  });
});

// -----------------------------------------------------------------------------
// extractSessionText — byte offset
// -----------------------------------------------------------------------------

describe("extractSessionText byte offset", () => {
  test("fromByteOffset=0 is equivalent to no offset", async () => {
    const filePath = writeSessionFile("offset-zero.jsonl", [
      makeHeader(),
      makeMessage("user", "Hello"),
      makeMessage("assistant", "World"),
    ]);

    const full = await extractSessionText(filePath);
    const fromZero = await extractSessionText(filePath, 0);
    expect(full.text).toBe(fromZero.text);
    expect(full.messageCount).toBe(fromZero.messageCount);
    expect(full.byteLength).toBe(fromZero.byteLength);
  });

  test("non-zero byte offset only returns messages after that point", async () => {
    const entries = [
      makeHeader(),
      makeMessage("user", "First message"),
      makeMessage("assistant", "First reply"),
    ];
    const filePath = writeSessionFile("offset-partial.jsonl", entries);

    // Get the byte length after first batch
    const firstResult = await extractSessionText(filePath);
    expect(firstResult.messageCount).toBe(2);
    const firstByteLength = firstResult.byteLength;

    // Append more messages
    const moreEntries = [
      makeMessage("user", "Second message"),
      makeMessage("assistant", "Second reply"),
    ];
    const moreContent = moreEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const { appendFileSync } = await import("node:fs");
    appendFileSync(filePath, moreContent);

    // Read from the offset — should only get the new messages
    const incremental = await extractSessionText(filePath, firstByteLength);
    expect(incremental.messageCount).toBe(2);
    expect(incremental.text).toContain("[user] Second message");
    expect(incremental.text).toContain("[assistant] Second reply");
    expect(incremental.text).not.toContain("First message");
    expect(incremental.fromOffset).toBe(firstByteLength);
  });

  test("offset beyond file size returns empty result", async () => {
    const filePath = writeSessionFile("offset-past-end.jsonl", [
      makeHeader(),
      makeMessage("user", "Hello"),
    ]);
    const fileSize = Bun.file(filePath).size;

    const result = await extractSessionText(filePath, fileSize + 100);
    expect(result.messageCount).toBe(0);
    expect(result.text).toBe("");
    expect(result.byteLength).toBe(fileSize);
  });

  test("offset at exact file size returns empty result", async () => {
    const filePath = writeSessionFile("offset-exact.jsonl", [
      makeHeader(),
      makeMessage("user", "Hello"),
    ]);
    const fileSize = Bun.file(filePath).size;

    const result = await extractSessionText(filePath, fileSize);
    expect(result.messageCount).toBe(0);
    expect(result.text).toBe("");
  });

  test("byteLength in result equals actual file size for complete files", async () => {
    const filePath = writeSessionFile("bytelength.jsonl", [
      makeHeader(),
      makeMessage("user", "Check byte length"),
      makeMessage("assistant", "Should match file size"),
    ]);

    const result = await extractSessionText(filePath);
    const actualSize = Bun.file(filePath).size;
    expect(result.byteLength).toBe(actualSize);
  });

  test("partial trailing line is not consumed — safe for concurrent writes", async () => {
    // Write a complete session file
    const entries = [
      makeHeader(),
      makeMessage("user", "First message"),
      makeMessage("assistant", "First reply"),
    ];
    const filePath = writeSessionFile("concurrent.jsonl", entries);

    const firstResult = await extractSessionText(filePath);
    expect(firstResult.messageCount).toBe(2);
    const safeOffset = firstResult.byteLength;

    // Simulate a concurrent write: append a partial JSONL line (no trailing newline)
    const { appendFileSync } = await import("node:fs");
    const partialLine = '{"type":"message","timestamp":"2026-04-12T10:05:00Z","message":{"role":"user","cont';
    appendFileSync(filePath, partialLine);

    // Read from the safe offset — should get nothing (partial line excluded)
    const midWrite = await extractSessionText(filePath, safeOffset);
    expect(midWrite.messageCount).toBe(0);
    expect(midWrite.text).toBe("");
    // byteLength should NOT advance past the partial line
    expect(midWrite.byteLength).toBe(safeOffset);

    // Now "complete" the write by appending the rest + newline
    const restOfLine =
      'ent":[{"type":"text","text":"Completed message"}]}}\n';
    appendFileSync(filePath, restOfLine);

    // Read again from the same safe offset — should now get the completed message
    const afterComplete = await extractSessionText(filePath, safeOffset);
    expect(afterComplete.messageCount).toBe(1);
    expect(afterComplete.text).toContain("[user] Completed message");
    // byteLength should now advance past the completed line
    expect(afterComplete.byteLength).toBeGreaterThan(safeOffset);
  });
});
