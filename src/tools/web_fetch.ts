// =============================================================================
// Web Fetch Tool
//
// Fetches a URL and extracts readable content using Mozilla Readability.
// Returns markdown or plain text. Handles JSON, HTML, and plain text responses.
// =============================================================================

import { resolve } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// 100K so long reference pages (e.g. a Wikipedia company article whose
// financials table sits past the 50K mark) aren't cut off before the data.
const DEFAULT_MAX_CHARS = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2_000_000; // 2 MB max raw response
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface WebFetchInput {
  url: string;
  extract_mode?: "markdown" | "text";
  max_chars?: number;
}

// -----------------------------------------------------------------------------
// HTML → Markdown conversion (custom, no heavy library)
// -----------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
  let result = html;

  // Strip script, style, noscript tags and their content
  result = result.replace(/<script[\s\S]*?<\/script>/gi, "");
  result = result.replace(/<style[\s\S]*?<\/style>/gi, "");
  result = result.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Convert links: <a href="url">text</a> → [text](url)
  result = result.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `[${text.trim()}](${href})`);

  // Convert headings: <h1>text</h1> → # text
  for (let level = 1; level <= 6; level++) {
    const prefix = "#".repeat(level);
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
    result = result.replace(re, (_, text) => `\n\n${prefix} ${text.trim()}\n\n`);
  }

  // Convert list items: <li> → - item
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n- ${text.trim()}`);

  // Convert block elements to newlines
  result = result.replace(/<\/(?:p|div|section|article|blockquote|pre|table|tr)>/gi, "\n\n");
  result = result.replace(/<br\s*\/?>/gi, "\n");
  result = result.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Bold and italic
  result = result.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  result = result.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Code
  result = result.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

  // Strip all remaining HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  result = result
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…");

  // Normalize whitespace: collapse multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  // Trim each line
  result = result.split("\n").map(l => l.trimEnd()).join("\n");
  result = result.trim();

  return result;
}

/**
 * Convert markdown to plain text by stripping markdown syntax.
 */
function markdownToText(md: string): string {
  let result = md;
  // Strip markdown links: [text](url) → text
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Strip heading markers
  result = result.replace(/^#{1,6}\s+/gm, "");
  // Strip bold/italic
  result = result.replace(/\*\*([^*]*)\*\*/g, "$1");
  result = result.replace(/\*([^*]*)\*/g, "$1");
  // Strip inline code
  result = result.replace(/`([^`]*)`/g, "$1");
  // Strip code fences
  result = result.replace(/```[\s\S]*?```/g, "");
  // Strip horizontal rules
  result = result.replace(/^---$/gm, "");
  // Collapse whitespace
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

// -----------------------------------------------------------------------------
// Content extraction using Readability
// -----------------------------------------------------------------------------

function extractWithReadability(
  html: string,
  url: string,
  extractMode: "markdown" | "text",
): { title: string; content: string; extractor: string } {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (article && article.content) {
      const markdown = htmlToMarkdown(article.content);
      const title = article.title || "";
      const content = extractMode === "markdown"
        ? (title ? `# ${title}\n\n${markdown}` : markdown)
        : (title ? `${title}\n\n${markdownToText(markdown)}` : markdownToText(markdown));
      return { title, content, extractor: "readability" };
    }
  } catch {
    // Readability failed, fall through to regex fallback
  }

  // Fallback: raw HTML → markdown/text
  const markdown = htmlToMarkdown(html);
  const content = extractMode === "text" ? markdownToText(markdown) : markdown;
  return { title: "", content, extractor: "regex-fallback" };
}

// -----------------------------------------------------------------------------
// Core fetch logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeWebFetch(
  input: WebFetchInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeWebFetchInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Fetch failed: ${msg}` };
  }
}

async function executeWebFetchInner(
  input: WebFetchInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { url, extract_mode, max_chars } = input;
  const rawUrl = url?.trim();

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Fetch cancelled: operation was aborted before starting." };
  }

  // --- Validate URL ---
  if (!rawUrl || typeof url !== "string") {
    return { type: "error", content: "Missing required parameter: url" };
  }

  let parsedUrl: URL;
  try {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rawUrl)) {
      parsedUrl = new URL(rawUrl);
    } else {
      parsedUrl = new URL(`https://${rawUrl}`);
    }
  } catch {
    return { type: "error", content: `Invalid URL: ${url}` };
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return { type: "error", content: `Invalid URL protocol: ${parsedUrl.protocol}. Only http/https supported.` };
  }

  if (parsedUrl.protocol === "http:") {
    parsedUrl = new URL(parsedUrl.toString().replace(/^http:/, "https:"));
  }

  const effectiveMode = extract_mode ?? "markdown";
  const effectiveMaxChars = Math.max(100, max_chars ?? DEFAULT_MAX_CHARS);

  // --- Fetch with timeout ---
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Chain with context abort signal
  if (context.abort_signal.aborted) {
    controller.abort();
  } else {
    context.abort_signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/markdown, text/html;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("AbortError")) {
      return { type: "error", content: "Request timed out after 30 seconds." };
    }
    return { type: "error", content: `Network error: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }

  // --- Check HTTP status ---
  if (!response.ok) {
    return {
      type: "error",
      content: `HTTP ${response.status}: ${response.statusText} for ${parsedUrl.toString()}`,
    };
  }

  // --- Read response body (with size limit) ---
  let body: string;
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      body = new TextDecoder().decode(buffer.slice(0, MAX_RESPONSE_BYTES));
    } else {
      body = new TextDecoder().decode(buffer);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error reading response: ${msg}` };
  }

  // --- Determine content type and extract ---
  const contentType = response.headers.get("content-type") || "";
  let text: string;
  let title = "";
  let extractor = "raw";

  if (contentType.includes("application/json")) {
    // JSON: pretty-print
    try {
      const parsed = JSON.parse(body);
      text = JSON.stringify(parsed, null, 2);
      extractor = "json";
    } catch {
      text = body;
      extractor = "raw";
    }
  } else if (contentType.includes("text/html") || body.trimStart().slice(0, 15).toLowerCase().startsWith("<!doctype") || body.trimStart().slice(0, 5).toLowerCase().startsWith("<html")) {
    // HTML: extract with Readability
    const result = extractWithReadability(body, parsedUrl.toString(), effectiveMode);
    text = result.content;
    title = result.title;
    extractor = result.extractor;
  } else {
    // Plain text or other: return as-is
    text = body;
    extractor = "raw";
  }

  // --- Truncate ---
  let truncated = false;
  if (text.length > effectiveMaxChars) {
    text = text.substring(0, effectiveMaxChars);
    truncated = true;
  }

  // --- Build result ---
  const resultLines: string[] = [];
  if (title) resultLines.push(`Title: ${title}`);
  resultLines.push(`URL: ${parsedUrl.toString()}`);
  resultLines.push(`Content-Type: ${contentType}`);
  resultLines.push(`Extractor: ${extractor}`);
  resultLines.push("");
  resultLines.push(text);
  if (truncated) {
    resultLines.push(`\n[Content truncated at ${effectiveMaxChars} characters]`);
  }

  return {
    type: "text",
    content: resultLines.join("\n"),
    metadata: {
      url: parsedUrl.toString(),
      final_url: response.url,
      status: response.status,
      content_type: contentType,
      title,
      extractor,
      truncated,
      length: text.length,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const webFetchToolDefinition: ToolDefinition<WebFetchInput> = {
  name: "web_fetch",
  description:
    "Fetch a URL and extract its readable content. Returns markdown by default. " +
    "Uses Mozilla Readability to extract the main article content from HTML pages, " +
    "stripping navigation, ads, and other noise. Also handles JSON (pretty-printed) " +
    "and plain text responses.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch. HTTP URLs are auto-upgraded to HTTPS.",
      },
      extract_mode: {
        type: "string",
        description: 'Output format: "markdown" (default) or "text" (plain text, no markdown syntax).',
      },
      max_chars: {
        type: "number",
        description: "Maximum characters to return. Default: 50000.",
      },
    },
    required: ["url"],
  },
  permission: "auto_approve",
  execute: executeWebFetch as any,
};
