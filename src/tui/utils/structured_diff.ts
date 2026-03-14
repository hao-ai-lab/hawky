// =============================================================================
// Structured Diff Utility
//
// Computes unified diffs with hunks, context lines, line numbers, and
// syntax-highlighted +/- coloring. Uses the `diff` npm package (same as
// Claude Code) for patch computation.
//
// Supports:
// - Hunk headers (@@ -3,7 +3,8 @@)
// - 3 context lines around changes
// - Line numbers in gutter
// - Green/red coloring for additions/removals
// - Syntax highlighting via cli-highlight
// - "..." separator between non-adjacent hunks
// - New file display (all lines as additions)
// =============================================================================

import { structuredPatch, type StructuredPatchHunk } from "diff";
import { highlight } from "cli-highlight";

// =============================================================================
// Constants
// =============================================================================

const CONTEXT_LINES = 3;
const DIFF_TIMEOUT_MS = 5_000;

// Language detection from file extension
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini",
  html: "xml", xml: "xml", css: "css", scss: "css",
  sql: "sql", md: "markdown", dockerfile: "docker",
  swift: "swift", kt: "kotlin", scala: "scala",
  php: "php", lua: "lua", r: "r", dart: "dart",
};

function detectLanguage(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? EXT_TO_LANG[ext] : undefined;
}

// =============================================================================
// Diff computation
// =============================================================================

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // prefixed with +, -, or space
}

/**
 * Compute structured diff hunks between old and new content.
 * Returns an array of hunks, each containing context + changed lines.
 */
export function computeDiffHunks(
  oldContent: string,
  newContent: string,
  filePath = "file",
): DiffHunk[] {
  try {
    const patch = structuredPatch(
      filePath,
      filePath,
      oldContent,
      newContent,
      undefined,
      undefined,
      { context: CONTEXT_LINES, timeout: DIFF_TIMEOUT_MS },
    );
    if (!patch) return fallbackDiff(oldContent, newContent);
    return patch.hunks.map((h: StructuredPatchHunk) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    }));
  } catch {
    // Timeout or error — fall back to simple line diff
    return fallbackDiff(oldContent, newContent);
  }
}

/** Simple fallback when structuredPatch fails */
function fallbackDiff(oldContent: string, newContent: string): DiffHunk[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lines: string[] = [];
  for (const l of oldLines) lines.push("-" + l);
  for (const l of newLines) lines.push("+" + l);
  return [{
    oldStart: 1, oldLines: oldLines.length,
    newStart: 1, newLines: newLines.length,
    lines,
  }];
}

// =============================================================================
// ANSI formatting (TUI)
// =============================================================================

interface FormatOptions {
  /** File path for syntax highlighting language detection */
  filePath?: string;
  /** Terminal width for wrapping (0 = no wrapping) */
  termWidth?: number;
  /** Enable syntax highlighting (default: true) */
  syntaxHighlight?: boolean;
  /** Starting line number offset (1-based). Adjusts hunk line numbers to match file position. */
  startLine?: number;
}

/**
 * Format diff hunks as ANSI-styled string for TUI display.
 * Includes line numbers, +/- coloring, hunk headers, and syntax highlighting.
 */
export function formatDiffHunks(
  hunks: DiffHunk[],
  options: FormatOptions = {},
): string {
  if (hunks.length === 0) return "\x1b[90m  (no changes)\x1b[0m";

  const { filePath, termWidth = 0, syntaxHighlight = true, startLine = 1 } = options;
  const lang = filePath ? detectLanguage(filePath) : undefined;
  // Offset to adjust line numbers from snippet-relative to file-relative
  const lineOffset = startLine - 1;

  // Calculate gutter width from max line number (adjusted for file position)
  const maxLineNum = hunks.reduce((max, h) => {
    return Math.max(max, h.oldStart + h.oldLines - 1 + lineOffset, h.newStart + h.newLines - 1 + lineOffset);
  }, 1);
  const gutterWidth = maxLineNum.toString().length;

  const parts: string[] = [];

  for (let hi = 0; hi < hunks.length; hi++) {
    // Separator between hunks
    if (hi > 0) {
      parts.push("\x1b[90m  ...\x1b[0m");
    }

    const hunk = hunks[hi];

    // Hunk header (adjusted to file-relative line numbers)
    const adjOldStart = hunk.oldStart + lineOffset;
    const adjNewStart = hunk.newStart + lineOffset;
    parts.push(
      `\x1b[36m  @@ -${adjOldStart},${hunk.oldLines} +${adjNewStart},${hunk.newLines} @@\x1b[0m`,
    );

    // Track line numbers (file-relative)
    let oldLine = adjOldStart;
    let newLine = adjNewStart;

    for (const line of hunk.lines) {
      const marker = line[0]; // +, -, or space
      const content = line.substring(1);
      const highlighted = syntaxHighlight && lang
        ? highlightLine(content, lang)
        : content;

      // Wrap if needed
      const displayContent = termWidth > 0 && stripAnsi(highlighted).length > termWidth - gutterWidth - 6
        ? highlighted.substring(0, termWidth - gutterWidth - 6) + "\x1b[90m…\x1b[0m"
        : highlighted;

      if (marker === "+") {
        const num = String(newLine++).padStart(gutterWidth);
        // Green line number + marker; bright white text on dark green background
        // No syntax highlighting on changed lines — colored keywords on colored bg is unreadable
        parts.push(`\x1b[32m  ${num} + \x1b[97;48;2;2;40;0m${content}\x1b[0m`);
      } else if (marker === "-") {
        const num = String(oldLine++).padStart(gutterWidth);
        // Red line number + marker; bright white text on dark red background (rgba 61,1,0)
        parts.push(`\x1b[31m  ${num} - \x1b[97;48;2;61;1;0m${content}\x1b[0m`);
      } else if (marker === "\\") {
        // "\ No newline at end of file" — skip
        continue;
      } else {
        // Context line — dim text, syntax highlighted, no background
        const num = String(oldLine++).padStart(gutterWidth);
        newLine++;
        parts.push(`\x1b[90m  ${num}   ${displayContent}\x1b[0m`);
      }
    }
  }

  return parts.join("\n");
}

/**
 * Format a new file as "all additions" diff display.
 */
export function formatNewFileDiff(
  content: string,
  options: FormatOptions = {},
): string {
  const { filePath, syntaxHighlight = true } = options;
  const lang = filePath ? detectLanguage(filePath) : undefined;
  const lines = content.split("\n");
  const gutterWidth = lines.length.toString().length;

  const parts: string[] = [];
  parts.push("\x1b[36m  @@ +1," + lines.length + " @@\x1b[0m");

  for (let i = 0; i < lines.length; i++) {
    const num = String(i + 1).padStart(gutterWidth);
    const highlighted = syntaxHighlight && lang
      ? highlightLine(lines[i], lang)
      : lines[i];
    // Green gutter, bright white text on dark green background
    parts.push(`\x1b[32m  ${num} + \x1b[97;48;2;2;40;0m${lines[i]}\x1b[0m`);
  }

  return parts.join("\n");
}

// =============================================================================
// Syntax highlighting helper
// =============================================================================

function highlightLine(line: string, lang: string): string {
  try {
    // highlight() expects complete code; for single lines, we strip trailing newline
    const result = highlight(line, { language: lang, ignoreIllegals: true });
    return result.replace(/\n$/, "");
  } catch {
    return line;
  }
}

/** Strip ANSI escape codes for width calculation */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// =============================================================================
// HTML formatting (Web)
// =============================================================================

/**
 * Format diff hunks as HTML for web display.
 * Returns an HTML string with CSS classes for styling.
 */
export function formatDiffHunksHTML(
  hunks: DiffHunk[],
  filePath?: string,
): string {
  if (hunks.length === 0) return '<span class="diff-empty">(no changes)</span>';

  const maxLineNum = hunks.reduce((max, h) => {
    return Math.max(max, h.oldStart + h.oldLines - 1, h.newStart + h.newLines - 1);
  }, 1);
  const gutterWidth = maxLineNum.toString().length;

  const parts: string[] = [];

  for (let hi = 0; hi < hunks.length; hi++) {
    if (hi > 0) {
      parts.push('<div class="diff-separator">...</div>');
    }

    const hunk = hunks[hi];
    parts.push(
      `<div class="diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</div>`,
    );

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      const marker = line[0];
      const content = escapeHtml(line.substring(1));

      if (marker === "+") {
        const num = String(newLine++).padStart(gutterWidth);
        parts.push(`<div class="diff-add"><span class="diff-gutter">${num}</span><span class="diff-marker">+</span><span class="diff-content">${content}</span></div>`);
      } else if (marker === "-") {
        const num = String(oldLine++).padStart(gutterWidth);
        parts.push(`<div class="diff-del"><span class="diff-gutter">${num}</span><span class="diff-marker">-</span><span class="diff-content">${content}</span></div>`);
      } else {
        const num = String(oldLine++).padStart(gutterWidth);
        newLine++;
        parts.push(`<div class="diff-ctx"><span class="diff-gutter">${num}</span><span class="diff-marker"> </span><span class="diff-content">${content}</span></div>`);
      }
    }
  }

  return parts.join("\n");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Export for testing
export { detectLanguage, highlightLine, CONTEXT_LINES };
