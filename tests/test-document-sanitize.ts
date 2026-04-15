// =============================================================================
// Document history sanitization tests
//
// Mirrors the image-sanitize tests: confirms over-budget documents are
// replaced with placeholders oldest-first, that the current turn is never
// touched, and that per-item oversized docs are stripped unconditionally.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { sanitizeHistoryDocuments } from "../src/agent/document-sanitize.js";
import type { ChatMessage } from "../src/agent/types.js";

function docBlock(sizeChars: number) {
  return {
    type: "document" as const,
    source: { type: "base64" as const, media_type: "application/pdf", data: "x".repeat(sizeChars) },
    title: "report.pdf",
  };
}

function msg(role: "user" | "assistant", content: any[]): ChatMessage {
  return { role, content };
}

describe("sanitizeHistoryDocuments", () => {
  test("no-op when there are no documents", () => {
    const msgs: ChatMessage[] = [msg("user", [{ type: "text", text: "hi" }])];
    sanitizeHistoryDocuments(msgs);
    expect(msgs[0].content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("leaves docs untouched when total is under budget", () => {
    const msgs: ChatMessage[] = [
      msg("user", [docBlock(1_000_000)]),
      msg("user", [docBlock(1_000_000)]),
    ];
    sanitizeHistoryDocuments(msgs);
    expect((msgs[0].content[0] as any).type).toBe("document");
    expect((msgs[1].content[0] as any).type).toBe("document");
  });

  test("strips a single doc that exceeds the per-item cap", () => {
    // 28 MB base64 > MAX_SINGLE_DOCUMENT_BASE64 (27 MB)
    const msgs: ChatMessage[] = [
      msg("user", [docBlock(28 * 1024 * 1024)]),
      msg("user", [{ type: "text", text: "current turn" }]),
    ];
    sanitizeHistoryDocuments(msgs);
    expect((msgs[0].content[0] as any).type).toBe("text");
    expect((msgs[0].content[0] as any).text).toMatch(/previously shown/i);
  });

  test("replaces oldest doc first when over budget", () => {
    // 4 docs * 15 MB base64 = 60 MB total, over 50 MB budget.
    const msgs: ChatMessage[] = [
      msg("user", [docBlock(15 * 1024 * 1024)]),
      msg("user", [docBlock(15 * 1024 * 1024)]),
      msg("user", [docBlock(15 * 1024 * 1024)]),
      msg("user", [docBlock(15 * 1024 * 1024)]),
    ];
    sanitizeHistoryDocuments(msgs);
    // Oldest goes first; the most recent survives.
    expect((msgs[0].content[0] as any).type).toBe("text");
    expect((msgs[3].content[0] as any).type).toBe("document");
  });

  test("trims within the current turn when its own payload is over budget", () => {
    // A single tool_result carries 4 docs * 15 MB = 60 MB > budget.
    // Without the fix the sanitizer exempted the current turn and let
    // the whole payload through. Now oldest-within-the-turn is dropped
    // first; the last one stays.
    const toolResult = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text: "" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(15 * 1024 * 1024) } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(15 * 1024 * 1024) } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(15 * 1024 * 1024) } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(15 * 1024 * 1024) } },
      ],
    } as any;
    const msgs: ChatMessage[] = [msg("user", [toolResult])];
    sanitizeHistoryDocuments(msgs);
    const body = (msgs[0].content[0] as any).content;
    // First few are scrubbed (type text), last one stays (type document).
    expect(body[1].type).toBe("text");
    expect(body[4].type).toBe("document");
    // Total base64 in remaining doc blocks fits within the session budget.
    const remaining = body
      .filter((b: any) => b.type === "document")
      .reduce((sum: number, b: any) => sum + (b.source?.data?.length ?? 0), 0);
    expect(remaining).toBeLessThanOrEqual(50 * 1024 * 1024);
  });

  test("is independent of image budget (no image handling here)", () => {
    // An image block must not be touched by the document sanitizer.
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "x".repeat(1_000_000) },
    } as any;
    const msgs: ChatMessage[] = [msg("user", [image])];
    sanitizeHistoryDocuments(msgs);
    expect((msgs[0].content[0] as any).type).toBe("image");
  });

  test("handles document blocks embedded in tool_result content", () => {
    // read_file('x.pdf') produces a tool_result whose content array carries
    // a document block. Oversized doc there should also be scrubbed.
    const toolResult = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text: "[PDF: x.pdf]" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(28 * 1024 * 1024) } },
      ],
    } as any;
    const msgs: ChatMessage[] = [
      msg("user", [toolResult]),
      msg("user", [{ type: "text", text: "next" }]),
    ];
    sanitizeHistoryDocuments(msgs);
    const replaced = (msgs[0].content[0] as any).content[1];
    expect(replaced.type).toBe("text");
    expect(replaced.text).toMatch(/previously shown/i);
  });
});
