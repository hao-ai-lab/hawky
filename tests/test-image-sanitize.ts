// =============================================================================
// Image History Sanitization Tests
// =============================================================================

import { describe, test, expect } from "bun:test";
import { sanitizeHistoryImages } from "../src/agent/image-sanitize.js";
import type { ChatMessage } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Create a fake base64 string of exactly `base64Len` characters.
 *  The sanitizer now counts base64 string length (matching the Anthropic API). */
function fakeBase64(base64Len: number): string {
  return "A".repeat(base64Len);
}

function makeImageBlock(base64Len: number) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/jpeg",
      data: fakeBase64(base64Len),
    },
  };
}

function makeUserMessage(content: any[]): ChatMessage {
  return { role: "user", content, timestamp: new Date().toISOString() };
}

function makeAssistantMessage(text: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  };
}

function makeToolResultWithImage(bytes: number): any {
  return {
    type: "tool_result",
    tool_use_id: "test",
    content: [
      { type: "text", text: "Screenshot" },
      makeImageBlock(bytes),
    ],
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("sanitizeHistoryImages", () => {
  test("no-op when no images", () => {
    const messages: ChatMessage[] = [
      makeUserMessage([{ type: "text", text: "hello" }]),
      makeAssistantMessage("hi"),
    ];
    sanitizeHistoryImages(messages);
    expect(messages[0].content[0].type).toBe("text");
  });

  test("no-op when images under budget", () => {
    const messages: ChatMessage[] = [
      makeUserMessage([
        { type: "text", text: "look at this" },
        makeImageBlock(1_000_000) /* 1MB base64 */, // 1MB — well under 10MB budget
      ]),
      makeAssistantMessage("I see it"),
    ];
    sanitizeHistoryImages(messages);
    expect(messages[0].content[1].type).toBe("image");
  });

  test("replaces oldest images when over budget", () => {
    // 4 images at 3MB each = 12MB, over 10MB budget
    const messages: ChatMessage[] = [
      makeUserMessage([{ type: "text", text: "img1" }, makeImageBlock(3_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([{ type: "text", text: "img2" }, makeImageBlock(3_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([{ type: "text", text: "img3" }, makeImageBlock(3_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([{ type: "text", text: "img4" }, makeImageBlock(3_000_000)]),
    ];
    sanitizeHistoryImages(messages);

    // Oldest images replaced until under budget (12MB - 3MB = 9MB < 10MB)
    // So only the first image needs to go
    expect(messages[0].content[1].type).toBe("text"); // replaced (oldest)
    expect((messages[0].content[1] as any).text).toContain("previously shown");
    // Remaining images kept (9MB total, under budget)
    expect(messages[2].content[1].type).toBe("image"); // kept
    // Last user message always kept
    expect(messages[6].content[1].type).toBe("image"); // kept
  });

  test("preserves last user message images under API limit", () => {
    // Current turn with image under per-image limit — should be kept
    const messages: ChatMessage[] = [
      makeUserMessage([makeImageBlock(3_000_000)]), // 3MB, under 5MB API limit
    ];
    sanitizeHistoryImages(messages);
    expect(messages[0].content[0].type).toBe("image"); // kept
  });

  test("handles tool result images (screenshots)", () => {
    // Tool result with screenshot image, over budget
    const messages: ChatMessage[] = [
      makeUserMessage([makeToolResultWithImage(4_000_000)]),
      makeAssistantMessage("I see the screenshot"),
      makeUserMessage([makeToolResultWithImage(4_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([makeToolResultWithImage(4_000_000)]),
    ];
    sanitizeHistoryImages(messages);

    // Oldest tool result image replaced, newest kept
    const oldToolResult = messages[0].content[0] as any;
    const oldImageBlock = oldToolResult.content.find((b: any) => b.type === "text" && b.text?.includes("previously shown"));
    expect(oldImageBlock).toBeDefined();

    // Last message's image kept
    const newToolResult = messages[4].content[0] as any;
    const newImageBlock = newToolResult.content.find((b: any) => b.type === "image");
    expect(newImageBlock).toBeDefined();
  });

  test("mixed user images and tool result images", () => {
    const messages: ChatMessage[] = [
      makeUserMessage([makeImageBlock(4_000_000)]), // user image
      makeAssistantMessage("ok"),
      makeUserMessage([makeToolResultWithImage(4_000_000)]), // screenshot
      makeAssistantMessage("ok"),
      makeUserMessage([makeImageBlock(4_000_000)]), // newest user image
    ];
    sanitizeHistoryImages(messages);

    // Oldest replaced first
    expect(messages[0].content[0].type).toBe("text"); // replaced
    // Last user message kept
    expect(messages[4].content[0].type).toBe("image"); // kept
  });

  test("many small images under budget are all kept", () => {
    // 10 images at 500KB each = 5MB, under 10MB budget
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUserMessage([{ type: "text", text: `img ${i}` }, makeImageBlock(500_000)]));
      messages.push(makeAssistantMessage("ok"));
    }
    sanitizeHistoryImages(messages);
    // All images should be kept
    for (let i = 0; i < messages.length; i += 2) {
      expect(messages[i].content[1].type).toBe("image");
    }
  });

  test("many small images over budget replaces oldest", () => {
    // 25 images at 500KB each = 12.5MB, over 10MB budget
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(makeUserMessage([{ type: "text", text: `img ${i}` }, makeImageBlock(500_000)]));
      if (i < 24) messages.push(makeAssistantMessage("ok"));
    }
    sanitizeHistoryImages(messages);

    // First few images should be replaced, later ones kept
    // Need to remove ~5 images (2.5MB) to get to 10MB
    let replacedCount = 0;
    let keptCount = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") continue;
      if (messages[i].content[1]?.type === "text") replacedCount++;
      if (messages[i].content[1]?.type === "image") keptCount++;
    }
    expect(replacedCount).toBeGreaterThan(0);
    expect(keptCount).toBeGreaterThan(0);
    // Last user message always preserved
    expect(messages[messages.length - 1].content[1].type).toBe("image");
  });

  test("multiple images in same message", () => {
    // Single user message with 4 images at 3MB each = 12MB
    const messages: ChatMessage[] = [
      makeUserMessage([
        { type: "text", text: "4 monitors" },
        makeImageBlock(3_000_000),
        makeImageBlock(3_000_000),
        makeImageBlock(3_000_000),
        makeImageBlock(3_000_000),
      ]),
    ];
    sanitizeHistoryImages(messages);
    // It's the only (and last) user message, so all images should be kept
    const imageCount = messages[0].content.filter((b) => b.type === "image").length;
    expect(imageCount).toBe(4);
  });

  test("multiple images in old message replaced before newer ones", () => {
    // Old message has 2 images at 4MB each, new message has 1 at 4MB = 12MB
    const messages: ChatMessage[] = [
      makeUserMessage([makeImageBlock(4_000_000), makeImageBlock(4_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([makeImageBlock(4_000_000)]),
    ];
    sanitizeHistoryImages(messages);
    // Old message's images replaced first (oldest order)
    const oldReplaced = messages[0].content.filter((b) => b.type === "text").length;
    expect(oldReplaced).toBeGreaterThan(0);
    // New message's image kept
    expect(messages[2].content[0].type).toBe("image");
  });

  test("empty history", () => {
    const messages: ChatMessage[] = [];
    sanitizeHistoryImages(messages); // should not throw
    expect(messages.length).toBe(0);
  });

  test("idempotent — running twice produces same result", () => {
    const messages: ChatMessage[] = [
      makeUserMessage([makeImageBlock(6_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([makeImageBlock(6_000_000)]),
    ];
    sanitizeHistoryImages(messages);
    const afterFirst = JSON.stringify(messages);
    sanitizeHistoryImages(messages);
    const afterSecond = JSON.stringify(messages);
    expect(afterFirst).toBe(afterSecond);
  });

  test("replaces individual images over 5MB API limit", () => {
    // One image at 6MB — exceeds per-image API limit even if under total budget
    const messages: ChatMessage[] = [
      makeUserMessage([{ type: "text", text: "big image" }, makeImageBlock(6_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([{ type: "text", text: "small" }, makeImageBlock(500_000)]),
    ];
    sanitizeHistoryImages(messages);

    // Big image replaced regardless of total budget
    expect(messages[0].content[1].type).toBe("text");
    expect((messages[0].content[1] as any).text).toContain("previously shown");
    // Small image kept
    expect(messages[2].content[1].type).toBe("image");
  });

  test("oversized images in current turn are also replaced", () => {
    // Even current-turn images over 5MB API limit must be replaced
    const messages: ChatMessage[] = [
      makeUserMessage([makeImageBlock(6_000_000)]),
    ];
    sanitizeHistoryImages(messages);
    expect(messages[0].content[0].type).toBe("text"); // replaced — API would reject
  });

  test("handles old session with many large images (migration)", () => {
    // Simulates loading an old session with pre-fix large images
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeUserMessage([makeImageBlock(4_000_000)])); // 4MB each
      messages.push(makeAssistantMessage("ok"));
    }
    messages.push(makeUserMessage([{ type: "text", text: "help" }]));
    sanitizeHistoryImages(messages);

    // Total was 20MB. Budget is 10MB. Oldest images replaced.
    let replacedCount = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "text" && (block as any).text?.includes("previously shown")) replacedCount++;
      }
    }
    expect(replacedCount).toBeGreaterThan(0);
  });

  test("replaces just enough to get under budget", () => {
    // 3 images at 4MB = 12MB. Budget is 10MB. Need to remove 1 (oldest).
    const messages: ChatMessage[] = [
      makeUserMessage([makeImageBlock(4_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([makeImageBlock(4_000_000)]),
      makeAssistantMessage("ok"),
      makeUserMessage([makeImageBlock(4_000_000)]),
    ];
    sanitizeHistoryImages(messages);

    expect(messages[0].content[0].type).toBe("text"); // replaced (oldest)
    expect(messages[2].content[0].type).toBe("image"); // kept (now under budget)
    expect(messages[4].content[0].type).toBe("image"); // kept (current turn)
  });
});
