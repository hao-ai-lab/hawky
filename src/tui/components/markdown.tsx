// =============================================================================
// Markdown & StreamingMarkdown Components
//
// React (Ink) components for rendering markdown in the TUI.
//
// <Markdown> — renders finalized markdown content as React elements.
// <StreamingMarkdown> — renders growing text with stable-prefix optimization.
//
// Architecture follows Claude Code's approach:
// - marked.lexer() parses markdown into tokens
// - Tokens are formatted to ANSI strings via formatToken()
// - Non-table content is grouped into <Text> elements
// - Tables are rendered separately (cli-table3)
// - StreamingMarkdown tracks a stable prefix boundary that only advances,
//   so completed blocks are never re-parsed (O(delta) per frame)
// - Module-level LRU cache (500 entries) for token parsing
// =============================================================================

import React, { useMemo, useRef } from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { highlight } from "cli-highlight";
import Table from "cli-table3";

// =============================================================================
// Language aliases (same as render_markdown.ts)
// =============================================================================

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  pgsql: "sql",
  mysql: "sql",
  postgresql: "sql",
  sqlite: "sql",
  dockerfile: "docker",
  md: "markdown",
};

function resolveLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const lower = lang.toLowerCase().trim();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

// =============================================================================
// Syntax highlighting
// =============================================================================

function highlightCode(code: string, lang: string | undefined): string {
  const resolved = resolveLanguage(lang);
  try {
    return highlight(code, { language: resolved, ignoreIllegals: true });
  } catch {
    return code;
  }
}

// =============================================================================
// Text wrapping (ANSI-aware)
// =============================================================================

/** Strip ANSI escape codes for width calculation */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Available width for markdown content (terminal minus padding + dot prefix) */
function getContentWidth(): number {
  const cols = process.stdout.columns ?? 80;
  // paddingX={1} = 2 chars, dot prefix = 2 chars, some margin = 2 chars
  return Math.max(20, cols - 6);
}

/** Wrap a single line to fit within the given width (ANSI-aware) */
function wrapLine(line: string, width: number): string[] {
  if (stripAnsi(line).length <= width) return [line];
  const words = line.split(/(\s+)/);
  const result: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const word of words) {
    const wordWidth = stripAnsi(word).length;
    if (currentWidth + wordWidth > width && current.length > 0) {
      result.push(current);
      current = "";
      currentWidth = 0;
      if (word.trim().length === 0) continue;
    }
    current += word;
    currentWidth += wordWidth;
  }
  if (current.length > 0) result.push(current);
  return result.length > 0 ? result : [line];
}

/** Wrap text to fit within the given width */
function wrapText(text: string, width: number): string {
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, width))
    .join("\n");
}

// =============================================================================
// Token cache (module-level LRU, survives unmount)
// =============================================================================

const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, Token[]>();

/** Fast hash for cache key — FNV-1a inspired */
function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) | 0;
  }
  return String(h);
}

/** Detect markdown syntax — skip lexer for plain text (single paragraph) */
const MD_SYNTAX_RE = /[#*`|[\]>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s);
}

// Disable strikethrough — model often uses ~ for "approximate" (e.g., ~100)
marked.use({
  tokenizer: {
    del() {
      return undefined as any;
    },
  },
});

function cachedLexer(content: string): Token[] {
  // Fast path: plain text with no markdown syntax → single paragraph token
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: "paragraph",
        raw: content,
        text: content,
        tokens: [{ type: "text", raw: content, text: content }],
      } as Token,
    ];
  }

  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) {
    // Promote to MRU
    tokenCache.delete(key);
    tokenCache.set(key, hit);
    return hit;
  }

  const tokens = marked.lexer(content);

  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    // LRU eviction: drop oldest (Map preserves insertion order)
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(key, tokens);
  return tokens;
}

// =============================================================================
// Token → ANSI string formatting
// =============================================================================

function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case "heading": {
      const text = formatInlineTokens(token.tokens ?? []);
      // Bold cyan for all headings
      return `\n\x1b[1;36m${text}\x1b[0m\n\n`;
    }

    case "paragraph": {
      const text = formatInlineTokens(token.tokens ?? []);
      const wrapped = wrapText(text, getContentWidth());
      return wrapped + "\n";
    }

    case "code": {
      const lang = resolveLanguage(token.lang || undefined);
      const highlighted = highlightCode(token.text, token.lang || undefined);
      const langLabel = lang ? `\x1b[90m[${lang}]\x1b[0m\n` : "";
      // Indent code blocks by 2 spaces
      const indented = highlighted
        .split("\n")
        .map((line: string) => "  " + line)
        .join("\n");
      return `\n${langLabel}${indented}\n\n`;
    }

    case "codespan":
      return `\x1b[36m${(token as any).text}\x1b[39m`;

    case "blockquote": {
      const inner = ((token as any).tokens ?? [])
        .map((t: Token) => formatToken(t))
        .join("");
      return (
        inner
          .trim()
          .split("\n")
          .map((line: string) => `\x1b[90m  │ ${line}\x1b[0m`)
          .join("\n") + "\n\n"
      );
    }

    case "list": {
      const t = token as Tokens.List;
      return (
        t.items
          .map((item: Token, i: number) =>
            formatToken(
              item,
              listDepth,
              t.ordered ? ((t.start ?? 1) as number) + i : null,
              token,
            ),
          )
          .join("") + "\n"
      );
    }

    case "list_item": {
      const bullet =
        orderedListNumber !== null ? `${orderedListNumber}. ` : "- ";
      const indent = "  ".repeat(listDepth);
      const parts: string[] = [];
      let isFirst = true;

      for (const sub of (token as any).tokens ?? []) {
        if (sub.type === "text" || sub.type === "paragraph") {
          const rawText = formatInlineTokens(sub.tokens ?? []);
          const itemWidth = getContentWidth() - indent.length - bullet.length;
          const text = wrapText(rawText, itemWidth);
          const continuationIndent = `${indent}${"  ".repeat(bullet.length)}`;
          if (isFirst) {
            const lines = text.split("\n");
            parts.push(`${indent}${bullet}${lines[0]}`);
            for (let li = 1; li < lines.length; li++) {
              parts.push(`${continuationIndent}${lines[li]}`);
            }
            isFirst = false;
          } else {
            parts.push(text.split("\n").map((l: string) => `${continuationIndent}${l}`).join("\n"));
          }
        } else if (sub.type === "code") {
          const highlighted = highlightCode(sub.text, sub.lang || undefined);
          const codeIndent = indent + "  ".repeat(bullet.length) + "  ";
          parts.push(
            highlighted
              .split("\n")
              .map((l: string) => codeIndent + l)
              .join("\n"),
          );
        } else if (sub.type === "space") {
          // skip
        } else {
          const rendered = formatToken(
            sub,
            listDepth + 1,
            orderedListNumber,
            token,
          );
          if (isFirst) {
            parts.push(`${indent}${bullet}${rendered.trim()}`);
            isFirst = false;
          } else {
            parts.push(
              rendered
                .trim()
                .split("\n")
                .map((l: string) => `${indent}${"  ".repeat(bullet.length)}${l}`)
                .join("\n"),
            );
          }
        }
      }
      return parts.join("\n") + "\n";
    }

    case "table":
      return renderTable(token as Tokens.Table);

    case "hr": {
      // Account for paddingX={1} (2 chars) + dot prefix (2 chars) = 4 chars
      const width = (process.stdout.columns ?? 80) - 8;
      return `\x1b[90m${"─".repeat(Math.max(10, width))}\x1b[0m\n\n`;
    }

    case "space":
      return "\n";

    case "br":
      return "\n";

    case "strong":
      return `\x1b[1m${formatInlineTokens((token as any).tokens ?? [])}\x1b[22m`;

    case "em":
      return `\x1b[3m${formatInlineTokens((token as any).tokens ?? [])}\x1b[23m`;

    case "del":
      return `\x1b[9m${formatInlineTokens((token as any).tokens ?? [])}\x1b[29m`;

    case "link": {
      const linkText = formatInlineTokens((token as any).tokens ?? []);
      return `\x1b[4m${linkText}\x1b[24m (${(token as any).href})`;
    }

    case "image":
      return `[image: ${(token as any).text ?? (token as any).href}]`;

    case "escape":
      return (token as any).text;

    case "html":
      return (token as any).text.replace(/<[^>]+>/g, "") + "\n";

    case "text": {
      if (parent?.type === "list_item") {
        const bullet =
          orderedListNumber !== null ? `${orderedListNumber}. ` : "- ";
        const indent = "  ".repeat(listDepth);
        const text = (token as any).tokens
          ? formatInlineTokens((token as any).tokens)
          : (token as any).text;
        return `${indent}${bullet}${text}\n`;
      }
      if ((token as any).tokens) {
        return formatInlineTokens((token as any).tokens);
      }
      return (token as any).text ?? "";
    }

    default: {
      if ("text" in token && typeof (token as any).text === "string") {
        return (token as any).text + "\n";
      }
      if ("raw" in token && typeof (token as any).raw === "string") {
        return (token as any).raw;
      }
      return "";
    }
  }
}

function formatInlineTokens(tokens: Token[]): string {
  return tokens.map((t) => formatToken(t)).join("");
}

// =============================================================================
// Table rendering (ANSI string via cli-table3)
// =============================================================================

function renderTable(token: Tokens.Table): string {
  const headers = (token.header ?? []).map((cell: any) =>
    formatInlineTokens(cell.tokens ?? []),
  );
  const rows = (token.rows ?? []).map((row: any) =>
    row.map((cell: any) => formatInlineTokens(cell.tokens ?? [])),
  );

  // Account for paddingX={1} (2 chars) + dot prefix (2 chars) = 4 chars
  const termWidth = (process.stdout.columns ?? 80) - 8;
  const colCount = headers.length;
  const maxColWidth = Math.max(10, Math.floor(termWidth / colCount) - 3);

  // Measure actual content width per column, cap at maxColWidth
  const contentWidths = headers.map((h, i) => {
    const cellWidths = [h.length, ...rows.map((r) => (r[i] ?? "").length)];
    return Math.min(Math.max(6, ...cellWidths) + 2, maxColWidth);
  });

  try {
    const table = new Table({
      head: headers,
      colWidths: contentWidths,
      wordWrap: true,
      wrapOnWordBoundary: true,
      style: { head: ["cyan"], border: ["gray"] },
    });
    for (const row of rows) {
      table.push(row);
    }
    return table.toString() + "\n\n";
  } catch {
    // Fallback: simple pipe-separated
    const lines: string[] = [];
    lines.push("  " + headers.join(" | "));
    lines.push("  " + headers.map(() => "---").join(" | "));
    for (const row of rows) {
      lines.push("  " + row.join(" | "));
    }
    return lines.join("\n") + "\n\n";
  }
}

// =============================================================================
// <Markdown> — React component for finalized markdown
//
// Renders markdown content as a single <Text> element (no nested Box layout).
// This is critical for Ink's <Static> which doesn't handle row layouts well
// in narrow terminals.
//
// Optional `prefix` prop (e.g., cyan ⏺ dot) is prepended to the first line
// and continuation lines are indented to align under the text.
// =============================================================================

interface MarkdownProps {
  children: string;
  /** Optional prefix prepended to first line (e.g., cyan dot). Continuation lines indented by prefix width. */
  prefix?: string;
}

export function Markdown({ children, prefix }: MarkdownProps): React.ReactElement {
  // Include terminal width in memo deps so content re-wraps on resize
  // (Static remount triggers re-render but children/prefix don't change)
  const termCols = process.stdout.columns ?? 80;
  const rendered = useMemo(() => {
    if (!children) return "";
    const trimmed = children.replace(/^\n+/, "");
    if (!trimmed) return "";

    const tokens = cachedLexer(trimmed);
    let output = tokens.map((token) => formatToken(token)).join("");

    // Clean up excessive newlines
    output = output.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");

    // Prepend prefix (dot) to first line, indent continuation lines
    if (prefix && output) {
      const prefixWidth = stripAnsi(prefix).length;
      const indent = " ".repeat(prefixWidth);
      const lines = output.split("\n");
      lines[0] = prefix + lines[0];
      for (let i = 1; i < lines.length; i++) {
        lines[i] = indent + lines[i];
      }
      output = lines.join("\n");
    }

    return output;
  }, [children, prefix, termCols]);

  if (!rendered) return <Text>{""}</Text>;
  return <Text>{rendered}</Text>;
}

// =============================================================================
// <StreamingMarkdown> — React component with stable-prefix optimization
//
// Algorithm (same as Claude Code):
// 1. Maintain a stablePrefixRef (byte offset into accumulated text)
// 2. Lex only from boundary to end — O(unstable_length), not O(full_text)
// 3. All tokens except the last are "complete blocks" — advance boundary
// 4. Render stable prefix via <Markdown> (memoized) + unstable tail
//
// Key insight: marked.lexer() treats unclosed code fences as a single
// token, so block boundaries are always safe to split on.
// =============================================================================

interface StreamingMarkdownProps {
  children: string;
  /** Optional prefix for first line (e.g., cyan dot) */
  prefix?: string;
}

export function StreamingMarkdown({
  children,
  prefix,
}: StreamingMarkdownProps): React.ReactElement {
  if (!children) return <Text>{prefix ?? ""}</Text>;
  const stripped = children.replace(/^\n+/, "");
  if (!stripped) return <Text>{prefix ?? ""}</Text>;

  const stablePrefixRef = useRef("");

  // Reset if text was replaced (e.g., agent restart)
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = "";
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = stablePrefixRef.current.length;
  const tokens = marked.lexer(stripped.substring(boundary));

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1;
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === "space") {
    lastContentIdx--;
  }

  let advance = 0;
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length;
  }

  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance);
  }

  const stableText = stablePrefixRef.current;
  const unstableSuffix = stripped.substring(stableText.length);

  // Render both stable and unstable blocks with markdown formatting.
  // The stable prefix is parsed from cache (fast), the unstable suffix
  // is parsed fresh each frame (it's the growing last block).
  // Concatenate raw formatted output BEFORE normalizing whitespace —
  // trimming each half independently would collapse block separators
  // (e.g., blank lines after headings) causing a layout jump on commit.
  const stableFormatted = stableText
    ? cachedLexer(stableText).map((t) => formatToken(t)).join("")
    : "";
  const unstableFormatted = unstableSuffix
    ? marked.lexer(unstableSuffix).map((t) => formatToken(t)).join("")
    : "";
  const combined = (stableFormatted + unstableFormatted)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  // Apply prefix (dot) and indentation
  if (prefix && combined) {
    const prefixWidth = stripAnsi(prefix).length;
    const indent = " ".repeat(prefixWidth);
    const lines = combined.split("\n");
    lines[0] = prefix + lines[0];
    for (let i = 1; i < lines.length; i++) {
      lines[i] = indent + lines[i];
    }
    return <Text>{lines.join("\n")}</Text>;
  }

  return <Text>{prefix ?? ""}{combined}</Text>;
}

// Export for testing
export { cachedLexer, formatToken, renderTable, hashContent };
