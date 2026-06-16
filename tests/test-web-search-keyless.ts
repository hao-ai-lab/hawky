import { describe, test, expect, afterEach } from "bun:test";
import { executeWebSearch } from "../src/tools/web_search.js";
import { loadConfig, resetConfig } from "../src/storage/config.js";
import type { ToolContext, ToolResult } from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// Keyless web_search backend tests (DuckDuckGo Instant Answers + Wikipedia).
// With no Brave key, web_search must still return real, fetchable results so
// the agent can search → web_fetch → chart with no extra API key.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

function ctx(): ToolContext {
  return {
    session_id: "test",
    working_directory: process.cwd(),
    abort_signal: new AbortController().signal,
    emit: () => {},
    headless: true,
  };
}

function mockFetch(impl: (u: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => impl(String(input))) as typeof fetch;
}

function ddg(body: object): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
function wiki(search: Array<{ title: string; snippet: string }>): Response {
  return new Response(JSON.stringify({ query: { search } }), { headers: { "Content-Type": "application/json" } });
}

/** Force the keyless backend by clearing the Brave key on the cached config. */
function clearBraveKey(): () => void {
  const config = loadConfig();
  const saved = config.api_keys.brave_search;
  config.api_keys.brave_search = "";
  return () => { config.api_keys.brave_search = saved; };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConfig();
});

describe("keyless web_search backend", () => {
  test("combines DuckDuckGo abstract + Wikipedia results, tagged keyless", async () => {
    const restore = clearBraveKey();
    mockFetch((u) => {
      if (u.includes("api.duckduckgo.com")) {
        return ddg({ Heading: "Apple Inc.", AbstractText: "Apple is a tech company.", AbstractURL: "https://en.wikipedia.org/wiki/Apple_Inc.", AbstractSource: "Wikipedia" });
      }
      if (u.includes("en.wikipedia.org/w/api.php")) {
        return wiki([
          { title: "Apple Inc.", snippet: "American <b>technology</b> company" },
          { title: "List of largest companies by revenue", snippet: "ranked by <i>revenue</i>" },
        ]);
      }
      return ddg({});
    });
    try {
      const r = await executeWebSearch({ query: "apple revenue", count: 5 }, ctx());
      expect(r.type).toBe("text");
      const meta = (r as { metadata?: { backend?: string; count?: number } }).metadata;
      expect(meta?.backend).toBe("keyless");
      // DDG abstract first, then wiki results.
      expect(r.content).toContain("https://en.wikipedia.org/wiki/Apple_Inc."); // DDG abstract URL
      expect(r.content).toContain("Wikipedia: List of largest companies by revenue");
      // Wikipedia article URLs are constructed from titles.
      expect(r.content).toContain("https://en.wikipedia.org/wiki/List_of_largest_companies_by_revenue");
      // The follow-up hint nudges the agent to web_fetch.
      expect(r.content).toContain("web_fetch");
    } finally {
      restore();
    }
  });

  test("strips HTML/entities from Wikipedia snippets", async () => {
    const restore = clearBraveKey();
    mockFetch((u) => {
      if (u.includes("api.duckduckgo.com")) return ddg({});
      if (u.includes("en.wikipedia.org/w/api.php")) {
        return wiki([{ title: "Tesla, Inc.", snippet: "world&#039;s leading <span class=\"x\">electric</span> &amp; clean" }]);
      }
      return ddg({});
    });
    try {
      const r = await executeWebSearch({ query: "tesla" }, ctx());
      expect(r.content).not.toContain("<span");
      expect(r.content).not.toContain("&#039;");
      expect(r.content).not.toContain("&amp;");
      expect(r.content).toContain("world's leading electric & clean");
    } finally {
      restore();
    }
  });

  test("dedupes by URL and caps to count", async () => {
    const restore = clearBraveKey();
    mockFetch((u) => {
      if (u.includes("api.duckduckgo.com")) {
        // DDG abstract points at the SAME url as the first wiki result → deduped.
        return ddg({ Heading: "X", AbstractText: "abstract", AbstractURL: "https://en.wikipedia.org/wiki/X", AbstractSource: "Wikipedia" });
      }
      if (u.includes("en.wikipedia.org/w/api.php")) {
        return wiki([
          { title: "X", snippet: "one" },
          { title: "Y", snippet: "two" },
          { title: "Z", snippet: "three" },
        ]);
      }
      return ddg({});
    });
    try {
      const r = await executeWebSearch({ query: "x", count: 2 }, ctx());
      const meta = (r as { metadata?: { count?: number } }).metadata;
      expect(meta?.count).toBe(2); // capped
      // X appears once (deduped), not twice.
      const xCount = (r.content.match(/\/wiki\/X(\D|$)/g) || []).length;
      expect(xCount).toBe(1);
    } finally {
      restore();
    }
  });

  test("one backend failing does not sink the other (DDG 500, wiki ok)", async () => {
    const restore = clearBraveKey();
    mockFetch((u) => {
      if (u.includes("api.duckduckgo.com")) return new Response("err", { status: 500 });
      if (u.includes("en.wikipedia.org/w/api.php")) return wiki([{ title: "Japan", snippet: "an island country" }]);
      return ddg({});
    });
    try {
      const r = await executeWebSearch({ query: "japan" }, ctx());
      expect(r.type).toBe("text");
      expect(r.content).toContain("Wikipedia: Japan");
    } finally {
      restore();
    }
  });

  test("no results yields a helpful keyless message (not an error)", async () => {
    const restore = clearBraveKey();
    mockFetch((u) => {
      if (u.includes("api.duckduckgo.com")) return ddg({});
      if (u.includes("en.wikipedia.org/w/api.php")) return wiki([]);
      return ddg({});
    });
    try {
      const r = await executeWebSearch({ query: "zzzqqq no such thing" }, ctx());
      expect(r.type).toBe("text"); // not an error
      expect(r.content).toContain("No results");
      expect(r.content).toContain("Brave"); // suggests the upgrade path
    } finally {
      restore();
    }
  });

  test("empty query still errors regardless of backend", async () => {
    const restore = clearBraveKey();
    try {
      const r: ToolResult = await executeWebSearch({ query: "  " }, ctx());
      expect(r.type).toBe("error");
      expect(r.content).toContain("Missing required parameter: query");
    } finally {
      restore();
    }
  });
});
