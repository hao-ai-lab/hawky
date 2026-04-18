// =============================================================================
// Tests: Message Normalization & Tool Result Truncation
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  truncateToolResult,
  truncateToolResultsInMessage,
  normalizeMessages,
} from "../src/agent/normalize.js";
import { formatMessagesForApi } from "../src/agent/context.js";
import type { ChatMessage, ContentBlock } from "../src/agent/types.js";

// =============================================================================
// Helpers
// =============================================================================

function userMsg(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(id: string, name: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

function toolResultMsg(toolUseId: string, content: string, isError = false): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  };
}

function mixedAssistantMsg(text: string, toolId: string, toolName: string): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: toolId, name: toolName, input: {} },
    ],
  };
}

// =============================================================================
// truncateToolResult
// =============================================================================

describe("truncateToolResult", () => {
  test("returns content unchanged when under limit", () => {
    const result = truncateToolResult("hello world", 100);
    expect(result).toBe("hello world");
  });

  test("truncates content exceeding limit", () => {
    // Use multi-line content so tail preview is actually shorter
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: ${"x".repeat(20)}`);
    const content = lines.join("\n");
    const result = truncateToolResult(content, 500);
    expect(result).toContain("[Output truncated:");
    expect(result).toContain("Showing last 20 lines");
    expect(result).toContain("line 200");
    // Result should be much shorter than original
    expect(result.length).toBeLessThan(content.length);
  });

  test("preserves last 20 lines as tail", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const result = truncateToolResult(content, 500);
    expect(result).toContain("line 100");
    expect(result).toContain("line 81"); // 100 - 20 + 1
    expect(result).toContain("Showing last 20 lines");
  });

  test("handles content with fewer lines than TAIL_LINES", () => {
    const content = "line1\nline2\nline3";
    // Make it long enough to trigger truncation by repeating
    const longContent = (content + "\n").repeat(200);
    const result = truncateToolResult(longContent, 100);
    expect(result).toContain("[Output truncated:");
    expect(result).toContain("---");
  });

  test("exactly at limit is not truncated", () => {
    const content = "x".repeat(500);
    expect(truncateToolResult(content, 500)).toBe(content);
  });

  test("empty content is not truncated", () => {
    expect(truncateToolResult("", 500)).toBe("");
  });
});

// =============================================================================
// truncateToolResultsInMessage
// =============================================================================

describe("truncateToolResultsInMessage", () => {
  test("truncates oversized tool_result in message", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const bigContent = lines.join("\n");
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: bigContent },
      ],
    };
    const result = truncateToolResultsInMessage(msg, 500);
    const block = result.content[0] as any;
    expect(block.content).toContain("[Output truncated:");
    expect(block.content.length).toBeLessThan(bigContent.length);
  });

  test("leaves small tool_result unchanged", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "small output" },
      ],
    };
    const result = truncateToolResultsInMessage(msg, 500);
    expect(result).toBe(msg); // Same reference — no change
  });

  test("leaves non-tool_result blocks unchanged", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: "x".repeat(1000) }],
    };
    const result = truncateToolResultsInMessage(msg, 500);
    expect(result).toBe(msg); // Text blocks not truncated
  });

  test("handles multiple tool_results in one message", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "x".repeat(1000) },
        { type: "tool_result", tool_use_id: "tu_2", content: "small" },
      ],
    };
    const result = truncateToolResultsInMessage(msg, 500);
    const block1 = result.content[0] as any;
    const block2 = result.content[1] as any;
    expect(block1.content).toContain("[Output truncated:");
    expect(block2.content).toBe("small");
  });
});

// =============================================================================
// normalizeMessages — empty content
// =============================================================================

describe("normalizeMessages — empty content", () => {
  test("strips messages with empty content array", () => {
    const msgs = [
      userMsg("hello"),
      { role: "assistant" as const, content: [] },
      assistantMsg("world"),
    ];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect((result[0].content[0] as any).text).toBe("hello");
    expect((result[1].content[0] as any).text).toBe("world");
  });

  test("keeps messages with non-empty content", () => {
    const msgs = [userMsg("a"), assistantMsg("b")];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(2);
  });
});

// =============================================================================
// normalizeMessages — orphaned tool_results
// =============================================================================

describe("normalizeMessages — orphaned tool_results", () => {
  test("drops tool_result with no matching tool_use", () => {
    const msgs = [
      userMsg("hello"),
      toolResultMsg("orphan_tu", "some result"), // No matching tool_use!
      assistantMsg("ok"),
    ];
    const result = normalizeMessages(msgs);
    // The orphaned tool_result message should be dropped
    // user("hello") + assistant("ok") remain, but need merge since consecutive user might happen
    expect(result.length).toBeLessThanOrEqual(2);
    // Should not contain the orphaned content
    const allContent = result.flatMap((m) => m.content);
    const toolResults = allContent.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(0);
  });

  test("keeps tool_result with matching tool_use", () => {
    const msgs = [
      userMsg("do something"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
      assistantMsg("done"),
    ];
    const result = normalizeMessages(msgs);
    const allContent = result.flatMap((m) => m.content);
    const toolResults = allContent.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
  });

  test("drops only the orphaned blocks, keeps others in same message", () => {
    const msgs: ChatMessage[] = [
      userMsg("start"),
      toolUseMsg("tu_1", "bash"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "valid" },
          { type: "tool_result", tool_use_id: "orphan", content: "invalid" },
        ],
      },
      assistantMsg("done"),
    ];
    const result = normalizeMessages(msgs);
    const allContent = result.flatMap((m) => m.content);
    const toolResults = allContent.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).tool_use_id).toBe("tu_1");
  });
});

// =============================================================================
// normalizeMessages — missing tool_results
// =============================================================================

describe("normalizeMessages — missing tool_results", () => {
  test("inserts synthetic error for tool_use without result", () => {
    const msgs = [
      userMsg("run something"),
      toolUseMsg("tu_1", "bash"),
      // No tool_result for tu_1!
      userMsg("next question"),
    ];
    const result = normalizeMessages(msgs);
    const allContent = result.flatMap((m) => m.content);
    const toolResults = allContent.filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const synthetic = toolResults.find((b) => (b as any).tool_use_id === "tu_1");
    expect(synthetic).toBeDefined();
    expect((synthetic as any).content).toContain("missing");
    expect((synthetic as any).is_error).toBe(true);
  });

  test("inserts synthetic for multiple missing results", () => {
    const msgs: ChatMessage[] = [
      userMsg("do both"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          { type: "tool_use", id: "tu_2", name: "grep", input: {} },
        ],
      },
      // No results for either!
      userMsg("what happened?"),
    ];
    const result = normalizeMessages(msgs);
    const allContent = result.flatMap((m) => m.content);
    const toolResults = allContent.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(2);
  });

  test("does not insert synthetic when result exists", () => {
    const msgs = [
      userMsg("run"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
      assistantMsg("done"),
    ];
    const result = normalizeMessages(msgs);
    const allContent = result.flatMap((m) => m.content);
    const synthetics = allContent.filter(
      (b) => b.type === "tool_result" && (b as any).content.includes("missing"),
    );
    expect(synthetics).toHaveLength(0);
  });
});

// =============================================================================
// normalizeMessages — consecutive same-role merge
// =============================================================================

describe("normalizeMessages — merge consecutive same-role", () => {
  test("merges two consecutive user messages", () => {
    const msgs = [
      userMsg("hello"),
      userMsg("world"),
      assistantMsg("hi"),
    ];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as any).text).toBe("hello");
    expect((result[0].content[1] as any).text).toBe("world");
  });

  test("merges three consecutive assistant messages", () => {
    const msgs = [
      userMsg("go"),
      assistantMsg("part 1"),
      assistantMsg("part 2"),
      assistantMsg("part 3"),
    ];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[1].content).toHaveLength(3);
  });

  test("does not merge alternating messages", () => {
    const msgs = [
      userMsg("a"),
      assistantMsg("b"),
      userMsg("c"),
      assistantMsg("d"),
    ];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(4);
  });

  test("single message unchanged", () => {
    const msgs = [userMsg("only")];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(1);
  });
});

// =============================================================================
// normalizeMessages — first message user
// =============================================================================

describe("normalizeMessages — first message must be user", () => {
  test("prepends synthetic user message when first is assistant", () => {
    const msgs = [
      assistantMsg("I'm first"),
      userMsg("hello"),
    ];
    const result = normalizeMessages(msgs);
    expect(result[0].role).toBe("user");
    expect((result[0].content[0] as any).text).toBe("[Continuing conversation]");
    expect(result).toHaveLength(3);
  });

  test("does nothing when first is already user", () => {
    const msgs = [userMsg("hello"), assistantMsg("hi")];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect((result[0].content[0] as any).text).toBe("hello");
  });

  test("handles empty array", () => {
    expect(normalizeMessages([])).toEqual([]);
  });
});

// =============================================================================
// normalizeMessages — complex scenarios
// =============================================================================

describe("normalizeMessages — complex scenarios", () => {
  test("real-world cancel scenario: tool_use without result + new user msg", () => {
    const msgs = [
      userMsg("search for TODO"),
      toolUseMsg("tu_1", "grep"),
      // Cancel happened — no tool_result, user types new message
      userMsg("never mind, list files instead"),
    ];
    const result = normalizeMessages(msgs);

    // Should have: user, assistant(tool_use), user(synthetic_result + new msg merged)
    expect(result.length).toBeGreaterThanOrEqual(3);

    // The tool_use should have a matching result somewhere
    const allBlocks = result.flatMap((m) => m.content);
    const toolResults = allBlocks.filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  test("corrupted session: orphaned result + missing result + consecutive users", () => {
    const msgs: ChatMessage[] = [
      userMsg("start"),
      toolResultMsg("orphan", "ghost result"), // Orphaned
      assistantMsg("thinking"),
      { // Assistant with tool_use
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
      },
      // Missing result for tu_1
      userMsg("continue"),
      userMsg("more"), // Consecutive users
      assistantMsg("done"),
    ];
    const result = normalizeMessages(msgs);

    // Should be valid: alternating roles, no orphans, no missing results
    for (let i = 1; i < result.length; i++) {
      if (result[i].role === "assistant" && result[i - 1].role === "assistant") {
        throw new Error("Consecutive assistant messages found");
      }
    }

    // Should have synthetic result for tu_1
    const allBlocks = result.flatMap((m) => m.content);
    const results = allBlocks.filter((b) => b.type === "tool_result");
    const syntheticResult = results.find((b) => (b as any).tool_use_id === "tu_1");
    expect(syntheticResult).toBeDefined();

    // Orphaned result should be gone
    const orphanResult = results.find((b) => (b as any).tool_use_id === "orphan");
    expect(orphanResult).toBeUndefined();
  });

  test("normal conversation passes through unchanged (structurally)", () => {
    const msgs = [
      userMsg("hello"),
      assistantMsg("hi"),
      userMsg("how are you"),
      assistantMsg("good"),
    ];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
    expect(result[3].role).toBe("assistant");
  });

  test("tool call conversation passes through unchanged", () => {
    const msgs = [
      userMsg("run ls"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "file1.txt"),
      assistantMsg("Found files"),
    ];
    const result = normalizeMessages(msgs);
    expect(result).toHaveLength(4);
  });
});

// =============================================================================
// Integration: formatMessagesForApi includes normalization
// =============================================================================

describe("formatMessagesForApi — normalization integration", () => {
  test("normalizes before formatting", () => {
    const msgs: ChatMessage[] = [
      assistantMsg("I shouldn't be first"), // First msg is assistant
      userMsg("hello"),
    ];
    const result = formatMessagesForApi(msgs);
    // Should have synthetic user prepended
    expect(result[0].role).toBe("user");
    expect(result.length).toBe(3);
  });

  test("strips internal fields after normalization", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello", internal_only: true }],
      },
      assistantMsg("hi"),
    ];
    const result = formatMessagesForApi(msgs);
    expect((result[0].content[0] as any).internal_only).toBeUndefined();
  });
});
