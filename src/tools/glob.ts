// =============================================================================
// Glob Tool
//
// Find files by glob pattern using Bun.Glob. Returns relative paths sorted
// alphabetically. Skips common noise directories. Caps results at 500.
// =============================================================================

import { stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_RESULTS = 500;
const MAX_DEPTH = 10;
const TIMEOUT_MS = 30_000;

// Directories to skip during traversal
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  ".next",
  ".cache",
  "coverage",
]);

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface GlobInput {
  pattern: string;
  path?: string;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Check if a relative path passes through a skipped directory.
 */
function shouldSkip(relativePath: string): boolean {
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  return false;
}

/**
 * Count depth of a path (number of / separators).
 */
function pathDepth(p: string): number {
  if (p === "" || p === ".") return 0;
  return p.split("/").length;
}

// -----------------------------------------------------------------------------
// Core glob logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeGlob(
  input: GlobInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeGlobInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error finding files: ${msg}` };
  }
}

async function executeGlobInner(
  input: GlobInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { pattern, path: searchPath } = input;

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Glob cancelled: operation was aborted before starting." };
  }

  // --- Validate parameters ---
  if (!pattern || typeof pattern !== "string") {
    return { type: "error", content: "Missing required parameter: pattern" };
  }

  // --- Resolve search directory ---
  const baseDir = searchPath
    ? resolve(context.working_directory, searchPath)
    : context.working_directory;

  // --- Check directory exists ---
  try {
    const dirStat = await stat(baseDir);
    if (!dirStat.isDirectory()) {
      return { type: "error", content: `Not a directory: ${searchPath ?? "."}` };
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { type: "error", content: `Path not found: ${searchPath ?? "."}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error accessing path: ${msg}` };
  }

  // --- Run glob with timeout ---
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  let truncated = false;

  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    for await (const entry of glob.scan({ cwd: baseDir, dot: true, onlyFiles: true })) {
      // Check abort
      if (context.abort_signal.aborted || timeoutSignal.aborted) break;

      // Skip noise directories
      if (shouldSkip(entry)) continue;

      // Enforce max depth
      if (pathDepth(entry) > MAX_DEPTH) continue;

      matches.push(entry);
      if (matches.length >= MAX_RESULTS) {
        truncated = true;
        break;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timed out") || msg.includes("timeout")) {
      return { type: "error", content: "Glob search timed out after 30s. Try a more specific pattern or narrower path." };
    }
    return { type: "error", content: `Glob search failed: ${msg}` };
  }

  if (timeoutSignal.aborted) {
    return { type: "error", content: "Glob search timed out after 30s. Try a more specific pattern or narrower path." };
  }

  // --- Sort alphabetically ---
  matches.sort();

  // --- Format output ---
  if (matches.length === 0) {
    return {
      type: "text",
      content: `No files found matching '${pattern}' in ${searchPath ?? "."}`,
      metadata: { pattern, base_dir: baseDir, count: 0 },
    };
  }

  const lines: string[] = [];
  for (const m of matches) {
    lines.push(m);
  }

  let result = lines.join("\n");
  result += `\n\n[${matches.length} file(s) found]`;
  if (truncated) {
    result += `\n[Results limited to ${MAX_RESULTS} matches. Use a more specific pattern to narrow results.]`;
  }

  return {
    type: "text",
    content: result,
    metadata: {
      pattern,
      base_dir: baseDir,
      count: matches.length,
      truncated,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const globToolDefinition: ToolDefinition<GlobInput> = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g., '**/*.ts', 'src/**/*.py'). " +
    "Returns relative paths sorted alphabetically. " +
    "Automatically skips noise directories (node_modules, .git, dist, etc.). " +
    "Results are capped at 500 matches.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against (e.g., '**/*.ts').",
      },
      path: {
        type: "string",
        description: "The directory to search in. Defaults to the working directory.",
      },
    },
    required: ["pattern"],
  },
  permission: "auto_approve",
  execute: executeGlob as any,
};
