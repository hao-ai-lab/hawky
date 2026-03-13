// =============================================================================
// E2E Tests — External API calls
//
// All tests that hit external APIs are consolidated here so they run
// sequentially within one file, avoiding concurrent connection rate limits.
//
// Required env vars:
//   ANTHROPIC_API_KEY — for Anthropic API tests
//   BRAVE_API_KEY     — for Brave Search API tests
//
// Run with: bun run test:e2e
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/agent/anthropic_provider.js";
import { LLMError } from "../src/agent/provider.js";
import type { LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";
import { AgentLoop } from "../src/agent/loop.js";
import { ToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import type { HawkyConfig, StreamEvent } from "../src/agent/types.js";
import { executeWebSearch } from "../src/tools/web_search.js";
import { executeWebFetch } from "../src/tools/web_fetch.js";
import type { ToolContext, ToolResult } from "../src/agent/types.js";
import { resetConfig } from "../src/storage/config.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function requireAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY env var is required for E2E tests. " +
      "Run: ANTHROPIC_API_KEY=sk-ant-... bun run test:e2e",
    );
  }
  return key;
}

function requireBraveKey(): string {
  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    throw new Error(
      "BRAVE_API_KEY env var is required for E2E tests. " +
      "Run: BRAVE_API_KEY=... bun run test:e2e",
    );
  }
  return key;
}

function makeConfig(overrides?: Partial<HawkyConfig>): HawkyConfig {
  return {
    api_keys: { anthropic: "", brave_search: "" },
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

function collectEvents(loop: AgentLoop): StreamEvent[] {
  const events: StreamEvent[] = [];
  loop.subscribe((e) => events.push(e));
  return events;
}

function toolCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "test",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

// =============================================================================
// Anthropic Provider — streaming
// =============================================================================

describe("E2E: Anthropic Provider", () => {
  // Tests run with --max-concurrency=1 to avoid rate limits

  test("streams a simple text response", async () => {
    const provider = new AnthropicProvider(requireAnthropicKey());
    const events: LLMStreamEvent[] = [];

    for await (const event of provider.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{ role: "user", content: "Say exactly: hello world" }],
    })) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("message_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    const start = events.find((e) => e.type === "message_start") as any;
    expect(start.message_id).toMatch(/^msg_/);
    expect(start.model).toContain("claude");
    expect(start.usage.input_tokens).toBeGreaterThan(0);

    const delta = events.find((e) => e.type === "message_delta") as any;
    expect(delta.stop_reason).toBe("end_turn");
    expect(delta.usage.output_tokens).toBeGreaterThan(0);

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text)
      .join("");
    expect(text.toLowerCase()).toContain("hello");
  });

  test("streams with tool definitions", async () => {
    const provider = new AnthropicProvider(requireAnthropicKey());
    const events: LLMStreamEvent[] = [];

    for await (const event of provider.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: "What is the current working directory? Use the bash tool to find out." }],
      tools: [{
        name: "bash",
        description: "Execute a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string", description: "The command to run" } },
          required: ["command"],
        },
      }],
    })) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_use_start");
    expect(types).toContain("tool_use_input_delta");

    const delta = events.find((e) => e.type === "message_delta") as any;
    expect(delta.stop_reason).toBe("tool_use");

    const toolStart = events.find((e) => e.type === "tool_use_start") as any;
    expect(toolStart.name).toBe("bash");
    expect(toolStart.id).toMatch(/^toolu_/);

    const inputJson = events
      .filter((e) => e.type === "tool_use_input_delta")
      .map((e) => (e as any).partial_json)
      .join("");
    const parsed = JSON.parse(inputJson);
    expect(parsed.command).toBeDefined();
  });

  test("abort cancels streaming", async () => {
    const provider = new AnthropicProvider(requireAnthropicKey());
    const controller = new AbortController();
    const events: LLMStreamEvent[] = [];

    try {
      for await (const event of provider.stream(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 500,
          messages: [{ role: "user", content: "Write a very long story about a dragon." }],
        },
        controller.signal,
      )) {
        events.push(event);
        if (event.type === "text_delta") controller.abort();
      }
    } catch (e: any) {
      expect(e).toBeInstanceOf(LLMError);
      expect(["aborted", "connection_error"]).toContain(e.code);
    }

    expect(events.length).toBeGreaterThan(0);
  });

  test("invalid API key throws auth_error", async () => {
    requireAnthropicKey(); // Ensure env is set
    const provider = new AnthropicProvider("sk-bad-key-12345");

    try {
      for await (const _event of provider.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hi" }],
      })) {
        // drain
      }
      expect(false).toBe(true);
    } catch (e: any) {
      expect(e).toBeInstanceOf(LLMError);
      expect(e.code).toBe("auth_error");
      expect(e.status).toBe(401);
      expect(e.retryable).toBe(false);
    }
  });

  test("system prompt works", async () => {
    const provider = new AnthropicProvider(requireAnthropicKey());
    const events: LLMStreamEvent[] = [];

    for await (const event of provider.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{ role: "user", content: "What is my name?" }],
      system: "The user's name is TestBot42. Always use their name.",
    })) {
      events.push(event);
    }

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text)
      .join("");
    expect(text).toContain("TestBot42");
  });

  test("token usage is reported", async () => {
    const provider = new AnthropicProvider(requireAnthropicKey());
    const events: LLMStreamEvent[] = [];

    for await (const event of provider.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 20,
      messages: [{ role: "user", content: "Hi" }],
    })) {
      events.push(event);
    }

    const start = events.find((e) => e.type === "message_start") as any;
    expect(start.usage.input_tokens).toBeGreaterThan(0);
    const delta = events.find((e) => e.type === "message_delta") as any;
    expect(delta.usage.output_tokens).toBeGreaterThan(0);
  });
});

// =============================================================================
// Agent Loop — full stack with real API
// =============================================================================

describe("E2E: Agent Loop", () => {
  afterEach(() => {
    resetToolRegistry();
  });

  test("system prompt includes environment info", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: process.cwd(),
    });
    const events = collectEvents(loop);

    await loop.sendMessage("What operating system am I on? Reply with just the OS name.");

    const textEvents = events.filter((e) => e.type === "text");
    const fullText = textEvents.map((e) => (e as any).content).join("");
    // Agent should know the OS from the system prompt
    expect(fullText.toLowerCase()).toMatch(/macos|darwin|linux|windows/);
  });

  test("simple text response through full loop", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: "/tmp",
    });
    const events = collectEvents(loop);

    await loop.sendMessage("Say exactly: hello world");

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    const fullText = textEvents.map((e) => (e as any).content).join("");
    expect(fullText.toLowerCase()).toContain("hello");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("tool execution through full loop", async () => {
    const apiKey = requireAnthropicKey();
    const registry = new ToolRegistry();
    registry.register({
      name: "calculate",
      description: "Evaluate a mathematical expression and return the result. Use this for any math calculations.",
      input_schema: {
        type: "object",
        properties: { expression: { type: "string", description: "Math expression" } },
        required: ["expression"],
      },
      permission: "auto_approve",
      execute: async (input: any) => {
        try {
          const result = Function(`"use strict"; return (${input.expression})`)();
          return { type: "text", content: String(result) };
        } catch {
          return { type: "error", content: "Failed to evaluate" };
        }
      },
    });

    const provider = new AnthropicProvider(apiKey);
    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: "/tmp",
    });
    const events = collectEvents(loop);

    await loop.sendMessage("What is 2+2? Use the calculate tool.");

    const textEvents = events.filter((e) => e.type === "text");
    const fullText = textEvents.map((e) => (e as any).content).join("");
    expect(fullText).toContain("4");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("multi-turn conversation", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: "/tmp",
    });
    const events = collectEvents(loop);

    await loop.sendMessage("My name is TestBot123. Remember this.");
    expect(loop.getHistory().length).toBeGreaterThanOrEqual(2);

    await loop.sendMessage("What is my name? Reply with just the name.");
    const textEvents = events.filter((e) => e.type === "text");
    const fullText = textEvents.map((e) => (e as any).content).join("");
    expect(fullText).toContain("TestBot123");
  });
});

// =============================================================================
// Agent Loop + Built-in Tools — full TUI stack simulation
//
// Tests the same path the TUI uses: AgentLoop with registerBuiltinTools,
// real API, and the event→DisplayMessage mapping that useAgentLoop does.
// =============================================================================

describe("E2E: Agent Loop + Built-in Tools (TUI stack)", () => {
  afterEach(() => {
    resetToolRegistry();
  });

  test("agent uses bash tool to run a command", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const registry = new ToolRegistry();
    // Register just bash — same as registerBuiltinTools but fewer tools = faster
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: "/tmp",
    });
    const events = collectEvents(loop);

    await loop.sendMessage("Run: echo HAWKY_E2E_TEST. Use the bash tool. Reply with the output.");

    // Should have tool_result for bash
    // (tool_use_start may not emit when permissionResolver is absent — known issue)
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).name).toBe("bash");

    // Final text should mention the output
    const textEvents = events.filter((e) => e.type === "text");
    const fullText = textEvents.map((e) => (e as any).content).join("");
    expect(fullText).toContain("HAWKY_E2E_TEST");

    // Done event with accumulated token usage
    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    expect(done.usage.input_tokens).toBeGreaterThan(0);
    expect(done.usage.output_tokens).toBeGreaterThan(0);
  });

  test("agent uses read_file tool", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const registry = new ToolRegistry();
    const { readFileToolDefinition } = await import("../src/tools/read_file.js");
    registry.register(readFileToolDefinition as any);

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: process.cwd(),
    });
    const events = collectEvents(loop);

    await loop.sendMessage("Read the file package.json and tell me the project name. Use the read_file tool.");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).name).toBe("read_file");

    const textEvents = events.filter((e) => e.type === "text");
    const fullText = textEvents.map((e) => (e as any).content).join("");
    expect(fullText.toLowerCase()).toContain("hawky");
  });

  test("token usage accumulates across tool iterations", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: "/tmp",
    });
    const events = collectEvents(loop);

    await loop.sendMessage("Run: echo hello. Use the bash tool. Then summarize what you did in one sentence.");

    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    // Tool use means at least 2 API calls, so usage should be substantial.
    // Sum the cache fields too — with prompt caching enabled, most of the
    // bulk lands in cache_creation_input_tokens (first call) and
    // cache_read_input_tokens (subsequent calls), and the raw
    // input_tokens drops to a tiny per-call delta. Asserting only on
    // input_tokens fails after #194 landed prompt caching.
    const totalInput =
      (done.usage.input_tokens ?? 0) +
      (done.usage.cache_creation_input_tokens ?? 0) +
      (done.usage.cache_read_input_tokens ?? 0);
    expect(totalInput).toBeGreaterThan(50);
    expect(done.usage.output_tokens).toBeGreaterThan(10);
  });

  test("cancel mid-stream with real API", async () => {
    const apiKey = requireAnthropicKey();
    const provider = new AnthropicProvider(apiKey);
    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      config: makeConfig({ api_keys: { anthropic: apiKey, brave_search: "" } }),
      working_directory: "/tmp",
    });
    const events = collectEvents(loop);

    // Start a long response and cancel after first text
    const promise = loop.sendMessage("Write a detailed 500 word essay about the history of computing.");

    // Wait for first text event, then cancel
    await new Promise<void>((resolve) => {
      const unsub = loop.subscribe((event) => {
        if (event.type === "text") {
          loop.cancel();
          unsub();
          resolve();
        }
      });
    });

    await promise;

    // Should have cancel event
    const cancelEvents = events.filter((e) => e.type === "cancel");
    expect(cancelEvents.length).toBeGreaterThanOrEqual(1);

    // Should have partial text
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);

    // Should NOT be running anymore
    expect(loop.isRunning()).toBe(false);
  });

  // Permission resolver tests moved to tests/test-permission-resolver.ts
  // (they use a mock provider — not E2E)
});

// =============================================================================
// Brave Search API
// =============================================================================

describe("E2E: Brave Search", () => {
  // Save original env to restore after each test
  const origBraveKey = process.env.BRAVE_API_KEY;

  afterEach(() => {
    resetConfig();
    if (origBraveKey !== undefined) {
      process.env.BRAVE_API_KEY = origBraveKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  });

  test("searches for a known term", async () => {
    requireBraveKey();
    resetConfig();
    const r = await executeWebSearch(
      { query: "TypeScript programming language", count: 3 },
      toolCtx(),
    );
    expect(r.type).toBe("text");
    expect(r.content).toContain("Results for:");
    expect((r as any).metadata?.count).toBeGreaterThan(0);
  });

  test("searches with count=1", async () => {
    requireBraveKey();
    resetConfig();
    const r = await executeWebSearch(
      { query: "Anthropic Claude", count: 1 },
      toolCtx(),
    );
    expect(r.type).toBe("text");
    expect(r.content).toContain("1.");
    expect(r.content).not.toContain("2.");
  });
});

// =============================================================================
// Web Fetch (real network, no API key needed)
// =============================================================================

describe("E2E: Web Fetch", () => {
  test("fetches example.com successfully", async () => {
    const r = await executeWebFetch({ url: "https://example.com" }, toolCtx());
    expect(r.type).toBe("text");
    expect(r.content).toContain("Example Domain");
  });

  test("fetches a real JSON endpoint successfully", async () => {
    const r = await executeWebFetch({ url: "https://httpbin.org/json" }, toolCtx());
    expect(r.type).toBe("text");
    expect(r.content).toContain("Extractor: json");
  });
});
