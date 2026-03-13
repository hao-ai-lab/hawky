// =============================================================================
// Tests for Anthropic Provider (3.1)
//
// Unit tests mock the SDK; E2E tests hit the real API.
// =============================================================================

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AnthropicProvider, _classifyError, _mapEvent } from "../src/agent/anthropic_provider.js";
import { LLMError } from "../src/agent/provider.js";
import type { LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";
import {
  APIUserAbortError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  BadRequestError,
  InternalServerError,
  APIError,
} from "@anthropic-ai/sdk/error";


// =============================================================================
// Helper: create a mock Anthropic client that yields given events
// =============================================================================

function makeRequest(overrides?: Partial<LLMStreamRequest>): LLMStreamRequest {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

// Helper to create a fake async iterable of MessageStreamEvents
async function* fakeStream(events: any[]): AsyncGenerator<any> {
  for (const e of events) {
    yield e;
  }
}

// =============================================================================
// mapEvent tests
// =============================================================================

describe("mapEvent", () => {
  test("maps message_start event", () => {
    const result = _mapEvent({
      type: "message_start",
      message: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    } as any);
    expect(result).toEqual({
      type: "message_start",
      message_id: "msg_123",
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      },
    });
  });

  test("maps message_start with cache usage", () => {
    const result = _mapEvent({
      type: "message_start",
      message: {
        id: "msg_456",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
    } as any);
    expect(result!.type).toBe("message_start");
    const msg = result as any;
    expect(msg.usage.cache_creation_input_tokens).toBe(100);
    expect(msg.usage.cache_read_input_tokens).toBe(50);
  });

  test("maps message_delta event", () => {
    const result = _mapEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 },
    } as any);
    expect(result).toEqual({
      type: "message_delta",
      stop_reason: "end_turn",
      usage: { output_tokens: 42 },
    });
  });

  test("maps message_delta with tool_use stop_reason", () => {
    const result = _mapEvent({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 15 },
    } as any);
    expect((result as any).stop_reason).toBe("tool_use");
  });

  test("maps message_stop event", () => {
    const result = _mapEvent({ type: "message_stop" } as any);
    expect(result).toEqual({ type: "message_stop" });
  });

  test("maps content_block_start for tool_use", () => {
    const result = _mapEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_abc", name: "bash", input: {} },
    } as any);
    expect(result).toEqual({
      type: "tool_use_start",
      index: 1,
      id: "tu_abc",
      name: "bash",
    });
  });

  test("returns null for content_block_start with text type", () => {
    const result = _mapEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as any);
    expect(result).toBeNull();
  });

  test("returns null for content_block_start with thinking type", () => {
    const result = _mapEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    } as any);
    expect(result).toBeNull();
  });

  test("maps content_block_delta for text_delta", () => {
    const result = _mapEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    } as any);
    expect(result).toEqual({ type: "text_delta", text: "Hello" });
  });

  test("maps content_block_delta for thinking_delta", () => {
    const result = _mapEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me think..." },
    } as any);
    expect(result).toEqual({ type: "thinking_delta", thinking: "Let me think..." });
  });

  test("maps content_block_delta for input_json_delta", () => {
    const result = _mapEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"comm' },
    } as any);
    expect(result).toEqual({ type: "tool_use_input_delta", partial_json: '{"comm' });
  });

  test("returns null for signature_delta", () => {
    const result = _mapEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "abc123" },
    } as any);
    expect(result).toBeNull();
  });

  test("maps content_block_stop", () => {
    const result = _mapEvent({
      type: "content_block_stop",
      index: 2,
    } as any);
    expect(result).toEqual({ type: "content_block_stop", index: 2 });
  });

  test("returns null for unknown event type", () => {
    const result = _mapEvent({ type: "ping" } as any);
    expect(result).toBeNull();
  });
});

// =============================================================================
// classifyError tests
// =============================================================================

describe("classifyError", () => {
  test("passes through LLMError unchanged", () => {
    const err = new LLMError("rate_limit", "Too many requests", 429);
    const result = _classifyError(err);
    expect(result).toBe(err);
  });

  test("classifies APIUserAbortError", () => {
    const err = new APIUserAbortError();
    const result = _classifyError(err);
    expect(result.code).toBe("aborted");
  });

  test("classifies APIConnectionTimeoutError", () => {
    const err = new APIConnectionTimeoutError();
    const result = _classifyError(err);
    expect(result.code).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  test("classifies APIConnectionError", () => {
    const err = new APIConnectionError({ message: "ECONNREFUSED" });
    const result = _classifyError(err);
    expect(result.code).toBe("connection_error");
  });

  test("classifies AuthenticationError", () => {
    const err = new AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid api key" } }, "invalid api key", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("auth_error");
    expect(result.status).toBe(401);
    expect(result.retryable).toBe(false);
  });

  test("classifies PermissionDeniedError", () => {
    const err = new PermissionDeniedError(403, undefined, "forbidden", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("permission_error");
    expect(result.status).toBe(403);
  });

  test("classifies RateLimitError", () => {
    const err = new RateLimitError(429, undefined, "rate limited", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("rate_limit");
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(true);
  });

  test("classifies BadRequestError as bad_request", () => {
    const err = new BadRequestError(400, undefined, "invalid messages format", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("bad_request");
  });

  test("classifies BadRequestError with context overflow", () => {
    const err = new BadRequestError(400, undefined, "prompt is too long: context window exceeded", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("context_overflow");
  });

  test("classifies BadRequestError with token overflow", () => {
    const err = new BadRequestError(400, undefined, "maximum token limit exceeded", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("context_overflow");
  });

  test("classifies InternalServerError as overloaded", () => {
    const err = new InternalServerError(500, undefined, "overloaded", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  test("classifies InternalServerError 529 as overloaded", () => {
    const err = new InternalServerError(529, undefined, "overloaded", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("overloaded");
  });

  test("classifies generic APIError as unknown", () => {
    const err = new APIError(418, undefined, "I'm a teapot", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("unknown");
    expect(result.status).toBe(418);
  });

  test("classifies plain Error as unknown", () => {
    const err = new Error("something broke");
    const result = _classifyError(err);
    expect(result.code).toBe("unknown");
    expect(result.message).toBe("something broke");
  });

  test("classifies non-Error thrown value", () => {
    const result = _classifyError("string error");
    expect(result.code).toBe("unknown");
    expect(result.message).toBe("string error");
  });
});

// =============================================================================
// LLMError tests
// =============================================================================

describe("LLMError", () => {
  test("retryable for rate_limit", () => {
    expect(new LLMError("rate_limit", "x").retryable).toBe(true);
  });

  test("retryable for overloaded", () => {
    expect(new LLMError("overloaded", "x").retryable).toBe(true);
  });

  test("retryable for timeout", () => {
    expect(new LLMError("timeout", "x").retryable).toBe(true);
  });

  test("not retryable for auth_error", () => {
    expect(new LLMError("auth_error", "x").retryable).toBe(false);
  });

  test("not retryable for bad_request", () => {
    expect(new LLMError("bad_request", "x").retryable).toBe(false);
  });

  test("not retryable for aborted", () => {
    expect(new LLMError("aborted", "x").retryable).toBe(false);
  });

  test("stores status code", () => {
    const err = new LLMError("rate_limit", "x", 429);
    expect(err.status).toBe(429);
  });

  test("name is LLMError", () => {
    expect(new LLMError("unknown", "x").name).toBe("LLMError");
  });
});

// =============================================================================
// AnthropicProvider constructor
// =============================================================================

describe("AnthropicProvider constructor", () => {
  test("throws LLMError for empty API key", () => {
    expect(() => new AnthropicProvider("")).toThrow(LLMError);
    try {
      new AnthropicProvider("");
    } catch (e: any) {
      expect(e.code).toBe("auth_error");
    }
  });

  test("creates provider with valid API key", () => {
    const provider = new AnthropicProvider("sk-test-key");
    expect(provider).toBeDefined();
  });
});

// =============================================================================
// AnthropicProvider.stream() — unit tests with mocked client
// =============================================================================

describe("AnthropicProvider.stream()", () => {
  test("throws on pre-aborted signal", async () => {
    const provider = new AnthropicProvider("sk-test-key");
    const controller = new AbortController();
    controller.abort();

    const events: LLMStreamEvent[] = [];
    try {
      for await (const e of provider.stream(makeRequest(), controller.signal)) {
        events.push(e);
      }
      expect(false).toBe(true); // Should not reach
    } catch (e: any) {
      expect(e).toBeInstanceOf(LLMError);
      expect(e.code).toBe("aborted");
    }
    expect(events).toHaveLength(0);
  });
});

// =============================================================================
// Provider type exports
// =============================================================================

describe("Provider type shape", () => {
  test("LLMStreamEvent covers all expected types", () => {
    // Compile-time check: ensure all event types are present
    const eventTypes: LLMStreamEvent["type"][] = [
      "text_delta",
      "thinking_delta",
      "tool_use_start",
      "tool_use_input_delta",
      "content_block_stop",
      "message_start",
      "message_delta",
      "message_stop",
    ];
    expect(eventTypes).toHaveLength(8);
  });
});

// E2E tests moved to tests/e2e-api.ts — run with: bun run test:e2e
