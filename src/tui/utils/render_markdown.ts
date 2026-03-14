// =============================================================================
// Markdown Renderer
//
// Pure function: markdown string → ANSI-styled string for terminal display.
// Uses `marked` for parsing and `cli-highlight` for syntax highlighting.
// Same approach as COCO's renderMarkdown().
//
// Applied to committed assistant messages only (not during streaming).
// =============================================================================

import { Marked } from "marked";
import { highlight } from "cli-highlight";
import Table from "cli-table3";

// Use `any` for token types — marked v17's type exports are complex
// and vary between versions. The runtime token structure is stable.
/* eslint-disable @typescript-eslint/no-explicit-any */

// -----------------------------------------------------------------------------
// Language alias map (same as COCO)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Syntax highlighting
// -----------------------------------------------------------------------------

function highlightCode(code: string, lang: string | undefined): string {
  const resolved = resolveLanguage(lang);
  try {
    return highlight(code, {
      language: resolved,
      ignoreIllegals: true,
    });
  } catch {
    // Fallback: return unhighlighted code
    return code;
  }
}

// -----------------------------------------------------------------------------
// Text wrapping
// -----------------------------------------------------------------------------

// Strip ANSI escape codes for width calculation
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrapLine(line: string, width: number): string[] {
  const stripped = stripAnsi(line);
  if (stripped.length <= width) return [line];

  // Simple word-wrap (doesn't handle ANSI mid-word perfectly, but good enough)
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
      // Skip leading whitespace on new line
      if (word.trim().length === 0) continue;
    }
    current += word;
    currentWidth += wordWidth;
  }
  if (current.length > 0) result.push(current);

  return result.length > 0 ? result : [line];
}

function wrapText(text: string, width: number): string {
  if (width <= 0) return text;
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, width))
    .join("\n");
}

// -----------------------------------------------------------------------------
// Indent helper
// -----------------------------------------------------------------------------

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

// -----------------------------------------------------------------------------
// Markdown renderer
// -----------------------------------------------------------------------------

/**
 * Render markdown content to an ANSI-styled terminal string.
 *
 * @param content — raw markdown text
 * @param terminalWidth — terminal column width (for wrapping). 0 = no wrapping.
 * @returns ANSI-styled string
 */
export function renderMarkdown(content: string, terminalWidth = 0): string {
  // Effective width for text (account for 2-char indent padding)
  const textWidth = terminalWidth > 4 ? terminalWidth - 4 : 0;

  const marked = new Marked();
  const tokens = marked.lexer(content);
  const parts: string[] = [];

  for (const token of tokens) {
    parts.push(renderBlockToken(token, textWidth, terminalWidth));
  }

  let result = parts.join("").replace(/\n{3,}/g, "\n\n"); // Collapse excessive newlines

  // Final wrapping pass: ensure NO line exceeds terminal width.
  // Without this, long code lines, headings, and tables overflow the terminal,
  // causing terminal-level wrapping that Ink's yoga layout doesn't account for.
  // Over many messages in <Static>, the accumulated height error pushes all
  // content above the viewport in narrow terminals.
  if (terminalWidth > 0) {
    result = wrapText(result, terminalWidth);
  }

  return result;
}

// -----------------------------------------------------------------------------
// Block token rendering
// -----------------------------------------------------------------------------

function renderBlockToken(token: any, textWidth: number, termWidth: number): string {
  switch (token.type) {
    case "heading": {
      const text = renderInlineTokens(token.tokens ?? []);
      return `\n\x1b[1;36m${text}\x1b[0m\n\n`; // Bold cyan
    }

    case "paragraph": {
      const text = renderInlineTokens(token.tokens ?? []);
      const wrapped = textWidth > 0 ? wrapText(text, textWidth) : text;
      return wrapped + "\n\n";
    }

    case "code": {
      const lang = resolveLanguage(token.lang || undefined);
      const highlighted = highlightCode(token.text, token.lang || undefined);
      const langLabel = lang ? `\x1b[90m[${lang}]\x1b[0m\n` : "";
      const indented = indent(highlighted, 2);
      return `\n${langLabel}${indented}\n\n`;
    }

    case "list": {
      const items = token.items.map((item: any, i: any) => {
        const bullet = token.ordered ? `${(token.start ?? 1) + i}. ` : "- ";
        const bulletIndent = " ".repeat(2 + bullet.length);

        // List items can contain block tokens (paragraph, code, space)
        // Render each token, then indent continuation lines under the bullet
        const parts: string[] = [];
        let isFirst = true;
        for (const subToken of (item.tokens ?? [])) {
          if (subToken.type === "text" || subToken.type === "paragraph") {
            const text = renderInlineTokens(subToken.tokens ?? []);
            const wrapped = textWidth > 0 ? wrapText(text, textWidth - bullet.length) : text;
            const lines = wrapped.split("\n");
            if (isFirst) {
              parts.push(`  ${bullet}${lines[0]}`);
              parts.push(...lines.slice(1).map((l: string) => bulletIndent + l));
              isFirst = false;
            } else {
              parts.push(...lines.map((l: string) => bulletIndent + l));
            }
          } else if (subToken.type === "code") {
            const highlighted = highlightCode(subToken.text, subToken.lang || undefined);
            const lang = resolveLanguage(subToken.lang || undefined);
            const langLabel = lang ? `${bulletIndent}\x1b[90m[${lang}]\x1b[0m` : "";
            if (langLabel) parts.push(langLabel);
            const indented = indent(highlighted, 2 + bullet.length + 2);
            parts.push(indented);
          } else if (subToken.type === "space") {
            // Skip spaces between items
          } else {
            // Fallback: render as block and indent
            const rendered = renderBlockToken(subToken, textWidth - bullet.length, termWidth);
            const lines = rendered.trim().split("\n");
            if (isFirst) {
              parts.push(`  ${bullet}${lines[0]}`);
              parts.push(...lines.slice(1).map((l: string) => bulletIndent + l));
              isFirst = false;
            } else {
              parts.push(...lines.map((l: string) => bulletIndent + l));
            }
          }
        }
        return parts.join("\n");
      });
      return items.join("\n") + "\n\n";
    }

    case "blockquote": {
      const text = (token.tokens ?? []).map((t: any) => renderBlockToken(t, textWidth - 2, termWidth)).join("");
      const lines = text.trim().split("\n").map((l: any) => `\x1b[90m  │ ${l}\x1b[0m`);
      return lines.join("\n") + "\n\n";
    }

    case "table": {
      return renderTable(token, termWidth);
    }

    case "hr": {
      const width = termWidth > 0 ? termWidth - 2 : 40;
      return `\x1b[90m${"─".repeat(width)}\x1b[0m\n\n`;
    }

    case "space": {
      return "\n";
    }

    case "html": {
      // Strip HTML tags, show text content
      return token.text.replace(/<[^>]+>/g, "") + "\n";
    }

    default: {
      // Fallback: render raw text
      if ("text" in token && typeof token.text === "string") {
        return token.text + "\n";
      }
      if ("raw" in token && typeof token.raw === "string") {
        return token.raw;
      }
      return "";
    }
  }
}

// -----------------------------------------------------------------------------
// Inline token rendering
// -----------------------------------------------------------------------------

function renderInlineTokens(tokens: any[]): string {
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: any): string {
  switch (token.type) {
    case "text":
      // Text tokens can have nested inline tokens (bold, code, etc.)
      if (token.tokens && token.tokens.length > 0) {
        return renderInlineTokens(token.tokens);
      }
      return token.text ?? "";

    case "strong":
      return `\x1b[1m${renderInlineTokens(token.tokens ?? [])}\x1b[22m`; // Bold

    case "em":
      return `\x1b[3m${renderInlineTokens(token.tokens ?? [])}\x1b[23m`; // Italic

    case "codespan":
      return `\x1b[36m${token.text}\x1b[39m`; // Cyan

    case "del":
      return `\x1b[9m${renderInlineTokens(token.tokens ?? [])}\x1b[29m`; // Strikethrough

    case "link":
      return `\x1b[4m${renderInlineTokens(token.tokens ?? [])}\x1b[24m (${token.href})`; // Underline + URL

    case "image":
      return `[image: ${token.text ?? token.href}]`;

    case "br":
      return "\n";

    case "escape":
      return token.text;

    default:
      if ("text" in token && typeof token.text === "string") return token.text;
      if ("raw" in token && typeof token.raw === "string") return token.raw;
      return "";
  }
}

// -----------------------------------------------------------------------------
// Table rendering (using cli-table3)
// -----------------------------------------------------------------------------

function renderTable(token: any, termWidth: number): string {
  const headers = (token.header ?? []).map((cell: any) => renderInlineTokens(cell.tokens ?? []));
  const rows = (token.rows ?? []).map((row: any) =>
    row.map((cell: any) => renderInlineTokens(cell.tokens ?? [])),
  );

  // Calculate column widths based on actual content (not padded to terminal width)
  const colCount = headers.length;
  const availableWidth = termWidth > 0 ? termWidth - 4 : 80;
  const maxColWidth = Math.max(10, Math.floor(availableWidth / colCount) - 3);

  // Measure actual content width per column (header + all rows), cap at maxColWidth
  const contentWidths = headers.map((h: string, i: number) => {
    const cellWidths = [h.length, ...rows.map((r: string[]) => (r[i] ?? "").length)];
    return Math.min(Math.max(6, ...cellWidths) + 2, maxColWidth); // +2 for cell padding
  });

  try {
    const table = new Table({
      head: headers,
      colWidths: contentWidths,
      wordWrap: true,
      wrapOnWordBoundary: true,
      style: {
        head: ["cyan"],
        border: ["gray"],
      },
    });

    for (const row of rows) {
      table.push(row);
    }

    return table.toString() + "\n\n";
  } catch {
    // Fallback: simple pipe-separated table
    const lines: string[] = [];
    lines.push("  " + headers.join(" | "));
    lines.push("  " + headers.map(() => "---").join(" | "));
    for (const row of rows) {
      lines.push("  " + row.join(" | "));
    }
    return lines.join("\n") + "\n\n";
  }
}
