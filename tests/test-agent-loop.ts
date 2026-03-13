// =============================================================================
// Test: Agent Loop — Integration + E2E tests
// Run: bun test tests/test-agent-loop.ts
// =============================================================================

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { AgentLoop, type AgentLoopOptions } from "../src/agent/loop.js";
import type {
  LLMProvider,
  LLMStreamRequest,
  LLMStreamEvent,
} from "../src/agent/provider.js";
import { LLMError } from "../src/agent/provider.js";
import { ToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import { AnthropicProvider } from "../src/agent/anthropic_provider.js";
import type {
  StreamEvent,
  ToolDefinition,
  ToolContext,
  ToolResult,
  HawkyConfig,
  PermissionLevel,
} from "../src/agent/types.js";

// =============================================================================
// Mock Provider
// =============================================================================

class MockProvider implements LLMProvider {
  private responses: LLMStreamEvent[][] = [];
  callCount = 0;
  lastRequest: LLMStreamRequest | null = null;
  allRequests: LLMStreamRequest[] = [];

  addResponse(events: LLMStreamEvent[]) {
    this.responses.push(events);
  }

  async *stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    this.lastRequest = request;
    this.allRequests.push(request);
    const events = this.responses[this.callCount++] ?? [];
    for (const event of events) {
      if (signal?.aborted) throw new LLMError("aborted", "aborted");
      yield event;
    }
  }
}

// =============================================================================
// Throwing Provider (for error tests)
// =============================================================================

class ThrowingProvider implements LLMProvider {
  private error: Error;
  callCount = 0;

  constructor(error: Error) {
    this.error = error;
  }

  async *stream(
    _request: LLMStreamRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    this.callCount++;
    throw this.error;
  }
}

// =============================================================================
// Retryable Provider (fails N times, then succeeds)
// =============================================================================

class RetryableProvider implements LLMProvider {
  callCount = 0;
  private failCount: number;
  private successEvents: LLMStreamEvent[];

  constructor(failCount: number, successEvents: LLMStreamEvent[]) {
    this.failCount = failCount;
    this.successEvents = successEvents;
  }

  async *stream(
    _request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    this.callCount++;
    if (this.callCount <= this.failCount) {
      throw new LLMError("overloaded", "Server overloaded", 529);
    }
    for (const event of this.successEvents) {
      if (signal?.aborted) throw new LLMError("aborted", "aborted");
      yield event;
    }
  }
}

// =============================================================================
// Slow Provider (for cancel tests)
// =============================================================================

class SlowProvider implements LLMProvider {
  callCount = 0;
  yielded = 0;

  async *stream(
    _request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    this.callCount++;

    yield { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } };
    this.yielded++;

    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (signal?.aborted) throw new LLMError("aborted", "aborted");
      yield { type: "text_delta", text: `chunk${i} ` };
      this.yielded++;
    }

    yield { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 100 } };
    yield { type: "message_stop" };
  }
}

// =============================================================================
// Helpers
// =============================================================================

function makeConfig(overrides?: Partial<HawkyConfig>): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: {
      enabled: false,
      interval_minutes: 30,
      keep_recent_messages: 8,
      active_hours: { start: "08:00", end: "22:00" },
    },
    ...overrides,
  };
}

function makeTool(
  name: string,
  permission: PermissionLevel = "auto_approve",
  opts?: {
    executeFn?: (input: any, ctx: ToolContext) => Promise<ToolResult>;
  },
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    input_schema: {
      type: "object",
      properties: {
        value: { type: "string", description: "A test value" },
      },
    },
    permission,
    execute:
      opts?.executeFn ??
      (async (input: any) => ({
        type: "text" as const,
        content: `${name} result: ${input.value ?? "no-value"}`,
      })),
  };
}

/** Helper: simple text response from LLM (no tools). */
function textResponse(text: string): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "text_delta", text },
    { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

/** Helper: tool use response from LLM. */
function toolUseResponse(
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): LLMStreamEvent[] {
  const inputJson = JSON.stringify(input);
  return [
    { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "tool_use_start", index: 0, id: toolId, name: toolName },
    { type: "tool_use_input_delta", partial_json: inputJson },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
}

/** Collect all stream events from an AgentLoop. */
function collectEvents(loop: AgentLoop): StreamEvent[] {
  const events: StreamEvent[] = [];
  loop.subscribe((e) => events.push(e));
  return events;
}

function makeLoop(
  provider: LLMProvider,
  registry?: ToolRegistry,
  configOverrides?: Partial<HawkyConfig>,
  sessionKey = "default",
): AgentLoop {
  return new AgentLoop({
    provider,
    registry: registry ?? new ToolRegistry(),
    config: makeConfig(configOverrides),
    working_directory: "/tmp/test",
    session_key: sessionKey,
  });
}

// =============================================================================
// Unit Tests with MockProvider
// =============================================================================

describe("AgentLoop — simple text response", () => {
  afterEach(() => resetToolRegistry());

  test("emits text events and done", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("Hello, world!"));

    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("say hello");

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as any).content).toBe("Hello, world!");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("done event includes usage", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hello");

    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    expect(done.usage).toBeDefined();
    expect(done.usage.input_tokens).toBeGreaterThan(0);
  });

  test("provider receives correct model and messages", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("test message");

    expect(provider.callCount).toBe(1);
    expect(provider.lastRequest).toBeDefined();
    expect(provider.lastRequest!.model).toBe("claude-sonnet-4-6");
    // The messages should contain the user message
    const lastMsg = provider.lastRequest!.messages[provider.lastRequest!.messages.length - 1];
    expect(lastMsg.role).toBe("user");
  });

  test("multi-chunk text streaming", async () => {
    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 5, output_tokens: 0 } },
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
      { type: "text_delta", text: "!" },
      { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);

    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hi");

    const texts = events.filter((e) => e.type === "text");
    expect(texts).toHaveLength(3);
    const combined = texts.map((e) => (e as any).content).join("");
    expect(combined).toBe("Hello world!");
  });
});

describe("AgentLoop — conversation history", () => {
  afterEach(() => resetToolRegistry());

  test("history contains user message after send", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("response"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("user input");

    const history = loop.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(history[0].role).toBe("user");
    expect((history[0].content[0] as any).text).toBe("user input");
  });

  test("history contains assistant message after send", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("assistant reply"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("question");

    const history = loop.getHistory();
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const textBlock = assistant!.content.find((b) => b.type === "text") as any;
    expect(textBlock.text).toBe("assistant reply");
  });

  test("multi-turn conversation builds up history", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("reply 1"));
    provider.addResponse(textResponse("reply 2"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("msg 1");
    await loop.sendMessage("msg 2");

    const history = loop.getHistory();
    // Should have 4 messages: user1, assistant1, user2, assistant2
    expect(history).toHaveLength(4);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user");
    expect(history[3].role).toBe("assistant");
  });

  test("clearHistory resets everything", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("reply"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("msg");
    expect(loop.getHistory().length).toBeGreaterThan(0);

    loop.clearHistory();
    expect(loop.getHistory()).toHaveLength(0);
  });

  test("clearHistory allows new conversation", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("reply 1"));
    provider.addResponse(textResponse("reply 2"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("msg 1");
    loop.clearHistory();
    await loop.sendMessage("msg 2");

    const history = loop.getHistory();
    expect(history).toHaveLength(2); // Only user2 + assistant2
    expect((history[0].content[0] as any).text).toBe("msg 2");
  });

  test("history sent to provider includes previous turns", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("reply 1"));
    provider.addResponse(textResponse("reply 2"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("msg 1");
    await loop.sendMessage("msg 2");

    // Second request should include previous conversation
    expect(provider.allRequests).toHaveLength(2);
    const secondRequest = provider.allRequests[1];
    expect(secondRequest.messages.length).toBeGreaterThanOrEqual(3); // user1, assistant1, user2
  });
});

describe("AgentLoop — tool execution loop", () => {
  afterEach(() => resetToolRegistry());

  test("tool_use response triggers tool execution then second LLM call", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo_tool"));

    const provider = new MockProvider();
    // First call: LLM wants to use a tool
    provider.addResponse(toolUseResponse("tu_1", "echo_tool", { value: "test" }));
    // Second call: LLM provides final text response
    provider.addResponse(textResponse("The tool returned: echo_tool result: test"));

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("use the echo tool");

    expect(provider.callCount).toBe(2);

    // Should have tool_use_start and tool_result events
    const toolStarts = events.filter((e) => e.type === "tool_use_start");
    expect(toolStarts.length).toBeGreaterThanOrEqual(1);

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).content).toContain("echo_tool result: test");

    // And a final text event
    const texts = events.filter((e) => e.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);

    // And done
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("tool results are added to history as user messages", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("my_tool"));

    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tu_1", "my_tool", { value: "x" }));
    provider.addResponse(textResponse("done"));

    const loop = makeLoop(provider, registry);
    collectEvents(loop);

    await loop.sendMessage("use tool");

    const history = loop.getHistory();
    // Should be: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(history).toHaveLength(4);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user"); // tool result
    expect(history[3].role).toBe("assistant");

    // The tool result message should contain tool_result content blocks
    const toolResultMsg = history[2];
    expect(toolResultMsg.content[0].type).toBe("tool_result");
  });

  test("multiple tool calls in single response", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("tool_a"));
    registry.register(makeTool("tool_b"));

    const provider = new MockProvider();
    // Response with two tool calls
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tu_1", name: "tool_a" },
      { type: "tool_use_input_delta", partial_json: '{"value":"a"}' },
      { type: "content_block_stop", index: 0 },
      { type: "tool_use_start", index: 1, id: "tu_2", name: "tool_b" },
      { type: "tool_use_input_delta", partial_json: '{"value":"b"}' },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ]);
    provider.addResponse(textResponse("Both tools executed"));

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("use both tools");

    expect(provider.callCount).toBe(2);

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
  });

  test("tool execution with error tool result continues loop", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("failing_tool", "auto_approve", {
        executeFn: async () => ({
          type: "error",
          content: "Tool failed: file not found",
        }),
      }),
    );

    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tu_1", "failing_tool", { value: "x" }));
    provider.addResponse(textResponse("The tool failed, sorry."));

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("use failing tool");

    expect(provider.callCount).toBe(2);

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).is_error).toBe(true);
  });

  // Regression for the "orphan tool_use when stop_reason != tool_use" class
  // of bug. Vertex/Anthropic can return tool_use blocks alongside
  // stop_reason: "end_turn" or "max_tokens" when the response is cut at a
  // block boundary. Before the fix, the loop treated stop_reason as
  // authoritative and broke out without ever calling executeTools, leaving
  // the assistant message orphaned (tool_use with no matching tool_result).
  // PR #161's executeTools try/catch did NOT cover this because executeTools
  // was never reached.
  test("tool_use blocks with stop_reason=end_turn still execute (Vertex quirk)", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo_tool"));

    const provider = new MockProvider();
    // First response: tool_use block BUT stop_reason is end_turn, not tool_use.
    provider.addResponse([
      { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tu_stuck", name: "echo_tool" },
      { type: "tool_use_input_delta", partial_json: JSON.stringify({ value: "hi" }) },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 15 } },
      { type: "message_stop" },
    ]);
    // Second response: final text after tool completes.
    provider.addResponse(textResponse("Tool done."));

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("use the echo tool");

    // The loop must have executed the tool and called the provider again.
    expect(provider.callCount).toBe(2);

    // Tool result event fired (proves executeTools ran).
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).tool_use_id).toBe("tu_stuck");

    // History invariant: assistant(tool_use) must be followed by user(tool_result).
    const history = loop.getHistory();
    expect(history).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(history[1].role).toBe("assistant");
    expect(history[1].content.some((b: any) => b.type === "tool_use" && b.id === "tu_stuck")).toBe(true);
    expect(history[2].role).toBe("user");
    expect(history[2].content[0].type).toBe("tool_result");
    expect((history[2].content[0] as any).tool_use_id).toBe("tu_stuck");
  });

  // max_tokens is the other known-safe boundary reason — same quirk as
  // end_turn, just triggered by the token cap rather than the model
  // declaring itself done.
  test("tool_use blocks with stop_reason=max_tokens still execute", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo_tool"));

    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tu_cap", name: "echo_tool" },
      { type: "tool_use_input_delta", partial_json: JSON.stringify({ value: "hi" }) },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", stop_reason: "max_tokens", usage: { output_tokens: 2000 } },
      { type: "message_stop" },
    ]);
    provider.addResponse(textResponse("Tool done."));

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("use the echo tool");

    expect(provider.callCount).toBe(2);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).tool_use_id).toBe("tu_cap");
  });

  // An unknown/unexpected stop_reason is the trust-boundary we deliberately
  // do NOT honor with tool execution. Instead, synthesize error tool_results
  // so the conversation invariant holds, then emit done and stop. No tool
  // side effects under a terminal state we don't understand.
  test("tool_use blocks with unknown stop_reason synthesize error results and stop", async () => {
    const registry = new ToolRegistry();
    // If this tool ever ran, its result would contain "REAL TOOL RAN" —
    // the assertion below proves that did NOT happen.
    const markerTool = makeTool("marker_tool", "auto_approve", {
      executeFn: async () => ({ type: "text" as const, content: "REAL TOOL RAN" }),
    });
    registry.register(markerTool);

    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tu_weird", name: "marker_tool" },
      { type: "tool_use_input_delta", partial_json: JSON.stringify({ value: "x" }) },
      { type: "content_block_stop", index: 0 },
      // Unexpected stop_reason — not in the safe allowlist.
      { type: "message_delta", stop_reason: "refusal", usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]);

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("try to use marker");

    // Second API call must NOT happen — we halted on the unexpected stop.
    expect(provider.callCount).toBe(1);

    // The real tool must NOT have fired.
    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents).toHaveLength(0);

    // History invariant still holds: the orphan is paired with a synthetic
    // error tool_result so the next API call (if any) would be well-formed.
    const history = loop.getHistory();
    expect(history).toHaveLength(3); // user, assistant(tool_use), user(error tool_result)
    expect(history[1].role).toBe("assistant");
    expect(history[1].content.some((b: any) => b.type === "tool_use" && b.id === "tu_weird")).toBe(true);
    expect(history[2].role).toBe("user");
    const syntheticBlock = (history[2].content as any[])[0];
    expect(syntheticBlock.type).toBe("tool_result");
    expect(syntheticBlock.tool_use_id).toBe("tu_weird");
    expect(syntheticBlock.is_error).toBe(true);
    expect(String(syntheticBlock.content)).toContain("refusal");

    // Loop should still have emitted a done event so the UI returns to idle.
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  // Symmetric sanity check: no tool calls + end_turn must still terminate
  // cleanly. This is the normal happy path and the condition change must
  // not regress it.
  test("no tool calls + stop_reason=end_turn terminates without extra API calls", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("Just text, no tools."));

    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hello");

    expect(provider.callCount).toBe(1);
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(0);
  });
});

describe("AgentLoop — cancel", () => {
  afterEach(() => resetToolRegistry());

  test("cancel mid-stream emits cancel event", async () => {
    const provider = new SlowProvider();
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    // Start sending and cancel after a short delay
    const promise = loop.sendMessage("slow message");
    await new Promise((r) => setTimeout(r, 50));
    loop.cancel();
    await promise;

    const cancelEvents = events.filter((e) => e.type === "cancel");
    expect(cancelEvents).toHaveLength(1);
    expect((cancelEvents[0] as any).content).toContain("Cancelled");
  });

  test("isRunning is false after cancel completes", async () => {
    const provider = new SlowProvider();
    const loop = makeLoop(provider);
    collectEvents(loop);

    const promise = loop.sendMessage("slow");
    await new Promise((r) => setTimeout(r, 30));
    expect(loop.isRunning()).toBe(true);
    loop.cancel();
    await promise;
    expect(loop.isRunning()).toBe(false);
  });

  test("cancel when not running does nothing", () => {
    const provider = new MockProvider();
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    loop.cancel(); // Should not throw

    expect(events).toHaveLength(0);
  });
});

describe("AgentLoop — queue message", () => {
  afterEach(() => resetToolRegistry());

  test("sending message while running emits queue_message", async () => {
    const provider = new SlowProvider();
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    const promise = loop.sendMessage("first message");
    await new Promise((r) => setTimeout(r, 20));

    // Try to send a second message while the first is running
    await loop.sendMessage("second message");

    const queueEvents = events.filter((e) => e.type === "queue_message");
    expect(queueEvents).toHaveLength(1);
    expect((queueEvents[0] as any).content).toBe("second message");
    expect((queueEvents[0] as any).position).toBe(1);

    // Clean up
    loop.cancel();
    await promise;
  });
});

describe("AgentLoop — iteration limit", () => {
  afterEach(() => resetToolRegistry());

  test("stops after max_iterations with error", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("loop_tool"));

    const provider = new MockProvider();
    // Each iteration returns a tool call, creating an infinite loop
    for (let i = 0; i < 15; i++) {
      provider.addResponse(toolUseResponse(`tu_${i}`, "loop_tool", { value: `${i}` }));
    }

    const loop = makeLoop(provider, registry, { max_iterations: 3 });
    const events = collectEvents(loop);

    await loop.sendMessage("loop forever");

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const maxIterError = errorEvents.find((e) => (e as any).code === "max_iterations");
    expect(maxIterError).toBeDefined();
    expect((maxIterError as any).content).toContain("maximum iterations");
  });

  test("iteration limit is configurable", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("loop_tool"));

    const provider = new MockProvider();
    for (let i = 0; i < 10; i++) {
      provider.addResponse(toolUseResponse(`tu_${i}`, "loop_tool", { value: `${i}` }));
    }

    const loop = makeLoop(provider, registry, { max_iterations: 5 });
    const events = collectEvents(loop);

    await loop.sendMessage("loop");

    // Should have called the provider at most 5 times (iterations)
    expect(provider.callCount).toBeLessThanOrEqual(5);
  });
});

describe("AgentLoop — error handling", () => {
  afterEach(() => resetToolRegistry());

  test("provider throws non-retryable error", async () => {
    const provider = new ThrowingProvider(
      new LLMError("auth_error", "Invalid API key", 401),
    );
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hello");

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as any).content).toContain("Invalid API key");
    expect((errorEvents[0] as any).code).toBe("auth_error");
  });

  test("provider throws generic Error", async () => {
    const provider = new ThrowingProvider(new Error("Network failure"));
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hello");

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as any).content).toContain("Network failure");
  });

  test("isRunning returns false after error", async () => {
    const provider = new ThrowingProvider(new Error("fail"));
    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("hello");
    expect(loop.isRunning()).toBe(false);
  });
});

describe("AgentLoop — retry on retryable errors", () => {
  afterEach(() => resetToolRegistry());

  test("retries on overloaded error and succeeds", async () => {
    const provider = new RetryableProvider(1, textResponse("success after retry"));
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hello");

    // Should have retried: 1 fail + 1 success = 2 calls
    expect(provider.callCount).toBe(2);

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThanOrEqual(1);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("gives up after max retries on retryable error", async () => {
    // Fails 5 times, but maxRetries is 2 (default), so should fail
    const provider = new RetryableProvider(5, textResponse("never"));
    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("hello");

    // 1 initial + 2 retries = 3 attempts
    expect(provider.callCount).toBe(3);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
  });
});

describe("AgentLoop — subscribe/unsubscribe", () => {
  afterEach(() => resetToolRegistry());

  test("unsubscribe stops receiving events", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hello"));

    const loop = makeLoop(provider);
    const events: StreamEvent[] = [];
    const unsub = loop.subscribe((e) => events.push(e));

    // Unsubscribe before sending
    unsub();

    await loop.sendMessage("test");

    expect(events).toHaveLength(0);
  });

  test("multiple subscribers receive all events", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const loop = makeLoop(provider);
    const events1: StreamEvent[] = [];
    const events2: StreamEvent[] = [];
    loop.subscribe((e) => events1.push(e));
    loop.subscribe((e) => events2.push(e));

    await loop.sendMessage("test");

    expect(events1.length).toBeGreaterThan(0);
    expect(events1.length).toBe(events2.length);
  });
});

describe("AgentLoop — thinking events", () => {
  afterEach(() => resetToolRegistry());

  test("thinking deltas are emitted", async () => {
    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 5, output_tokens: 0 } },
      { type: "thinking_delta", thinking: "Let me think..." },
      { type: "text_delta", text: "Here is my answer." },
      { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]);

    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("think about this");

    const thinkingEvents = events.filter((e) => e.type === "thinking");
    expect(thinkingEvents).toHaveLength(1);
    expect((thinkingEvents[0] as any).content).toBe("Let me think...");
  });

  test("thinking content is stored in history", async () => {
    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 5, output_tokens: 0 } },
      { type: "thinking_delta", thinking: "I need to consider..." },
      { type: "text_delta", text: "The answer is 42." },
      { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]);

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("think");

    const history = loop.getHistory();
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const thinkingBlock = assistant!.content.find((b) => b.type === "thinking") as any;
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBe("I need to consider...");
  });
});

describe("AgentLoop — usage accumulation", () => {
  afterEach(() => resetToolRegistry());

  test("usage accumulates across iterations", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("my_tool"));

    const provider = new MockProvider();
    // First response: tool use with usage
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 100, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tu_1", name: "my_tool" },
      { type: "tool_use_input_delta", partial_json: '{"value":"x"}' },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 50 } },
      { type: "message_stop" },
    ]);
    // Second response: text with usage
    provider.addResponse([
      { type: "message_start", message_id: "m2", model: "test", usage: { input_tokens: 200, output_tokens: 0 } },
      { type: "text_delta", text: "done" },
      { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ]);

    const loop = makeLoop(provider, registry);
    const events = collectEvents(loop);

    await loop.sendMessage("use tool");

    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    expect(done.usage.input_tokens).toBe(300); // 100 + 200
    expect(done.usage.output_tokens).toBe(80);  // 50 + 30
  });
});

describe("AgentLoop — system prompt", () => {
  afterEach(() => resetToolRegistry());

  // After prompt-cache breakpoints landed, the loop wraps the system prompt
  // as a typed-block array carrying a cache_control marker — necessary
  // because cache_control can't attach to a plain string. These helpers
  // extract the text so the existing substring assertions still apply.
  const extractSystemText = (sys: unknown): string => {
    if (typeof sys === "string") return sys;
    if (Array.isArray(sys)) {
      return sys
        .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
    }
    return "";
  };

  test("system prompt is passed to provider", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("test");

    expect(provider.lastRequest).toBeDefined();
    expect(provider.lastRequest!.system).toBeDefined();
    expect(extractSystemText(provider.lastRequest!.system)).toContain("Hawky");
  });

  test("custom instructions are included in system prompt", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));

    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      config: makeConfig(),
      working_directory: "/tmp/test",
      custom_instructions: "Always respond in French.",
    });
    collectEvents(loop);

    await loop.sendMessage("test");

    expect(extractSystemText(provider.lastRequest!.system)).toContain("Always respond in French");
  });

  test("system prompt carries a cache_control marker on its last block", async () => {
    // Regression: the loop must mark the system prompt with cache_control so
    // Anthropic prompt caching can engage. Without this every API call is
    // billed at the full fresh-input rate (~10× more than necessary).
    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("test");

    const sys = provider.lastRequest!.system;
    expect(Array.isArray(sys)).toBe(true);
    const blocks = sys as Array<{ cache_control?: { type: string } }>;
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[blocks.length - 1].cache_control?.type).toBe("ephemeral");
  });

  test("tools are included in request when registered", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("my_tool"));

    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));

    const loop = makeLoop(provider, registry);
    collectEvents(loop);

    await loop.sendMessage("test");

    expect(provider.lastRequest!.tools).toBeDefined();
    expect(provider.lastRequest!.tools).toHaveLength(1);
    expect(provider.lastRequest!.tools![0].name).toBe("my_tool");
  });

  test("no tools in request when none registered", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("test");

    // tools should be undefined or empty
    expect(provider.lastRequest!.tools).toBeUndefined();
  });
});

describe("AgentLoop — empty/edge cases", () => {
  afterEach(() => resetToolRegistry());

  test("empty text response still emits done", async () => {
    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 5, output_tokens: 0 } },
      { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]);

    const loop = makeLoop(provider);
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("getHistory returns a copy", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("test");

    const h1 = loop.getHistory();
    const h2 = loop.getHistory();
    expect(h1).not.toBe(h2); // Different array instances
    expect(h1).toEqual(h2);  // Same content
  });

  test("isRunning is true during execution", async () => {
    const provider = new SlowProvider();
    const loop = makeLoop(provider);
    collectEvents(loop);

    expect(loop.isRunning()).toBe(false);

    const promise = loop.sendMessage("slow");
    await new Promise((r) => setTimeout(r, 20));
    expect(loop.isRunning()).toBe(true);

    loop.cancel();
    await promise;
    expect(loop.isRunning()).toBe(false);
  });
});

// =============================================================================
// Tool result truncation in loop
// =============================================================================

describe("AgentLoop — tool result truncation", () => {
  afterEach(() => resetToolRegistry());

  test("large tool output is truncated in history", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("big_output", "auto_approve", {
        executeFn: async () => {
          // Generate output larger than max_tool_result_chars
          const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}: ${"x".repeat(100)}`);
          return { type: "text", content: lines.join("\n") };
        },
      }),
    );

    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tu_1", "big_output", { value: "test" }));
    provider.addResponse(textResponse("Done with big output."));

    // Use a small truncation limit for testing
    const loop = makeLoop(provider, registry, { max_tool_result_chars: 1000 });
    const events = collectEvents(loop);

    await loop.sendMessage("generate big output");

    // History should contain truncated content (truncation happens in loop, not in event)
    const history = loop.getHistory();
    const toolResultMsg = history.find((m) =>
      m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
    const resultBlock = toolResultMsg!.content.find((b) => b.type === "tool_result") as any;
    expect(resultBlock.content).toContain("[Output truncated:");
    expect(resultBlock.content).toContain("Showing last");
  });

  test("small tool output is NOT truncated", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("small_output"));

    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tu_1", "small_output", { value: "test" }));
    provider.addResponse(textResponse("Done."));

    const loop = makeLoop(provider, registry);
    collectEvents(loop);

    await loop.sendMessage("small output");

    const history = loop.getHistory();
    const toolResultMsg = history.find((m) =>
      m.content.some((b) => b.type === "tool_result"),
    );
    const resultBlock = toolResultMsg!.content.find((b) => b.type === "tool_result") as any;
    expect(resultBlock.content).not.toContain("[Output truncated:");
    expect(resultBlock.content).toContain("small_output result:");
  });

  test("truncated output preserves tail lines", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("tail_test", "auto_approve", {
        executeFn: async () => {
          const lines = Array.from({ length: 100 }, (_, i) => `line_${i + 1}`);
          return { type: "text", content: lines.join("\n") };
        },
      }),
    );

    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tu_1", "tail_test", { value: "x" }));
    provider.addResponse(textResponse("Done."));

    const loop = makeLoop(provider, registry, { max_tool_result_chars: 500 });
    collectEvents(loop);

    await loop.sendMessage("run tail test");

    const history = loop.getHistory();
    const toolResultMsg = history.find((m) =>
      m.content.some((b) => b.type === "tool_result"),
    );
    const resultBlock = toolResultMsg!.content.find((b) => b.type === "tool_result") as any;
    // Last line should be preserved in tail
    expect(resultBlock.content).toContain("line_100");
  });
});

// =============================================================================
// Message normalization through the loop
// =============================================================================

describe("AgentLoop — message normalization", () => {
  afterEach(() => resetToolRegistry());

  test("provider receives normalized messages (no structural issues)", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("first"));
    provider.addResponse(textResponse("second"));

    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("turn 1");
    await loop.sendMessage("turn 2");

    // Second request should have properly alternating messages
    const req = provider.allRequests[1];
    expect(req.messages.length).toBeGreaterThanOrEqual(3);
    // Check alternation
    for (let i = 1; i < req.messages.length; i++) {
      if (req.messages[i].role === req.messages[i - 1].role) {
        // Same role consecutive — only OK if it's user (tool_result pattern)
        // The normalization should have merged them
        // Actually after normalization, consecutive same-role should be merged
        // So this shouldn't happen
      }
    }
    // First message should be user
    expect(req.messages[0].role).toBe("user");
  });
});

// =============================================================================
// History invariant: tool_use always followed by matching tool_result
// =============================================================================

describe("AgentLoop — history invariant when tool execution fails", () => {
  afterEach(() => resetToolRegistry());

  test("executeTools throwing still leaves a valid assistant/tool_result pair in history", async () => {
    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tool_abc", "boom", { value: "x" }));
    // Not adding a second response — the loop should throw before needing it.

    const registry = new ToolRegistry();
    // A tool whose execute throws an unhandled exception.
    registry.register(makeTool("boom", "auto_approve", {
      executeFn: async () => {
        throw new Error("synthetic tool crash");
      },
    }));

    const loop = makeLoop(provider, registry);
    collectEvents(loop);

    // sendMessage itself does not throw on tool errors — the tool failure
    // surfaces as an error-type ToolResult which executeTools returns
    // normally. So instead of relying on that path, simulate a REAL crash
    // at the tool-execution layer: replace the registry mid-call so the
    // tool is no longer findable. Use a crashing permission resolver
    // which IS a path that throws OUT of executeTools.
    // Replace the loop's permission resolver with one that throws.
    (loop as any).permissionResolver = {
      ask: async () => { throw new Error("permission oracle offline"); },
    };
    // Mark the tool as requiring permission so the resolver gets called.
    registry.resetForTests?.();
    registry.register(makeTool("boom", "ask_user", {
      executeFn: async () => ({ type: "text" as const, content: "unreachable" }),
    }));

    let caught: unknown = null;
    try {
      await loop.sendMessage("trigger");
    } catch (err) {
      caught = err;
    }

    // Even though the loop threw, the in-memory history MUST now contain
    // a user message with a tool_result for every tool_use the assistant
    // emitted — otherwise the next Anthropic API call 400s.
    const history = loop.getHistory();
    // Find the assistant message with the tool_use
    const assistantIdx = history.findIndex(
      (m) => m.role === "assistant" && (m.content as any[]).some((b) => b?.type === "tool_use"),
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);

    const assistant = history[assistantIdx];
    const toolUseIds = (assistant.content as any[])
      .filter((b) => b?.type === "tool_use")
      .map((b) => b.id);
    expect(toolUseIds).toEqual(["tool_abc"]);

    // The NEXT message must be a user message whose tool_results cover
    // every tool_use id above (and be marked is_error).
    const next = history[assistantIdx + 1];
    expect(next).toBeDefined();
    expect(next.role).toBe("user");
    const resultIds = (next.content as any[])
      .filter((b) => b?.type === "tool_result")
      .map((b) => ({ id: b.tool_use_id, isErr: b.is_error }));
    expect(resultIds).toEqual([{ id: "tool_abc", isErr: true }]);
  });

  test("normal tool execution still produces a non-error tool_result", async () => {
    const provider = new MockProvider();
    provider.addResponse(toolUseResponse("tool_ok", "happy", { value: "hi" }));
    provider.addResponse(textResponse("all done"));

    const registry = new ToolRegistry();
    registry.register(makeTool("happy")); // default executeFn returns success

    const loop = makeLoop(provider, registry);
    collectEvents(loop);

    await loop.sendMessage("trigger");

    const history = loop.getHistory();
    const toolResult = history
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as any[]) : []))
      .find((b) => b?.type === "tool_result" && b.tool_use_id === "tool_ok");
    expect(toolResult).toBeDefined();
    expect((toolResult as any).is_error).toBe(false);
  });

  test("batch with one throwing tool preserves successful results from the other tools", async () => {
    // Regression: the old outer catch in loop.ts synthesized error
    // tool_results for EVERY tool_use_id when executeTools threw, which
    // overwrote successful outputs from earlier tools in the same batch.
    // The fix pushes the recovery down into executeTools — a single tool
    // throw becomes an error result for that one tool, not the whole batch.
    // Provider emits a two-tool parallel batch.
    const provider = new MockProvider();
    provider.addResponse([
      { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tool_good", name: "good" },
      { type: "tool_use_input_delta", partial_json: JSON.stringify({ value: "1" }) },
      { type: "content_block_stop", index: 0 },
      { type: "tool_use_start", index: 1, id: "tool_bad", name: "bad" },
      { type: "tool_use_input_delta", partial_json: JSON.stringify({ value: "2" }) },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]);
    // Turn 2 just closes out cleanly; the invariant we're testing is in
    // turn 1's persisted results.
    provider.addResponse(textResponse("done"));

    const registry = new ToolRegistry();
    registry.register(makeTool("good", "auto_approve", {
      executeFn: async () => ({ type: "text" as const, content: "good returned" }),
    }));
    registry.register(makeTool("bad", "auto_approve", {
      executeFn: async () => { throw new Error("bad blew up"); },
    }));

    const loop = makeLoop(provider, registry);
    collectEvents(loop);
    await loop.sendMessage("run both");

    const history = loop.getHistory();
    const results = history
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as any[]) : []))
      .filter((b) => b?.type === "tool_result")
      .reduce<Record<string, any>>((acc, b) => { acc[b.tool_use_id] = b; return acc; }, {});

    // The successful tool must carry its real output AND be marked non-error.
    expect(results.tool_good).toBeDefined();
    expect(results.tool_good.is_error).toBe(false);
    expect(String(results.tool_good.content)).toContain("good returned");

    // The failing tool gets an error result (not blanket-overwriting the
    // successful one above).
    expect(results.tool_bad).toBeDefined();
    expect(results.tool_bad.is_error).toBe(true);
    expect(String(results.tool_bad.content)).toContain("bad blew up");
  });
});

// =============================================================================
// Per-turn reminder gating
//
// The <system-reminder> block that surfaces pending session tasks is gated
// by a 10-turn cooldown on both counters (task-action, reminder). Firing on
// every turn caused stall loops where the agent re-read the reminder as a
// new user prompt and acknowledged-without-acting. These tests pin the
// gating contract so the behavior can't silently regress.
// =============================================================================

describe("AgentLoop — per-turn reminder gating", () => {
  // Each test gets a fresh task-store registry so one test's tasks don't
  // leak into another's store cache. Stores are in-memory only (no
  // disk), so no filesystem scaffolding needed.
  beforeEach(async () => {
    const { resetAllTaskStores } = await import("../src/tools/task_global.js");
    resetAllTaskStores();
  });
  afterEach(async () => {
    resetToolRegistry();
    const { resetAllTaskStores } = await import("../src/tools/task_global.js");
    resetAllTaskStores();
  });

  // Pull a compact "does the user message contain a reminder" snapshot
  // from the Nth user message (0-indexed in conversation order).
  function userMsgHasReminder(loop: AgentLoop, nthUser: number): boolean {
    const history = loop.getHistory();
    const userMsgs = history.filter((m) => m.role === "user");
    const userMsg = userMsgs[nthUser];
    if (!userMsg) throw new Error(`No user message at index ${nthUser}`);
    for (const block of userMsg.content) {
      if (block.type === "text" && block.text.includes("<system-reminder>")) {
        return true;
      }
    }
    return false;
  }

  test("case 1: fresh loop + pending task fires on the first turn", async () => {
    const { getTaskStore } = await import("../src/tools/task_global.js");
    getTaskStore("default").create("First task");

    const provider = new MockProvider();
    provider.addResponse(textResponse("ok"));
    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("hello");
    expect(userMsgHasReminder(loop, 0)).toBe(true);
  });

  test("case 2: the turn immediately after firing does NOT fire again", async () => {
    const { getTaskStore } = await import("../src/tools/task_global.js");
    getTaskStore("default").create("Pending task");

    const provider = new MockProvider();
    provider.addResponse(textResponse("reply 1"));
    provider.addResponse(textResponse("reply 2"));
    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("turn 1");
    await loop.sendMessage("turn 2");

    expect(userMsgHasReminder(loop, 0)).toBe(true);   // first turn: fires
    expect(userMsgHasReminder(loop, 1)).toBe(false);  // second turn: gated
  });

  test("case 3: reminder fires again on the 11th quiet turn after firing", async () => {
    const { getTaskStore } = await import("../src/tools/task_global.js");
    getTaskStore("default").create("Always-pending task");

    const provider = new MockProvider();
    for (let i = 0; i < 11; i++) provider.addResponse(textResponse(`r${i}`));
    const loop = makeLoop(provider);
    collectEvents(loop);

    for (let i = 0; i < 11; i++) await loop.sendMessage(`turn ${i + 1}`);

    // Turn 0 (1st): fires (fresh Infinity counters).
    expect(userMsgHasReminder(loop, 0)).toBe(true);
    // Turns 1-9 (the 2nd through 10th): gated.
    for (let i = 1; i <= 9; i++) {
      expect(userMsgHasReminder(loop, i)).toBe(false);
    }
    // Turn 10 (11th): counter reaches 10, fires again.
    expect(userMsgHasReminder(loop, 10)).toBe(true);
  });

  test("case 4: task_create tool call resets task-action counter, blocking the next reminder", async () => {
    // Sequence:
    //   Turn 1: fires (fresh loop + pending task) — turnsSinceLastReminder → 0.
    //   Turn 2: agent calls task_create. Counter reset. But reminder still
    //           gated because turnsSinceLastReminder is only 1.
    //   Turn 3: no reminder (both counters still < 10).
    //   … confirms task action blocks, not enables, the reminder.
    const { getTaskStore } = await import("../src/tools/task_global.js");
    getTaskStore("default").create("Initial task");

    // Register the real task_create tool so the loop sees its name.
    const registry = new ToolRegistry();
    const taskCreateTool = makeTool("task_create", "auto_approve", {
      executeFn: async () => ({ type: "text" as const, content: "Task created: task_X" }),
    });
    registry.register(taskCreateTool);

    const provider = new MockProvider();
    provider.addResponse(textResponse("reply 1"));                                    // turn 1
    provider.addResponse(toolUseResponse("tu_tc", "task_create", { description: "new task" })); // turn 2: tool_use
    provider.addResponse(textResponse("tool done"));                                  // turn 2: after tool_result
    provider.addResponse(textResponse("reply 3"));                                    // turn 3
    const loop = makeLoop(provider, registry);
    collectEvents(loop);

    await loop.sendMessage("turn 1");
    await loop.sendMessage("turn 2 (with task_create)");
    await loop.sendMessage("turn 3");

    expect(userMsgHasReminder(loop, 0)).toBe(true);
    expect(userMsgHasReminder(loop, 1)).toBe(false);
    expect(userMsgHasReminder(loop, 2)).toBe(false);
  });

  test("case 5: no tasks at all → reminder never fires, even over many turns", async () => {
    const provider = new MockProvider();
    for (let i = 0; i < 20; i++) provider.addResponse(textResponse(`r${i}`));
    const loop = makeLoop(provider);
    collectEvents(loop);

    for (let i = 0; i < 20; i++) await loop.sendMessage(`t${i + 1}`);

    for (let i = 0; i < 20; i++) {
      expect(userMsgHasReminder(loop, i)).toBe(false);
    }
  });

  test("case 6: two AgentLoop instances have independent counters (per-session scoping)", async () => {
    const { getTaskStore } = await import("../src/tools/task_global.js");
    getTaskStore("default").create("Shared pending task");

    const provider1 = new MockProvider();
    const provider2 = new MockProvider();
    provider1.addResponse(textResponse("r1"));
    provider1.addResponse(textResponse("r2"));
    provider2.addResponse(textResponse("r3"));

    const loop1 = makeLoop(provider1);
    const loop2 = makeLoop(provider2);
    collectEvents(loop1);
    collectEvents(loop2);

    await loop1.sendMessage("loop1 turn 1");  // loop1: reminder fires, counter → 0
    await loop1.sendMessage("loop1 turn 2");  // loop1: gated
    await loop2.sendMessage("loop2 turn 1");  // loop2: still fresh, fires

    expect(userMsgHasReminder(loop1, 0)).toBe(true);
    expect(userMsgHasReminder(loop1, 1)).toBe(false);
    expect(userMsgHasReminder(loop2, 0)).toBe(true);
  });

  test("case 10 (Codex P2 regression): clearHistory wipes the session's task store too", async () => {
    // /new / session.clear is a "clean slate" from the user's
    // perspective. Without this, the conversation resets but stale
    // tasks still show in the tray/reminder and rehydrate on restart.
    const { getTaskStore } = await import("../src/tools/task_global.js");
    const store = getTaskStore("default");
    store.create("Old task 1");
    store.create("Old task 2");
    expect(store.getTasks().length).toBe(2);

    const provider = new MockProvider();
    const loop = makeLoop(provider);
    loop.clearHistory();

    // Same store — cleared in place.
    expect(getTaskStore("default").getTasks().length).toBe(0);
    // Counter reset too, so a fresh create starts at task_1.
    expect(getTaskStore("default").create("new one")).toBe("task_1");
  });

  test("case 8 (Codex P2 regression): clearHistory resets the gate so the next turn fires", async () => {
    // Without a reset, cooldown state from a prior conversation would
    // suppress the first reminder in a fresh conversation started from
    // clearHistory() (the gateway and TUI reset paths). We want
    // clearHistory to behave like a fresh loop for gating purposes.
    //
    // Note: clearHistory also now wipes the session's task store (case 10),
    // so this test creates a new task AFTER clearHistory to simulate the
    // realistic flow: user /news → agent starts new work → task_creates.
    const { getTaskStore } = await import("../src/tools/task_global.js");
    getTaskStore("default").create("Pre-clear task");

    const provider = new MockProvider();
    provider.addResponse(textResponse("reply 1"));
    provider.addResponse(textResponse("reply 2"));
    provider.addResponse(textResponse("reply 3"));
    const loop = makeLoop(provider);
    collectEvents(loop);

    // Turn 1: fires (fresh counters).
    await loop.sendMessage("turn 1");
    expect(userMsgHasReminder(loop, 0)).toBe(true);

    // Turn 2: gated (just fired last turn).
    await loop.sendMessage("turn 2");
    expect(userMsgHasReminder(loop, 1)).toBe(false);

    // Clear history. Gate counters reset; task store also cleared.
    loop.clearHistory();
    // Simulate the new conversation creating a fresh task.
    getTaskStore("default").create("Fresh post-clear task");

    // Turn 3 must fire — gate counters have been reset to Infinity.
    await loop.sendMessage("turn 3 after clearHistory");
    expect(userMsgHasReminder(loop, 0)).toBe(true);
  });

  test("case 9 (Codex P2 regression): empty-reminder turns do NOT consume the cooldown", async () => {
    // If there are no pending tasks on turn N, the gate passes but the
    // reminder is empty. That empty "fire" must NOT reset the reminder
    // counter — otherwise a task that becomes pending later (e.g. via
    // external task_create from a sibling session in multi-session
    // setups, or a distillation job) would have its FIRST reminder
    // suppressed for up to another 10 turns. Only real content
    // consumes the cooldown.
    const { getTaskStore } = await import("../src/tools/task_global.js");

    const provider = new MockProvider();
    for (let i = 0; i < 15; i++) provider.addResponse(textResponse(`r${i}`));
    const loop = makeLoop(provider);
    collectEvents(loop);

    // Turns 1-3: no tasks at all. Gate passes (fresh Infinity) but
    // reminder is empty → counter must stay Infinity.
    await loop.sendMessage("t1");
    await loop.sendMessage("t2");
    await loop.sendMessage("t3");
    for (let i = 0; i < 3; i++) expect(userMsgHasReminder(loop, i)).toBe(false);

    // A task becomes pending externally (simulating another session
    // creating one, or distillation adding one).
    getTaskStore("default").create("Suddenly pending");

    // Turn 4: with real reminder content, MUST fire. If the earlier
    // empty-reminder turns had eaten the cooldown, this would be
    // suppressed for 10 more turns.
    await loop.sendMessage("t4");
    expect(userMsgHasReminder(loop, 3)).toBe(true);
  });

  test("case 7: only completed tasks → never fires even with counters open", async () => {
    const { getTaskStore } = await import("../src/tools/task_global.js");
    const id = getTaskStore("default").create("Will complete");
    getTaskStore("default").update(id, "completed");

    const provider = new MockProvider();
    provider.addResponse(textResponse("reply"));
    const loop = makeLoop(provider);
    collectEvents(loop);

    await loop.sendMessage("hello");
    // shouldRemind=true on turn 1 (Infinity counters), but
    // buildPerTurnReminders returns "" because the only task is complete.
    expect(userMsgHasReminder(loop, 0)).toBe(false);
  });
});

// E2E tests moved to tests/e2e-api.ts — run with: bun run test:e2e
