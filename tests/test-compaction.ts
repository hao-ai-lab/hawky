// =============================================================================
// Tests: Auto-Compaction (11.1)
// =============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import {
  resolveCompactionConfig,
  shouldAutoCompact,
  isContextBlocked,
  createCompactionState,
  splitHistory,
  buildCompactionMessages,
  parseSummary,
  buildSummaryMessage,
  compactConversation,
  safeSlice,
  type CompactionConfig,
  type CompactionState,
} from "../src/agent/compaction.js";
import type { ChatMessage, HawkyConfig } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeUserMessage(text: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  };
}

function makeAssistantMessage(text: string): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  };
}

function makeToolResultMessage(toolUseId: string, content: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    timestamp: new Date().toISOString(),
  };
}

function makeAssistantWithToolUse(text: string, toolName: string, toolId: string): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: toolId, name: toolName, input: {} },
    ],
    timestamp: new Date().toISOString(),
  };
}

/** Build a conversation with N turns (user + assistant pairs). */
function buildConversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(makeUserMessage(`Question ${i + 1}`));
    messages.push(makeAssistantMessage(`Answer ${i + 1}`));
  }
  return messages;
}

const DEFAULT_CONFIG: CompactionConfig = {
  enabled: true,
  threshold_percent: 95,
  blocking_percent: 98,
  keep_recent_turns: 10,
  max_failures: 3,
};

// -----------------------------------------------------------------------------
// resolveCompactionConfig
// -----------------------------------------------------------------------------

describe("resolveCompactionConfig", () => {
  it("returns defaults when no compaction config", () => {
    const config = { compaction: undefined } as unknown as HawkyConfig;
    const result = resolveCompactionConfig(config);
    expect(result.enabled).toBe(true);
    expect(result.threshold_percent).toBe(95);
    expect(result.blocking_percent).toBe(98);
    expect(result.keep_recent_turns).toBe(10);
    expect(result.max_failures).toBe(3);
  });

  it("merges partial config with defaults", () => {
    const config = {
      compaction: { threshold_percent: 90, keep_recent_turns: 5 },
    } as unknown as HawkyConfig;
    const result = resolveCompactionConfig(config);
    expect(result.threshold_percent).toBe(90);
    expect(result.keep_recent_turns).toBe(5);
    expect(result.blocking_percent).toBe(98); // default
    expect(result.enabled).toBe(true); // default
  });

  it("respects enabled: false", () => {
    const config = {
      compaction: { enabled: false },
    } as unknown as HawkyConfig;
    const result = resolveCompactionConfig(config);
    expect(result.enabled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// shouldAutoCompact
// -----------------------------------------------------------------------------

describe("shouldAutoCompact", () => {
  let state: CompactionState;

  beforeEach(() => {
    state = createCompactionState();
  });

  it("returns false when disabled", () => {
    const config = { ...DEFAULT_CONFIG, enabled: false };
    expect(shouldAutoCompact(96, config, state)).toBe(false);
  });

  it("returns false when below threshold", () => {
    expect(shouldAutoCompact(90, DEFAULT_CONFIG, state)).toBe(false);
  });

  it("returns true when at threshold", () => {
    expect(shouldAutoCompact(95, DEFAULT_CONFIG, state)).toBe(true);
  });

  it("returns true when above threshold", () => {
    expect(shouldAutoCompact(97, DEFAULT_CONFIG, state)).toBe(true);
  });

  it("returns false when circuit breaker tripped", () => {
    state.consecutiveFailures = 3;
    expect(shouldAutoCompact(97, DEFAULT_CONFIG, state)).toBe(false);
  });

  it("returns true when failures below max", () => {
    state.consecutiveFailures = 2;
    expect(shouldAutoCompact(97, DEFAULT_CONFIG, state)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// isContextBlocked
// -----------------------------------------------------------------------------

describe("isContextBlocked", () => {
  it("returns false below blocking threshold", () => {
    expect(isContextBlocked(97, DEFAULT_CONFIG)).toBe(false);
  });

  it("returns true at blocking threshold", () => {
    expect(isContextBlocked(98, DEFAULT_CONFIG)).toBe(true);
  });

  it("returns true above blocking threshold", () => {
    expect(isContextBlocked(99, DEFAULT_CONFIG)).toBe(true);
  });

  it("returns false when disabled", () => {
    const config = { ...DEFAULT_CONFIG, enabled: false };
    expect(isContextBlocked(99, config)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// splitHistory
// -----------------------------------------------------------------------------

describe("splitHistory", () => {
  it("returns empty arrays for empty history", () => {
    const { toSummarize, toKeep } = splitHistory([], 10);
    expect(toSummarize).toEqual([]);
    expect(toKeep).toEqual([]);
  });

  it("keeps all messages when history is smaller than keepTurns", () => {
    const history = buildConversation(5); // 10 messages
    const { toSummarize, toKeep } = splitHistory(history, 10); // keep 20 messages
    expect(toSummarize).toEqual([]);
    expect(toKeep).toEqual(history);
  });

  it("splits correctly with enough messages", () => {
    const history = buildConversation(20); // 40 messages
    const { toSummarize, toKeep } = splitHistory(history, 10); // keep 20
    expect(toSummarize.length).toBeGreaterThan(0);
    expect(toKeep.length).toBe(20);
    expect(toSummarize.length + toKeep.length).toBe(40);
  });

  it("does not split too-small history (< 4 messages to summarize)", () => {
    const history = buildConversation(12); // 24 messages, keep 20 → only 4 to summarize
    const { toSummarize, toKeep } = splitHistory(history, 10);
    // splitIndex would be 4, which is the minimum
    expect(toSummarize.length + toKeep.length).toBe(24);
  });

  it("respects tool_result boundaries", () => {
    const history: ChatMessage[] = [
      makeUserMessage("Question 1"),
      makeAssistantWithToolUse("Let me check", "bash", "tool_1"),
      makeToolResultMessage("tool_1", "output"),
      makeAssistantMessage("Here's the answer"),
      // More messages after...
      ...buildConversation(15), // 30 more messages
    ];
    const { toSummarize, toKeep } = splitHistory(history, 10);
    // Should not split in the middle of tool_use → tool_result pair
    // The tool_result message (role: user, all content is tool_result) should not
    // be the first message in toKeep
    if (toKeep.length > 0) {
      const firstKept = toKeep[0];
      const isToolResultOnly = firstKept.content.every((b) => b.type === "tool_result");
      expect(isToolResultOnly).toBe(false);
    }
  });

  it("skips compaction for very short history", () => {
    const history = buildConversation(2); // 4 messages total
    const { toSummarize, toKeep } = splitHistory(history, 10);
    expect(toSummarize).toEqual([]);
    expect(toKeep).toEqual(history);
  });
});

// -----------------------------------------------------------------------------
// buildCompactionMessages
// -----------------------------------------------------------------------------

describe("buildCompactionMessages", () => {
  it("produces a single user message with transcript", () => {
    const history = buildConversation(3);
    const messages = buildCompactionMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("Question 1");
    expect(messages[0].content).toContain("Answer 1");
    expect(messages[0].content).toContain("Question 3");
  });

  it("includes tool_use and tool_result in transcript", () => {
    const history: ChatMessage[] = [
      makeUserMessage("Run a command"),
      makeAssistantWithToolUse("Sure", "bash", "t1"),
      makeToolResultMessage("t1", "command output here"),
      makeAssistantMessage("Done"),
    ];
    const messages = buildCompactionMessages(history);
    expect(messages[0].content).toContain("[tool_use: bash");
    expect(messages[0].content).toContain("[tool_result: command output here]");
  });

  it("truncates long tool results in transcript", () => {
    const longOutput = "x".repeat(1000);
    const history: ChatMessage[] = [
      makeUserMessage("Run"),
      makeAssistantWithToolUse("Ok", "bash", "t1"),
      makeToolResultMessage("t1", longOutput),
    ];
    const messages = buildCompactionMessages(history);
    // Tool result content is capped at 500 chars in the transcript
    expect(messages[0].content).toContain("...");
    // The full 1000-char output should NOT appear verbatim
    expect(messages[0].content).not.toContain(longOutput);
  });

  it("includes compaction prompt instructions", () => {
    const history = buildConversation(1);
    const messages = buildCompactionMessages(history);
    expect(messages[0].content).toContain("Primary Request and Intent");
    expect(messages[0].content).toContain("<summary>");
    expect(messages[0].content).toContain("Do NOT call any tools");
  });
});

// -----------------------------------------------------------------------------
// parseSummary
// -----------------------------------------------------------------------------

describe("parseSummary", () => {
  it("extracts text from <summary> tags", () => {
    const response = "Some analysis\n<summary>\nThis is the summary.\n</summary>";
    expect(parseSummary(response)).toBe("This is the summary.");
  });

  it("handles multiline summary", () => {
    const response = "<summary>\nLine 1\nLine 2\nLine 3\n</summary>";
    expect(parseSummary(response)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("falls back to full response when no tags", () => {
    const response = "This is a summary without tags.";
    expect(parseSummary(response)).toBe("This is a summary without tags.");
  });

  it("handles empty summary tags", () => {
    const response = "<summary></summary>";
    expect(parseSummary(response)).toBe("");
  });
});

// -----------------------------------------------------------------------------
// buildSummaryMessage
// -----------------------------------------------------------------------------

describe("buildSummaryMessage", () => {
  it("creates a user-role message with summary text", () => {
    const msg = buildSummaryMessage("Test summary");
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe("text");
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Test summary");
    expect(text).toContain("compacted");
  });

  it("has a timestamp", () => {
    const msg = buildSummaryMessage("Test");
    expect(msg.timestamp).toBeDefined();
  });

  it("includes boundary markers for the agent", () => {
    const msg = buildSummaryMessage("Summary content");
    const text = (msg.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[This conversation was automatically compacted");
    expect(text).toContain("[End of compacted summary");
  });
});

// -----------------------------------------------------------------------------
// compactConversation (integration with mock provider)
// -----------------------------------------------------------------------------

describe("compactConversation", () => {
  // Mock provider that returns a fixed summary
  function createMockProvider(summaryText: string) {
    return {
      stream: async function* (_request: unknown, _signal: AbortSignal) {
        yield { type: "text_delta" as const, text: `<summary>\n${summaryText}\n</summary>` };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 100 } };
      },
    } as any;
  }

  function createFailingProvider(errorMessage: string) {
    return {
      stream: async function* (_request: unknown, _signal: AbortSignal) {
        throw new Error(errorMessage);
        // TypeScript needs a yield to infer this as an async generator
        yield { type: "text_delta" as const, text: "" };
      },
    } as any;
  }

  it("returns null for short conversations", async () => {
    const history = buildConversation(3); // 6 messages, too short
    const result = await compactConversation(
      history,
      createMockProvider("unused"),
      "claude-sonnet-4-6",
      DEFAULT_CONFIG,
    );
    expect(result).toBeNull();
  });

  it("compacts a long conversation", async () => {
    const history = buildConversation(20); // 40 messages
    const provider = createMockProvider("This is the compacted summary.");
    const result = await compactConversation(
      history,
      provider,
      "claude-sonnet-4-6",
      DEFAULT_CONFIG,
    );

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("This is the compacted summary.");
    expect(result!.messagesRemoved).toBeGreaterThan(0);
    expect(result!.messagesKept).toBe(20); // 10 turns = 20 messages
    expect(result!.compactedHistory.length).toBe(21); // 1 summary + 20 kept
  });

  it("first message in compacted history is the summary", async () => {
    const history = buildConversation(20);
    const provider = createMockProvider("Summary here");
    const result = await compactConversation(
      history,
      provider,
      "claude-sonnet-4-6",
      DEFAULT_CONFIG,
    );

    const first = result!.compactedHistory[0];
    expect(first.role).toBe("user");
    const text = (first.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Summary here");
    expect(text).toContain("compacted");
  });

  it("preserves recent messages after summary", async () => {
    const history = buildConversation(20);
    const lastMessage = history[history.length - 1];
    const provider = createMockProvider("Summary");
    const result = await compactConversation(
      history,
      provider,
      "claude-sonnet-4-6",
      DEFAULT_CONFIG,
    );

    // Last message in compacted history should be the same as original last message
    const compactedLast = result!.compactedHistory[result!.compactedHistory.length - 1];
    expect(compactedLast.content).toEqual(lastMessage.content);
  });

  it("throws on provider failure", async () => {
    const history = buildConversation(20);
    const provider = createFailingProvider("API error");

    await expect(
      compactConversation(history, provider, "claude-sonnet-4-6", DEFAULT_CONFIG),
    ).rejects.toThrow("API error");
  });

  it("throws on empty response", async () => {
    const history = buildConversation(20);
    const provider = {
      stream: async function* () {
        // yield nothing meaningful
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 0 } };
      },
    } as any;

    await expect(
      compactConversation(history, provider, "claude-sonnet-4-6", DEFAULT_CONFIG),
    ).rejects.toThrow("empty response");
  });

  it("respects keep_recent_turns config", async () => {
    const history = buildConversation(20);
    const config = { ...DEFAULT_CONFIG, keep_recent_turns: 5 };
    const provider = createMockProvider("Summary");
    const result = await compactConversation(
      history,
      provider,
      "claude-sonnet-4-6",
      config,
    );

    expect(result!.messagesKept).toBe(10); // 5 turns = 10 messages
    expect(result!.compactedHistory.length).toBe(11); // 1 summary + 10 kept
  });
});

// -----------------------------------------------------------------------------
// createCompactionState
// -----------------------------------------------------------------------------

describe("createCompactionState", () => {
  it("starts with zero failures and null timestamp", () => {
    const state = createCompactionState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastCompactedAt).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// safeSlice — surrogate-pair-aware truncation
//
// Regression: Vertex AI rejects requests containing lone UTF-16 surrogates
// with a 400 "input data is not valid json" / FAILED_PRECONDITION. The old
// `.slice(0, N)` calls in buildCompactionMessages cut emoji in half whenever
// the boundary landed between the high and low halves of a surrogate pair,
// bricking compaction on any session containing an emoji at one of those
// offsets (we hit this in dev.jsonl on the 5 messages with 📄 / 🤖 / 🗞 /
// 🕐 at positions 199-200 and 499-500).
// -----------------------------------------------------------------------------

/** Returns positions of any UTF-16 code units that are NOT part of a valid
 *  surrogate pair. An empty result means the string is well-formed UTF-16. */
function loneSurrogates(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xDC00 && next <= 0xDFFF)) out.push(i);
      else i++; // valid pair, skip the low half
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      out.push(i);
    }
  }
  return out;
}

describe("safeSlice", () => {
  it("returns the input unchanged when shorter than n", () => {
    expect(safeSlice("hi", 10)).toBe("hi");
  });

  it("does NOT split a surrogate pair at the boundary (📄 at offset 1-2)", () => {
    // "x📄y" = ['x', high-surrogate, low-surrogate, 'y'] = 4 UTF-16 code units.
    const s = "x📄y";
    expect(s.length).toBe(4);
    // slice(0, 2) on plain `.slice` would cut between the surrogate pair.
    // safeSlice backs off to length 1, dropping the would-be-orphaned half.
    const out = safeSlice(s, 2);
    expect(loneSurrogates(out)).toEqual([]);
    expect(out).toBe("x");
  });

  it("plain .slice produces a lone surrogate where safeSlice does not", () => {
    const s = "x📄y";
    const bad = s.slice(0, 2);
    expect(loneSurrogates(bad).length).toBeGreaterThan(0);
    expect(loneSurrogates(safeSlice(s, 2))).toEqual([]);
  });

  it("keeps the full surrogate pair when boundary is just past the low half", () => {
    // slice(0, 3) lands AFTER the complete pair — keep all of "x📄".
    const out = safeSlice("x📄y", 3);
    expect(out).toBe("x📄");
    expect(loneSurrogates(out)).toEqual([]);
  });
});

describe("buildCompactionMessages — surrogate-safe rendering", () => {
  function makeToolResultMsg(content: string): ChatMessage {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
      timestamp: new Date().toISOString(),
    };
  }

  it("does not produce lone surrogates when an emoji lands at the 500-char tool_result boundary", () => {
    // Pad to position 499 with ASCII so 📄 starts at char-index 499.
    // The high half is at 499 and the low half at 500. The old slice(0, 500)
    // would cut between them; safeSlice backs off to 499.
    const padded = "a".repeat(499) + "📄" + "tail";
    const msgs = buildCompactionMessages([makeToolResultMsg(padded)]);
    const rendered = msgs[0].content;
    expect(loneSurrogates(rendered)).toEqual([]);
  });

  it("does not produce lone surrogates when an emoji lands at the 200-char tool_use boundary", () => {
    // Build a JSON.stringify'd input whose output puts 📄 at index 199-200.
    // Easiest: a single-key object whose value is `'a'.repeat(N) + '📄...'`.
    // We don't need surgical positioning — picking N=190 is enough that
    // the 200-char boundary sometimes lands inside the surrogate pair when
    // the JSON-encoded prefix has a predictable length.
    const value = "a".repeat(190) + "📄" + "📄" + "tail";
    const msg: ChatMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "u1", name: "write_file", input: { value } }],
      timestamp: new Date().toISOString(),
    };
    const msgs = buildCompactionMessages([msg]);
    expect(loneSurrogates(msgs[0].content)).toEqual([]);
  });

  it("produces zero lone surrogates across a battery of boundary positions", () => {
    // Sweep emoji starting positions 495..505 to confirm the slice
    // boundary is always handled cleanly.
    for (let pos = 490; pos <= 510; pos++) {
      const padded = "a".repeat(pos) + "🗞" + "tail";  // 🗞 = U+1F5DE, also a surrogate pair
      const msgs = buildCompactionMessages([makeToolResultMsg(padded)]);
      expect(loneSurrogates(msgs[0].content)).toEqual([]);
    }
  });

  it("renders multimodal tool_result as a short text+type marker (NOT raw base64)", () => {
    // Image / document tool results: `content` is an array of blocks, not a
    // string. We MUST keep this short — the model can't see the base64
    // anyway, and compaction runs near the context limit, so dumping
    // hundreds of chars of binary per old screenshot bloats the request
    // (Codex P2 finding on the initial fix).
    const bigBase64 = "A".repeat(50_000); // ~37 KB of decoded image
    const arrayContent: any = [
      { type: "text", text: "Screenshot of monitor 1" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: bigBase64 } },
    ];
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: arrayContent, is_error: false } as any],
      timestamp: new Date().toISOString(),
    };
    let out: ReturnType<typeof buildCompactionMessages> = [];
    expect(() => { out = buildCompactionMessages([msg]); }).not.toThrow();
    const rendered = out[0].content;
    expect(rendered).toContain("[tool_result");
    expect(rendered).toContain("Screenshot of monitor 1");
    expect(rendered).toContain("image/png");
    // Critical: the embedded 50KB base64 must NOT appear in the transcript.
    // `bigBase64` is "AAAA...". Asserting the long run is absent is
    // sufficient — anything in the rendered output is fine as long as it
    // isn't a verbatim slice of the data.
    expect(rendered).not.toContain("AAAAAAAAAA"); // 10-A run never present
    // And no lone surrogates from the safeSlice path either.
    expect(loneSurrogates(rendered)).toEqual([]);
  });

  it("renders document tool_result with media type + byte count", () => {
    const arrayContent: any = [
      { type: "text", text: "Read PDF" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJDREVGRw==" } },
    ];
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: arrayContent, is_error: false } as any],
      timestamp: new Date().toISOString(),
    };
    const rendered = buildCompactionMessages([msg])[0].content;
    expect(rendered).toContain("Read PDF");
    expect(rendered).toContain("application/pdf");
    // The base64 itself ("QUJDREVGRw==") must NOT appear verbatim.
    expect(rendered).not.toContain("QUJDREVGRw");
  });

  it("renders plain-string tool_result unchanged (no marker, no leakage)", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "hello world", is_error: false } as any],
      timestamp: new Date().toISOString(),
    };
    const rendered = buildCompactionMessages([msg])[0].content;
    expect(rendered).toContain("[tool_result: hello world]");
  });
});
