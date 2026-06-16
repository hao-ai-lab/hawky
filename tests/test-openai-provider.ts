// =============================================================================
// Tests for OpenAI Provider
//
// Unit tests mock the SDK; E2E tests hit the real API.
// =============================================================================

import { describe, expect, spyOn, test } from "bun:test";
import {
  OpenAIProvider,
  _classifyError,
  _mapEvent,
  _translateMessages,
} from "../src/agent/openai_provider.js";
import { LLMError } from "../src/agent/provider.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";
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
} from "openai";

// =============================================================================
// Helpers
// =============================================================================

function makeRequest(overrides?: Partial<LLMStreamRequest>): LLMStreamRequest {
  return {
    model: "gpt-test",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

async function* fakeStream(chunks: any[]): AsyncGenerator<any> {
  for (const c of chunks) {
    yield c;
  }
}

// =============================================================================
// _classifyError
// =============================================================================

describe("_classifyError", () => {
  test("passes through LLMError unchanged", () => {
    const err = new LLMError("rate_limit", "Too many requests", 429);
    expect(_classifyError(err)).toBe(err);
  });

  test("classifies APIUserAbortError", () => {
    const err = new APIUserAbortError();
    expect(_classifyError(err).code).toBe("aborted");
  });

  test("classifies APIConnectionTimeoutError", () => {
    const err = new APIConnectionTimeoutError();
    const result = _classifyError(err);
    expect(result.code).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  test("classifies APIConnectionError", () => {
    const err = new APIConnectionError({ message: "ECONNREFUSED" });
    expect(_classifyError(err).code).toBe("connection_error");
  });

  test("classifies AuthenticationError (401)", () => {
    const err = new AuthenticationError(401, { type: "error" } as any, "invalid api key", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("auth_error");
    expect(result.status).toBe(401);
    expect(result.retryable).toBe(false);
  });

  test("classifies PermissionDeniedError (403)", () => {
    const err = new PermissionDeniedError(403, undefined as any, "forbidden", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("permission_error");
    expect(result.status).toBe(403);
  });

  test("classifies RateLimitError (429)", () => {
    const err = new RateLimitError(429, undefined as any, "rate limited", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("rate_limit");
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(true);
  });

  test("classifies BadRequestError with 'context too long' as context_overflow", () => {
    const err = new BadRequestError(400, undefined as any, "context too long", new Headers());
    expect(_classifyError(err).code).toBe("context_overflow");
  });

  test("classifies BadRequestError with generic message as bad_request", () => {
    const err = new BadRequestError(400, undefined as any, "invalid messages format", new Headers());
    expect(_classifyError(err).code).toBe("bad_request");
  });

  test("classifies InternalServerError (500) as overloaded", () => {
    const err = new InternalServerError(500, undefined as any, "overloaded", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  test("classifies generic APIError as unknown", () => {
    const err = new APIError(418, undefined, "I'm a teapot", new Headers());
    const result = _classifyError(err);
    expect(result.code).toBe("unknown");
    expect(result.status).toBe(418);
  });

  test("classifies plain Error as unknown", () => {
    const result = _classifyError(new Error("something broke"));
    expect(result.code).toBe("unknown");
    expect(result.message).toBe("something broke");
  });

  test("classifies non-Error thrown value as unknown", () => {
    const result = _classifyError("string error");
    expect(result.code).toBe("unknown");
    expect(result.message).toBe("string error");
  });
});

// =============================================================================
// LLMError
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
    expect(new LLMError("rate_limit", "x", 429).status).toBe(429);
  });

  test("name is LLMError", () => {
    expect(new LLMError("unknown", "x").name).toBe("LLMError");
  });
});

// =============================================================================
// _translateMessages
// =============================================================================

describe("_translateMessages", () => {
  test("string system → first message has role: system", () => {
    const msgs = _translateMessages(makeRequest({ system: "You are helpful." }));
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("You are helpful.");
  });

  test("LLMSystemBlock[] system → joined .text", () => {
    const msgs = _translateMessages(
      makeRequest({
        system: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
      }),
    );
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Line 1\nLine 2");
  });

  test("user message with string content passes through", () => {
    const msgs = _translateMessages(makeRequest({ messages: [{ role: "user", content: "Hi" }] }));
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("Hi");
  });

  test("user message with ContentBlock[] text-only joined into string", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello " },
              { type: "text", text: "world" },
            ] as any,
          },
        ],
      }),
    );
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("Hello world");
  });

  test("document block throws LLMError with code bad_request", () => {
    try {
      _translateMessages(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: "abc" } },
              ] as any,
            },
          ],
        }),
      );
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("bad_request");
      expect((err as LLMError).message).toContain("document blocks not supported");
    }
  });

});

// =============================================================================
// OpenAIProvider tool call translation (Slice 3)
// =============================================================================

describe("OpenAIProvider tool call translation", () => {
  // ---------------------------------------------------------------------------
  // translateMessages — assistant tool_use
  // ---------------------------------------------------------------------------

  test("history round-trip: assistant with text + tool_use", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "./x" } },
            ] as any,
          },
        ],
      }),
    );
    const asst = msgs.find((m: any) => m.role === "assistant");
    expect(asst).toBeDefined();
    expect(asst.content).toBe("calling");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0]).toEqual({
      id: "tu_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"./x"}' },
    });
  });

  test("history round-trip: assistant with ONLY tool_use (no text) → content null", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu_2", name: "bash", input: { command: "ls" } },
            ] as any,
          },
        ],
      }),
    );
    const asst = msgs.find((m: any) => m.role === "assistant");
    expect(asst).toBeDefined();
    expect(asst.content).toBeNull();
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].function.name).toBe("bash");
  });

  // ---------------------------------------------------------------------------
  // translateMessages — user tool_result
  // ---------------------------------------------------------------------------

  test("history round-trip: user with single tool_result (string content)", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "file contents" },
            ] as any,
          },
        ],
      }),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "file contents" });
  });

  test("history round-trip: user with multiple tool_results in sequence", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "a" },
              { type: "tool_result", tool_use_id: "tu_2", content: "b" },
            ] as any,
          },
        ],
      }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "a" });
    expect(msgs[1]).toEqual({ role: "tool", tool_call_id: "tu_2", content: "b" });
  });

  test("history round-trip: mixed tool_result + user text → tool msg then user msg", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "r" },
              { type: "text", text: "thanks" },
            ] as any,
          },
        ],
      }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "r" });
    expect(msgs[1]).toEqual({ role: "user", content: "thanks" });
  });

  test("history round-trip: tool_result with array of text blocks → joined string", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: [
                  { type: "text", text: "part1 " },
                  { type: "text", text: "part2" },
                ],
              },
            ] as any,
          },
        ],
      }),
    );
    expect(msgs[0].content).toBe("part1 part2");
  });

  test("history: image inside tool_result translates to content-parts array", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_x",
                content: [
                  { type: "text", text: "found" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0" } },
                ],
              },
            ] as any,
          },
        ],
      }),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].tool_call_id).toBe("tu_x");
    expect(Array.isArray(msgs[0].content)).toBe(true);
    expect(msgs[0].content[0]).toEqual({ type: "text", text: "found" });
    expect(msgs[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0" } });
  });

  // ---------------------------------------------------------------------------
  // Tools array translation
  // ---------------------------------------------------------------------------

  test("request.tools translated to OpenAI function format", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const createSpy = spyOn(
      provider["client"].chat.completions,
      "create",
    ).mockResolvedValue(
      fakeStream([
        {
          id: "c1",
          model: "gpt-test",
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ]) as any,
    );

    for await (const _ of provider.stream(
      makeRequest({
        tools: [
          {
            name: "read_file",
            description: "reads a file",
            input_schema: {
              type: "object" as const,
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ] as any,
      }),
    )) { /* drain */ }

    expect(createSpy).toHaveBeenCalled();
    const params = createSpy.mock.calls[0][0] as any;
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0]).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "reads a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming — tool call buffering
  // ---------------------------------------------------------------------------

  test("single tool call across 5 fragments emits one start + one delta + one stop", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    // Simulate a single tool call whose arguments arrive in 5 fragments.
    const chunks = [
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc123", function: { name: "read_file", arguments: '{"pa' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: 'th":' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '"./x' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '.ts"' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: "}" } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "tool_use_start",
      "tool_use_input_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events.find((e) => e.type === "tool_use_start") as any;
    expect(start.id).toBe("call_abc123");
    expect(start.name).toBe("read_file");

    const delta = events.find((e) => e.type === "tool_use_input_delta") as any;
    expect(delta.partial_json).toBe('{"path":"./x.ts"}');

    const msgDelta = events.find((e) => e.type === "message_delta") as any;
    expect(msgDelta.stop_reason).toBe("tool_use");
  });

  test("two parallel tool calls (interleaved chunks) emitted serially: index 0 fully before index 1", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    // Simulate two tool calls interleaved: 0,1,0,1,0,1 then finish
    const chunks = [
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "read_file", arguments: '{"p' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 1, id: "call_1", function: { name: "bash", arguments: '{"c' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: 'ath":"f"}' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 1, id: null, function: { name: null, arguments: 'md":"ls"}' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    // Both tool calls fully sequential: start0/delta0/stop0 then start1/delta1/stop1
    expect(types).toEqual([
      "message_start",
      "tool_use_start",       // index 0
      "tool_use_input_delta", // index 0
      "content_block_stop",   // index 0
      "tool_use_start",       // index 1
      "tool_use_input_delta", // index 1
      "content_block_stop",   // index 1
      "message_delta",
      "message_stop",
    ]);

    const starts = events.filter((e) => e.type === "tool_use_start") as any[];
    expect(starts[0].id).toBe("call_0");
    expect(starts[0].name).toBe("read_file");
    expect(starts[1].id).toBe("call_1");
    expect(starts[1].name).toBe("bash");
  });

  test("empty arguments fragment not emitted as tool_use_input_delta", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    // First chunk has id+name but empty arguments; subsequent carry actual args.
    const chunks = [
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const inputDeltas = events.filter((e) => e.type === "tool_use_input_delta") as any[];
    expect(inputDeltas).toHaveLength(1);
    expect(inputDeltas[0].partial_json).toBe('{"command":"ls"}');
    expect(inputDeltas.every((d: any) => d.partial_json.length > 0)).toBe(true);
  });

  test("tool_call_id round-trips verbatim", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const chunks = [
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc123", function: { name: "bash", arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const start = events.find((e) => e.type === "tool_use_start") as any;
    expect(start.id).toBe("call_abc123");
  });

  test("regression: tool_calls AND finish_reason on the same chunk emit message_delta", async () => {
    // Some servers (and earlier versions of our test mocks) co-locate the
    // final tool_calls fragment with finish_reason="tool_calls" on a single
    // chunk. The original `continue` after buffering tool_calls would have
    // dropped the finish_reason and never emitted message_delta. This test
    // guards that fix.
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const chunks = [
      {
        id: "c1",
        model: "gpt-test",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_x", function: { name: "bash", arguments: '{"command":"ls"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "tool_use_start",
      "tool_use_input_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const msgDelta = events.find((e) => e.type === "message_delta") as any;
    expect(msgDelta.stop_reason).toBe("tool_use");
    expect(msgDelta.usage.output_tokens).toBe(4);
  });

  test("late id arrival on chunk N>0 backfills the buffer entry (defensive)", async () => {
    // Defensive against non-conformant servers that emit id on a later
    // chunk instead of the first. Verify backfill works and id reaches
    // tool_use_start.
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const chunks = [
      // First chunk: no id, has name + partial args.
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: "bash", arguments: '{"cmd' } }] }, finish_reason: null }] },
      // Second chunk: id arrives late, more args.
      { id: "c1", model: "gpt-test", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_late", function: { name: null, arguments: '":"ls"}' } }] }, finish_reason: null }] },
      { id: "c1", model: "gpt-test", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const start = events.find((e) => e.type === "tool_use_start") as any;
    expect(start.id).toBe("call_late");
    expect(start.name).toBe("bash");
  });

  test("empty request.tools array is NOT included in the OpenAI request body", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const createSpy = spyOn(
      provider["client"].chat.completions,
      "create",
    ).mockResolvedValue(
      fakeStream([
        {
          id: "c1",
          model: "gpt-test",
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ]) as any,
    );

    for await (const _ of provider.stream(makeRequest({ tools: [] }))) { /* drain */ }

    const params = createSpy.mock.calls[0][0] as any;
    expect(params.tools).toBeUndefined();
  });
});

// =============================================================================
// OpenAIProvider constructor
// =============================================================================

describe("OpenAIProvider constructor", () => {
  test("empty apiKey throws LLMError auth_error", () => {
    try {
      new OpenAIProvider("");
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("auth_error");
    }
  });

  test("apiKey + baseURL creates instance without throwing", () => {
    const p = new OpenAIProvider("sk-test", { baseURL: "http://localhost:8000/v1" });
    expect(p).toBeDefined();
  });
});

// =============================================================================
// OpenAIProvider.stream() — text-only happy path
// =============================================================================

describe("OpenAIProvider.stream() text-only happy path", () => {
  test("emits correct events and mutates usage in place", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const chunks = [
      { id: "chat-1", model: "gpt-test", choices: [{ delta: { content: "Hi " }, finish_reason: null }] },
      { id: "chat-1", model: "gpt-test", choices: [{ delta: { content: "there" }, finish_reason: null }] },
      { id: "chat-1", model: "gpt-test", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    // message_start
    expect(events[0].type).toBe("message_start");
    expect((events[0] as any).model).toBe("gpt-test");

    // text deltas
    expect(events[1]).toEqual({ type: "text_delta", text: "Hi " });
    expect(events[2]).toEqual({ type: "text_delta", text: "there" });

    // message_delta
    expect(events[3].type).toBe("message_delta");
    expect((events[3] as any).stop_reason).toBe("end_turn");
    expect((events[3] as any).usage.output_tokens).toBe(2);

    // message_stop
    expect(events[4]).toEqual({ type: "message_stop" });

    // in-place usage mutation: message_start.usage.input_tokens patched to 5
    expect((events[0] as any).usage.input_tokens).toBe(5);
  });

  test("real OpenAI split-chunk pattern: stop chunk then usage chunk", async () => {
    // Mirrors what OpenAI actually emits with stream_options.include_usage:
    // a stop chunk with usage:null, followed by a usage-only chunk with
    // choices:[]. message_delta must fire with the *real* output_tokens,
    // not the 0 from the stop chunk.
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });

    const chunks = [
      { id: "chat-2", model: "gpt-test", choices: [{ delta: { content: "Yo" }, finish_reason: null }] },
      { id: "chat-2", model: "gpt-test", choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
      { id: "chat-2", model: "gpt-test", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ];

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream(chunks) as any,
    );

    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }

    const messageDelta = events.find((e) => e.type === "message_delta") as any;
    expect(messageDelta).toBeDefined();
    expect(messageDelta.stop_reason).toBe("end_turn");
    expect(messageDelta.usage.output_tokens).toBe(7); // from the usage chunk
    expect((events[0] as any).usage.input_tokens).toBe(11); // mutated in place
  });

});

// =============================================================================
// _mapEvent (chunk → LLMStreamEvent translator used inside stream())
// =============================================================================

describe("_mapEvent", () => {
  test("text-delta chunk produces text_delta event", () => {
    const chunk = { choices: [{ delta: { content: "hello" }, finish_reason: null }] };
    const ev = _mapEvent(chunk);
    expect(ev).toEqual({ type: "text_delta", text: "hello" });
  });

  test("finish_reason chunk produces message_delta with mapped stop_reason", () => {
    const chunk = {
      choices: [{ delta: {}, finish_reason: "length" }],
      usage: { completion_tokens: 42 },
    };
    const ev = _mapEvent(chunk) as any;
    expect(ev.type).toBe("message_delta");
    expect(ev.stop_reason).toBe("max_tokens");
    expect(ev.usage.output_tokens).toBe(42);
  });

  test("tool_calls finish_reason maps to tool_use", () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    const ev = _mapEvent(chunk) as any;
    expect(ev.stop_reason).toBe("tool_use");
  });

  test("empty delta with no finish_reason returns null", () => {
    const chunk = { choices: [{ delta: {}, finish_reason: null }] };
    expect(_mapEvent(chunk)).toBeNull();
  });

  test("usage-only chunk (choices: []) returns null — caller pairs with prior finish_reason", () => {
    const chunk = { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } };
    expect(_mapEvent(chunk)).toBeNull();
  });

  test("unknown finish_reason falls through to end_turn rather than throwing", () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "content_filter" }] };
    const ev = _mapEvent(chunk) as any;
    expect(ev.type).toBe("message_delta");
    expect(ev.stop_reason).toBe("end_turn");
  });
});

// =============================================================================
// OpenAIProvider.stream() — abort handling
// =============================================================================

describe("OpenAIProvider.stream() abort handling", () => {
  test("pre-aborted signal throws LLMError aborted before any event", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });
    const controller = new AbortController();
    controller.abort();

    const events: LLMStreamEvent[] = [];
    try {
      for await (const e of provider.stream(makeRequest(), controller.signal)) {
        events.push(e);
      }
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("aborted");
    }
    expect(events).toHaveLength(0);
  });

  test("mid-stream abort throws LLMError aborted", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });
    const controller = new AbortController();

    async function* abortingStream(): AsyncGenerator<any> {
      yield { id: "c1", model: "gpt-test", choices: [{ delta: { content: "Hi" }, finish_reason: null }] };
      controller.abort();
      yield { id: "c1", model: "gpt-test", choices: [{ delta: { content: " there" }, finish_reason: null }] };
    }

    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      abortingStream() as any,
    );

    const events: LLMStreamEvent[] = [];
    try {
      for await (const e of provider.stream(makeRequest(), controller.signal)) {
        events.push(e);
      }
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("aborted");
    }
  });
});


// =============================================================================
// OpenAIProvider images, cache_control stripping, finish_reason map
// =============================================================================

describe("OpenAIProvider images and finalize stop_reason map", () => {
  // ---------------------------------------------------------------------------
  // Image translation
  // ---------------------------------------------------------------------------

  test("base64 image in user message produces content-parts array", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0" } },
            ] as any,
          },
        ],
      }),
    );
    const userMsg = msgs.find((m: any) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "describe" });
    expect(userMsg.content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0" } });
  });

  test("URL-source image translates to image_url with the URL passed through", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
            ] as any,
          },
        ],
      }),
    );
    const userMsg = msgs.find((m: any) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: "image_url", image_url: { url: "https://example.com/cat.jpg" } });
  });

  test("pure-text user message stays as flat string (no array wrapping)", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    const userMsg = msgs.find((m: any) => m.role === "user");
    expect(typeof userMsg.content).toBe("string");
    expect(userMsg.content).toBe("hello");
  });

  test("pure-text ContentBlock[] user message stays as flat string", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ] as any,
          },
        ],
      }),
    );
    const userMsg = msgs.find((m: any) => m.role === "user");
    expect(typeof userMsg.content).toBe("string");
    expect(userMsg.content).toBe("hello world");
  });

  test("image-only tool_result (no text) produces content-parts array", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_img",
                content: [
                  { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/abc" } },
                ],
              },
            ] as any,
          },
        ],
      }),
    );
    expect(msgs[0].role).toBe("tool");
    expect(Array.isArray(msgs[0].content)).toBe(true);
    expect(msgs[0].content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/abc" } });
  });

  test("document block in user message throws bad_request", () => {
    try {
      _translateMessages(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: "abc" } },
              ] as any,
            },
          ],
        }),
      );
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("bad_request");
      expect((err as LLMError).message).toContain("document blocks not supported");
    }
  });

  // ---------------------------------------------------------------------------
  // cache_control stripping
  // ---------------------------------------------------------------------------

  test("system block with cache_control: no cache_control in translated result", () => {
    const msgs = _translateMessages(
      makeRequest({
        system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] as any,
      }),
    );
    expect(JSON.stringify(msgs)).not.toContain("cache_control");
    const systemMsg = msgs.find((m: any) => m.role === "system");
    expect(systemMsg?.content).toBe("x");
  });

  test("user message text block with cache_control: stripped from wire payload", () => {
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] as any,
          },
        ],
      }),
    );
    expect(JSON.stringify(msgs)).not.toContain("cache_control");
  });

  test("tool definition with cache_control: stripped from wire tools", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });
    const createSpy = spyOn(
      provider["client"].chat.completions,
      "create",
    ).mockResolvedValue(
      fakeStream([
        { id: "c1", model: "gpt-test", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]) as any,
    );
    for await (const _ of provider.stream(
      makeRequest({
        tools: [
          {
            name: "x",
            description: "y",
            input_schema: { type: "object", properties: {}, required: [] },
            cache_control: { type: "ephemeral" },
          },
        ] as any,
      }),
    )) { /* drain */ }
    expect(createSpy).toHaveBeenCalled();
    const params = createSpy.mock.calls[0][0] as any;
    expect(JSON.stringify(params.tools)).not.toContain("cache_control");
  });

  test("cache_control nested deep inside tool input_schema is stripped", async () => {
    // Anthropic sometimes attaches cache_control to individual property
    // schemas. The plain object-spread in the tools translation drops only
    // top-level cache_control — the deep walk via stripCacheControl is what
    // covers nested cases. This test exercises that path specifically.
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });
    const createSpy = spyOn(
      provider["client"].chat.completions,
      "create",
    ).mockResolvedValue(
      fakeStream([
        { id: "c1", model: "gpt-test", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]) as any,
    );
    for await (const _ of provider.stream(
      makeRequest({
        tools: [
          {
            name: "deep_tool",
            description: "exercises nested strip",
            input_schema: {
              type: "object",
              properties: {
                foo: { type: "string", cache_control: { type: "ephemeral" } },
                bar: {
                  type: "object",
                  properties: {
                    baz: { type: "number" },
                  },
                  cache_control: { type: "ephemeral" },
                },
              },
              required: ["foo"],
            },
          },
        ] as any,
      }),
    )) { /* drain */ }
    const params = createSpy.mock.calls[0][0] as any;
    expect(JSON.stringify(params.tools)).not.toContain("cache_control");
    // Sanity: the rest of the schema should still be present.
    expect(params.tools[0].function.parameters.properties.foo.type).toBe("string");
    expect(params.tools[0].function.parameters.properties.bar.properties.baz.type).toBe("number");
  });

  test("cache_control on tool_result content blocks is stripped", () => {
    // Cover the stripCacheControl call inside translateToolResultContent.
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_x",
                content: [
                  { type: "text", text: "found", cache_control: { type: "ephemeral" } },
                ],
              },
            ] as any,
          },
        ],
      }),
    );
    expect(JSON.stringify(msgs)).not.toContain("cache_control");
  });

  test("thinking block embedded in user content is silently dropped", () => {
    // Thinking is model-internal; OpenAI has no equivalent. The translation
    // must drop it without throwing and preserve the surrounding text.
    const msgs = _translateMessages(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "before " },
              { type: "thinking", thinking: "(internal pondering)" },
              { type: "text", text: "after" },
            ] as any,
          },
        ],
      }),
    );
    const userMsg = msgs.find((m) => m.role === "user");
    // String content (no images), text concatenated, thinking dropped.
    expect(userMsg?.content).toBe("before after");
  });

  // ---------------------------------------------------------------------------
  // thinking and output_config drop
  // ---------------------------------------------------------------------------

  test("thinking and output_config fields are not present in wire params", async () => {
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });
    const createSpy = spyOn(
      provider["client"].chat.completions,
      "create",
    ).mockResolvedValue(
      fakeStream([
        { id: "c1", model: "gpt-test", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]) as any,
    );
    for await (const _ of provider.stream(
      makeRequest({
        thinking: { type: "enabled", budget_tokens: 8000 } as any,
        output_config: { effort: "high" } as any,
      }),
    )) { /* drain */ }
    expect(createSpy).toHaveBeenCalled();
    const params = createSpy.mock.calls[0][0] as any;
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // mapFinishReason matrix
  // ---------------------------------------------------------------------------

  test('mapFinishReason: "stop" → "end_turn"', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "stop" }] };
    expect((_mapEvent(chunk) as any)?.stop_reason).toBe("end_turn");
  });

  test('mapFinishReason: "tool_calls" → "tool_use"', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    expect((_mapEvent(chunk) as any)?.stop_reason).toBe("tool_use");
  });

  test('mapFinishReason: "length" → "max_tokens"', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "length" }] };
    expect((_mapEvent(chunk) as any)?.stop_reason).toBe("max_tokens");
  });

  test('mapFinishReason: "content_filter" → "end_turn"', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "content_filter" }] };
    expect((_mapEvent(chunk) as any)?.stop_reason).toBe("end_turn");
  });

  test('mapFinishReason: "function_call" → "tool_use" (legacy OpenAI v0)', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "function_call" }] };
    expect((_mapEvent(chunk) as any)?.stop_reason).toBe("tool_use");
  });

  test('mapFinishReason: null/undefined → "end_turn" (via end-of-stream fallback)', async () => {
    // mapChunk's `if (finishReason)` guard means _mapEvent never directly
    // calls mapFinishReason(null). The null/undefined path is exercised by
    // the stream() end-of-stream fallback at `if (!messageDeltaEmitted)`,
    // which calls emitMessageDelta(pendingFinishReason ?? null, ...). Drive
    // it: stream a chunk with content but no finish_reason and no usage —
    // the generator finishes without ever emitting message_delta inside
    // the loop, so the fallback fires with finishReason=null.
    const provider = new OpenAIProvider("sk-test", {
      baseURL: "http://localhost:8000/v1",
    });
    spyOn(provider["client"].chat.completions, "create").mockResolvedValue(
      fakeStream([
        { id: "c1", model: "gpt-test", choices: [{ delta: { content: "abrupt end" }, finish_reason: null }] },
      ]) as any,
    );
    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream(makeRequest())) {
      events.push(e);
    }
    const md = events.find((e) => e.type === "message_delta") as any;
    expect(md).toBeDefined();
    expect(md.stop_reason).toBe("end_turn");
  });

  test('mapFinishReason: unknown string "weirdo" → "end_turn" (catch-all)', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: "weirdo" }] };
    expect((_mapEvent(chunk) as any)?.stop_reason).toBe("end_turn");
  });
});

// =============================================================================
// Provider type shape
// =============================================================================

describe("Provider type shape", () => {
  test("OpenAIProvider satisfies LLMProvider interface", () => {
    // Compile-time structural check — if the interface is unmet, TS errors here.
    const _: LLMProvider = new OpenAIProvider("k", { baseURL: "u" });
    expect(_).toBeDefined();
  });
});

// =============================================================================
// OpenAIProvider.countTokens()
// =============================================================================

describe("OpenAIProvider.countTokens()", () => {
  function makeProvider() {
    return new OpenAIProvider("sk-test", { baseURL: "http://localhost:8000/v1" });
  }

  test("pre-aborted signal throws LLMError aborted", async () => {
    const provider = makeProvider();
    const controller = new AbortController();
    controller.abort();
    try {
      await provider.countTokens({ model: "gpt-4o", messages: [] }, controller.signal);
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("aborted");
    }
  });

  test("empty messages with no system returns 0", async () => {
    const provider = makeProvider();
    const result = await provider.countTokens({ model: "gpt-4o", messages: [] });
    expect(result.input_tokens).toBe(0);
  });

  test("system + user message returns positive integer", async () => {
    const provider = makeProvider();
    const result = await provider.countTokens({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello world" }],
      system: "You are helpful",
    });
    // "You are helpful" (15) + "\nuser: " (7) + "Hello world" (11) = 33 chars → ceil(33/4) = 9
    expect(result.input_tokens).toBeGreaterThan(0);
    expect(result.input_tokens).toBe(Math.ceil((15 + 7 + 11) / 4));
  });

  test("image block adds flat 1024 tokens regardless of data size", async () => {
    const provider = makeProvider();
    const result = await provider.countTokens({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(1000) } },
          ] as any,
        },
      ],
    });
    // "\nuser: " = 7 chars → 0 text chars from image data + 1024 image flat
    const textChars = 7; // "\nuser: "
    expect(result.input_tokens).toBe(Math.ceil(textChars / 4) + 1024);
    expect(result.input_tokens).toBeGreaterThanOrEqual(1024);
  });

  test("LLMSystemBlock[] system text is counted", async () => {
    const provider = makeProvider();
    const system = [
      { type: "text" as const, text: "Line 1" },
      { type: "text" as const, text: "Line 2" },
    ];
    const result = await provider.countTokens({ model: "gpt-4o", messages: [], system });
    // "Line 1" (6) + "Line 2" (6) = 12 chars → ceil(12/4) = 3
    expect(result.input_tokens).toBe(3);
  });

  test("tool definitions are counted toward input", async () => {
    const provider = makeProvider();
    const tools = [
      {
        name: "read_file",
        description: "reads a file",
        input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];
    const withTools = await provider.countTokens({ model: "gpt-4o", messages: [], tools });
    const withoutTools = await provider.countTokens({ model: "gpt-4o", messages: [] });
    expect(withTools.input_tokens).toBeGreaterThan(withoutTools.input_tokens);
  });
});
