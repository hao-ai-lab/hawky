// =============================================================================
// Memory Tools
//
// Two read-only tools for workspace memory access (matching a proven design pattern):
//
// memory_get    — Read a workspace file with optional line range
// memory_search — Hybrid BM25 + vector search across workspace files
//
// The agent WRITES to memory using standard write_file/edit_file tools.
// These memory tools are read-only convenience wrappers that know the
// workspace path and enforce security boundaries.
// =============================================================================

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";
import { getWorkspaceDir } from "../storage/workspace.js";
import { createSubsystemLogger } from "../logging/index.js";
import { extractMemoryAppendJsonlText } from "../memory/append-jsonl-extract.js";

const log = createSubsystemLogger("tools/memory");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS_LIMIT = 50;
const MAX_SNIPPET_CHARS = 300;

// Files to search in workspace root (in addition to memory/ directory)
const SEARCHABLE_ROOT_FILES = [
  "MEMORY.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "AGENTS.md",
  "TOOLS.md",
  "HEARTBEAT.md",
];

// -----------------------------------------------------------------------------
// memory_get
// -----------------------------------------------------------------------------

interface MemoryGetInput {
  path: string;
  from?: number;
  lines?: number;
}

function parseMemoryGetPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    return undefined;
  }
  return value;
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    return `${field} must be a positive integer`;
  }
  return value;
}

async function executeMemoryGet(
  input: MemoryGetInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const workspaceDir = getWorkspaceDir();
  const rawInput = input as unknown as Record<string, unknown>;
  const relPath = parseMemoryGetPath(rawInput.path);
  if (!relPath) {
    return { type: "error", content: "Path must be a non-empty relative string" };
  }

  const from = parseOptionalPositiveInteger(rawInput.from, "from");
  if (typeof from === "string") {
    return { type: "error", content: from };
  }
  const lines = parseOptionalPositiveInteger(rawInput.lines, "lines");
  if (typeof lines === "string") {
    return { type: "error", content: lines };
  }

  // Security: reject absolute paths
  if (relPath.startsWith("/") || relPath.startsWith("\\")) {
    return { type: "error", content: "Path must be relative to workspace (e.g., 'MEMORY.md', 'memory/2026-03-14.md')" };
  }

  // Security: reject directory traversal (resolve to catch all bypass patterns)
  const normalized = normalize(relPath);
  const fullPath = resolve(workspaceDir, normalized);
  // Append separator to prevent sibling-path bypass (e.g., /tmp/ws vs /tmp/ws-secret)
  const wsPrefix = resolve(workspaceDir) + "/";
  if (!fullPath.startsWith(wsPrefix) && fullPath !== resolve(workspaceDir)) {
    return { type: "error", content: "Path must not traverse outside workspace" };
  }

  // Security: only .md files
  if (!normalized.endsWith(".md")) {
    return { type: "error", content: "Only .md files can be read via memory_get" };
  }
  if (!existsSync(fullPath)) {
    return { type: "text", content: JSON.stringify({ path: relPath, text: "", error: "File not found" }) };
  }

  try {
    const content = readFileSync(fullPath, "utf-8");
    const allLines = content.split("\n");

    // Apply line range if specified
    if (from !== undefined || lines !== undefined) {
      const start = (from ?? 1) - 1; // 1-based to 0-based
      const count = lines ?? allLines.length;
      const slice = allLines.slice(start, start + count);

      // content: full JSON for LLM
      const jsonContent = JSON.stringify({
        path: relPath,
        text: slice.join("\n"),
        from: start + 1,
        lines: slice.length,
        total_lines: allLines.length,
      });

      // display_content: clean preview for TUI
      const rangeLabel = `lines ${start + 1}-${start + slice.length} of ${allLines.length}`;
      const preview = formatFilePreview(relPath, slice, rangeLabel);

      return { type: "text", content: jsonContent, display_content: preview };
    }

    // Full file read
    const jsonContent = JSON.stringify({ path: relPath, text: content });
    const sizeLabel = `${allLines.length} lines, ${content.length} chars`;
    const preview = formatFilePreview(relPath, allLines, sizeLabel);

    return { type: "text", content: jsonContent, display_content: preview };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Failed to read ${relPath}: ${message}` };
  }
}

export const memoryGetToolDefinition: ToolDefinition<MemoryGetInput> = {
  name: "memory_get",
  description:
    "Read a workspace memory file (MEMORY.md, SOUL.md, USER.md, memory/*.md, etc.) " +
    "with optional line range. Use after memory_search to pull only the needed lines " +
    "and keep context small. Path is relative to workspace.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File path relative to workspace. Examples: 'MEMORY.md', 'SOUL.md', " +
          "'memory/2026-03-14.md', 'IDENTITY.md'.",
      },
      from: {
        type: "integer",
        description: "Start line (1-based). If omitted, reads from beginning.",
      },
      lines: {
        type: "integer",
        description: "Maximum number of lines to read. If omitted, reads entire file.",
      },
    },
    required: ["path"],
  },
  execute: executeMemoryGet,
  permission: "auto_approve",
};

// -----------------------------------------------------------------------------
// memory_search
// -----------------------------------------------------------------------------

interface MemorySearchInput {
  query: string;
  max_results?: number;
}

interface SearchMatch {
  path: string;
  line_number: number;
  snippet: string;
}

function normalizeMaxResults(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }

  return Math.max(1, Math.min(Math.floor(value), MAX_RESULTS_LIMIT));
}

function parseMemorySearchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const query = value.trim();
  return query ? query : undefined;
}

/**
 * Hybrid BM25 + vector search across workspace memory files.
 * Uses MemoryIndex (SQLite FTS5 + in-memory cosine similarity).
 * Falls back to FTS-only when no embedding API key available.
 */
async function executeMemorySearch(
  input: MemorySearchInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const rawInput = input as unknown as Record<string, unknown>;
  const query = parseMemorySearchQuery(rawInput.query);
  if (!query) {
    return { type: "error", content: "Query must be a non-empty string" };
  }
  const maxResults = normalizeMaxResults(rawInput.max_results as number | undefined);

  try {
    const { getGlobalMemoryIndex } = await import("../memory/global.js");
    const index = getGlobalMemoryIndex(getWorkspaceDir());
    const results = await index.search(query, { maxResults });
    const meta = index.lastSearchMeta;

    // content: clean JSON for the LLM
    const content = JSON.stringify({
      results: results.map((r) => ({
        path: r.path,
        line_number: r.startLine,
        snippet: r.snippet,
        score: Math.round(r.score * 1000) / 1000,
      })),
      query,
      result_count: results.length,
    });

    // display_content: formatted for human readability in TUI
    const displayLines: string[] = [];

    // Sync status — prominent when re-indexing happened
    if (meta?.synced && meta.syncStats) {
      const { indexed, removed } = meta.syncStats;
      if (indexed > 0 || removed > 0) {
        const parts: string[] = [];
        if (indexed > 0) parts.push(`${indexed} file(s) re-indexed`);
        if (removed > 0) parts.push(`${removed} removed`);
        displayLines.push(`⟳ Index updated: ${parts.join(", ")} (${meta.totalChunks} chunks total)`);
      }
    }

    // Search result line
    const mode = meta?.searchMode ?? "unknown";
    displayLines.push(`[${mode}] ${results.length} result(s) for "${query}"`);

    // Results
    if (results.length === 0) {
      displayLines.push("  No matches found.");
    } else {
      for (const r of results) {
        const score = Math.round(r.score * 100);
        const snippetOneLine = r.snippet.split("\n")[0].slice(0, 80);
        displayLines.push(`  ${r.path}:${r.startLine} (${score}%) ${snippetOneLine}`);
      }
    }

    return {
      type: "text",
      content,
      display_content: displayLines.join("\n"),
    };
  } catch (err) {
    // Fallback to simple grep if index fails — log the actual error so degraded
    // search quality doesn't go unnoticed
    log.warn("memory_search indexed path failed, falling back to grep", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallbackGrepSearch(query, maxResults);
  }
}

export const memorySearchToolDefinition: ToolDefinition<MemorySearchInput> = {
  name: "memory_search",
  description:
    "Search MEMORY.md + memory/*.md and other workspace files for relevant context " +
    "about prior work, decisions, dates, people, preferences, or todos. Returns " +
    "matching snippets with file path and line numbers. Use memory_get afterwards " +
    "to pull full context for specific matches.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (case-insensitive text search).",
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return. Default: 6, max: 50.",
      },
    },
    required: ["query"],
  },
  execute: executeMemorySearch,
  permission: "auto_approve",
};

// -----------------------------------------------------------------------------
// Fallback grep search (used when MemoryIndex is unavailable)
// -----------------------------------------------------------------------------

function fallbackGrepSearch(query: string, maxResults: number): ToolResult {
  const workspaceDir = getWorkspaceDir();
  const filesToSearch: Array<{ relPath: string; fullPath: string }> = [];

  for (const filename of SEARCHABLE_ROOT_FILES) {
    const fullPath = join(workspaceDir, filename);
    if (existsSync(fullPath)) {
      filesToSearch.push({ relPath: filename, fullPath });
    }
  }

  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    collectSearchableMemoryFiles(memoryDir, memoryDir, filesToSearch);
  }

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  const matches: SearchMatch[] = [];

  for (const file of filesToSearch) {
    if (matches.length >= maxResults) break;
    try {
      const content = file.relPath.endsWith(".jsonl")
        ? extractMemoryAppendJsonlText(file.fullPath).text
        : readFileSync(file.fullPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          let snippet = lines.slice(start, end).join("\n");
          if (snippet.length > MAX_SNIPPET_CHARS) snippet = snippet.substring(0, MAX_SNIPPET_CHARS) + "...";
          matches.push({ path: file.relPath, line_number: i + 1, snippet });
        }
      }
    } catch { /* skip */ }
  }

  const content = JSON.stringify({
    results: matches,
    query,
    result_count: matches.length,
    files_searched: filesToSearch.length,
  });

  // display_content: match the format of the indexed path
  const displayLines: string[] = [];
  displayLines.push(`[grep-fallback] ${matches.length} result(s) for "${query}"`);
  if (matches.length === 0) {
    displayLines.push("  No matches found.");
  } else {
    for (const m of matches) {
      const snippetOneLine = m.snippet.split("\n")[0].slice(0, 80);
      displayLines.push(`  ${m.path}:${m.line_number} ${snippetOneLine}`);
    }
  }

  return {
    type: "text",
    content,
    display_content: displayLines.join("\n"),
  };
}

function collectSearchableMemoryFiles(
  dir: string,
  rootDir: string,
  out: Array<{ relPath: string; fullPath: string }>,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectSearchableMemoryFiles(fullPath, rootDir, out);
        continue;
      }
      if (!stat.isFile() || (!entry.endsWith(".md") && !entry.endsWith(".jsonl"))) {
        continue;
      }
      const relFromRoot = fullPath.slice(rootDir.length + 1);
      out.push({ relPath: `memory/${relFromRoot}`, fullPath });
    } catch { /* skip */ }
  }
}

// -----------------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------------

const PREVIEW_MAX_LINES = 8;

/**
 * Format a file's content for TUI display.
 * Shows: header with path + metadata, then first N lines as preview.
 */
function formatFilePreview(path: string, lines: string[], meta: string): string {
  const displayLines: string[] = [];
  displayLines.push(`${path} (${meta})`);

  // Show first N non-empty lines as preview
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const preview = nonEmpty.slice(0, PREVIEW_MAX_LINES);
  for (const line of preview) {
    const trimmed = line.length > 100 ? line.slice(0, 97) + "..." : line;
    displayLines.push(`  ${trimmed}`);
  }

  if (nonEmpty.length > PREVIEW_MAX_LINES) {
    displayLines.push(`  ... (${nonEmpty.length - PREVIEW_MAX_LINES} more lines)`);
  }

  return displayLines.join("\n");
}
