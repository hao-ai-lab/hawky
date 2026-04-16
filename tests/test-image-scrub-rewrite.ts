// =============================================================================
// Tests: Image scrubbing in session rewrite paths
//
// Verifies that rewriteMessages() scrubs image blocks the same way
// appendMessage() does, preventing base64 data from persisting to JSONL.
// =============================================================================

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../src/storage/session.js";
import type { ChatMessage } from "../src/agent/types.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-scrub-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  try {
    const entries = require("fs").readdirSync(tmpdir()).filter((f: string) => f.startsWith("hawky-scrub-test-"));
    for (const e of entries) rmSync(join(tmpdir(), e), { recursive: true, force: true });
  } catch {}
});

function makeImageMessage(): ChatMessage {
  return {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", data: "AAAA".repeat(1000), media_type: "image/jpeg" } } as any,
      { type: "text", text: "What is this?" },
    ],
  };
}

function makeToolResultWithScreenshot(): ChatMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [
          { type: "image", source: { type: "base64", data: "BBBB".repeat(1000), media_type: "image/jpeg" } },
          { type: "text", text: "Screenshot captured" },
        ],
      } as any,
    ],
  };
}

describe("rewriteMessages image scrubbing", () => {
  test("scrubs direct image blocks in rewritten JSONL", () => {
    const sm = new SessionManager("test-session-1", testDir);
    const messages: ChatMessage[] = [
      makeImageMessage(),
      { role: "assistant", content: [{ type: "text", text: "I see a cat." }] },
    ];

    sm.rewriteMessages(messages);

    const content = readFileSync(sm.filePath, "utf-8");
    expect(content).not.toContain("AAAA");
    expect(content).toContain("[image was attached]");
  });

  test("scrubs tool_result screenshots in rewritten JSONL", () => {
    const sm = new SessionManager("test-session-2", testDir);
    const messages: ChatMessage[] = [
      makeToolResultWithScreenshot(),
      { role: "assistant", content: [{ type: "text", text: "I see your desktop." }] },
    ];

    sm.rewriteMessages(messages);

    const content = readFileSync(sm.filePath, "utf-8");
    expect(content).not.toContain("BBBB");
    expect(content).toContain("[screenshot was captured]");
  });

  test("preserves text content alongside scrubbed images", () => {
    const sm = new SessionManager("test-session-3", testDir);
    const messages: ChatMessage[] = [
      makeImageMessage(),
      { role: "assistant", content: [{ type: "text", text: "Analysis complete." }] },
    ];

    sm.rewriteMessages(messages);

    const content = readFileSync(sm.filePath, "utf-8");
    expect(content).toContain("What is this?");
    expect(content).toContain("Analysis complete.");
  });

  test("appendMessage also scrubs images", () => {
    const sm = new SessionManager("test-session-4", testDir);
    sm.rewriteMessages([{ role: "assistant", content: [{ type: "text", text: "Hi" }] }]);

    sm.appendMessage(makeImageMessage());

    const content = readFileSync(sm.filePath, "utf-8");
    expect(content).not.toContain("AAAA");
    expect(content).toContain("[image was attached]");
  });
});
