// =============================================================================
// Tests for web_fetch tool
//
// This suite avoids binding a local HTTP server because CI environments
// may disallow listening sockets. Instead it mocks fetch() for deterministic
// unit/integration coverage. Real-network E2E checks live in a separate file.
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import { executeWebFetch, webFetchToolDefinition } from "../src/tools/web_fetch.js";
import { getToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import type { ToolContext, ToolResult } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const realFetch = globalThis.fetch;

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    session_id: "s",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

async function doFetch(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): Promise<ToolResult> {
  return executeWebFetch(input as any, ctx(overrides));
}

function mockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as typeof fetch;
}

function spyAbortSignal(signal: AbortSignal): {
  added: EventListenerOrEventListenerObject[];
  removed: EventListenerOrEventListenerObject[];
} {
  const added: EventListenerOrEventListenerObject[] = [];
  const removed: EventListenerOrEventListenerObject[] = [];
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);

  (signal as any).addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort") added.push(listener);
    return originalAdd(type, listener, options);
  };

  (signal as any).removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") removed.push(listener);
    return originalRemove(type, listener, options);
  };

  return { added, removed };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetToolRegistry();
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const htmlPage = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
<nav>Navigation stuff</nav>
<article>
<h1>Main Heading</h1>
<p>This is the <strong>main content</strong> of the page.</p>
<p>It has <a href="https://example.com">a link</a> and some text.</p>
<ul>
<li>Item one</li>
<li>Item two</li>
</ul>
</article>
<footer>Footer stuff</footer>
</body>
</html>`;

const complexPage = `<!DOCTYPE html>
<html>
<head><title>Complex Page</title></head>
<body>
<header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
<main>
<article>
<h1>Article Title</h1>
<p>First paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
<pre><code>function hello() {
  console.log("world");
}</code></pre>
<p>After code block.</p>
<h2>Section Two</h2>
<p>A list:</p>
<ul>
<li>First item</li>
<li>Second item with <a href="https://example.com">link</a></li>
</ul>
<hr>
<p>Final paragraph.</p>
</article>
</main>
<aside>Sidebar content</aside>
<footer>Copyright 2024</footer>
</body>
</html>`;

function response(
  body: string,
  init?: ResponseInit & { url?: string },
): Response {
  const res = new Response(body, init);
  if (init?.url) {
    Object.defineProperty(res, "url", { value: init.url, configurable: true });
  }
  return res;
}

function installRouteFetch(): void {
  mockFetch(async (input) => {
    const requestUrl = String(input);
    const url = new URL(requestUrl);
    const path = url.pathname;

    if (path === "/html") {
      return response(htmlPage, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        url: requestUrl,
      });
    }

    if (path === "/json") {
      return response(JSON.stringify({ name: "test", version: "1.0", items: [1, 2, 3] }), {
        headers: { "Content-Type": "application/json" },
        url: requestUrl,
      });
    }

    if (path === "/plain") {
      return response("This is plain text content.\nLine two.\nLine three.\n", {
        headers: { "Content-Type": "text/plain" },
        url: requestUrl,
      });
    }

    if (path === "/large") {
      // Must exceed web_fetch's DEFAULT_MAX_CHARS (100_000) so the default-limit
      // truncation test actually trips; equal-to-the-cap content is not truncated.
      return response(`<html><body><article>${"x".repeat(150_000)}</article></body></html>`, {
        headers: { "Content-Type": "text/html" },
        url: requestUrl,
      });
    }

    if (path === "/scripts") {
      return response(`<html><body>
<script>alert("evil");</script>
<style>.hidden { display: none; }</style>
<article><p>Clean content here.</p></article>
<noscript>You need JS!</noscript>
</body></html>`, {
        headers: { "Content-Type": "text/html" },
        url: requestUrl,
      });
    }

    if (path === "/entities") {
      return response(`<html><body><article>
<p>Entities: &amp; &lt; &gt; &quot; &#39; &mdash; &ndash; &hellip; &nbsp;</p>
</article></body></html>`, {
        headers: { "Content-Type": "text/html" },
        url: requestUrl,
      });
    }

    if (path === "/markdown-headings") {
      return response(`<html><body><article>
<h1>Title</h1>
<h2>Section A</h2>
<p>Content A</p>
<h3>Subsection</h3>
<p>Content B with <em>emphasis</em> and <code>code</code>.</p>
</article></body></html>`, {
        headers: { "Content-Type": "text/html" },
        url: requestUrl,
      });
    }

    if (path === "/complex") {
      return response(complexPage, {
        headers: { "Content-Type": "text/html" },
        url: requestUrl,
      });
    }

    if (path === "/notfound") {
      return response("Not Found", { status: 404, statusText: "Not Found", url: requestUrl });
    }

    if (path === "/servererror") {
      return response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
        url: requestUrl,
      });
    }

    if (path === "/redirect") {
      return response(htmlPage, {
        headers: { "Content-Type": "text/html" },
        url: "https://example.test/html",
      });
    }

    return response("Not Found", { status: 404, statusText: "Not Found", url: requestUrl });
  });
}

// =============================================================================
// HTML extraction with Readability
// =============================================================================

describe("HTML extraction", () => {
  test("extracts article content from HTML page", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/html" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Main Heading");
    expect(r.content).toContain("main content");
    expect(r.content).toContain("Extractor:");
  });

  test("strips script, style, and noscript tags", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/scripts" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Clean content");
    expect(r.content).not.toContain("alert");
    expect(r.content).not.toContain("display: none");
    expect(r.content).not.toContain("You need JS");
  });

  test("decodes HTML entities", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/entities" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("&");
    expect(r.content).toContain("<");
    expect(r.content).toContain(">");
    expect(r.content).toContain("—");
    expect(r.content).toContain("…");
  });
});

// =============================================================================
// Output modes
// =============================================================================

describe("Output modes", () => {
  test("default extract_mode is markdown with heading markers", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/markdown-headings" });
    expect(r.type).toBe("text");
    expect(r.content).toMatch(/#+\s+/);
  });

  test("extract_mode=text strips markdown syntax", async () => {
    installRouteFetch();
    const r = await doFetch({
      url: "https://example.test/markdown-headings",
      extract_mode: "text",
    });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Title");
    expect(r.content).not.toMatch(/^#\s/m);
  });

  test("complex page produces structured markdown", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/complex" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Article Title");
    expect(r.content).toContain("bold");
    expect(r.content).toContain("Final paragraph");
  });
});

// =============================================================================
// Content types
// =============================================================================

describe("Content type handling", () => {
  test("JSON response is pretty-printed", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/json" });
    expect(r.type).toBe("text");
    expect(r.content).toContain('"name": "test"');
    expect(r.content).toContain('"version": "1.0"');
    expect(r.content).toContain("Extractor: json");
  });

  test("invalid JSON falls back to raw text", async () => {
    mockFetch(async () =>
      response("{not-valid-json", {
        headers: { "Content-Type": "application/json" },
        url: "https://example.test/bad-json",
      }),
    );

    const r = await doFetch({ url: "https://example.test/bad-json" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("{not-valid-json");
    expect(r.content).toContain("Extractor: raw");
  });

  test("plain text returned as-is", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/plain" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("This is plain text content.");
    expect(r.content).toContain("Line two.");
    expect(r.content).toContain("Extractor: raw");
  });

  test("html detection works even when content-type is missing", async () => {
    mockFetch(async () =>
      response(htmlPage, {
        headers: {},
        url: "https://example.test/no-header",
      }),
    );

    const r = await doFetch({ url: "https://example.test/no-header" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Main Heading");
  });
});

// =============================================================================
// Truncation and limits
// =============================================================================

describe("Truncation and limits", () => {
  test("large content truncated at default max_chars", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/large" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("[Content truncated at");
    expect((r as any).metadata?.truncated).toBe(true);
  });

  test("custom max_chars respected", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/html", max_chars: 120 });
    expect(r.type).toBe("text");
    expect(r.content).toContain("[Content truncated at 120 characters]");
    expect((r as any).metadata?.truncated).toBe(true);
  });

  test("max_chars lower than minimum clamps to 100", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/large", max_chars: 1 });
    expect(r.type).toBe("text");
    expect(r.content).toContain("[Content truncated at 100 characters]");
  });

  test("oversized response body is capped before extraction", async () => {
    mockFetch(async () => {
      const body = "a".repeat(2_100_000);
      return response(body, {
        headers: { "Content-Type": "text/plain" },
        url: "https://example.test/huge",
      });
    });

    const r = await doFetch({ url: "https://example.test/huge", max_chars: 2_000_000 });
    expect(r.type).toBe("text");
    const m = (r as any).metadata;
    expect(m.length).toBeLessThanOrEqual(2_000_000);
  });
});

// =============================================================================
// Errors, redirects, and validation
// =============================================================================

describe("Errors and validation", () => {
  test("404 returns error", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/notfound" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("404");
  });

  test("500 returns error", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/servererror" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("500");
  });

  test("missing url returns error", async () => {
    const r = await doFetch({ url: "" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: url");
  });

  test("non-string url returns a validation error", async () => {
    const r = await doFetch({ url: 42 });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Missing required parameter: url");
  });

  test("invalid url returns error", async () => {
    const r = await doFetch({ url: "not a url at all !!!" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Invalid URL");
  });

  test("invalid protocol returns error", async () => {
    const r = await doFetch({ url: "file:///tmp/secret.txt" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Invalid URL protocol");
  });

  test("invalid extract_mode returns a validation error before fetch", async () => {
    mockFetch(async () => {
      throw new Error("fetch should not be called");
    });

    const r = await doFetch({ url: "https://example.test/html", extract_mode: "html" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("extract_mode");
  });

  test("invalid max_chars returns a validation error before fetch", async () => {
    mockFetch(async () => {
      throw new Error("fetch should not be called");
    });

    for (const max_chars of [Number.NaN, Number.POSITIVE_INFINITY, "120", 120.5]) {
      const r = await doFetch({ url: "https://example.test/html", max_chars });
      expect(r.type).toBe("error");
      expect(r.content).toContain("max_chars");
    }
  });

  test("network errors are surfaced", async () => {
    mockFetch(async () => {
      throw new Error("dns lookup failed");
    });

    const r = await doFetch({ url: "https://example.test/network-error" });
    expect(r.type).toBe("error");
    expect(r.content).toContain("Network error");
  });

  test("redirect metadata preserves final_url", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/redirect" });
    expect(r.type).toBe("text");
    expect(r.content).toContain("Main Heading");
    expect((r as any).metadata?.final_url).toBe("https://example.test/html");
  });

  test("http url is upgraded to https before fetch", async () => {
    let seenUrl = "";
    mockFetch(async (input) => {
      seenUrl = String(input);
      return response("ok", {
        headers: { "Content-Type": "text/plain" },
        url: seenUrl,
      });
    });

    const r = await doFetch({ url: "http://example.test/plain" });
    expect(r.type).toBe("text");
    expect(seenUrl).toBe("https://example.test/plain");
  });
});

// =============================================================================
// Abort and top-level error handling
// =============================================================================

describe("Abort and error handling", () => {
  test("pre-aborted signal returns cancelled without fetching", async () => {
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return response("should not fetch");
    });

    const controller = new AbortController();
    controller.abort();
    const r = await doFetch(
      { url: "https://example.test/html" },
      { abort_signal: controller.signal },
    );
    expect(r.type).toBe("error");
    expect(r.content).toContain("cancelled");
    expect(fetchCalled).toBe(false);
  });

  test("in-flight context abort returns cancelled and removes listener", async () => {
    const controller = new AbortController();
    const signalSpy = spyAbortSignal(controller.signal);
    mockFetch(async (_input, init) => {
      controller.abort();
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      throw new Error("expected abort");
    });

    const r = await doFetch(
      { url: "https://example.test/abort" },
      { abort_signal: controller.signal },
    );
    expect(r.type).toBe("error");
    expect(r.content).toContain("cancelled");
    expect(signalSpy.added.length).toBe(1);
    expect(signalSpy.removed).toContain(signalSpy.added[0]);
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
    const r = await executeWebFetch({ url: "https://example.test/html" }, bad);
    expect(r.type).toBe("error");
    expect(r.content).toContain("boom");
  });
});

// =============================================================================
// Metadata, definition, and registry
// =============================================================================

describe("Tool definition and registry", () => {
  test("result includes metadata", async () => {
    installRouteFetch();
    const r = await doFetch({ url: "https://example.test/html" });
    expect(r.type).toBe("text");
    const m = (r as any).metadata;
    expect(m).toBeDefined();
    expect(m.url).toBe("https://example.test/html");
    expect(m.status).toBe(200);
    expect(m.content_type).toContain("text/html");
    expect(typeof m.length).toBe("number");
    expect(typeof m.truncated).toBe("boolean");
  });

  test("tool definition has correct shape", () => {
    expect(webFetchToolDefinition.name).toBe("web_fetch");
    expect(webFetchToolDefinition.permission).toBe("auto_approve");
    expect(webFetchToolDefinition.input_schema.required).toEqual(["url"]);
    expect(webFetchToolDefinition.input_schema.properties.url).toBeDefined();
    expect(webFetchToolDefinition.input_schema.properties.extract_mode).toBeDefined();
    expect(webFetchToolDefinition.input_schema.properties.max_chars).toBeDefined();
    expect(webFetchToolDefinition.input_schema.properties.extract_mode.enum).toEqual(["markdown", "text"]);
  });

  test("registry integration executes tool successfully", async () => {
    installRouteFetch();
    const reg = getToolRegistry();
    reg.register(webFetchToolDefinition);

    const r = await reg.execute("web_fetch", { url: "https://example.test/plain" }, ctx());
    expect(r.type).toBe("text");
    expect(r.content).toContain("plain text");
  });
});

// =============================================================================
// E2E tests moved to tests/e2e-api.ts — run with: bun run test:e2e
