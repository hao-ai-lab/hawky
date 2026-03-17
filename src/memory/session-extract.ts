// =============================================================================
// Session Text Extraction
//
// Extracts searchable plain text from session JSONL files. Used by:
// - Memory index (PR 2): to index recent sessions for memory_search
// - Heartbeat distillation (PR 3): to extract facts into daily logs
//
// Supports byte-offset reading for incremental processing — only reads
// new content since the last extraction.
// =============================================================================

import type { ContentBlock, ChatMessage } from "../agent/types.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SessionTextResult {
  /** Combined plain text from user + assistant messages */
  text: string;
  /** Safe byte offset for next incremental read (end of last complete JSONL line).
   *  Use as `fromByteOffset` on the next call to avoid re-processing or skipping
   *  partially written lines from concurrent appends. */
  byteLength: number;
  /** Number of messages included in the output */
  messageCount: number;
  /** The byte offset we started reading from */
  fromOffset: number;
}

// -----------------------------------------------------------------------------
// Content extraction
// -----------------------------------------------------------------------------

/**
 * Extract plain text from a message's content blocks.
 * Only includes text blocks — skips tool_use, tool_result, image, thinking.
 */
export function extractTextFromContent(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n");
}

/**
 * Format a message for indexing.
 * Produces lines like "[user] Hello\n" or "[assistant] Here's the answer\n".
 */
function formatMessageForIndex(role: string, text: string): string {
  return `[${role}] ${text}\n`;
}

// -----------------------------------------------------------------------------
// JSONL reading
// -----------------------------------------------------------------------------

/**
 * Read session JSONL lines, optionally starting from a byte offset.
 * Returns only complete lines (up to the last newline). Any trailing
 * partial line (from a concurrent write) is excluded, and safeOffset
 * reflects the byte position after the last complete line — so the
 * caller won't skip over an in-progress entry on the next read.
 */
async function readSessionLines(
  filePath: string,
  fromByteOffset: number,
): Promise<{ lines: string[]; fileSize: number; safeOffset: number }> {
  const file = Bun.file(filePath);
  const fileSize = file.size;

  if (fileSize === 0 || fromByteOffset >= fileSize) {
    return { lines: [], fileSize, safeOffset: fileSize };
  }

  const slice = fromByteOffset > 0 ? file.slice(fromByteOffset) : file;
  const buffer = await slice.arrayBuffer();
  const text = new TextDecoder().decode(buffer);

  // Only consume up to the last newline — any trailing partial line
  // (from a concurrent write) is excluded so we re-read it next time.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    // No complete lines at all — don't advance the offset
    return { lines: [], fileSize, safeOffset: fromByteOffset };
  }

  const completeText = text.substring(0, lastNewline + 1);
  const lines = completeText.split("\n").filter((line) => line.trim());
  const safeOffset = fromByteOffset + Buffer.byteLength(completeText, "utf-8");

  return { lines, fileSize, safeOffset };
}

// -----------------------------------------------------------------------------
// Main extraction
// -----------------------------------------------------------------------------

/**
 * Extract searchable text from a session JSONL file.
 *
 * @param filePath - Absolute path to the session .jsonl file
 * @param fromByteOffset - Start reading from this byte offset (0 = full file).
 *   Use the `byteLength` from a previous call to read only new content.
 * @returns Extracted text, file size, and message count
 */
export async function extractSessionText(
  filePath: string,
  fromByteOffset = 0,
): Promise<SessionTextResult> {
  const { lines, safeOffset } = await readSessionLines(filePath, fromByteOffset);

  const parts: string[] = [];
  let messageCount = 0;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      // Skip corrupted or partial lines
      continue;
    }

    // Only process message entries with user or assistant role
    if (entry.type !== "message") continue;

    const message: ChatMessage = entry.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }

    const text = extractTextFromContent(message.content);
    if (!text) continue;

    parts.push(formatMessageForIndex(message.role, text));
    messageCount++;
  }

  return {
    text: parts.join(""),
    byteLength: safeOffset,
    messageCount,
    fromOffset: fromByteOffset,
  };
}
