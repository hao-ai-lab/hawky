// =============================================================================
// Edit File Tool
//
// Surgical string replacement with a 6-strategy fuzzy matching cascade.
// Enforces unique matches by default; supports replace_all.
// Returns a context snippet after successful edit.
// When no match is found, suggests the closest match via similarity scoring.
// =============================================================================

import { stat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CONTEXT_LINES = 10;       // Lines of context before/after edit in result
const MAX_PREVIEW_CHARS = 50;   // Truncate old_string in error messages
const SUGGEST_THRESHOLD = 0.5;  // Minimum similarity to suggest a near-match
const MAX_DIFF_METADATA_CHARS = 50_000; // Cap diff strings in metadata to prevent transport blow-up

// -----------------------------------------------------------------------------
// Input type
// -----------------------------------------------------------------------------

interface EditFileInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

// -----------------------------------------------------------------------------
// Line ending utilities
// -----------------------------------------------------------------------------

type LineEnding = "\n" | "\r\n";

function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeToLF(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function restoreLineEnding(content: string, ending: LineEnding): string {
  if (ending === "\r\n") {
    return content.replaceAll("\n", "\r\n");
  }
  return content;
}

// -----------------------------------------------------------------------------
// String similarity (Levenshtein-based)
// -----------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshteinDistance(a, b) / maxLen;
}

// -----------------------------------------------------------------------------
// Fuzzy matching: 6-strategy cascade
//
// Our approach differs from other agents in grouping, naming, and ordering.
// Each strategy is a generator yielding candidate substrings from the file.
// The main loop checks each candidate for uniqueness.
//
// 1. Verbatim         — exact string match (baseline)
// 2. Flexible indent  — strips per-line edge whitespace OR base indentation
// 3. Normalized space — collapses all whitespace (tabs, multi-space, etc.)
// 4. Unescaped        — interprets literal escape sequences (\n, \t, etc.)
// 5. Boundary trimmed — trims leading/trailing whitespace from entire search
// 6. Anchor scan      — matches by first/last line anchors with interior
//                        similarity scoring; also handles partial line matches
//                        (>=50% inner lines match, or Levenshtein on interior)
// -----------------------------------------------------------------------------

type MatchFn = (content: string, find: string) => Generator<string>;

// Strategy 1: Verbatim — exact string match
function* verbatimMatch(_content: string, find: string): Generator<string> {
  yield find;
}

// Strategy 2: Flexible indent — handles indentation mismatches
// Combines what others split into "line-trimmed" and "indentation-flexible":
// First tries per-line trim comparison, then tries base-indent removal.
function* flexibleIndentMatch(content: string, find: string): Generator<string> {
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  // Strip trailing empty line from find if present
  const effectiveFindLines = [...findLines];
  if (effectiveFindLines.length > 1 && effectiveFindLines[effectiveFindLines.length - 1].trim() === "") {
    effectiveFindLines.pop();
  }
  if (effectiveFindLines.length === 0) return;

  const yielded = new Set<string>();

  // Pass A: per-line trim comparison (each line trimmed independently)
  for (let i = 0; i <= contentLines.length - effectiveFindLines.length; i++) {
    let match = true;
    for (let j = 0; j < effectiveFindLines.length; j++) {
      if (contentLines[i + j].trim() !== effectiveFindLines[j].trim()) {
        match = false;
        break;
      }
    }
    if (match) {
      const candidate = contentLines.slice(i, i + effectiveFindLines.length).join("\n");
      if (!yielded.has(candidate)) {
        yielded.add(candidate);
        yield candidate;
      }
    }
  }

  // Pass B: base-indent removal (strip minimum common indentation, then compare)
  const stripBaseIndent = (text: string): string => {
    const lines = text.split("\n");
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length === 0) return text;
    const minIndent = Math.min(...nonEmpty.map(l => {
      const m = l.match(/^(\s*)/);
      return m ? m[0].length : 0;
    }));
    if (minIndent === 0) return text;
    return lines.map(l => l.length >= minIndent ? l.slice(minIndent) : l).join("\n");
  };

  const normalizedFind = stripBaseIndent(find);
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (stripBaseIndent(block) === normalizedFind) {
      if (!yielded.has(block)) {
        yielded.add(block);
        yield block;
      }
    }
  }
}

// Strategy 3: Normalized space — collapse all whitespace to single spaces
function* normalizedSpaceMatch(content: string, find: string): Generator<string> {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = collapse(find);
  if (target === "") return;

  const contentLines = content.split("\n");
  const yielded = new Set<string>();

  // Single-line matches
  for (const line of contentLines) {
    if (collapse(line) === target && !yielded.has(line)) {
      yielded.add(line);
      yield line;
    }
  }

  // Multi-line block matches
  const findLineCount = find.split("\n").length;
  if (findLineCount > 1) {
    for (let i = 0; i <= contentLines.length - findLineCount; i++) {
      const block = contentLines.slice(i, i + findLineCount).join("\n");
      if (collapse(block) === target && !yielded.has(block)) {
        yielded.add(block);
        yield block;
      }
    }
  }
}

// Strategy 4: Unescaped — interpret literal escape sequences
// Uses single-pass replacement to avoid double-processing (e.g., \\t → \t vs \ + t)
function* unescapedMatch(content: string, find: string): Generator<string> {
  const escapeMap: Record<string, string> = {
    "\\\\": "\\", "\\n": "\n", "\\t": "\t", "\\r": "\r",
    "\\'": "'", '\\"': '"', "\\`": "`", "\\$": "$",
  };
  const unescape = (s: string): string => {
    return s.replace(/\\[\\ntr'"` $]/g, (match) => escapeMap[match] ?? match);
  };

  const unescaped = unescape(find);
  if (unescaped === find) return; // No escape sequences found

  if (content.includes(unescaped)) {
    yield unescaped;
  }
}

// Strategy 5: Boundary trimmed — trim surrounding whitespace from the search string
function* boundaryTrimmedMatch(content: string, find: string): Generator<string> {
  const trimmed = find.trim();
  if (trimmed === find || trimmed === "") return;

  if (content.includes(trimmed)) {
    yield trimmed;
  }
}

// Strategy 6: Anchor scan — match by first/last line, validate interior
// Combines "block-anchor" and "context-aware" concepts into one unified strategy.
// Tries two passes:
//   A) Fixed-length: same line count, >=50% inner line match
//   B) Variable-length: any span between anchors, scored by Levenshtein similarity
function* anchorScanMatch(content: string, find: string): Generator<string> {
  const findLines = find.split("\n");
  // Strip trailing empty line
  const effectiveFind = [...findLines];
  if (effectiveFind.length > 1 && effectiveFind[effectiveFind.length - 1].trim() === "") {
    effectiveFind.pop();
  }
  if (effectiveFind.length < 3) return;

  const contentLines = content.split("\n");
  const firstAnchor = effectiveFind[0].trim();
  const lastAnchor = effectiveFind[effectiveFind.length - 1].trim();
  if (firstAnchor === "" || lastAnchor === "") return;

  const yielded = new Set<string>();

  // Collect all (start, end) pairs where anchors match
  interface Span { start: number; end: number; }
  const spans: Span[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstAnchor) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastAnchor) {
        spans.push({ start: i, end: j });
      }
    }
  }
  if (spans.length === 0) return;

  // Pass A: Fixed-length spans with >=50% inner line match
  const fixedSpans = spans.filter(s => s.end - s.start + 1 === effectiveFind.length);
  for (const s of fixedSpans) {
    const innerFind = effectiveFind.slice(1, -1);
    const innerContent = contentLines.slice(s.start + 1, s.end);
    const nonEmpty = innerFind.filter(l => l.trim().length > 0);
    let matchCount = 0;
    for (let k = 0; k < innerFind.length; k++) {
      if (innerContent[k]?.trim() === innerFind[k].trim()) matchCount++;
    }
    const ratio = nonEmpty.length === 0 ? 1.0 : matchCount / nonEmpty.length;
    if (ratio >= 0.5) {
      const block = contentLines.slice(s.start, s.end + 1).join("\n");
      if (!yielded.has(block)) {
        yielded.add(block);
        yield block;
      }
    }
  }

  // Pass B: Variable-length spans, scored by Levenshtein on interior
  const findInner = effectiveFind.slice(1, -1).join("\n");
  let best: Span | null = null;
  let bestSim = -1;

  for (const s of spans) {
    const block = contentLines.slice(s.start, s.end + 1).join("\n");
    if (yielded.has(block)) continue; // Already yielded in pass A

    const blockInner = contentLines.slice(s.start + 1, s.end).join("\n");
    const sim = similarity(blockInner, findInner);
    if (sim > bestSim) {
      bestSim = sim;
      best = s;
    }
  }
  if (best && bestSim >= 0.3) {
    const block = contentLines.slice(best.start, best.end + 1).join("\n");
    if (!yielded.has(block)) {
      yield block;
    }
  }
}

// The ordered cascade
const MATCH_CASCADE: MatchFn[] = [
  verbatimMatch,
  flexibleIndentMatch,
  normalizedSpaceMatch,
  unescapedMatch,
  boundaryTrimmedMatch,
  anchorScanMatch,
];

// -----------------------------------------------------------------------------
// Nearest match suggestion (feature COCO doesn't have)
// When no match is found, we scan the file for the closest block and suggest it.
// -----------------------------------------------------------------------------

function findNearestMatch(content: string, find: string): string | null {
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  const findLineCount = findLines.length;

  let bestBlock = "";
  let bestSim = 0;

  // Slide a window of findLineCount lines over the file
  for (let i = 0; i <= contentLines.length - findLineCount; i++) {
    const block = contentLines.slice(i, i + findLineCount).join("\n");
    const sim = similarity(block, find);
    if (sim > bestSim) {
      bestSim = sim;
      bestBlock = block;
    }
  }

  // Also try single-line match for single-line searches
  if (findLineCount === 1) {
    for (const line of contentLines) {
      const sim = similarity(line, find);
      if (sim > bestSim) {
        bestSim = sim;
        bestBlock = line;
      }
    }
  }

  if (bestSim >= SUGGEST_THRESHOLD && bestBlock !== find) {
    return bestBlock;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Core replacement logic
// -----------------------------------------------------------------------------

interface ReplaceResult {
  new_content: string;
  match_index: number;
  matched_string: string;
}

function replaceOnce(content: string, oldString: string, newString: string): ReplaceResult {
  let anyFound = false;

  for (const matchFn of MATCH_CASCADE) {
    for (const candidate of matchFn(content, oldString)) {
      const index = content.indexOf(candidate);
      if (index === -1) continue;

      anyFound = true;
      const lastIndex = content.lastIndexOf(candidate);

      if (index === lastIndex) {
        // Unique — replace via concatenation (dollar-sign safe)
        const newContent =
          content.substring(0, index) +
          newString +
          content.substring(index + candidate.length);
        return { new_content: newContent, match_index: index, matched_string: candidate };
      }
    }
  }

  const preview = oldString.length > MAX_PREVIEW_CHARS
    ? oldString.substring(0, MAX_PREVIEW_CHARS) + "..."
    : oldString;

  if (anyFound) {
    throw `String found multiple times in file. old_string must be unique. Add more context to make it unique. (searching for: "${preview}")`;
  }

  // Not found — try to suggest nearest match
  const suggestion = findNearestMatch(content, oldString);
  if (suggestion) {
    const suggestionPreview = suggestion.length > 200
      ? suggestion.substring(0, 200) + "..."
      : suggestion;
    throw `String not found in file: "${preview}"\n\nDid you mean:\n${suggestionPreview}`;
  }

  throw `String not found in file: "${preview}"`;
}

function replaceAllOccurrences(
  content: string,
  oldString: string,
  newString: string,
): { new_content: string; count: number } {
  let result = content;
  let count = 0;
  let start = 0;

  while (true) {
    const idx = result.indexOf(oldString, start);
    if (idx === -1) break;
    result = result.substring(0, idx) + newString + result.substring(idx + oldString.length);
    start = idx + newString.length;
    count++;
  }

  if (count === 0) {
    const preview = oldString.length > MAX_PREVIEW_CHARS
      ? oldString.substring(0, MAX_PREVIEW_CHARS) + "..."
      : oldString;
    throw `String not found in file: "${preview}"`;
  }

  return { new_content: result, count };
}

// -----------------------------------------------------------------------------
// Context snippet generation
// -----------------------------------------------------------------------------

function generateContextSnippet(
  content: string,
  editStartIndex: number,
  newString: string,
): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  const beforeEdit = content.substring(0, editStartIndex);
  const editStartLine = beforeEdit.split("\n").length - 1;
  const newLineCount = newString.split("\n").length;

  const windowStart = Math.max(0, editStartLine - CONTEXT_LINES);
  const windowEnd = Math.min(totalLines, editStartLine + newLineCount + CONTEXT_LINES);

  const width = Math.max(String(windowEnd).length, 4);
  const snippetLines: string[] = [];
  for (let i = windowStart; i < windowEnd; i++) {
    snippetLines.push(`${String(i + 1).padStart(width)}\t${lines[i]}`);
  }

  return snippetLines.join("\n");
}

// -----------------------------------------------------------------------------
// Core edit logic (exported for testing)
// -----------------------------------------------------------------------------

export async function executeEditFile(
  input: EditFileInput,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await executeEditFileInner(input, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error editing file: ${msg}` };
  }
}

async function executeEditFileInner(
  input: EditFileInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { file_path, old_string, new_string, replace_all: doReplaceAll } = input;

  // --- Pre-abort check ---
  if (context.abort_signal.aborted) {
    return { type: "error", content: "Edit cancelled: operation was aborted before starting." };
  }

  // --- Validate parameters ---
  if (!file_path || typeof file_path !== "string") {
    return { type: "error", content: "Missing required parameter: file_path" };
  }
  if (old_string === undefined || old_string === null) {
    return { type: "error", content: "Missing required parameter: old_string" };
  }
  if (new_string === undefined || new_string === null) {
    return { type: "error", content: "Missing required parameter: new_string" };
  }
  if (old_string === "") {
    return { type: "error", content: "old_string must be non-empty" };
  }
  if (old_string === new_string) {
    return { type: "error", content: "old_string and new_string must be different" };
  }

  // --- Resolve path ---
  const resolved = resolve(context.working_directory, file_path);

  // --- Check file exists ---
  try {
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory()) {
      return { type: "error", content: `Cannot edit a directory: ${file_path}` };
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { type: "error", content: `File not found: ${file_path}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `Error accessing file: ${msg}` };
  }

  // --- Read file ---
  const rawContent = await readFile(resolved, "utf-8");

  // --- Detect and normalize line endings ---
  const originalEnding = detectLineEnding(rawContent);
  const content = normalizeToLF(rawContent);
  const normalizedOld = normalizeToLF(old_string);
  const normalizedNew = normalizeToLF(new_string);

  // --- Perform replacement ---
  let newContent: string;
  let message: string;
  let matchIndex = 0;
  const oldLineCount = normalizedOld.split("\n").length;
  const newLineCount = normalizedNew.split("\n").length;

  try {
    if (doReplaceAll) {
      const result = replaceAllOccurrences(content, normalizedOld, normalizedNew);
      newContent = result.new_content;
      message = `Replaced ${result.count} occurrence(s) of ${oldLineCount} line(s) with ${newLineCount} line(s) each.`;
    } else {
      const result = replaceOnce(content, normalizedOld, normalizedNew);
      newContent = result.new_content;
      matchIndex = result.match_index;
      message = `Replaced ${oldLineCount} line(s) with ${newLineCount} line(s).`;
    }
  } catch (err: unknown) {
    const msg = typeof err === "string" ? err : (err instanceof Error ? err.message : String(err));
    return { type: "error", content: msg };
  }

  // --- Restore line endings ---
  const finalContent = restoreLineEnding(newContent, originalEnding);

  // --- Write file ---
  await writeFile(resolved, finalContent, "utf-8");

  // --- Generate context snippet ---
  const totalLines = newContent.split("\n").length;
  let contextSnippet = "";
  if (!doReplaceAll) {
    contextSnippet = generateContextSnippet(newContent, matchIndex, normalizedNew);
  }

  // --- Build result ---
  const resultLines: string[] = [
    `File edited successfully: ${file_path}`,
    `${message} File now has ${totalLines} lines.`,
  ];
  if (contextSnippet) {
    resultLines.push("");
    resultLines.push("Context after edit:");
    resultLines.push(contextSnippet);
  }

  return {
    type: "text",
    content: resultLines.join("\n"),
    metadata: {
      file_path: resolved,
      total_lines: totalLines,
      lines_added: newLineCount,
      lines_removed: oldLineCount,
      replace_all: doReplaceAll ?? false,
      // Line number where the match starts (1-based), for accurate diff display
      match_line: doReplaceAll ? 1 : content.substring(0, matchIndex).split("\n").length,
      // Bounded diff strings for display (capped to prevent transport/UI blow-up)
      old_string: old_string.length <= MAX_DIFF_METADATA_CHARS ? old_string : null,
      new_string: new_string.length <= MAX_DIFF_METADATA_CHARS ? new_string : null,
    },
  };
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

export const editFileToolDefinition: ToolDefinition<EditFileInput> = {
  name: "edit_file",
  description:
    "Edit a file by replacing a specific string with new content. " +
    "The old_string must appear exactly once in the file for the edit to succeed " +
    "(use replace_all=true to replace all occurrences). " +
    "Includes fuzzy matching to handle minor whitespace and indentation differences.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to edit. Can be absolute or relative to the working directory.",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace. Must be unique in the file unless replace_all is true.",
      },
      new_string: {
        type: "string",
        description: "The replacement string.",
      },
      replace_all: {
        type: "boolean",
        description: "If true, replace all occurrences of old_string. Default: false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  permission: "ask_user",
  execute: executeEditFile as any,
};
