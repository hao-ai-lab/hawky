// =============================================================================
// Tests for web_search tool
//
// Unit tests mock fetch() and config. E2E tests at the end hit the real
// Brave Search API (require BRAVE_API_KEY to be set).
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import { executeWebSearch, webSearchToolDefinition } from "../src/tools/web_search.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import { resetConfig, loadConfig } from "../src/storage/config.js";
import type { ToolContext, ToolResult } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const origBraveKey = process.env.BRAVE_API_KEY;

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "s",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

async function doSearch(
  input: { query: string; count?: number },
  overrides?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeWebSearch(input, ctx(overrides));
}

function mockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as typeof fetch;
}

function braveResponse(results: Array<{ title: string; url: string; description: string }>): Response {
  return new Response(
    JSON.stringify({ web: { results } }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function installBraveMock(resultCount = 5): void {
  mockFetch(async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("q") || "";
    const count = parseInt(url.searchParams.get("count") || "5", 10);
    const n = Math.min(count, resultCount);

    const results = Array.from({ length: n }, (_, i) => ({
      title: `Result ${i + 1} for ${query}`,
      url: `https://example.com/result-${i + 1}`,
      description: `Description of result ${i + 1} about ${query}.`,
    }));

    return braveResponse(results);
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetToolRegistry();
  resetConfig();
  // Restore env var to original value (don't just delete — other test files and E2E tests need it)
  if (origBraveKey !== undefined) {
    process.env.BRAVE_API_KEY = origBraveKey;
  } else {
    delete process.env.BRAVE_API_KEY;
  }
});

// =============================================================================
// Validation
// =============================================================================

describe("Input validation", () => {
  test("empty query returns error", async () => {
    const r = await doSearch({ query: "" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: query");
  });

  test("whitespace-only query returns error", async () => {
    const r = await doSearch({ query: "   " });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: query");
  });

  test("missing API key falls back to keyless search (no error)", async () => {
    // With no Brave key, web_search now uses the keyless backend (DuckDuckGo +
    // Wikipedia) instead of erroring. Mock those endpoints and assert real
    // results come back, tagged backend:"keyless".
    const config = loadConfig();
    const savedBraveKey = config.api_keys.brave_search;
    config.api_keys.brave_search = "";

    mockFetch(async (input) => {
      const u = String(input);
      if (u.includes("api.duckduckgo.com")) {
        return new Response(
          JSON.stringify({ Heading: "Test", AbstractText: "An abstract about test.", AbstractURL: "https://en.wikipedia.org/wiki/Test", AbstractSource: "Wikipedia" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("en.wikipedia.org/w/api.php")) {
        return new Response(
          JSON.stringify({ query: { search: [{ title: "Test article", snippet: "a <span>test</span> snippet" }] } }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });

    try {
      const r = await doSearch({ query: "test" });
      expect(r.type).toBe("text");
      expect((r as { metadata?: { backend?: string } }).metadata?.backend).toBe("keyless");
      expect(r.content).toContain("Results for: test");
      expect(r.content).toContain("https://en.wikipedia.org/wiki/Test"); // DDG abstract URL
      expect(r.content).toContain("Wikipedia: Test article");            // wiki result
      expect(r.content).not.toContain("<span>");                          // HTML stripped
    } finally {
      config.api_keys.brave_search = savedBraveKey;
    }
  });
});

// =============================================================================
// Successful searches
// =============================================================================

describe("Successful searches", () => {
  test("returns formatted results with title, url, description", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    installBraveMock();

    const r = await doSearch({ query: "typescript tutorials" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Results for: typescript tutorials");
    expect(r.content).toContain("Result 1 for typescript tutorials");
    expect(r.content).toContain("https://example.com/result-1");
    expect(r.content).toContain("Description of result 1");
  });

  test("default count is 5", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();

    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return braveResponse([
        { title: "R1", url: "https://a.com", description: "D1" },
      ]);
    });

    await doSearch({ query: "test" });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("count")).toBe("5");
  });

  test("custom count is passed to API", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();

    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return braveResponse([]);
    });

    await doSearch({ query: "test", count: 8 });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("count")).toBe("8");
  });

  test("count clamped to max 10", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();

    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return braveResponse([]);
    });

    await doSearch({ query: "test", count: 50 });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("count")).toBe("10");
  });

  test("count clamped to min 1", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();

    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return braveResponse([]);
    });

    await doSearch({ query: "test", count: -5 });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("count")).toBe("1");
  });

  test("no results returns message", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => braveResponse([]));

    const r = await doSearch({ query: "xyznonexistent123" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No results for: xyznonexistent123");
    expect((r as any).metadata?.count).toBe(0);
  });

  test("results include metadata", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    installBraveMock(3);

    const r = await doSearch({ query: "test", count: 3 });
    expect(r.type).toBe("text");
    const m = (r as any).metadata;
    expect(m).toBeDefined();
    expect(m.query).toBe("test");
    expect(m.count).toBe(3);
  });

  test("query is trimmed before use", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();

    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = String(input);
      return braveResponse([{ title: "R", url: "https://a.com", description: "D" }]);
    });

    await doSearch({ query: "  hello world  " });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("q")).toBe("hello world");
  });

  test("API key sent as X-Subscription-Token header", async () => {
    process.env.BRAVE_API_KEY = "my-secret-key";
    resetConfig();

    let capturedHeaders: Record<string, string> = {};
    mockFetch(async (_input, init) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = { ...h };
      return braveResponse([]);
    });

    await doSearch({ query: "test" });
    expect(capturedHeaders["X-Subscription-Token"]).toBe("my-secret-key");
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("Error handling", () => {
  test("HTTP 401 returns error with status", async () => {
    process.env.BRAVE_API_KEY = "bad-key";
    resetConfig();
    mockFetch(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("401");
  });

  test("HTTP 429 returns error with status", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => new Response("Rate limited", { status: 429, statusText: "Too Many Requests" }));

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("429");
  });

  test("HTTP 500 returns error", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => new Response("Server Error", { status: 500, statusText: "Internal Server Error" }));

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("500");
  });

  test("network error is surfaced", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => { throw new Error("dns lookup failed"); });

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Search error"); // "Search error (brave): ..."
    expect(r.content).toContain("dns lookup failed");
  });

  test("invalid JSON response returns error", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => new Response("not json", { headers: { "Content-Type": "application/json" } }));

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Failed to parse");
  });

  test("malformed response (missing web.results) returns no results", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => new Response(JSON.stringify({ query: "test" }), {
      headers: { "Content-Type": "application/json" },
    }));

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("No results for");
  });

  test("results with missing fields are handled gracefully", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () =>
      new Response(JSON.stringify({
        web: { results: [{ title: "Only Title" }, { url: "https://only-url.com" }, {}] },
      }), { headers: { "Content-Type": "application/json" } }),
    );

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Only Title");
    expect(r.content).toContain("https://only-url.com");
    expect(r.content).toContain("(no title)");
  });
});

// =============================================================================
// Abort handling
// =============================================================================

describe("Abort handling", () => {
  test("pre-aborted signal returns error", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();

    const controller = new AbortController();
    controller.abort();
    const r = await doSearch({ query: "test" }, { abort_signal: controller.signal });
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/aborted|cancelled/i);
  });

  test("fetch abort is reported as timeout", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    mockFetch(async () => { throw new DOMException("The operation was aborted.", "AbortError"); });

    const r = await doSearch({ query: "test" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("timed out");
  });

  test("top-level catch handles unexpected errors", async () => {
    const bad: any = {
      session_id: "t",
      working_directory: "/tmp",
      emit: () => {},
      get abort_signal(): AbortSignal {
        throw new Error("boom");
      },
    };
    const r = await executeWebSearch({ query: "test" }, bad);
    expect(r.type).toBe("error");
    expect(r.content).toContain("boom");
  });
});

// =============================================================================
// Tool definition and registry
// =============================================================================

describe("Tool definition and registry", () => {
  test("tool definition has correct shape", () => {
    expect(webSearchToolDefinition.name).toBe("web_search");
    expect(webSearchToolDefinition.permission).toBe("auto_approve");
    expect(webSearchToolDefinition.input_schema.required).toEqual(["query"]);
    expect(webSearchToolDefinition.input_schema.properties.query).toBeDefined();
    expect(webSearchToolDefinition.input_schema.properties.count).toBeDefined();
  });

  test("registry integration executes tool successfully", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    resetConfig();
    installBraveMock(2);

    const reg = getToolRegistry();
    reg.register(webSearchToolDefinition);

    const r = await reg.execute("web_search", { query: "hello" }, ctx());
    expect(r.type).toBe("text");
    expect(r.content).toContain("Result 1 for hello");
  });
});

// E2E tests moved to tests/e2e-api.ts — run with: bun run test:e2e
