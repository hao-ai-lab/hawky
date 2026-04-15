// =============================================================================
// Combined image + document budget sanitizer tests.
//
// Guards the worst case: per-bucket sanitizers each leave their max, but
// the combined total still exceeds the provider's request ceiling. The
// combined-budget pass must trim oldest until we're under.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { sanitizeCombinedAttachmentBudget } from "../src/agent/combined-attachment-budget.js";
import type { ChatMessage } from "../src/agent/types.js";

function docBlock(sizeChars: number) {
  return {
    type: "document" as const,
    source: { type: "base64" as const, media_type: "application/pdf", data: "x".repeat(sizeChars) },
  };
}

function imageBlock(sizeChars: number) {
  return {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "x".repeat(sizeChars) },
  };
}

function msg(role: "user" | "assistant", content: any[]): ChatMessage {
  return { role, content };
}

describe("sanitizeCombinedAttachmentBudget", () => {
  test("no-op when combined total is under the cap", () => {
    const msgs: ChatMessage[] = [
      msg("user", [imageBlock(5 * 1024 * 1024), docBlock(10 * 1024 * 1024)]),
    ];
    sanitizeCombinedAttachmentBudget(msgs);
    const content = msgs[0].content as any[];
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("document");
  });

  test("trims oldest across both buckets when combined > 55MB", () => {
    // 10MB image + 50MB doc = 60MB > 55MB cap. Oldest is the image
    // (bucket kind does not matter — we drop by msgIdx/blockIdx order).
    const msgs: ChatMessage[] = [
      msg("user", [imageBlock(10 * 1024 * 1024)]),
      msg("user", [docBlock(50 * 1024 * 1024)]),
    ];
    sanitizeCombinedAttachmentBudget(msgs);
    expect((msgs[0].content[0] as any).type).toBe("text");
    expect((msgs[1].content[0] as any).type).toBe("document");
  });

  test("trims doc first when it is older than image", () => {
    const msgs: ChatMessage[] = [
      msg("user", [docBlock(50 * 1024 * 1024)]),
      msg("user", [imageBlock(10 * 1024 * 1024)]),
    ];
    sanitizeCombinedAttachmentBudget(msgs);
    expect((msgs[0].content[0] as any).type).toBe("text");
    expect((msgs[1].content[0] as any).type).toBe("image");
  });

  test("handles attachments nested inside tool_result content", () => {
    const toolResult = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text: "" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(50 * 1024 * 1024) } },
      ],
    } as any;
    const msgs: ChatMessage[] = [
      msg("user", [toolResult]),
      msg("user", [imageBlock(10 * 1024 * 1024)]),
    ];
    sanitizeCombinedAttachmentBudget(msgs);
    // Doc inside the older tool_result is replaced; image in newer turn stays.
    expect((msgs[0].content[0] as any).content[1].type).toBe("text");
    expect((msgs[1].content[0] as any).type).toBe("image");
  });
});
