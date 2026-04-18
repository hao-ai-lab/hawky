// =============================================================================
// Tests: prompt-cache breakpoint placement
//
// Verifies applyCacheBreakpoints attaches cache_control markers to the
// expected places (system prompt, last tool, last block of last message)
// without mutating the input. These markers are what enables Anthropic
// prompt caching — without them every API call is billed at the full
// fresh-input rate.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { applyCacheBreakpoints } from "../src/agent/prompt-cache.js";
import type { LLMStreamRequest, LLMSystemBlock, LLMMessage } from "../src/agent/provider.js";
import type { AnthropicToolDefinition, ContentBlock, TextContentBlock, ToolResultContentBlock, ImageContentBlock, DocumentContentBlock } from "../src/agent/types.js";

function makeRequest(overrides: Partial<LLMStreamRequest> = {}): LLMStreamRequest {
  return {
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    system: "you are helpful",
    ...overrides,
  };
}

describe("applyCacheBreakpoints", () => {
  test("wraps a string system prompt into a typed block with cache_control", () => {
    const out = applyCacheBreakpoints(makeRequest({ system: "you are helpful" }));
    expect(Array.isArray(out.system)).toBe(true);
    const sys = out.system as LLMSystemBlock[];
    expect(sys.length).toBe(1);
    expect(sys[0]?.type).toBe("text");
    expect(sys[0]?.text).toBe("you are helpful");
    expect(sys[0]?.cache_control?.type).toBe("ephemeral");
  });

  test("marks the LAST block when system is already a typed-block array", () => {
    const sys: LLMSystemBlock[] = [
      { type: "text", text: "rules" },
      { type: "text", text: "more rules" },
    ];
    const out = applyCacheBreakpoints(makeRequest({ system: sys }));
    const outSys = out.system as LLMSystemBlock[];
    expect(outSys[0]?.cache_control).toBeUndefined();
    expect(outSys[1]?.cache_control?.type).toBe("ephemeral");
  });

  test("leaves system undefined when input was undefined", () => {
    const out = applyCacheBreakpoints(makeRequest({ system: undefined }));
    expect(out.system).toBeUndefined();
  });

  test("leaves an empty system string unchanged (nothing to mark)", () => {
    const out = applyCacheBreakpoints(makeRequest({ system: "" }));
    expect(out.system).toBe("");
  });

  test("marks the LAST tool with cache_control; earlier tools are untouched", () => {
    const tools: AnthropicToolDefinition[] = [
      { name: "a", description: "", input_schema: { type: "object", properties: {} } },
      { name: "b", description: "", input_schema: { type: "object", properties: {} } },
      { name: "c", description: "", input_schema: { type: "object", properties: {} } },
    ];
    const out = applyCacheBreakpoints(makeRequest({ tools }));
    const outTools = out.tools!;
    expect(outTools[0]?.cache_control).toBeUndefined();
    expect(outTools[1]?.cache_control).toBeUndefined();
    expect(outTools[2]?.cache_control?.type).toBe("ephemeral");
  });

  test("no tools → tools field unchanged (no marker invented)", () => {
    const out = applyCacheBreakpoints(makeRequest({ tools: undefined }));
    expect(out.tools).toBeUndefined();
  });

  test("empty tools array stays empty", () => {
    const out = applyCacheBreakpoints(makeRequest({ tools: [] }));
    expect(out.tools).toEqual([]);
  });

  test("marks the LAST block of the LAST message; earlier messages are untouched", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "old user" } as TextContentBlock] },
      { role: "assistant", content: [{ type: "text", text: "old reply" } as TextContentBlock] },
      {
        role: "user",
        content: [
          { type: "text", text: "first part" } as TextContentBlock,
          { type: "text", text: "last part" } as TextContentBlock,
        ],
      },
    ];
    const out = applyCacheBreakpoints(makeRequest({ messages }));
    // Earlier messages — no markers
    const m0Content = out.messages[0]!.content as ContentBlock[];
    expect((m0Content[0] as TextContentBlock).cache_control).toBeUndefined();
    const m1Content = out.messages[1]!.content as ContentBlock[];
    expect((m1Content[0] as TextContentBlock).cache_control).toBeUndefined();
    // Last message — only the last block marked
    const lastContent = out.messages[2]!.content as ContentBlock[];
    expect((lastContent[0] as TextContentBlock).cache_control).toBeUndefined();
    expect((lastContent[1] as TextContentBlock).cache_control?.type).toBe("ephemeral");
  });

  test("string-content last message is wrapped into a typed block with cache_control", () => {
    const out = applyCacheBreakpoints(makeRequest({
      messages: [{ role: "user", content: "ping" }],
    }));
    const content = out.messages[0]!.content as ContentBlock[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(1);
    expect(content[0]?.type).toBe("text");
    expect((content[0] as TextContentBlock).text).toBe("ping");
    expect((content[0] as TextContentBlock).cache_control?.type).toBe("ephemeral");
  });

  test("marks tool_result block (mid-turn case where last message ends in a tool_result)", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" } as ToolResultContentBlock,
        ],
      },
    ];
    const out = applyCacheBreakpoints(makeRequest({ messages }));
    const lastContent = out.messages[1]!.content as ContentBlock[];
    expect((lastContent[0] as ToolResultContentBlock).cache_control?.type).toBe("ephemeral");
  });

  test("marks an image attachment when the user message ends with one (multimodal turn)", () => {
    // sendMessage appends attachments AFTER the text block, so a user turn
    // with images ends in an `image` block. Earlier this case was skipped,
    // which meant every multimodal turn paid the full input rate on the
    // following call.
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what's in this picture?" } as TextContentBlock,
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "Zm9v" },
          } as ImageContentBlock,
        ],
      },
    ];
    const out = applyCacheBreakpoints(makeRequest({ messages }));
    const lastContent = out.messages[0]!.content as ContentBlock[];
    expect((lastContent[0] as TextContentBlock).cache_control).toBeUndefined();
    expect((lastContent[1] as ImageContentBlock).cache_control?.type).toBe("ephemeral");
  });

  test("marks a document (PDF) attachment when the user message ends with one", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "summarize this paper" } as TextContentBlock,
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBE..." },
            title: "paper.pdf",
          } as DocumentContentBlock,
        ],
      },
    ];
    const out = applyCacheBreakpoints(makeRequest({ messages }));
    const lastContent = out.messages[0]!.content as ContentBlock[];
    expect((lastContent[1] as DocumentContentBlock).cache_control?.type).toBe("ephemeral");
  });

  test("non-text/non-tool_result trailing block is left alone (e.g. trailing tool_use)", () => {
    // Edge case: an assistant message ending in a tool_use block. cache_control
    // isn't supported on tool_use in our types, so the helper must not crash
    // or fabricate the field — it just leaves the block untouched.
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" } as TextContentBlock,
          { type: "tool_use", id: "t1", name: "bash", input: {} },
        ],
      },
    ];
    const out = applyCacheBreakpoints(makeRequest({ messages }));
    const lastContent = out.messages[0]!.content as ContentBlock[];
    expect((lastContent[0] as TextContentBlock).cache_control).toBeUndefined();
    // Last block (tool_use) untouched — no cache_control field added.
    expect(lastContent[1]).toEqual({ type: "tool_use", id: "t1", name: "bash", input: {} });
  });

  test("does not mutate the input request", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" } as TextContentBlock] },
    ];
    const tools: AnthropicToolDefinition[] = [
      { name: "x", description: "", input_schema: { type: "object", properties: {} } },
    ];
    const req = makeRequest({ messages, tools, system: "sys" });
    const before = JSON.stringify(req);
    applyCacheBreakpoints(req);
    const after = JSON.stringify(req);
    expect(after).toBe(before);
  });

  test("uses up to 3 markers (system + last tool + last message) — fits inside Anthropic's limit of 4", () => {
    const out = applyCacheBreakpoints(makeRequest({
      system: "rules",
      tools: [
        { name: "a", description: "", input_schema: { type: "object", properties: {} } },
        { name: "b", description: "", input_schema: { type: "object", properties: {} } },
      ],
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
        { role: "user", content: "new" },
      ],
    }));
    let markerCount = 0;
    for (const block of out.system as LLMSystemBlock[]) {
      if (block.cache_control) markerCount++;
    }
    for (const tool of out.tools!) {
      if (tool.cache_control) markerCount++;
    }
    for (const msg of out.messages) {
      const content = msg.content as ContentBlock[];
      for (const block of content) {
        if ((block as any).cache_control) markerCount++;
      }
    }
    expect(markerCount).toBe(3);
  });
});
