// =============================================================================
// Test: countTokens-driven context-fill metric
//
// Verifies that the agent loop's `usage_percent` in the `done` event reflects
// what the NEXT API call would actually send (system + tools + full history),
// not what the LAST API call's `usage.input_tokens` happened to bill.
//
// This is the core fix for the "% never grows past 5-7%" bug — the prior
// implementation used `usage?.input_tokens / contextWindow`, which is the
// per-call billed input and shrinks under prompt caching / pruning. The new
// implementation calls provider.countTokens() and divides by the model's
// context window.
//
// Run: bun test tests/test-count-tokens-metric.ts
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { AgentLoop } from "../src/agent/loop.js";
import type {
  LLMProvider,
  LLMStreamRequest,
  LLMStreamEvent,
  LLMCountTokensRequest,
} from "../src/agent/provider.js";
import { LLMError } from "../src/agent/provider.js";
import { ToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import type {
  StreamEvent,
  HawkyConfig,
  PermissionLevel,
} from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Mock provider with countTokens
// -----------------------------------------------------------------------------

class CountingProvider implements LLMProvider {
  countTokensCallCount = 0;
  lastCountRequest: LLMCountTokensRequest | null = null;
  countTokensResult: number | (() => number) = 50_000;
  countTokensThrows: Error | null = null;

  async *stream(
    _req: LLMStreamRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    yield {
      type: "message_start",
      message_id: "m1",
      model: "claude-opus-4-7",
      // Per-call billed input is intentionally tiny — the metric must NOT
      // pick this up as the percent. countTokens result is the source.
      usage: { input_tokens: 100, output_tokens: 0 },
    };
    yield { type: "text_delta", text: "ok" };
    yield {
      type: "message_delta",
      stop_reason: "end_turn",
      usage: { output_tokens: 5 },
    };
    yield { type: "message_stop" };
  }

  async countTokens(
    req: LLMCountTokensRequest,
    _signal?: AbortSignal,
  ): Promise<{ input_tokens: number }> {
    this.countTokensCallCount++;
    this.lastCountRequest = req;
    if (this.countTokensThrows) throw this.countTokensThrows;
    const v = typeof this.countTokensResult === "function"
      ? this.countTokensResult()
      : this.countTokensResult;
    return { input_tokens: v };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "" },
    model: "claude-opus-4-7",
    max_tokens: 4096,
    permissions: { mode: "manual" as PermissionLevel },
    auto_approve: { tools: [], bash_commands: [] },
    workspace_dir: "/tmp/hawky-test-ctx",
    ...overrides,
  };
}

async function runOneTurn(provider: LLMProvider): Promise<StreamEvent[]> {
  resetToolRegistry();
  const events: StreamEvent[] = [];
  const loop = new AgentLoop({
    config: makeConfig(),
    provider,
    registry: new ToolRegistry(),
    session_key: "test:ctx",
    working_directory: "/tmp",
  });
  loop.subscribe((e) => events.push(e));
  await loop.sendMessage("hi");
  return events;
}

beforeEach(() => resetToolRegistry());
afterEach(() => resetToolRegistry());

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("usage_percent driven by provider.countTokens", () => {
  test("done event's context_usage_percent comes from countTokens, not usage.input_tokens", async () => {
    const provider = new CountingProvider();
    // Opus 4.7 → 1M context. 100K reported by countTokens → 10%.
    provider.countTokensResult = 100_000;

    const events = await runOneTurn(provider);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect((done as any).usage.context_usage_percent).toBe(10);
    // Sanity: the per-call billed input was 100 tokens (= 0% rounded). If
    // the metric ever falls back to billed input by mistake we'd see 0.
    expect(provider.countTokensCallCount).toBe(1);
  });

  test("done event includes lastTurnUsage + lastTurnCostUSD for the debug footer", async () => {
    // Phase 4 — UI shows what THE LAST API call billed (distinct from the
    // cumulative `usage`). Backend computes it from the per-call usage
    // local + calculateCost(model, usage).
    const provider = new CountingProvider();
    const events = await runOneTurn(provider);
    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    expect(done.lastTurnUsage).toBeDefined();
    // CountingProvider's stream always reports input_tokens=100, output=5
    // in the message_start / message_delta. Those are the per-call values.
    expect(done.lastTurnUsage.input_tokens).toBe(100);
    expect(done.lastTurnUsage.output_tokens).toBe(5);
    // Cost should be a positive number (Opus 4.7 pricing × 100 input + 5 output).
    expect(typeof done.lastTurnCostUSD).toBe("number");
    expect(done.lastTurnCostUSD).toBeGreaterThan(0);
  });

  test("countTokens is called with the same shape as the next API request would have", async () => {
    const provider = new CountingProvider();
    provider.countTokensResult = 200_000;
    await runOneTurn(provider);
    expect(provider.lastCountRequest).not.toBeNull();
    const req = provider.lastCountRequest!;
    expect(req.model).toBe("claude-opus-4-7");
    expect(typeof req.system).toBe("string");
    expect(req.system!.length).toBeGreaterThan(0);
    // History should include the user turn we just ran AND the assistant
    // response — that's "what the next call would send" semantics.
    const roles = req.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  test("falls back to billed-input metric when countTokens throws", async () => {
    const provider = new CountingProvider();
    provider.countTokensThrows = new LLMError("connection_error", "network down");
    const events = await runOneTurn(provider);
    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    // billed input was 100 → on a 1M window that rounds to 0%, but the test
    // is that the loop didn't crash and still emitted a done event.
    expect(done.usage.context_usage_percent).toBe(0);
    // Cumulative usage from the response is still recorded.
    expect(done.usage.input_tokens).toBe(100);
    expect(done.usage.output_tokens).toBe(5);
  });

  test("percent grows as countTokens reports more tokens (monotonic with history)", async () => {
    const provider = new CountingProvider();
    // First turn: 100K tokens → 10%
    provider.countTokensResult = 100_000;
    let events = await runOneTurn(provider);
    let done = events.find((e) => e.type === "done") as any;
    expect(done.usage.context_usage_percent).toBe(10);

    // Second turn (same provider, fresh loop): 500K tokens → 50%
    provider.countTokensResult = 500_000;
    events = await runOneTurn(provider);
    done = events.find((e) => e.type === "done") as any;
    expect(done.usage.context_usage_percent).toBe(50);
  });
});

describe("pre-call safety net for pathologically long sessions", () => {
  test("on 1M-context models (Opus 4.7): cap is 5000 messages", async () => {
    // The old 50-turn cap was the bug, but with NO cap a session that
    // somehow grew past the model's window before auto-compaction could
    // run would lock up — API rejects with context_overflow, no `done`
    // event fires, post-turn compaction never engages. The safety cap is
    // model-aware: ~1 message of headroom per 200 tokens of context window,
    // floored at 1000. For 1M-context models that's 5000 messages.
    let capturedRequest: LLMStreamRequest | null = null;

    class CaptureProvider implements LLMProvider {
      async *stream(req: LLMStreamRequest): AsyncGenerator<LLMStreamEvent> {
        capturedRequest = req;
        yield {
          type: "message_start",
          message_id: "m1",
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, output_tokens: 0 },
        };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_delta",
          stop_reason: "end_turn",
          usage: { output_tokens: 1 },
        };
        yield { type: "message_stop" };
      }
      async countTokens(): Promise<{ input_tokens: number }> {
        return { input_tokens: 1000 };
      }
    }

    resetToolRegistry();
    const provider = new CaptureProvider();
    const loop = new AgentLoop({
      config: makeConfig(),
      provider,
      registry: new ToolRegistry(),
      session_key: "test:safety-cap",
      working_directory: "/tmp",
    });

    // Seed 5500 messages — well past the 5000-message safety cap.
    const seed = [];
    for (let i = 0; i < 5500; i++) {
      seed.push({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: [{ type: "text" as const, text: `msg-${i}` }],
        timestamp: new Date().toISOString(),
      });
    }
    loop.setHistory(seed);

    await loop.sendMessage("now");
    expect(capturedRequest).not.toBeNull();
    // Cap is 5000 messages. After truncation, we have 5000 + the new "now"
    // user msg appended; if normalize() prepends "[Continuing conversation]"
    // (because the truncated head landed on an assistant turn) we may see
    // 5001. Either way the cap should be in effect — if it weren't, we'd
    // be looking at 5500+.
    expect(capturedRequest!.messages.length).toBeLessThanOrEqual(5001);
    expect(capturedRequest!.messages.length).toBeGreaterThanOrEqual(5000);
    // The oldest seeded messages must be GONE (cap is 5000, we seeded 5500
    // so msg-0 through ~msg-499 should have been dropped).
    const allText = capturedRequest!.messages
      .map((m) => Array.isArray(m.content)
        ? m.content.map((b: any) => b.text ?? "").join("")
        : (m.content as string))
      .join("\n");
    expect(allText).not.toContain("msg-0\n");
    expect(allText).not.toContain("msg-100\n");
    expect(allText).not.toContain("msg-499\n");
    // ...and the newest seeded messages must still be there.
    expect(allText).toContain("msg-5499");
  });

  test("on 1M-context models: at or below 5000 messages is NOT truncated", async () => {
    // The cap is a CEILING — sessions under the cap pass through untouched.
    let capturedRequest: LLMStreamRequest | null = null;

    class CaptureProvider implements LLMProvider {
      async *stream(req: LLMStreamRequest): AsyncGenerator<LLMStreamEvent> {
        capturedRequest = req;
        yield { type: "message_start", message_id: "m1", model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 0 } };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 1 } };
        yield { type: "message_stop" };
      }
      async countTokens(): Promise<{ input_tokens: number }> { return { input_tokens: 1000 }; }
    }

    resetToolRegistry();
    const loop = new AgentLoop({
      config: makeConfig(), provider: new CaptureProvider(), registry: new ToolRegistry(),
      session_key: "test:under-cap", working_directory: "/tmp",
    });

    const seed = [];
    for (let i = 0; i < 4500; i++) {
      seed.push({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: [{ type: "text" as const, text: `msg-${i}` }],
        timestamp: new Date().toISOString(),
      });
    }
    loop.setHistory(seed);
    await loop.sendMessage("now");
    expect(capturedRequest).not.toBeNull();
    // 4500 seeded + 1 new = 4501. Cap is 5000 so nothing dropped.
    expect(capturedRequest!.messages.length).toBeGreaterThanOrEqual(4501);
    // The oldest seed survives.
    const allText = capturedRequest!.messages
      .map((m) => Array.isArray(m.content)
        ? m.content.map((b: any) => b.text ?? "").join("")
        : (m.content as string))
      .join("\n");
    expect(allText).toContain("msg-0\n");
  });

  test("on 200K-context models (Haiku 4.5): cap is 1000 messages, NOT 5000", async () => {
    // Codex P1 regression: bumping the cap uniformly to 5000 removed
    // protection for smaller-window models. The model-aware formula
    // (~1 msg per 200 tokens of context window) puts Haiku 4.5 at the
    // original 1000-message ceiling. A 1500-message Haiku session
    // would still overflow context if the cap were 5000.
    let capturedRequest: LLMStreamRequest | null = null;

    class CaptureProvider implements LLMProvider {
      async *stream(req: LLMStreamRequest): AsyncGenerator<LLMStreamEvent> {
        capturedRequest = req;
        yield { type: "message_start", message_id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 0 } };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 1 } };
        yield { type: "message_stop" };
      }
      async countTokens(): Promise<{ input_tokens: number }> { return { input_tokens: 1000 }; }
    }

    resetToolRegistry();
    const loop = new AgentLoop({
      config: makeConfig({ model: "claude-haiku-4-5" }),
      provider: new CaptureProvider(),
      registry: new ToolRegistry(),
      session_key: "test:haiku-cap",
      working_directory: "/tmp",
    });

    const seed = [];
    for (let i = 0; i < 1500; i++) {
      seed.push({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: [{ type: "text" as const, text: `msg-${i}` }],
        timestamp: new Date().toISOString(),
      });
    }
    loop.setHistory(seed);
    await loop.sendMessage("now");
    expect(capturedRequest).not.toBeNull();
    // Cap is 1000 for 200K models; 1500 seeded should be trimmed.
    expect(capturedRequest!.messages.length).toBeLessThanOrEqual(1001);
    expect(capturedRequest!.messages.length).toBeGreaterThanOrEqual(1000);
    // Earliest seeds dropped, latest preserved.
    const allText = capturedRequest!.messages
      .map((m) => Array.isArray(m.content)
        ? m.content.map((b: any) => b.text ?? "").join("")
        : (m.content as string))
      .join("\n");
    expect(allText).not.toContain("msg-0\n");
    expect(allText).toContain("msg-1499");
  });
});

describe("history is no longer truncated to 50 turns", () => {
  test("the request shape passed to stream() includes the full history (no slice)", async () => {
    // Build an AgentLoop with a pre-loaded long history, then run one turn
    // and assert that what we sent to the provider includes those old
    // messages — proving the 50-turn `slice(-100)` is gone.
    let capturedRequest: LLMStreamRequest | null = null;

    class CaptureProvider implements LLMProvider {
      async *stream(req: LLMStreamRequest): AsyncGenerator<LLMStreamEvent> {
        capturedRequest = req;
        yield {
          type: "message_start",
          message_id: "m1",
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 0 },
        };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_delta",
          stop_reason: "end_turn",
          usage: { output_tokens: 1 },
        };
        yield { type: "message_stop" };
      }
      async countTokens(): Promise<{ input_tokens: number }> {
        return { input_tokens: 1000 };
      }
    }

    resetToolRegistry();
    const provider = new CaptureProvider();
    const loop = new AgentLoop({
      config: makeConfig(),
      provider,
      registry: new ToolRegistry(),
      session_key: "test:long",
      working_directory: "/tmp",
    });

    // Seed a 300-message history (well past the old 100-cap).
    const longHistory = [];
    for (let i = 0; i < 300; i++) {
      longHistory.push({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: [{ type: "text" as const, text: `msg-${i}` }],
        timestamp: new Date().toISOString(),
      });
    }
    loop.setHistory(longHistory);

    await loop.sendMessage("now");
    expect(capturedRequest).not.toBeNull();
    // 300 seeded + 1 new user turn + 1 assistant reply happens AFTER the
    // request is captured (added post-stream), so we expect 301 in the
    // captured request: 300 seed + 1 new user.
    expect(capturedRequest!.messages.length).toBe(301);
    // And the OLDEST seeded message must still be there — the old
    // truncateHistory(history, 50) would have dropped it.
    const firstContent = capturedRequest!.messages[0].content;
    const firstText = Array.isArray(firstContent) ? (firstContent[0] as any).text : firstContent;
    expect(firstText).toBe("msg-0");
  });
});
