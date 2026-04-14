// =============================================================================
// Prompt cache breakpoint placement
//
// Anthropic prompt caching: by attaching `cache_control: { type: "ephemeral" }`
// to a content block in the request, Claude caches everything in the request
// up to and including that block for ~5 minutes. Subsequent requests sharing
// the exact same prefix are billed at the cache_read rate (~10× cheaper than
// fresh input). Up to 4 markers per request.
//
// Strategy here:
//   1. System prompt — wrap the string into a typed block and mark it.
//      Stable across the whole session; biggest single cacheable chunk.
//   2. Tools — mark the LAST tool. Tool definitions are stable across the
//      session; the marker caches [system + tools] as one prefix.
//   3. Last message in history — mark whichever block is at the very end of
//      the history (typically the just-appended user message, or a
//      tool_result mid-turn). The marker creates a prefix for [system +
//      tools + all-of-history-up-to-here]; the NEXT call adds new content
//      after that point and gets a cache hit on this whole prefix.
//
// All three markers form a hierarchy of cache prefixes; Anthropic uses the
// longest matching prefix on each subsequent call.
//
// Why this is a pure function: easy to test against fixtures; no provider
// or network coupling. The agent loop calls this right before handing the
// request to the provider; providers themselves stay oblivious.
// =============================================================================

import type {
  AnthropicToolDefinition,
  ContentBlock,
} from "./types.js";
import type { LLMStreamRequest, LLMSystemBlock, LLMMessage } from "./provider.js";

const EPHEMERAL_MARKER = { type: "ephemeral" as const };

/**
 * Return a new request with prompt-cache breakpoints applied. Does not
 * mutate the input.
 *
 * No-op when `system`, `tools`, and `messages` are all empty — there's
 * nothing to mark.
 */
export function applyCacheBreakpoints(req: LLMStreamRequest): LLMStreamRequest {
  return {
    ...req,
    system: markSystem(req.system),
    tools: markLastTool(req.tools),
    messages: markLastMessage(req.messages),
  };
}

/**
 * Wrap a string system prompt into a typed-block array carrying a cache
 * marker. If the caller already passed an array, mark its LAST block (so
 * upstream callers can compose multiple system blocks and we still cache
 * the whole thing). Empty / undefined → unchanged.
 */
function markSystem(
  system: string | LLMSystemBlock[] | undefined,
): string | LLMSystemBlock[] | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") {
    if (system.length === 0) return system;
    return [{ type: "text", text: system, cache_control: EPHEMERAL_MARKER }];
  }
  if (system.length === 0) return system;
  return system.map((block, idx) =>
    idx === system.length - 1 ? { ...block, cache_control: EPHEMERAL_MARKER } : block,
  );
}

/**
 * Mark the last tool with a cache breakpoint. Tools are typically stable
 * across calls; this caches [system + tools] as one shared prefix.
 */
function markLastTool(
  tools: AnthropicToolDefinition[] | undefined,
): AnthropicToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return tools;
  return tools.map((tool, idx) =>
    idx === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL_MARKER } : tool,
  );
}

/**
 * Mark the last block of the last message with a cache breakpoint.
 *
 * The last message is the most recent stable point in the conversation —
 * marking it caches [system + tools + every prior message]. The next API
 * call appends new content after this marker; everything before is then a
 * cache hit. Within a multi-iteration turn (tool_use → tool_result loop),
 * each iteration's marker advances forward, so each iteration also benefits.
 *
 * String-content messages get wrapped into a typed-block array so the
 * marker has somewhere to attach. Empty content blocks → unchanged
 * (nothing to mark).
 */
function markLastMessage(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  return messages.map((msg, idx) => {
    if (idx !== lastIdx) return msg;
    return { ...msg, content: markLastContentBlock(msg.content) };
  });
}

function markLastContentBlock(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === "string") {
    if (content.length === 0) return [];
    return [{ type: "text", text: content, cache_control: EPHEMERAL_MARKER }];
  }
  if (content.length === 0) return content;
  return content.map((block, idx) => {
    if (idx !== content.length - 1) return block;
    // Anthropic accepts cache_control on text, tool_result, image, and
    // document blocks. Multimodal user turns end in an image / document
    // block (sendMessage appends attachments AFTER the text), so without
    // image/document support those turns would silently skip the history
    // breakpoint and re-bill the full conversation on the next call.
    // tool_use blocks can't carry cache_control in our type model; for
    // those (rare — assistant rarely ends a message in a bare tool_use
    // without preceding text) we just leave the message unmarked.
    if (
      block.type === "text"
      || block.type === "tool_result"
      || block.type === "image"
      || block.type === "document"
    ) {
      return { ...block, cache_control: EPHEMERAL_MARKER };
    }
    return block;
  });
}
