// =============================================================================
// Tool Output Component
//
// Renders a tool execution entry in the message list.
// Status icon + tool name + input preview header, followed by either:
// - Structured diff (for edit_file/write_file with diff data)
// - Standard output lines with ⎿ continuation prefix
//
// Examples:
//   ⠸ bash ─ ls -la /tmp                  (executing, spinner)
//     ⎿ total 48
//     ⎿ -rw-r--r-- 1 user staff 123 file.txt
//
//   ✓ edit_file ─ src/index.ts             (success, diff)
//     @@ -3,7 +3,8 @@
//      3   import { foo } from './bar';
//     -4 - const x = 1;
//     +4 + const x = 2;
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ToolDisplayData, ToolOutputLine } from "../types.js";
import { linkifyForTui } from "../utils/linkify.js";
import {
  computeDiffHunks,
  formatDiffHunks,
  formatNewFileDiff,
} from "../utils/structured_diff.js";

// =============================================================================
// JSON Auto-Formatting
// =============================================================================

const MAX_JSON_FORMAT_LENGTH = 20_000;

/**
 * Try to detect and pretty-print JSON in tool output.
 * Returns formatted lines if JSON detected, original lines otherwise.
 */
function tryFormatJsonLines(lines: ToolOutputLine[]): ToolOutputLine[] {
  if (lines.length === 0) return lines;

  // Check total length without joining (avoid O(n) string allocation for large outputs)
  let totalLength = 0;
  for (const l of lines) {
    totalLength += l.content.length;
    if (totalLength > MAX_JSON_FORMAT_LENGTH) return lines; // Too large — skip
  }

  // Join only after size check passes
  const fullContent = lines.map((l) => l.content).join("\n");

  const type = lines[0]?.type ?? "stdout";

  // Try full content as single JSON object/array
  const trimmed = fullContent.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      const formatted = JSON.stringify(parsed, null, 2);
      // Only reformat if it actually changes something (avoid reformatting already-pretty JSON)
      if (formatted !== trimmed) {
        return formatted.split("\n").map((l) => ({ type, content: l }));
      }
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Try per-line JSONL (each line is independent JSON)
  let anyFormatted = false;
  const result = lines.map((line) => {
    const t = line.content.trim();
    if (t.length > MAX_JSON_FORMAT_LENGTH || t.length === 0) return line;
    if ((!t.startsWith("{") || !t.endsWith("}")) && (!t.startsWith("[") || !t.endsWith("]"))) return line;
    try {
      const parsed = JSON.parse(t);
      const formatted = JSON.stringify(parsed, null, 2);
      if (formatted !== t) {
        anyFormatted = true;
        // Split formatted into multiple lines, preserve the original type
        return { type: line.type, content: formatted };
      }
    } catch {
      // Not JSON
    }
    return line;
  });

  if (!anyFormatted) return lines;

  // Re-split any multi-line formatted entries
  const expanded: ToolOutputLine[] = [];
  for (const line of result) {
    if (line.content.includes("\n")) {
      for (const sub of line.content.split("\n")) {
        expanded.push({ type: line.type, content: sub });
      }
    } else {
      expanded.push(line);
    }
  }
  return expanded;
}

// Unified indicator color for all dim UI elements (matches Claude Code's gray)
// rgba(148, 148, 148) — readable on both light and dark terminals
const INDICATOR_COLOR = "#949494";

// =============================================================================
// Elapsed Timer
// =============================================================================

/** Format elapsed milliseconds as human-readable string */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** Elapsed timer shown during tool execution */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    setElapsed(Date.now() - startedAt); // Seed immediately on mount
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // Don't show for the first second
  if (elapsed < 1000) return null;

  return <Text color={INDICATOR_COLOR}> ({formatElapsed(elapsed)})</Text>;
}

// Braille spinner frames (same pattern as COCO's dots spinner)
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending: { icon: "⏱", color: "yellow" },
  executing: { icon: "⠋", color: "yellow" }, // Replaced by spinner
  success: { icon: "✓", color: "green" },
  error: { icon: "✗", color: "red" },
  canceled: { icon: "⊘", color: "gray" },
};

// Max output lines in compact mode (expanded shows more, but capped to prevent crash)
const MAX_OUTPUT_LINES_COMPACT = 3;
const MAX_OUTPUT_LINES_VERBOSE = 200;

interface ToolOutputProps {
  data: ToolDisplayData;
  /** When true, show full output instead of truncated (Ctrl+O toggle) */
  verbose?: boolean;
}

function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color="yellow">{SPINNER_FRAMES[frame]}</Text>;
}

/** Standard output lines with ⎿ continuation prefix (Claude Code style) */
function OutputLines({ lines, isError, verbose }: { lines: ToolOutputLine[]; isError: boolean; verbose?: boolean }) {
  if (lines.length === 0) return null;

  // Auto-format JSON before truncation (Claude Code pattern)
  const formattedLines = tryFormatJsonLines(lines);

  const maxLines = verbose ? MAX_OUTPUT_LINES_VERBOSE : MAX_OUTPUT_LINES_COMPACT;
  const displayLines = formattedLines.slice(0, maxLines);
  const hiddenCount = formattedLines.length - displayLines.length;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {displayLines.map((line, i) => {
        const content = linkifyForTui(line.content);
        const color = line.type === "stderr"
          ? (isError ? "red" : "gray")
          : undefined;

        return (
          <Box key={i}>
            <Text color={INDICATOR_COLOR}>⎿ </Text>
            <Text color={color}>{content}</Text>
          </Box>
        );
      })}
      {hiddenCount > 0 && (
        <Box>
          <Text color={INDICATOR_COLOR}>⎿ … +{hiddenCount} lines (ctrl+o to expand)</Text>
        </Box>
      )}
      {verbose && formattedLines.length > MAX_OUTPUT_LINES_COMPACT && (
        <Box>
          <Text color={INDICATOR_COLOR}>⎿ (ctrl+o to compact)</Text>
        </Box>
      )}
    </Box>
  );
}

/** Structured diff display for edit_file/write_file */
function DiffOutput({ metadata }: { metadata: Record<string, unknown> }) {
  const filePath = metadata.file_path as string | undefined;

  // edit_file: has old_string + new_string + match_line (null if exceeded size cap)
  if (typeof metadata.old_string === "string" && typeof metadata.new_string === "string") {
    const hunks = computeDiffHunks(
      metadata.old_string as string,
      metadata.new_string as string,
      filePath,
    );
    const startLine = typeof metadata.match_line === "number" ? metadata.match_line : 1;
    const formatted = formatDiffHunks(hunks, {
      filePath,
      syntaxHighlight: true,
      startLine,
    });
    return (
      <Box paddingLeft={2}>
        <Text>{formatted}</Text>
      </Box>
    );
  }

  // write_file: has new_content
  // null = file didn't exist (new file), "__omitted__" = content exceeded size cap
  if (typeof metadata.new_content === "string" && metadata.new_content !== "__omitted__") {
    const newContent = metadata.new_content;
    const oldContent = metadata.old_content;

    if (oldContent === null) {
      // New file — show all as additions
      const formatted = formatNewFileDiff(newContent, { filePath });
      return (
        <Box paddingLeft={2}>
          <Text>{formatted}</Text>
        </Box>
      );
    }

    if (typeof oldContent === "string" && oldContent !== "__omitted__") {
      // Overwrite existing file — show diff
      const hunks = computeDiffHunks(oldContent, newContent, filePath);
      const formatted = formatDiffHunks(hunks, {
        filePath,
        syntaxHighlight: true,
      });
      return (
        <Box paddingLeft={2}>
          <Text>{formatted}</Text>
        </Box>
      );
    }

    // oldContent === "__omitted__" — file too large for diff, fall through to standard output
  }

  return null;
}

/** Check if tool result has usable diff data ("__omitted__" = exceeded size cap) */
function hasDiffData(data: ToolDisplayData): boolean {
  if (!data.metadata) return false;
  const m = data.metadata;
  // edit_file — both must be real strings (not omitted)
  if (typeof m.old_string === "string" && typeof m.new_string === "string") return true;
  // write_file — new_content must be a real string (not "__omitted__")
  if (typeof m.new_content === "string" && m.new_content !== "__omitted__") return true;
  return false;
}

// =============================================================================
// Tool-Specific Summary Formatter
//
// Generates a one-line summary from tool metadata. Each tool type has its own
// summary format. Falls back to null for unknown tools (raw output shown).
// =============================================================================

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  // Handle irregular plurals
  if (word.endsWith("ch") || word.endsWith("sh") || word.endsWith("x") || word.endsWith("s")) {
    return `${n} ${word}es`;
  }
  return `${n} ${word}s`;
}

export function formatToolSummary(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  isError: boolean,
  outputLines: ToolOutputLine[],
): string | null {
  if (!metadata) return null;

  switch (toolName) {
    case "bash": {
      const exitCode = metadata.exit_code as number | undefined;
      if (exitCode !== undefined) {
        if (exitCode === 0) {
          // bash sets display_content to "(no output)" for empty runs — treat that as no output
          const hasRealOutput = outputLines.length > 0 &&
            outputLines.some((l) => l.content.trim() && l.content.trim() !== "(no output)");
          return hasRealOutput ? null : "(no output)";
        }
        return `Exit ${exitCode} (error)`;
      }
      // Error without exit code (timeout, abort)
      if (isError) return null; // Let the error message show as output
      return null;
    }

    case "glob": {
      const count = metadata.count as number | undefined;
      if (count === undefined) return null;
      if (count === 0) return "No files found";
      return `Found ${plural(count, "file")}`;
    }

    case "grep": {
      const count = metadata.count as number | undefined;
      if (count === undefined) return null;
      if (count === 0) return "No matches found";
      const filesSearched = metadata.files_searched as number | undefined;
      const timedOut = metadata.timed_out as boolean | undefined;
      let summary = `Found ${plural(count, "match")}`;
      if (filesSearched) summary += ` in ${plural(filesSearched, "file")}`;
      if (timedOut) summary += " (timed out)";
      return summary;
    }

    case "read_file": {
      const totalLines = metadata.total_lines as number | undefined;
      const shownFrom = metadata.shown_from as number | undefined;
      const shownTo = metadata.shown_to as number | undefined;
      const binary = metadata.binary as boolean | undefined;
      if (binary) return "Binary file";
      if (totalLines === undefined) return null;
      if (shownFrom !== undefined && shownTo !== undefined) {
        return `Read ${plural(totalLines, "line")} (lines ${shownFrom}-${shownTo})`;
      }
      return `Read ${plural(totalLines, "line")}`;
    }

    case "web_search": {
      const count = metadata.count as number | undefined;
      const query = metadata.query as string | undefined;
      if (count === undefined) return null;
      if (count === 0) return `No results for "${query ?? "..."}"`;
      return `${plural(count, "result")} for "${query ?? "..."}"`;
    }

    case "web_fetch": {
      const url = metadata.url as string | undefined;
      const status = metadata.status as number | undefined;
      const length = metadata.length as number | undefined;
      if (!url) return null;
      let domain: string;
      try { domain = new URL(url).hostname; } catch { domain = url; }
      const parts = [`Fetched ${domain}`];
      if (length) parts.push(`${length > 1000 ? `${Math.round(length / 1000)}K` : length} chars`);
      if (status) parts.push(`HTTP ${status}`);
      return parts.join(", ");
    }

    case "edit_file": {
      const added = metadata.lines_added as number | undefined;
      const removed = metadata.lines_removed as number | undefined;
      const parts: string[] = [];
      if (added && added > 0) parts.push(`Added ${plural(added, "line")}`);
      if (removed && removed > 0) parts.push(`removed ${plural(removed, "line")}`);
      return parts.length > 0 ? parts.join(", ") : null;
    }

    case "write_file": {
      if (metadata.old_content === null && typeof metadata.new_content === "string" && metadata.new_content !== "__omitted__") {
        return `New file, ${plural((metadata.new_content as string).split("\n").length, "line")}`;
      }
      if (typeof metadata.old_content === "string" && metadata.old_content !== "__omitted__" &&
          typeof metadata.new_content === "string" && metadata.new_content !== "__omitted__") {
        const hunks = computeDiffHunks(metadata.old_content as string, metadata.new_content as string);
        let a = 0, r = 0;
        for (const hunk of hunks) {
          for (const line of hunk.lines) {
            if (line[0] === "+") a++;
            else if (line[0] === "-") r++;
          }
        }
        const parts: string[] = [];
        if (a > 0) parts.push(`Added ${plural(a, "line")}`);
        if (r > 0) parts.push(`removed ${plural(r, "line")}`);
        return parts.length > 0 ? parts.join(", ") : null;
      }
      const lines = metadata.lines as number | undefined;
      if (lines !== undefined) return `Wrote ${plural(lines, "line")}`;
      return null;
    }

    default:
      return null;
  }
}

export function ToolOutput({ data, verbose = false }: ToolOutputProps) {
  const { toolName, inputPreview, status, outputLines, isError, metadata } = data;
  const iconConfig = STATUS_ICONS[status];
  const showDiff = hasDiffData(data) && !isError;
  const summary = (status === "success" || status === "error")
    ? formatToolSummary(toolName, metadata, isError, outputLines)
    : null;

  // Tools where summary fully replaces output (content goes to LLM, not useful to display)
  const summaryOnly = summary && toolName === "read_file" && !isError;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* Header: icon + tool name + preview */}
      <Box>
        {status === "executing" ? (
          <Spinner />
        ) : (
          <Text color={iconConfig.color}>{iconConfig.icon}</Text>
        )}
        <Text bold> {toolName}</Text>
        {inputPreview && (
          <>
            <Text color={INDICATOR_COLOR}> ─ </Text>
            <Text>{inputPreview}</Text>
          </>
        )}
        {status === "executing" && data.startedAt && (
          <ElapsedTimer startedAt={data.startedAt} />
        )}
      </Box>

      {/* Auto-approve indicator (expanded mode only) */}
      {verbose && data.approvalReason && status !== "executing" && (
        <Box paddingLeft={2}>
          <Text color={INDICATOR_COLOR}>⎿ </Text>
          <Text color={INDICATOR_COLOR}>✓ Auto-approved · {
            data.approvalReason === "auto_approve" ? "auto-approve tool" :
            data.approvalReason === "safe_command" ? "safe command" :
            data.approvalReason === "always_allowed" ? "always allowed" :
            data.approvalReason === "allow_all" ? "all tools allowed" :
            data.approvalReason === "accept_edits" ? "accept edits mode" :
            data.approvalReason
          }</Text>
        </Box>
      )}

      {/* Summary line (all tools with metadata) */}
      {summary && (
        <Box paddingLeft={2}>
          <Text color={INDICATOR_COLOR}>⎿ </Text>
          <Text color={isError ? "red" : "green"}>{summary}</Text>
        </Box>
      )}

      {/* Diff output for file edit tools */}
      {showDiff && metadata ? (
        <DiffOutput metadata={metadata} />
      ) : !summaryOnly ? (
        /* Standard output lines (unless summary fully replaces) */
        <OutputLines lines={outputLines} isError={isError} verbose={verbose} />
      ) : null}
    </Box>
  );
}
