// =============================================================================
// Integration Tests: Message Normalization Pipeline
//
// Tests the full pipeline: history → truncateHistory → formatMessagesForApi
// Verifies that corrupted/complex histories produce valid Anthropic API messages.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { formatMessagesForApi, truncateHistory } from "../../src/agent/context.js";
import { truncateToolResultsInMessage } from "../../src/agent/normalize.js";
import type { ChatMessage, ContentBlock } from "../../src/agent/types.js";

// =============================================================================
// Helpers
// =============================================================================

function userMsg(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(id: string, name: string, input: Record<string, unknown> = {}): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function toolResultMsg(toolUseId: string, content: string, isError = false): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  };
}

/**
 * Validate that a message array is structurally valid for the Anthropic API:
 * - Non-empty
 * - First message is user
 * - Alternating roles (no consecutive same-role)
 * - Every tool_use has a matching tool_result
 * - No orphaned tool_results
 * - No empty content arrays
 */
function validateAnthropicFormat(messages: ReturnType<typeof formatMessagesForApi>): string[] {
  const errors: string[] = [];

  if (messages.length === 0) return ["empty message array"];

  if (messages[0].role !== "user") {
    errors.push(`first message role is "${messages[0].role}", expected "user"`);
  }

  // Check no consecutive same-role
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      errors.push(`consecutive ${messages[i].role} at indices ${i - 1} and ${i}`);
    }
  }

  // Check no empty content
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].content || messages[i].content.length === 0) {
      errors.push(`empty content at index ${i}`);
    }
  }

  // Check tool_use / tool_result pairing
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") toolUseIds.add((block as any).id);
      if (block.type === "tool_result") toolResultIds.add((block as any).tool_use_id);
    }
  }

  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      errors.push(`tool_use "${id}" has no matching tool_result`);
    }
  }

  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      errors.push(`tool_result "${id}" has no matching tool_use`);
    }
  }

  // Check no internal fields leaked
  for (const msg of messages) {
    for (const block of msg.content) {
      if ("internal_only" in block) errors.push("internal_only field leaked to API");
      if ("display_text" in block && block.type === "text") errors.push("display_text field leaked to API");
      if ("display_content" in block && block.type === "tool_result") errors.push("display_content field leaked to API");
    }
  }

  return errors;
}

// =============================================================================
// Full pipeline: corrupted histories → valid API format
// =============================================================================

describe("normalize pipeline — corrupted histories produce valid API format", () => {
  test("orphaned tool_result + missing tool_result + consecutive users", () => {
    const history: ChatMessage[] = [
      userMsg("start"),
      toolResultMsg("orphan_id", "ghost result"),   // orphaned
      assistantMsg("thinking"),
      toolUseMsg("tu_1", "bash"),                    // has no result
      userMsg("continue"),
      userMsg("more"),                               // consecutive user
      assistantMsg("done"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });

  test("cancel scenario: tool_use without result followed by new user message", () => {
    const history: ChatMessage[] = [
      userMsg("search for TODO"),
      toolUseMsg("tu_grep", "grep"),
      // User cancelled — no tool_result, typed new message
      userMsg("never mind, list files instead"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });

  test("assistant speaks first (session resume)", () => {
    const history: ChatMessage[] = [
      assistantMsg("Welcome back! I was helping you with..."),
      userMsg("yes, continue"),
      assistantMsg("ok"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
    expect(result[0].role).toBe("user");
  });

  test("multiple tool_uses in one assistant message, all missing results", () => {
    const history: ChatMessage[] = [
      userMsg("do everything"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          { type: "tool_use", id: "tu_2", name: "grep", input: {} },
          { type: "tool_use", id: "tu_3", name: "glob", input: {} },
        ],
      },
      // All three results missing (crash during tool execution)
      userMsg("what happened?"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });

  test("empty content messages are stripped", () => {
    const history: ChatMessage[] = [
      userMsg("hello"),
      { role: "assistant", content: [] },
      assistantMsg("hi"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
    expect(result.length).toBe(2);
  });

  test("internal_only and display_text fields are stripped", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "internal reminder", internal_only: true },
          { type: "text", text: "hello", display_text: "/help" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "output", display_content: "rich output" },
        ],
      },
      assistantMsg("done"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// Pipeline: truncation + normalization combined
// =============================================================================

describe("normalize pipeline — truncation before normalization", () => {
  test("truncateHistory then formatMessagesForApi produces valid output", () => {
    // Build a long conversation
    const history: ChatMessage[] = [];
    for (let i = 0; i < 120; i++) {
      history.push(userMsg(`question ${i}`));
      history.push(assistantMsg(`answer ${i}`));
    }
    // 240 messages, truncate to last 50 turns (100 messages)
    const truncated = truncateHistory(history, 50);
    const result = formatMessagesForApi(truncated);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
    expect(result.length).toBe(100);
  });

  test("truncation mid-tool-call: tool_use kept but result truncated away", () => {
    // Simulate: truncation cuts between a tool_use and its tool_result
    const history: ChatMessage[] = [];

    // Old messages that will be truncated
    for (let i = 0; i < 100; i++) {
      history.push(userMsg(`old ${i}`));
      history.push(assistantMsg(`old answer ${i}`));
    }

    // Tool call whose result is in the "old" section
    history.push(userMsg("run something"));
    history.push(toolUseMsg("tu_old", "bash"));
    history.push(toolResultMsg("tu_old", "old output"));
    history.push(assistantMsg("done with old"));

    // Recent messages that will survive truncation
    for (let i = 0; i < 5; i++) {
      history.push(userMsg(`recent ${i}`));
      history.push(assistantMsg(`recent answer ${i}`));
    }

    // Truncate to 5 turns — the old tool call pair is kept together or both dropped
    const truncated = truncateHistory(history, 5);
    const result = formatMessagesForApi(truncated);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// Pipeline: tool result truncation + normalization
// =============================================================================

describe("normalize pipeline — large tool results", () => {
  test("oversized tool result truncated then normalized correctly", () => {
    const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(100)}`).join("\n");

    const history: ChatMessage[] = [
      userMsg("run a big command"),
      toolUseMsg("tu_big", "bash"),
      toolResultMsg("tu_big", bigOutput),
      assistantMsg("done"),
    ];

    // Truncate tool results first (as the agent loop does)
    const withTruncated = history.map((msg) =>
      truncateToolResultsInMessage(msg, 30_000),
    );

    const result = formatMessagesForApi(withTruncated);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);

    // Verify the big output was actually truncated
    const toolResult = result
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result") as any;
    expect(toolResult.content).toContain("[Output truncated:");
  });

  test("mixed: some tool results big, some small, all normalized", () => {
    const bigOutput = "x".repeat(50_000);
    const smallOutput = "hello world";

    const history: ChatMessage[] = [
      userMsg("run two commands"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          { type: "tool_use", id: "tu_2", name: "grep", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: bigOutput },
          { type: "tool_result", tool_use_id: "tu_2", content: smallOutput },
        ],
      },
      assistantMsg("both done"),
    ];

    const withTruncated = history.map((msg) =>
      truncateToolResultsInMessage(msg, 30_000),
    );

    const result = formatMessagesForApi(withTruncated);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// Edge cases: deeply corrupted histories
// =============================================================================

describe("normalize pipeline — deeply corrupted histories", () => {
  test("only orphaned tool_results, no real messages", () => {
    const history: ChatMessage[] = [
      toolResultMsg("orphan_1", "result 1"),
      toolResultMsg("orphan_2", "result 2"),
    ];

    const result = formatMessagesForApi(history);
    // All messages dropped → empty → should at least not crash
    // (empty is technically valid for "no history yet")
    expect(result.length).toBe(0);
  });

  test("alternating tool_uses with no results (multiple cancels)", () => {
    const history: ChatMessage[] = [
      userMsg("task 1"),
      toolUseMsg("tu_1", "bash"),
      // cancel — no result
      userMsg("task 2"),
      toolUseMsg("tu_2", "grep"),
      // cancel — no result
      userMsg("task 3"),
      toolUseMsg("tu_3", "glob"),
      // cancel — no result
      userMsg("give up"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);

    // All three tool_uses should have synthetic results
    const allBlocks = result.flatMap((m) => m.content);
    const toolResults = allBlocks.filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBe(3);
  });

  test("mixed assistant content: text + tool_use, with result missing", () => {
    const history: ChatMessage[] = [
      userMsg("analyze this file"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read it..." },
          { type: "tool_use", id: "tu_read", name: "read_file", input: { path: "test.ts" } },
        ],
      },
      // crash — no tool_result
      userMsg("are you there?"),
      assistantMsg("sorry, I had an issue"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
  });

  test("thinking blocks preserved through pipeline", () => {
    const history: ChatMessage[] = [
      userMsg("think about this"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me consider...", signature: "sig_test_123" },
          { type: "text", text: "Here's my analysis" },
        ],
      },
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
    // Thinking block should be preserved
    const thinkingBlock = result.flatMap((m) => m.content).find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
  });

  test("tool_result with is_error=true is preserved", () => {
    const history: ChatMessage[] = [
      userMsg("run bad command"),
      toolUseMsg("tu_err", "bash"),
      toolResultMsg("tu_err", "command not found: foo", true),
      assistantMsg("That command failed"),
    ];

    const result = formatMessagesForApi(history);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);

    const errorResult = result
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result") as any;
    expect(errorResult.is_error).toBe(true);
  });

  test("single user message (minimal valid conversation)", () => {
    const result = formatMessagesForApi([userMsg("hello")]);
    const errors = validateAnthropicFormat(result);
    expect(errors).toEqual([]);
    expect(result.length).toBe(1);
  });
});
