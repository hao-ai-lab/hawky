// =============================================================================
// Prepaint — Synchronous Terminal Rendering
//
// Renders historical messages directly to stdout, bypassing Ink's React
// rendering. Used for session resume to display the full conversation
// before Ink takes over for live updates.
//
// Same pattern as COCO's fullRepaint: write to stdout synchronously,
// then set staticBaseline so <Static> doesn't re-render them.
// =============================================================================

import type { DisplayMessage } from "../types.js";
import { renderMarkdown } from "./render_markdown.js";

/**
 * Prepaint display messages directly to stdout.
 * Clears the terminal first, then renders each message.
 * Returns the number of messages painted (for staticBaseline tracking).
 */
export function prepaintMessages(messages: DisplayMessage[]): number {
  if (messages.length === 0) return 0;

  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push("");
      lines.push(`  \x1b[1;32mYou\x1b[0m`);
      lines.push(`  ${msg.text}`);
    } else if (msg.role === "assistant") {
      const termWidth = process.stdout.columns ?? 80;
      const rendered = renderMarkdown(msg.text, termWidth);
      lines.push(`  \x1b[1;36mAssistant\x1b[0m`);
      lines.push(`  ${rendered}`);
    } else if (msg.role === "tool" && msg.toolData) {
      const { toolData } = msg;
      const icon = toolData.status === "success" ? "\x1b[32m✓\x1b[0m"
        : toolData.status === "error" ? "\x1b[31m✗\x1b[0m"
        : toolData.status === "canceled" ? "\x1b[90m⊘\x1b[0m"
        : "\x1b[33m⏱\x1b[0m";

      const preview = toolData.inputPreview
        ? ` \x1b[90m─\x1b[0m ${toolData.inputPreview}`
        : "";
      lines.push(`  ${icon} \x1b[1m${toolData.toolName}\x1b[0m${preview}`);

      // Output lines with tree branches (max 4)
      const outputLines = toolData.outputLines.slice(0, 4);
      const hiddenCount = toolData.outputLines.length - outputLines.length;
      for (let i = 0; i < outputLines.length; i++) {
        const isLast = i === outputLines.length - 1 && hiddenCount === 0;
        const branch = isLast ? "└─" : "├─";
        const color = outputLines[i].type === "stderr" && toolData.isError
          ? "\x1b[31m" : "";
        const reset = color ? "\x1b[0m" : "";
        lines.push(`    \x1b[90m${branch}\x1b[0m ${color}${outputLines[i].content}${reset}`);
      }
      if (hiddenCount > 0) {
        lines.push(`    \x1b[90m└─ ... (${hiddenCount} more lines)\x1b[0m`);
      }
    } else if (msg.role === "system") {
      lines.push("");
      lines.push(`  \x1b[3;90m${msg.text}\x1b[0m`);
    }
  }

  // Clear terminal then write all lines
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  process.stdout.write(lines.join("\n") + "\n");

  return messages.length;
}
