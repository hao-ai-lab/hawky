// =============================================================================
// Read File Tool
//
// Reads file contents with optional offset/limit, line numbers, binary
// detection, and per-line truncation. Uses Bun.file() for efficient I/O.
// =============================================================================

import { stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ContentBlock,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_LIMIT = 2000;          // Default max lines to read
const MAX_LINE_LENGTH = 2000;        // Truncate individual lines beyond this
const MAX_CONTENT_CHARS = 100_000;   // Hard cap on total output characters
const BINARY_CHECK_BYTES = 8192;     // Read first 8KB to detect binary files

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface ReadFileInput {
  file_path: string;
  offset?: number;   // 1-based line number to start from (text files / notebooks only)
  limit?: number;    // Max lines to read (default 2000)
}

// -----------------------------------------------------------------------------
// File type detection
// -----------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

/** Device files that would hang if read */
const DEVICE_FILE_PREFIXES = ["/dev/", "/proc/", "/sys/"];

function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isPdfFile(path: string): boolean {
  return PDF_EXTENSIONS.has(extname(path).toLowerCase());
}

function isNotebookFile(path: string): boolean {
  return NOTEBOOK_EXTENSIONS.has(extname(path).toLowerCase());
}

function isDeviceFile(path: string): boolean {
  return DEVICE_FILE_PREFIXES.some((p) => path.startsWith(p));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Check if a buffer contains null bytes, indicating a binary file.
 */
function isBinaryBuffer(buffer: Uint8Array): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Format a single line with right-aligned line number and tab separator.
 * Matches `cat -n` style: `     1\tcontent`
 */
function formatLine(line_num: number, content: string, width: number): string {
  const truncated = content.length > MAX_LINE_LENGTH
    ? content.substring(0, MAX_LINE_LENGTH) + "... [truncated]"
    : content;
  return `${String(line_num).padStart(width)}\t${truncated}`;
}

/**
 * Calculate the width needed for line number alignment.
 */
function lineNumWidth(max_line: number): number {
  return Math.max(String(max_line).length, 4); // minimum 4 chars wide
}

// -----------------------------------------------------------------------------
// Core read logic (exported for testing)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Image handling
// -----------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** Max pixels for Claude vision (recommended ~1.2M pixels) */
const MAX_IMAGE_PIXELS = 1_200_000;

async function readImageFile(resolved: string, filePath: string): Promise<ToolResult> {
  const ext = extname(resolved).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? "image/png";

  const file = Bun.file(resolved);
  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  // For SVG, return as text (more useful for editing)
  if (ext === ".svg") {
    const text = new TextDecoder().decode(buffer);
    return {
      type: "text",
      content: text,
      metadata: { file_path: resolved, media_type: mimeType, size: buffer.byteLength },
    };
  }

  // Return as ImageToolResult — the agent loop converts this to a proper
  // multimodal content block (text + image) so the model can visually
  // inspect the image via its vision capability. No base64 dumped in text.
  const sizeKB = Math.round(buffer.byteLength / 1024);
  return {
    type: "image",
    content: `[Image: ${filePath} (${mimeType}, ${sizeKB}KB)]`,
    base64,
    media_type: mimeType,
    metadata: {
      file_path: resolved,
      media_type: mimeType,
      size: buffer.byteLength,
    },
  };
}

// -----------------------------------------------------------------------------
// PDF handling
// -----------------------------------------------------------------------------

/**
 * Cap on raw PDF size. Claude's API accepts up to 32 MB per document;
 * we stay well under that so the base64-inflated payload still fits
 * comfortably in a single RPC frame and respects the session doc budget.
 */
const MAX_PDF_RAW_BYTES = 20 * 1024 * 1024;

async function readPdfFile(
  resolved: string,
  filePath: string,
): Promise<ToolResult> {
  const file = Bun.file(resolved);
  const buffer = await file.arrayBuffer();
  const size = buffer.byteLength;

  if (size > MAX_PDF_RAW_BYTES) {
    return {
      type: "error",
      content:
        `PDF is too large (${Math.round(size / (1024 * 1024))} MB). ` +
        `Max for inline read is ${MAX_PDF_RAW_BYTES / (1024 * 1024)} MB. ` +
        `Use 'pdftotext <file>' via bash to extract text from larger PDFs.`,
    };
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const sizeKB = Math.round(size / 1024);

  // Return as DocumentToolResult — the agent loop wraps this in a document
  // block inside the tool_result so the model gets Claude's native PDF
  // understanding (text + images + layout) instead of lossy text extraction.
  return {
    type: "document",
    content: `[PDF: ${filePath} (${sizeKB}KB)]`,
    base64,
    media_type: "application/pdf",
    title: filePath,
    metadata: {
      file_path: resolved,
      media_type: "application/pdf",
      size,
    },
  };
}

// -----------------------------------------------------------------------------
// Jupyter Notebook handling
// -----------------------------------------------------------------------------

async function readNotebookFile(
  resolved: string,
  filePath: string,
  offset?: number,
  limit?: number,
): Promise<ToolResult> {
  const file = Bun.file(resolved);
  let notebook: any;
  try {
    notebook = JSON.parse(await file.text());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error parsing notebook: ${msg}` };
  }

  // nbformat v4: cells at top level. nbformat v3: cells inside worksheets[0].
  const cells = notebook.cells ?? notebook.worksheets?.[0]?.cells ?? [];
  if (cells.length === 0) {
    return {
      type: "text",
      content: `Empty notebook: ${filePath}`,
      metadata: { file_path: resolved, cell_count: 0 },
    };
  }

  // Language detection from notebook metadata
  const kernelLang = notebook.metadata?.kernelspec?.language
    ?? notebook.metadata?.language_info?.name
    ?? "python";

  // Apply offset/limit to cells (1-based)
  const effectiveOffset = offset ?? 1;
  if (effectiveOffset < 1) {
    return { type: "error", content: "Offset must be >= 1 (1-based cell numbering)." };
  }
  if (effectiveOffset > cells.length) {
    return {
      type: "text",
      content: `Notebook has ${cells.length} cells, offset ${effectiveOffset} is out of range. Use offset=1 to read from the beginning.`,
      metadata: { file_path: resolved, cell_count: cells.length },
    };
  }
  const startCell = effectiveOffset - 1;
  const maxCells = limit ?? cells.length;
  const selectedCells = cells.slice(startCell, startCell + maxCells);

  const parts: string[] = [];
  parts.push(`Notebook: ${filePath} (${cells.length} cells, ${kernelLang})`);
  parts.push("");

  for (let i = 0; i < selectedCells.length; i++) {
    const cell = selectedCells[i];
    const cellNum = startCell + i + 1;
    const cellType = cell.cell_type === "heading" ? "markdown" : (cell.cell_type ?? "unknown");
    // nbformat v3 uses "input", v4 uses "source"
    const rawSource = cell.source ?? cell.input ?? "";
    const source = Array.isArray(rawSource) ? rawSource.join("") : rawSource;

    parts.push(`--- Cell ${cellNum} [${cellType}] ---`);
    if (cellType === "code") {
      parts.push("```" + kernelLang);
      parts.push(source);
      parts.push("```");

      // Include outputs
      const outputs = cell.outputs ?? [];
      if (outputs.length > 0) {
        parts.push("Output:");
        for (const out of outputs) {
          if (out.output_type === "stream") {
            const text = Array.isArray(out.text) ? out.text.join("") : (out.text ?? "");
            parts.push(text.trimEnd());
          } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
            const textData = out.data?.["text/plain"];
            if (textData) {
              const text = Array.isArray(textData) ? textData.join("") : textData;
              parts.push(text.trimEnd());
            } else {
              parts.push(`[${out.output_type}: ${Object.keys(out.data ?? {}).join(", ")}]`);
            }
          } else if (out.output_type === "error") {
            parts.push(`Error: ${out.ename ?? "Unknown"}: ${out.evalue ?? ""}`);
            if (out.traceback) {
              // Strip ANSI codes from traceback
              const tb = Array.isArray(out.traceback) ? out.traceback.join("\n") : out.traceback;
              parts.push(tb.replace(/\x1b\[[0-9;]*m/g, ""));
            }
          }
        }
      }
    } else {
      // Markdown or raw cells
      parts.push(source);
    }
    parts.push("");
  }

  // Cell range notice
  if (startCell + selectedCells.length < cells.length) {
    parts.push(`[Showing cells ${startCell + 1}-${startCell + selectedCells.length} of ${cells.length}. Use offset=${startCell + selectedCells.length + 1} to see more.]`);
  }

  let content = parts.join("\n");
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.substring(0, MAX_CONTENT_CHARS) + `\n... [truncated to ${MAX_CONTENT_CHARS} characters]`;
  }

  return {
    type: "text",
    content,
    metadata: {
      file_path: resolved,
      cell_count: cells.length,
      shown_from: startCell + 1,
      shown_to: startCell + selectedCells.length,
      language: kernelLang,
    },
  };
}

// -----------------------------------------------------------------------------
// Core read logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeReadFile(
  input: ReadFileInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeReadFileInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error reading file: ${msg}` };
  }
}

async function executeReadFileInner(
  input: ReadFileInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { file_path, offset, limit } = input;

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Read cancelled: operation was aborted before starting." };
  }

  // --- Validate file_path ---
  if (!file_path || typeof file_path !== "string") {
    return { type: "error", content: "Missing required parameter: file_path" };
  }

  // --- Resolve path (handles .., ., relative paths) ---
  const resolved = resolve(context.working_directory, file_path);

  // --- Block device files (would hang) ---
  if (isDeviceFile(resolved)) {
    return { type: "error", content: `Cannot read device file: ${file_path}` };
  }

  // --- Special file types: detect before stat/binary check ---
  if (isImageFile(resolved)) {
    // Quick existence check
    try { await stat(resolved); } catch {
      return { type: "error", content: `File not found: ${file_path}` };
    }
    return readImageFile(resolved, file_path);
  }

  if (isPdfFile(resolved)) {
    try { await stat(resolved); } catch {
      return { type: "error", content: `File not found: ${file_path}` };
    }
    // Fail loud if a caller still passes the removed `pages` parameter — we
    // switched to native PDF document blocks and no longer slice pages. Old
    // prompts or legacy RPC clients would otherwise silently read the whole
    // file instead of the intended subset.
    if (typeof (input as unknown as Record<string, unknown>).pages !== "undefined") {
      return {
        type: "error",
        content:
          "read_file: the 'pages' parameter is no longer supported for PDFs. " +
          "PDFs are now delivered as native document blocks to the model. " +
          "For page-range extraction use `pdftotext -f <start> -l <end>` via bash.",
      };
    }
    return readPdfFile(resolved, file_path);
  }

  if (isNotebookFile(resolved)) {
    try { await stat(resolved); } catch {
      return { type: "error", content: `File not found: ${file_path}` };
    }
    return readNotebookFile(resolved, file_path, offset, limit);
  }

  // --- Check if path exists and get stats ---
  let file_stat;
  try {
    file_stat = await stat(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { type: "error", content: `File not found: ${file_path}` };
    }
    if (code === "EACCES") {
      return { type: "error", content: `Permission denied: ${file_path}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error accessing file: ${msg}` };
  }

  // --- Directory check ---
  if (file_stat.isDirectory()) {
    return { type: "error", content: `Cannot read directory: ${file_path}` };
  }

  // --- Empty file ---
  const size = file_stat.size;
  if (size === 0) {
    return {
      type: "text",
      content: `File is empty (0 bytes): ${file_path}`,
      metadata: { file_path: resolved, size: 0, lines: 0 },
    };
  }

  // --- Binary detection: check first 8KB for null bytes ---
  const file = Bun.file(resolved);
  try {
    const check_size = Math.min(size, BINARY_CHECK_BYTES);
    const check_buffer = new Uint8Array(await file.slice(0, check_size).arrayBuffer());
    if (isBinaryBuffer(check_buffer)) {
      return {
        type: "text",
        content: `Binary file (${size} bytes): ${file_path}`,
        metadata: { file_path: resolved, size, binary: true },
      };
    }
  } catch {
    // If we can't read for binary check, proceed and catch below
  }

  // --- Read file as text ---
  let content: string;
  try {
    content = await file.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error reading file: ${msg}` };
  }

  // --- Split into lines (normalize CRLF first for Windows files) ---
  const all_lines = content.replace(/\r\n/g, "\n").split("\n");
  const total_lines = all_lines.length;

  // --- Validate offset ---
  const effective_offset = offset ?? 1; // default: start from line 1
  if (effective_offset < 1) {
    return { type: "error", content: "Offset must be >= 1 (1-based line numbering)." };
  }
  if (effective_offset > total_lines) {
    return {
      type: "text",
      content: `File has ${total_lines} lines, offset ${effective_offset} is out of range. Use offset=1 to read from the beginning.`,
      metadata: { file_path: resolved, total_lines },
    };
  }

  // --- Slice lines ---
  const effective_limit = limit ?? DEFAULT_LIMIT;
  const start_idx = effective_offset - 1; // convert 1-based to 0-based index
  const end_idx = Math.min(start_idx + effective_limit, total_lines);
  const selected_lines = all_lines.slice(start_idx, end_idx);

  // --- Format with line numbers ---
  const max_line_num = effective_offset + selected_lines.length - 1;
  const width = lineNumWidth(max_line_num);

  const formatted: string[] = [];
  for (let i = 0; i < selected_lines.length; i++) {
    formatted.push(formatLine(effective_offset + i, selected_lines[i], width));
  }

  let result = formatted.join("\n");

  // --- Truncation notice if not all lines shown ---
  const shown_end = effective_offset + selected_lines.length - 1;
  if (end_idx < total_lines) {
    result += `\n[Showing lines ${effective_offset}-${shown_end} of ${total_lines}. Use offset=${shown_end + 1} to read more.]`;
  }

  // --- Hard character limit ---
  if (result.length > MAX_CONTENT_CHARS) {
    result = result.substring(0, MAX_CONTENT_CHARS)
      + `\n... [truncated to ${MAX_CONTENT_CHARS} characters]`;
  }

  return {
    type: "text",
    content: result,
    metadata: {
      file_path: resolved,
      total_lines,
      shown_from: effective_offset,
      shown_to: shown_end,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const readFileToolDefinition: ToolDefinition<ReadFileInput> = {
  name: "read_file",
  description:
    "Read the contents of a file at the given path. Supports text files (with line numbers), " +
    "images (PNG, JPG, GIF, WebP — returns base64), PDFs (native document blocks), " +
    "and Jupyter notebooks (.ipynb — formatted cells with outputs).",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to read. Can be absolute or relative to the working directory.",
      },
      offset: {
        type: "number",
        description:
          "For text files: 1-based line number to start from (default 1). For notebooks: 1-based cell number.",
      },
      limit: {
        type: "number",
        description:
          "For text files: max lines to read (default 2000). For notebooks: max cells to show.",
      },
    },
    required: ["file_path"],
  },
  permission: "auto_approve",
  execute: executeReadFile as any,
};
