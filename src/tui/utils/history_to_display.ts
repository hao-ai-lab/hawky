// =============================================================================
// History → DisplayMessage Converter
//
// Converts ChatMessage[] (API format from session file) into DisplayMessage[]
// (TUI format) for visual restoration on session resume.
//
// Handles: user text, assistant text, tool_use → tool display entries,
//          tool_result → updates tool entries with output/status.
// =============================================================================

import type { ChatMessage, ContentBlock } from "../../agent/types.js";
import type { DisplayMessage, ToolDisplayData, ToolOutputLine } from "../types.js";
import { formatToolPreview } from "./format_tool_preview.js";

let restoreCounter = 0;

function nextRestoreId(): string {
  return `restore_${++restoreCounter}`;
}

/** Reset counter (for testing) */
export function resetRestoreCounter(): void {
  restoreCounter = 0;
}

/**
 * Convert a ChatMessage history into DisplayMessages for TUI rendering.
 *
 * Returns display messages in order, with tool_use entries paired with their
 * tool_result to show final status (success/error) and output.
 */
export function historyToDisplayMessages(messages: ChatMessage[]): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  // Track tool_use entries by tool_use_id so we can update them with results
  const toolEntryMap = new Map<string, DisplayMessage>();

  for (const msg of messages) {
    if (!msg.content || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      switch (block.type) {
        case "text": {
          if (msg.role === "user") {
            display.push({
              id: nextRestoreId(),
              role: "user",
              text: block.text,
              timestamp: msg.timestamp ?? "",
            });
          } else if (msg.role === "assistant") {
            display.push({
              id: nextRestoreId(),
              role: "assistant",
              text: block.text,
              timestamp: msg.timestamp ?? "",
            });
          }
          break;
        }

        case "tool_use": {
          const preview = formatToolPreview(block.name, block.input);
          const entry: DisplayMessage = {
            id: nextRestoreId(),
            role: "tool",
            text: "",
            timestamp: msg.timestamp ?? "",
            toolData: {
              toolUseId: block.id,
              toolName: block.name,
              inputPreview: preview,
              status: "success", // Default; updated by tool_result if present
              outputLines: [],
              isError: false,
            },
          };
          display.push(entry);
          toolEntryMap.set(block.id, entry);
          break;
        }

        case "tool_result": {
          const toolEntry = toolEntryMap.get(block.tool_use_id);
          if (toolEntry && toolEntry.toolData) {
            // Update the tool entry with result
            toolEntry.toolData.isError = block.is_error === true;
            toolEntry.toolData.status = block.is_error ? "error" : "success";
            if (block.content) {
              // content can be string or array (multimodal image results)
              const textContent = typeof block.content === "string"
                ? block.content
                : block.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
              toolEntry.toolData.outputLines = textContent
                .split("\n")
                .filter((line: string) => line.length > 0)
                .map((line: string) => ({
                  type: (block.is_error ? "stderr" : "stdout") as "stdout" | "stderr",
                  content: line,
                }));
            }
          }
          // tool_result entries are not displayed separately — they update the tool_use entry
          break;
        }

        case "thinking": {
          // Thinking blocks are not displayed on resume (same as COCO)
          break;
        }
      }
    }
  }

  return display;
}
