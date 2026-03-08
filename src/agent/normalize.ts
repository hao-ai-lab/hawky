// =============================================================================
// Message Normalization
//
// Sanitizes conversation history before sending to the Anthropic API.
// Fixes structural issues that would cause API rejection:
// - Empty content blocks
// - Orphaned tool_results (no matching tool_use)
// - Missing tool_results (tool_use without matching result)
// - Consecutive same-role messages
// - First message not user role
//
// Also: tool result truncation for oversized outputs.
// =============================================================================

import type {
  ChatMessage,
  ContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
} from "./types.js";

// -----------------------------------------------------------------------------
// Tool result truncation
// -----------------------------------------------------------------------------

const TAIL_LINES = 20;

/**
 * Truncate a tool result string if it exceeds maxChars.
 * Preserves the last TAIL_LINES lines as a preview.
 */
export function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const lines = content.split("\n");
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  const tail = lines.slice(tailStart).join("\n");

  const notice =
    `[Output truncated: ${content.length.toLocaleString()} chars → ${maxChars.toLocaleString()}. ` +
    `Showing last ${Math.min(TAIL_LINES, lines.length)} lines]`;

  return `${notice}\n---\n${tail}`;
}

/**
 * Truncate all tool_result content blocks in a message.
 */
export function truncateToolResultsInMessage(
  message: ChatMessage,
  maxChars: number,
): ChatMessage {
  let changed = false;
  const newContent = message.content.map((block) => {
    // Only truncate string content (not multimodal array content like image blocks)
    if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > maxChars) {
      changed = true;
      return { ...block, content: truncateToolResult(block.content, maxChars) };
    }
    return block;
  });

  return changed ? { ...message, content: newContent } : message;
}

// -----------------------------------------------------------------------------
// Message normalization
// -----------------------------------------------------------------------------

/**
 * Normalize a message array to be valid for the Anthropic API.
 *
 * Fixes:
 * 1. Strip messages with empty content arrays
 * 2. Drop orphaned tool_results (no matching tool_use)
 * 3. Insert synthetic error results for tool_uses without matching tool_results
 * 4. Merge consecutive same-role messages
 * 5. Ensure first message is user role
 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  let result = messages;

  // Step 1: Strip empty content
  result = stripEmptyContent(result);

  // Step 2: Fix tool_use / tool_result pairing
  result = fixToolPairing(result);

  // Step 3: Merge consecutive same-role messages
  result = mergeConsecutiveSameRole(result);

  // Step 4: Ensure first message is user
  result = ensureFirstMessageIsUser(result);

  return result;
}

// -----------------------------------------------------------------------------
// Step 1: Strip empty content
// -----------------------------------------------------------------------------

function stripEmptyContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (msg) => msg.content && Array.isArray(msg.content) && msg.content.length > 0,
  );
}

// -----------------------------------------------------------------------------
// Step 2: Fix tool_use / tool_result pairing
// -----------------------------------------------------------------------------

function fixToolPairing(messages: ChatMessage[]): ChatMessage[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolUseIds.add(block.id);
        }
      }
    }
  }

  // Collect all tool_result IDs from user messages
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Drop orphaned tool_results (no matching tool_use)
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const filteredContent = msg.content.filter((block) => {
        if (block.type === "tool_result") {
          return toolUseIds.has(block.tool_use_id);
        }
        return true;
      });

      if (filteredContent.length > 0) {
        result.push(
          filteredContent.length === msg.content.length
            ? msg
            : { ...msg, content: filteredContent },
        );
      }
      // If all blocks were orphaned tool_results, drop the entire message
    } else {
      result.push(msg);
    }
  }

  // Insert synthetic results for unmatched tool_uses
  const finalResult: ChatMessage[] = [];
  for (let i = 0; i < result.length; i++) {
    finalResult.push(result[i]);

    if (result[i].role === "assistant") {
      const assistantMsg = result[i];
      const toolUses = assistantMsg.content.filter(
        (b): b is ToolUseContentBlock => b.type === "tool_use",
      );

      if (toolUses.length > 0) {
        // Check if the next message has matching tool_results
        const nextMsg = result[i + 1];
        const existingResultIds = new Set<string>();

        if (nextMsg?.role === "user") {
          for (const block of nextMsg.content) {
            if (block.type === "tool_result") {
              existingResultIds.add(block.tool_use_id);
            }
          }
        }

        // Find tool_uses without results
        const missingResults = toolUses.filter(
          (tu) => !existingResultIds.has(tu.id) && !toolResultIds.has(tu.id),
        );

        if (missingResults.length > 0) {
          const syntheticBlocks: ContentBlock[] = missingResults.map((tu) => ({
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: "[Tool result missing — execution may have been interrupted]",
            is_error: true,
          }));

          if (nextMsg?.role === "user") {
            // Append synthetic results to existing user message
            const updated = {
              ...nextMsg,
              content: [...nextMsg.content, ...syntheticBlocks],
            };
            // Replace the next message
            result[i + 1] = updated;
          } else {
            // Insert a new user message with synthetic results
            finalResult.push({
              role: "user",
              content: syntheticBlocks,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  return finalResult;
}

// -----------------------------------------------------------------------------
// Step 3: Merge consecutive same-role messages
// -----------------------------------------------------------------------------

function mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;

  const result: ChatMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge: combine content arrays
      result[result.length - 1] = {
        ...prev,
        content: [...prev.content, ...curr.content],
      };
    } else {
      result.push(curr);
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Step 4: Ensure first message is user
// -----------------------------------------------------------------------------

function ensureFirstMessageIsUser(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  if (messages[0].role === "user") return messages;

  // Prepend synthetic user message
  return [
    {
      role: "user",
      content: [{ type: "text", text: "[Continuing conversation]" }],
      timestamp: new Date().toISOString(),
    },
    ...messages,
  ];
}
