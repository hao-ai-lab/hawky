// =============================================================================
// Write File Tool
//
// Creates or overwrites files. Auto-creates parent directories.
// Uses Bun.write() for efficient I/O.
// =============================================================================

import { stat, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";

const MAX_DIFF_METADATA_CHARS = 50_000; // Cap diff content in metadata

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface WriteFileInput {
  file_path: string;
  content: string;
}

// -----------------------------------------------------------------------------
// Core write logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeWriteFile(
  input: WriteFileInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeWriteFileInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error writing file: ${msg}` };
  }
}

async function executeWriteFileInner(
  input: WriteFileInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { file_path, content } = input;

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Write cancelled: operation was aborted before starting." };
  }

  // --- Validate parameters ---
  if (!file_path || typeof file_path !== "string") {
    return { type: "error", content: "Missing required parameter: file_path" };
  }
  if (content === undefined || content === null) {
    return { type: "error", content: "Missing required parameter: content" };
  }

  // --- Resolve path (handles .., ., relative paths) ---
  const resolved = resolve(context.working_directory, file_path);

  // --- Check if target is an existing directory ---
  try {
    const existing = await stat(resolved);
    if (existing.isDirectory()) {
      return { type: "error", content: `Cannot write to a directory: ${file_path}` };
    }
  } catch {
    // Path doesn't exist yet — that's fine, we'll create it
  }

  // --- Read old content for diff (if file exists) ---
  let old_content: string | null = null;
  try {
    old_content = await readFile(resolved, "utf-8");
  } catch {
    // File doesn't exist yet — old_content stays null (new file)
  }

  // --- Create parent directories ---
  const parent = dirname(resolved);
  await mkdir(parent, { recursive: true });

  // --- Write file ---
  const bytes_written = await Bun.write(resolved, content);

  // --- Compute line count ---
  const line_count = content === "" ? 0 : content.split("\n").length;

  return {
    type: "text",
    content: `Wrote ${bytes_written} bytes to ${file_path} (${line_count} lines)`,
    metadata: {
      file_path: resolved,
      bytes_written,
      lines: line_count,
      // Bounded diff content — cap to prevent transport/UI blow-up with large files
      // null = file didn't exist (new file), "__omitted__" = content exceeded size cap
      old_content: old_content === null
        ? null  // File didn't exist
        : old_content.length <= MAX_DIFF_METADATA_CHARS ? old_content : "__omitted__",
      new_content: content.length <= MAX_DIFF_METADATA_CHARS ? content : "__omitted__",
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const writeFileToolDefinition: ToolDefinition<WriteFileInput> = {
  name: "write_file",
  description:
    "Write content to a file at the given path. Creates the file if it does not exist, " +
    "or overwrites it if it does. Parent directories are created automatically.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to write. Can be absolute or relative to the working directory.",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
    required: ["file_path", "content"],
  },
  permission: "ask_user",
  execute: executeWriteFile as any,
};
