// =============================================================================
// Web Search Tool
//
// Searches the web and returns numbered results (title, URL, snippet). Two
// backends, chosen automatically:
//   • Brave Search API — used when a Brave key is configured (best quality).
//   • Keyless fallback — DuckDuckGo Instant Answers + Wikipedia search, no API
//     key required. Returns fetchable source URLs the agent can then web_fetch.
//
// So web_search works out of the box with NO extra key; a Brave key is just an
// optional upgrade. The output format is identical across backends, so the
// agent (and callers) see the same numbered title/URL/snippet list either way.
// =============================================================================

import { loadConfig } from "../storage/config.js";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const DDG_API_URL = "https://api.duckduckgo.com/";
const WIKI_API_URL = "https://en.wikipedia.org/w/api.php";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

// A normal desktop UA — Wikipedia/DDG accept this; some endpoints throttle
// obvious bot agents.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// -----------------------------------------------------------------------------
// Input + shared result types
// -----------------------------------------------------------------------------

interface WebSearchInput {
  query: string;
  count?: number;
}

/** A normalized search hit, backend-agnostic. */
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

// -----------------------------------------------------------------------------
// Brave backend
// -----------------------------------------------------------------------------

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}
interface BraveSearchResponse {
  web?: { results?: BraveSearchResult[] };
}

async function searchBrave(query: string, count: number, apiKey: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL(BRAVE_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Brave Search API error: HTTP ${resp.status} ${resp.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await resp.json()) as BraveSearchResponse;
  return (data?.web?.results ?? []).map((r) => ({
    title: r.title ?? "(no title)",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

// -----------------------------------------------------------------------------
// Keyless backend: DuckDuckGo Instant Answers + Wikipedia search
// -----------------------------------------------------------------------------

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

/** Strip HTML tags + decode the few entities Wikipedia snippets use. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** DuckDuckGo Instant Answer — gives a topic abstract + a canonical source URL
 *  (often Wikipedia). No key. Returns at most one "abstract" hit. */
async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL(DDG_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  const resp = await fetch(url.toString(), { headers: { Accept: "application/json", "User-Agent": UA }, signal });
  if (!resp.ok) return [];
  const data = (await resp.json().catch(() => null)) as DdgResponse | null;
  if (!data) return [];
  const hits: SearchHit[] = [];
  if (data.AbstractText && data.AbstractURL) {
    hits.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: `${data.AbstractText}${data.AbstractSource ? ` (source: ${data.AbstractSource})` : ""}`,
    });
  }
  return hits;
}

interface WikiSearchResponse {
  query?: { search?: Array<{ title?: string; snippet?: string }> };
}

/** Wikipedia full-text search — a real keyless, bot-friendly result list. Each
 *  hit's article URL is fetchable by web_fetch for the actual content. */
async function searchWikipedia(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL(WIKI_API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", String(limit));
  url.searchParams.set("srprop", "snippet");
  url.searchParams.set("format", "json");
  const resp = await fetch(url.toString(), { headers: { Accept: "application/json", "User-Agent": UA }, signal });
  if (!resp.ok) return [];
  const data = (await resp.json().catch(() => null)) as WikiSearchResponse | null;
  const results = data?.query?.search ?? [];
  return results.map((r) => {
    const title = r.title ?? "(untitled)";
    return {
      title: `Wikipedia: ${title}`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: stripHtml(r.snippet ?? ""),
    };
  });
}

/** Keyless search: DDG abstract (a canonical source) + Wikipedia results,
 *  deduped by URL, capped to `count`. Each runs independently so one failing
 *  doesn't sink the other. */
async function searchKeyless(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const [ddg, wiki] = await Promise.all([
    searchDuckDuckGo(query, signal).catch(() => [] as SearchHit[]),
    searchWikipedia(query, count, signal).catch(() => [] as SearchHit[]),
  ]);
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of [...ddg, ...wiki]) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
    if (out.length >= count) break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Core search logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeWebSearch(
  input: WebSearchInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeWebSearchInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Search failed: ${msg}` };
  }
}

async function executeWebSearchInner(
  input: WebSearchInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { query, count } = input;

  if (context.abort_signal.aborted) {
    return { type: "error", content: "Search cancelled: operation was aborted before starting." };
  }

  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  if (!trimmedQuery) {
    return { type: "error", content: "Missing required parameter: query" };
  }

  const effectiveCount = Math.min(Math.max(count ?? DEFAULT_COUNT, 1), MAX_COUNT);

  // --- Choose backend: Brave if keyed, else keyless. ---
  const config = loadConfig();
  const braveKey = config.api_keys.brave_search;
  const backend = braveKey ? "brave" : "keyless";

  // --- Timeout + abort plumbing ---
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (context.abort_signal.aborted) {
    controller.abort();
  } else {
    context.abort_signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let hits: SearchHit[];
  try {
    hits =
      backend === "brave"
        ? await searchBrave(trimmedQuery, effectiveCount, braveKey, controller.signal)
        : await searchKeyless(trimmedQuery, effectiveCount, controller.signal);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("AbortError")) {
      return { type: "error", content: "Search request timed out after 10 seconds." };
    }
    return { type: "error", content: `Search error (${backend}): ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }

  if (hits.length === 0) {
    return {
      type: "text",
      content:
        `No results for: ${trimmedQuery}` +
        (backend === "keyless"
          ? "\n(Keyless search covers well-documented topics. For broad web coverage, set a Brave API key under api_keys.brave_search.)"
          : ""),
      metadata: { query: trimmedQuery, count: 0, backend },
    };
  }

  // --- Format (identical shape for both backends) ---
  const lines: string[] = [`Results for: ${trimmedQuery}${backend === "keyless" ? " (keyless: DuckDuckGo + Wikipedia)" : ""}\n`];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    lines.push(`${i + 1}. ${h.title}`);
    if (h.url) lines.push(`   ${h.url}`);
    if (h.snippet) lines.push(`   ${h.snippet}`);
    lines.push("");
  }
  if (backend === "keyless") {
    lines.push("Tip: use web_fetch on a result URL above to read the full page (e.g. to extract numbers/stats).");
    // Financial queries: steer toward SEC EDGAR (structured JSON, no key, no
    // truncation) instead of parsing a long Wikipedia article.
    if (/\b(revenue|earnings|profit|income|sales|financ|annual report|10-?k|fiscal|quarterly|net income|gross margin)\b/i.test(trimmedQuery)) {
      lines.push(
        "For US public-company financials, SEC EDGAR is the best source (official, structured JSON, no key):\n" +
        "  • Company facts: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json (10-digit zero-padded CIK)\n" +
        "  • One concept: https://data.sec.gov/api/xbrl/companyconcept/CIK##########/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json\n" +
        "  e.g. Apple's CIK is 0000320193. web_fetch that JSON, keep the annual (10-K, ~365-day) datapoints, dedupe by fiscal year.",
      );
    }
  }

  return {
    type: "text",
    content: lines.join("\n").trimEnd(),
    metadata: { query: trimmedQuery, count: hits.length, backend },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const webSearchToolDefinition: ToolDefinition<WebSearchInput> = {
  name: "web_search",
  description:
    "Search the web for current information, documentation, facts, or sources. Returns numbered " +
    "results with title, URL, and snippet. Works with NO API key (DuckDuckGo + Wikipedia); if a " +
    "Brave Search key is configured it's used for broader coverage. For statistics/numbers, search " +
    "to find a source URL, then use web_fetch on that URL to read the actual data.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query.",
      },
      count: {
        type: "number",
        description: "Number of results to return (1-10, default: 5).",
      },
    },
    required: ["query"],
  },
  permission: "auto_approve",
  execute: executeWebSearch as any,
};
