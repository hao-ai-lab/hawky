// =============================================================================
// Tool display helpers — shared between ToolLine, ToolStep, and their tests.
//
// Extracted from the legacy ToolCard.tsx so the new tree-style UI
// (ToolStep → ToolLine) can reuse the formatting/diff/linkification logic
// without pulling in the old card-frame markup.
// =============================================================================

import { useState, useMemo, useEffect } from "react";
import { structuredPatch } from "diff";

const MAX_JSON_FORMAT_LENGTH = 20_000;

/** Try to detect and pretty-print JSON content. */
export function tryFormatJson(content: string): string {
  if (content.length > MAX_JSON_FORMAT_LENGTH || content.length === 0) return content;
  const trimmed = content.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      const formatted = JSON.stringify(parsed, null, 2);
      if (formatted !== trimmed) return formatted;
    } catch { /* not JSON */ }
  }
  return content;
}

/** Format elapsed milliseconds as a short human string. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** React hook for an elapsed timer that ticks every second while active. */
export function useElapsed(startedAt?: number, active = false): string | null {
  const [elapsed, setElapsed] = useState(() => (active && startedAt) ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (!active || !startedAt) { setElapsed(0); return; }
    setElapsed(Date.now() - startedAt);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [startedAt, active]);
  if (!active || !startedAt || elapsed < 1000) return null;
  return formatElapsed(elapsed);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animated braille spinner for running tools. */
export function AnimatedSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <>{SPINNER_FRAMES[frame]}</>;
}

/** Strip trailing punctuation from bare URLs. */
function stripTrailingPunct(url: string): string {
  let cleaned = url.replace(/[.,!?;:]+$/, "");
  let opens = 0, closes = 0;
  for (const ch of cleaned) { if (ch === "(") opens++; if (ch === ")") closes++; }
  while (closes > opens && cleaned.endsWith(")")) { cleaned = cleaned.slice(0, -1); closes--; }
  return cleaned;
}

/** Render text with clickable URLs (bare URLs, markdown links, file:// paths). */
export function LinkifiedText({ text }: { text: string }) {
  const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+|file:\/\/\/[^)]+)\)|https?:\/\/[^\s"'<>\]]+|file:\/\/\/[^\s"'<>\]]+/g;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = LINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));

    if (match[1] && match[2]) {
      parts.push(
        <a key={match.index} href={match[2]} target="_blank" rel="noopener noreferrer"
          className="text-link dark:text-link-dark underline underline-offset-2">{match[1]}</a>,
      );
    } else {
      const cleanUrl = stripTrailingPunct(match[0]);
      const trailing = match[0].slice(cleanUrl.length);
      parts.push(
        <a key={match.index} href={cleanUrl} target="_blank" rel="noopener noreferrer"
          className="text-link dark:text-link-dark underline underline-offset-2">{cleanUrl}</a>,
      );
      if (trailing) parts.push(trailing);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

// -----------------------------------------------------------------------------
// Diff rendering — for edit_file and write_file metadata
// -----------------------------------------------------------------------------

/** Compute structured diff lines from metadata using the diff package. */
export function computeDiffLines(metadata: Record<string, unknown>) {
  let oldStr: string | null = null;
  let newStr: string | null = null;
  const filePath = (metadata.file_path as string) ?? "file";

  if (typeof metadata.old_string === "string" && typeof metadata.new_string === "string") {
    oldStr = metadata.old_string;
    newStr = metadata.new_string;
  } else if (typeof metadata.new_content === "string" && metadata.new_content !== "__omitted__") {
    const oc = metadata.old_content;
    oldStr = (typeof oc === "string" && oc !== "__omitted__") ? oc : (oc === null ? "" : null);
    newStr = metadata.new_content;
    if (oldStr === null) return null;
  }

  if (newStr === null) return null;

  try {
    const patch = structuredPatch(filePath, filePath, oldStr ?? "", newStr, undefined, undefined, { context: 3 });
    if (!patch || patch.hunks.length === 0) return null;

    const result: { type: "add" | "del" | "ctx" | "hunk" | "sep"; lineNum?: number; content: string }[] = [];
    const lineOffset = typeof metadata.match_line === "number" ? (metadata.match_line as number) - 1 : 0;

    for (let hi = 0; hi < patch.hunks.length; hi++) {
      if (hi > 0) result.push({ type: "sep", content: "..." });
      const hunk = patch.hunks[hi];
      const adjOldStart = hunk.oldStart + lineOffset;
      const adjNewStart = hunk.newStart + lineOffset;
      result.push({ type: "hunk", content: `@@ -${adjOldStart},${hunk.oldLines} +${adjNewStart},${hunk.newLines} @@` });

      let oldLine = adjOldStart;
      let newLine = adjNewStart;
      for (const line of hunk.lines) {
        const marker = line[0];
        const content = line.substring(1);
        if (marker === "+") result.push({ type: "add", lineNum: newLine++, content });
        else if (marker === "-") result.push({ type: "del", lineNum: oldLine++, content });
        else { result.push({ type: "ctx", lineNum: oldLine++, content }); newLine++; }
      }
    }
    return result;
  } catch {
    return null;
  }
}

export function DiffView({ metadata, fallback }: { metadata: Record<string, unknown>; fallback?: React.ReactNode }) {
  const lines = useMemo(() => computeDiffLines(metadata), [metadata]);
  if (!lines || lines.length === 0) return fallback ?? null;

  return (
    <div className="font-mono text-xs leading-relaxed whitespace-pre">
      {lines.map((line, i) => {
        if (line.type === "hunk") {
          return (
            <div key={i} className="text-cyan-600 dark:text-cyan-400 select-none">
              {line.content}
            </div>
          );
        }
        if (line.type === "sep") {
          return (
            <div key={i} className="text-stone-400 dark:text-stone-600 select-none">...</div>
          );
        }
        const num = line.lineNum !== undefined ? String(line.lineNum).padStart(4) : "    ";
        return (
          <div
            key={i}
            className={
              line.type === "add"
                ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300"
                : line.type === "del"
                  ? "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300"
                  : "text-stone-500 dark:text-stone-500"
            }
          >
            <span className="inline-block w-10 text-right pr-2 text-stone-400 dark:text-stone-600 select-none">
              {num}
            </span>
            <span className="inline-block w-4 select-none">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            <span>{line.content}</span>
          </div>
        );
      })}
    </div>
  );
}

export function hasDiffMetadata(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  if (typeof metadata.old_string === "string" && typeof metadata.new_string === "string") return true;
  if (typeof metadata.new_content === "string" && metadata.new_content !== "__omitted__") {
    if (metadata.old_content === "__omitted__") return false;
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Summary and headline helpers
// -----------------------------------------------------------------------------

function pl(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  if (word.endsWith("ch") || word.endsWith("sh") || word.endsWith("x") || word.endsWith("s")) return `${n} ${word}es`;
  return `${n} ${word}s`;
}

/** One-line outcome summary from tool metadata (after completion). */
export function formatToolSummary(name: string, metadata?: Record<string, unknown>, _isError?: boolean, output?: string): string | null {
  if (!metadata) return null;
  switch (name) {
    case "bash": {
      const exitCode = metadata.exit_code as number | undefined;
      if (exitCode !== undefined) {
        if (exitCode === 0) {
          const hasRealOutput = output && output.trim().length > 0 && output.trim() !== "(no output)";
          return hasRealOutput ? null : "(no output)";
        }
        return `Exit ${exitCode} (error)`;
      }
      return null;
    }
    case "glob": {
      const count = metadata.count as number | undefined;
      if (count === 0) return "No files found";
      if (count !== undefined) return `Found ${pl(count, "file")}`;
      return null;
    }
    case "grep": {
      const count = metadata.count as number | undefined;
      if (count === 0) return "No matches found";
      if (count !== undefined) {
        const filesSearched = metadata.files_searched as number | undefined;
        const timedOut = metadata.timed_out as boolean | undefined;
        let summary = `Found ${pl(count, "match")}`;
        if (filesSearched) summary += ` in ${pl(filesSearched, "file")}`;
        if (timedOut) summary += " (timed out)";
        return summary;
      }
      return null;
    }
    case "read_file": {
      const total = metadata.total_lines as number | undefined;
      const shownFrom = metadata.shown_from as number | undefined;
      const shownTo = metadata.shown_to as number | undefined;
      if (metadata.binary) return "Binary file";
      if (total !== undefined) {
        if (shownFrom !== undefined && shownTo !== undefined) {
          return `Read ${pl(total, "line")} (lines ${shownFrom}-${shownTo})`;
        }
        return `Read ${pl(total, "line")}`;
      }
      return null;
    }
    case "web_search": {
      const count = metadata.count as number | undefined;
      const query = metadata.query as string | undefined;
      if (count === 0) return `No results for "${query ?? "..."}"`;
      if (count !== undefined) return `${pl(count, "result")} for "${query ?? "..."}"`;
      return null;
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
      if (added && added > 0) parts.push(`Added ${pl(added, "line")}`);
      if (removed && removed > 0) parts.push(`removed ${pl(removed, "line")}`);
      return parts.length > 0 ? parts.join(", ") : null;
    }
    case "write_file": {
      if (metadata.old_content === null && typeof metadata.new_content === "string" && metadata.new_content !== "__omitted__") {
        return `New file, ${pl((metadata.new_content as string).split("\n").length, "line")}`;
      }
      const lines = metadata.lines as number | undefined;
      if (lines !== undefined) return `Wrote ${pl(lines, "line")}`;
      return null;
    }
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Headlines — semantic labels for the collapsed step / tool line
// -----------------------------------------------------------------------------

/** Basename of a file path (handles trailing slashes). */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Truncate a string to N chars, adding an ellipsis if it was cut. */
function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

interface HeadlineInput {
  name: string;
  inputPreview: string;
  metadata?: Record<string, unknown>;
}

/**
 * Human-readable one-line label for a single tool — used both in a
 * single-tool step's header and alongside each tool inside a multi-tool step.
 *
 * Examples:
 *   bash "npm test"             → "Run bash"
 *   read_file "src/foo.ts"      → "Read foo.ts"
 *   edit_file "web/Bar.tsx"     → "Edit Bar.tsx"
 *   write_file "out.txt"        → "Write out.txt"
 *   grep "TODO"                 → "Search \"TODO\""
 *   web_fetch "https://..."     → "Fetch example.com"
 *   unknown tool                → "Run unknown_tool"
 */
export function formatToolHeadline({ name, inputPreview, metadata }: HeadlineInput): string {
  const raw = inputPreview ?? "";

  switch (name) {
    case "bash":
    case "shell":
      return raw ? `Run bash: ${clip(raw, 60)}` : "Run bash";

    // File tools: basename from the FULL path first, then clip. Clipping
    // before basename would chop the filename mid-word for deeply nested
    // paths and surface an intermediate directory as the "name".
    case "read_file":
    case "read":
      return raw ? `Read ${clip(basename(raw), 48)}` : "Read file";

    case "edit_file":
    case "edit":
      return raw ? `Edit ${clip(basename(raw), 48)}` : "Edit file";

    case "write_file":
    case "write":
      return raw ? `Write ${clip(basename(raw), 48)}` : "Write file";

    case "glob":
      return raw ? `Find ${clip(raw, 60)}` : "Find files";

    case "grep": {
      const pattern = typeof metadata?.pattern === "string" ? (metadata.pattern as string) : "";
      const q = pattern || raw;
      return q ? `Search "${clip(q, 40)}"` : "Search";
    }

    case "web_search": {
      const q = typeof metadata?.query === "string" ? (metadata.query as string) : raw;
      return q ? `Web search "${clip(q, 40)}"` : "Web search";
    }

    case "web_fetch": {
      const url = typeof metadata?.url === "string" ? (metadata.url as string) : raw;
      let host = url;
      try { host = new URL(url).hostname; } catch { /* keep raw */ }
      return host ? `Fetch ${clip(host, 40)}` : "Fetch URL";
    }

    default:
      return raw ? `Run ${name}: ${clip(raw, 60)}` : `Run ${name}`;
  }
}

/**
 * Label for a whole step (possibly containing multiple tools in parallel).
 *
 *   1 tool                 → formatToolHeadline for that tool
 *   N tools, all same kind → "N reads" / "N edits"
 *   N tools, mixed         → "N tools: Read, Edit, Bash"
 */
export function formatStepHeadline(tools: readonly HeadlineInput[]): string {
  if (tools.length === 0) return "(empty step)";
  if (tools.length === 1) return formatToolHeadline(tools[0]);

  const names = tools.map((t) => t.name);
  const uniq = [...new Set(names)];
  if (uniq.length === 1) {
    const prettyName = niceVerb(uniq[0]);
    return `${tools.length} ${plVerb(prettyName, tools.length)}`;
  }

  const displayNames = uniq.slice(0, 3).map(niceVerb);
  const more = uniq.length > 3 ? `, +${uniq.length - 3} more` : "";
  return `${tools.length} tools: ${displayNames.join(", ")}${more}`;
}

/** Map a tool name to its "verb" noun form for summary headlines. */
function niceVerb(toolName: string): string {
  switch (toolName) {
    case "bash":
    case "shell":
      return "bash command";
    case "read_file":
    case "read":
      return "read";
    case "edit_file":
    case "edit":
      return "edit";
    case "write_file":
    case "write":
      return "write";
    case "glob":
      return "glob";
    case "grep":
      return "search";
    case "web_search":
      return "web search";
    case "web_fetch":
      return "fetch";
    default:
      return toolName;
  }
}

/** Naive pluralization for the verb nouns — matches n≥2 cases we actually produce. */
function plVerb(verb: string, n: number): string {
  if (n === 1) return verb;
  // "bash command" → "bash commands"; "web search" → "web searches"; "search" → "searches"
  if (verb.endsWith("ch") || verb.endsWith("sh") || verb.endsWith("x") || verb.endsWith("s")) return `${verb}es`;
  return `${verb}s`;
}
