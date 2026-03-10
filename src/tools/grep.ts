// =============================================================================
// Grep Tool
//
// Search file contents with regex. Pure Bun implementation using readdir
// traversal + RegExp per line. Supports context lines, include filter,
// result limits. Skips binary files and noise directories.
// =============================================================================

import { stat, readdir, readFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_RESULTS = 100;
const MAX_LINE_LENGTH = 500;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_FILES = 10_000;
const MAX_DEPTH = 15;
const TIMEOUT_MS = 30_000;
const BINARY_CHECK_BYTES = 512;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__",
  ".venv", ".next", ".cache", "coverage",
]);

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  context_lines?: number;
  head_limit?: number;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isBinaryBuffer(buffer: Uint8Array): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return false;
    const checkSize = Math.min(size, BINARY_CHECK_BYTES);
    const buffer = new Uint8Array(await file.slice(0, checkSize).arrayBuffer());
    return isBinaryBuffer(buffer);
  } catch {
    return false;
  }
}

/**
 * Convert a simple glob pattern like "*.ts" to a RegExp for filename matching.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Truncate a line to MAX_LINE_LENGTH.
 */
function truncateLine(line: string): string {
  if (line.length > MAX_LINE_LENGTH) {
    return line.substring(0, MAX_LINE_LENGTH) + "...";
  }
  return line;
}

// -----------------------------------------------------------------------------
// File discovery
// -----------------------------------------------------------------------------

async function discoverFiles(
  dir: string,
  includeFilter: RegExp | null,
  deadline: number,
  depth: number = 0,
): Promise<string[]> {
  if (depth > MAX_DEPTH || Date.now() > deadline) return [];

  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (Date.now() > deadline) break;
    if (files.length >= MAX_FILES) break;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const subFiles = await discoverFiles(
        join(dir, entry.name), includeFilter, deadline, depth + 1,
      );
      files.push(...subFiles);
    } else if (entry.isFile()) {
      if (includeFilter && !includeFilter.test(entry.name)) continue;
      files.push(join(dir, entry.name));
    }
  }

  return files;
}

// -----------------------------------------------------------------------------
// Core grep logic (exported for testing)
// -----------------------------------------------------------------------------

interface MatchResult {
  file: string;       // relative path
  line_num: number;   // 1-based
  content: string;    // the matching line (trimmed + truncated)
  context_before: string[];  // lines before the match
  context_after: string[];   // lines after the match
}

export async function executeGrep(
  input: GrepInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeGrepInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error during search: ${msg}` };
  }
}

async function executeGrepInner(
  input: GrepInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { pattern, path: searchPath, include, context_lines, head_limit } = input;

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Grep cancelled: operation was aborted before starting." };
  }

  // --- Validate parameters ---
  if (!pattern || typeof pattern !== "string") {
    return { type: "error", content: "Missing required parameter: pattern" };
  }

  let regex: RegExp;
  try {
    // Support inline flags like (?i) by extracting them
    let flags = "";
    let effectivePattern = pattern;
    const flagMatch = pattern.match(/^\(\?([gimsuy]+)\)/);
    if (flagMatch) {
      flags = flagMatch[1];
      effectivePattern = pattern.slice(flagMatch[0].length);
    }
    regex = new RegExp(effectivePattern, flags);
  } catch {
    return { type: "error", content: `Invalid regex pattern: ${pattern}` };
  }

  // --- Resolve search path ---
  const baseDir = context.working_directory;
  const searchTarget = searchPath
    ? resolve(baseDir, searchPath)
    : baseDir;

  // --- Check path exists ---
  let targetStat;
  try {
    targetStat = await stat(searchTarget);
  } catch {
    return { type: "error", content: `Path not found: ${searchPath ?? "."}` };
  }

  // --- Build include filter ---
  const includeFilter = include ? globToRegex(include) : null;

  // --- Limits ---
  const effectiveLimit = Math.min(head_limit ?? MAX_RESULTS, MAX_RESULTS);
  const ctxLines = Math.max(0, Math.min(context_lines ?? 0, 10));
  const deadline = Date.now() + TIMEOUT_MS;

  // --- Discover files ---
  let filesToSearch: string[];
  if (targetStat.isFile()) {
    filesToSearch = [searchTarget];
  } else {
    filesToSearch = await discoverFiles(searchTarget, includeFilter, deadline);
    if (Date.now() > deadline) {
      return { type: "error", content: "Grep timed out during file discovery. Try a narrower path or include filter." };
    }
    filesToSearch.sort();
  }

  // --- Search files ---
  const matches: MatchResult[] = [];
  let filesSearched = 0;
  let timedOut = false;

  for (const filePath of filesToSearch) {
    if (Date.now() > deadline) { timedOut = true; break; }
    if (context.abort_signal.aborted) break;
    if (matches.length >= effectiveLimit) break;

    // Skip binary files
    if (await isBinaryFile(filePath)) continue;

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    filesSearched++;
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const relPath = relative(baseDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= effectiveLimit) break;

      if (regex.test(lines[i])) {
        // Gather context lines
        const beforeStart = Math.max(0, i - ctxLines);
        const afterEnd = Math.min(lines.length - 1, i + ctxLines);
        const before: string[] = [];
        const after: string[] = [];

        for (let b = beforeStart; b < i; b++) {
          before.push(truncateLine(lines[b].trimEnd()));
        }
        for (let a = i + 1; a <= afterEnd; a++) {
          after.push(truncateLine(lines[a].trimEnd()));
        }

        matches.push({
          file: relPath,
          line_num: i + 1,
          content: truncateLine(lines[i].trimEnd()),
          context_before: before,
          context_after: after,
        });
      }
    }
  }

  // --- Format output ---
  if (matches.length === 0) {
    let msg = `No matches found for '${pattern}'`;
    if (include) msg += ` in ${include} files`;
    if (timedOut) msg += ` (search timed out after 30s, ${filesSearched} files searched)`;
    return {
      type: "text",
      content: msg,
      metadata: { pattern, count: 0, files_searched: filesSearched, timed_out: timedOut },
    };
  }

  const outputLines: string[] = [];
  for (const m of matches) {
    if (ctxLines > 0 && m.context_before.length > 0) {
      for (let b = 0; b < m.context_before.length; b++) {
        const lineNum = m.line_num - m.context_before.length + b;
        outputLines.push(`${m.file}:${lineNum}- ${m.context_before[b]}`);
      }
    }
    outputLines.push(`${m.file}:${m.line_num}: ${m.content}`);
    if (ctxLines > 0 && m.context_after.length > 0) {
      for (let a = 0; a < m.context_after.length; a++) {
        const lineNum = m.line_num + a + 1;
        outputLines.push(`${m.file}:${lineNum}- ${m.context_after[a]}`);
      }
    }
    if (ctxLines > 0) outputLines.push("--");
  }

  // Remove trailing separator
  if (ctxLines > 0 && outputLines[outputLines.length - 1] === "--") {
    outputLines.pop();
  }

  let result = outputLines.join("\n");

  // Hard character limit
  if (result.length > MAX_OUTPUT_CHARS) {
    result = result.substring(0, MAX_OUTPUT_CHARS) + "\n... [output truncated at 30000 characters]";
  }

  // Append summary
  const warnings: string[] = [];
  if (matches.length >= effectiveLimit) warnings.push(`results capped at ${effectiveLimit}`);
  if (timedOut) warnings.push("search timed out after 30s");
  const warningStr = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
  result += `\n\n[${matches.length} match(es) in ${filesSearched} file(s)${warningStr}]`;

  return {
    type: "text",
    content: result,
    metadata: {
      pattern,
      count: matches.length,
      files_searched: filesSearched,
      timed_out: timedOut,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const grepToolDefinition: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search file contents using a regex pattern. Returns matching lines with " +
    "file paths and line numbers (filepath:linenum: content). " +
    "Supports include filter (e.g., '*.ts'), context lines, and result limits. " +
    "Automatically skips binary files and noise directories.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for in file contents.",
      },
      path: {
        type: "string",
        description: "File or directory to search in. Defaults to working directory.",
      },
      include: {
        type: "string",
        description: "Glob filter for filenames, e.g., '*.ts', '*.py'. Only files matching this pattern are searched.",
      },
      context_lines: {
        type: "number",
        description: "Number of lines to show before and after each match (like grep -C). Default: 0, max: 10.",
      },
      head_limit: {
        type: "number",
        description: "Maximum number of matches to return. Default and max: 100.",
      },
    },
    required: ["pattern"],
  },
  permission: "auto_approve",
  execute: executeGrep as any,
};
