// =============================================================================
// Tests for API key validators (src/storage/config-validators.ts)
//
// Most tests run offline or with fast-failing invalid keys (401 responses).
// Valid-key E2E tests are gated behind the corresponding env var.
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import {
  validateAnthropicKey,
  validateBraveKey,
  validateOpenAIKey,
  validateOpenAICompatibleEndpoint,
} from "../src/storage/config-validators.js";

const realFetch = globalThis.fetch;

function mockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as typeof fetch;
}

// =============================================================================
// Anthropic key validation
// =============================================================================

describe("validateAnthropicKey", () => {
  test("rejects empty string", async () => {
    const result = await validateAnthropicKey("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects whitespace-only string", async () => {
    const result = await validateAnthropicKey("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects invalid key", async () => {
    const result = await validateAnthropicKey("sk-ant-api03-invalid-key-12345");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 15_000 });

  test("rejects key with unreachable base URL", async () => {
    const result = await validateAnthropicKey(
      "sk-ant-api03-test",
      "http://localhost:1",
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 15_000 });

  // E2E: requires ANTHROPIC_API_KEY env var with a valid key
  const realAnthropicKey = process.env.ANTHROPIC_API_KEY;
  (realAnthropicKey ? test : test.skip)(
    "accepts valid key",
    async () => {
      const result = await validateAnthropicKey(realAnthropicKey!);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
    { timeout: 15_000 },
  );
});

// =============================================================================
// Brave Search key validation
// =============================================================================

describe("validateBraveKey", () => {
  test("rejects empty string", async () => {
    const result = await validateBraveKey("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects whitespace-only string", async () => {
    const result = await validateBraveKey("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects invalid key", async () => {
    const result = await validateBraveKey("invalid-brave-key-12345");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 15_000 });

  // E2E: requires BRAVE_API_KEY env var with a valid key
  const realBraveKey = process.env.BRAVE_API_KEY;
  (realBraveKey ? test : test.skip)(
    "accepts valid key",
    async () => {
      const result = await validateBraveKey(realBraveKey!);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
    { timeout: 15_000 },
  );
});

// =============================================================================
// OpenAI key validation
// =============================================================================

describe("validateOpenAIKey", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("rejects empty string", async () => {
    const result = await validateOpenAIKey("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects whitespace-only string", async () => {
    const result = await validateOpenAIKey("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("returns valid on 200 from GET /v1/models", async () => {
    mockFetch(async (input) => {
      expect(String(input)).toContain("/v1/models");
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
    });
    const result = await validateOpenAIKey("sk-test-key");
    expect(result.valid).toBe(true);
  });

  test("returns invalid on 401 from GET /v1/models", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
    );
    const result = await validateOpenAIKey("sk-bad-key");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid API key");
  });

  test("returns invalid with error on non-200/401", async () => {
    mockFetch(async () => new Response("Not found", { status: 404 }));
    const result = await validateOpenAIKey("sk-test-key");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("404");
  });

  test("returns invalid on network error", async () => {
    mockFetch(async () => { throw new Error("network error"); });
    const result = await validateOpenAIKey("sk-test-key");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects invalid key against real API", async () => {
    const result = await validateOpenAIKey("sk-invalid-openai-key-12345");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 15_000 });

  // E2E: requires OPENAI_API_KEY env var with a valid key
  const realOpenAIKey = process.env.OPENAI_API_KEY;
  (realOpenAIKey ? test : test.skip)(
    "accepts valid key",
    async () => {
      const result = await validateOpenAIKey(realOpenAIKey!);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
    { timeout: 15_000 },
  );
});

// =============================================================================
// OpenAI-compatible endpoint reachability
// =============================================================================

describe("validateOpenAICompatibleEndpoint", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns valid with modelCount and latencyMs on 200 with data array", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-5.4-mini" }, { id: "gpt-5.4" }] }), { status: 200 }),
    );
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.modelCount).toBe(2);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.error).toBeUndefined();
  });

  test("returns valid with soft warning on 200 but missing data array", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    );
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.modelCount).toBe(0);
    expect(result.error).toContain("no data array");
  });

  test("returns valid with soft warning on 404 (raw llama.cpp)", async () => {
    mockFetch(async () => new Response("Not found", { status: 404 }));
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(result.valid).toBe(true);
    expect(result.status).toBe(404);
    expect(result.error).toContain("llama.cpp");
  });

  test("returns invalid on 401", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1", "bad-key");
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("auth rejected");
  });

  test("returns invalid on other non-2xx status", async () => {
    mockFetch(async () => new Response("Server Error", { status: 500 }));
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(result.valid).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain("500");
  });

  test("returns invalid with timeout error on AbortError", async () => {
    mockFetch(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("timeout");
  });

  test("returns invalid on network error", async () => {
    mockFetch(async () => { throw new Error("ECONNREFUSED"); });
    const result = await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("sends Authorization header when apiKey provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetch(async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
      );
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await validateOpenAICompatibleEndpoint("http://localhost:8000/v1", "my-api-key");
    expect(capturedHeaders["Authorization"]).toBe("Bearer my-api-key");
  });

  test("does not send Authorization header when apiKey omitted", async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetch(async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
      );
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  test("builds /v1/models URL from baseURL ending in /v1", async () => {
    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await validateOpenAICompatibleEndpoint("http://localhost:8000/v1");
    expect(capturedUrl).toBe("http://localhost:8000/v1/models");
  });

  test("builds /v1/models URL from baseURL without /v1 suffix", async () => {
    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await validateOpenAICompatibleEndpoint("http://localhost:8000");
    expect(capturedUrl).toBe("http://localhost:8000/v1/models");
  });
});

// =============================================================================
// Cross-cutting behavior
// =============================================================================

describe("Validator return shape", () => {
  test("all validators return { valid, error? } — never throw", async () => {
    const results = await Promise.all([
      validateAnthropicKey("bad"),
      validateBraveKey("bad"),
      validateOpenAIKey("bad"),
    ]);

    for (const result of results) {
      expect(typeof result.valid).toBe("boolean");
      if (!result.valid) {
        expect(typeof result.error).toBe("string");
      }
    }
  }, { timeout: 30_000 });
});

