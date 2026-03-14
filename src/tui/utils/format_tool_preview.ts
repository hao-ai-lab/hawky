// =============================================================================
// Tool Input Preview Formatter
//
// Generates a one-line summary of a tool call's input for display in the TUI.
// Same pattern as COCO's formatToolInput(): tool-specific field extraction
// with 80-char truncation.
// =============================================================================

const MAX_PREVIEW_LENGTH = 80;

function truncate(str: string, maxLen: number = MAX_PREVIEW_LENGTH): string {
  const cleaned = str.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + "...";
}

/**
 * Extract the most relevant input field for a tool and format as a one-line preview.
 */
export function formatToolPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash":
      return truncate(String(input.command ?? ""));

    case "read_file":
    case "write_file":
    case "edit_file":
      return truncate(String(input.file_path ?? input.path ?? ""));

    case "glob":
      return truncate(String(input.pattern ?? ""));

    case "grep":
      return truncate(`"${String(input.pattern ?? "")}"`);

    case "web_fetch":
      return truncate(String(input.url ?? ""));

    case "web_search":
      return truncate(`"${String(input.query ?? "")}"`);

    case "ask_user":
      return truncate(String(input.question ?? ""));

    case "memory_search":
      return truncate(`"${String(input.query ?? "")}"`);

    case "memory_get":
      return truncate(String(input.path ?? ""));

    case "task_create":
      return truncate(String(input.description ?? ""));

    case "task_update":
      return truncate(`${String(input.task_id ?? "")} → ${String(input.status ?? "")}`);

    default: {
      // Fallback: find first short string value
      for (const value of Object.values(input)) {
        if (typeof value === "string" && value.length > 0 && value.length < 200) {
          return truncate(value);
        }
      }
      return "";
    }
  }
}
