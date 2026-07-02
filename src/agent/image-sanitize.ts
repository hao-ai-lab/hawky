// =============================================================================
// Image History Sanitization
//
// Before each API call, scans conversation history for image blocks and
// ensures total image payload stays within budget. Images are kept for
// multi-turn reference (not stripped), but oldest images are replaced
// with placeholders when the budget is exceeded.
//
// Pattern: a proven sanitizeSessionMessagesImages() — runs on every
// replay, preventive rather than reactive.
// =============================================================================

import type { ChatMessage } from "./types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Max total image payload (base64 string length) across all messages.
 *  The Anthropic API counts base64 string bytes, not raw bytes.
 *  10MB base64 ≈ 7.5MB raw. Leaves headroom within the API request limit. */
const MAX_TOTAL_IMAGE_BASE64 = 10 * 1024 * 1024;

/** Max per-image base64 string length. The Anthropic API rejects images
 *  where the base64 field exceeds 5,242,880 bytes (5MB base64 = ~3.75MB raw).
 *  Any single image exceeding this is always replaced, regardless of budget. */
const MAX_SINGLE_IMAGE_BASE64 = 5 * 1024 * 1024;

/** Placeholder text for images removed due to budget. */
const IMAGE_PLACEHOLDER = "[image was previously shown to you]";

/** Placeholder text for screenshots removed due to budget. */
const SCREENSHOT_PLACEHOLDER = "[screenshot was previously shown to you]";

// -----------------------------------------------------------------------------
// Sanitization
// -----------------------------------------------------------------------------

interface ImageRef {
  /** Index into the messages array. */
  msgIdx: number;
  /** Index into the message's content array (for user/assistant images). */
  blockIdx: number;
  /** For tool_result with array content: index into the content array. */
  subIdx?: number;
  /** Raw byte size of the image (base64 length * 0.75). */
  bytes: number;
}

/**
 * Sanitize images in conversation history to stay within budget.
 * Mutates the messages array in place.
 *
 * Strategy: scan all images, compute total size. If over budget, replace
 * oldest images first with text placeholders until under budget.
 * The most recent turn's images are always kept (the model needs them).
 */
export function sanitizeHistoryImages(messages: ChatMessage[]): void {
  // Collect all image references with their sizes, oldest first
  const refs: ImageRef[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi] as any;

      // Direct image block (user-attached images)
      if (block.type === "image" && block.source?.data) {
        refs.push({
          msgIdx: mi,
          blockIdx: bi,
          bytes: block.source.data.length,
        });
      }

      // Tool result with image content (screenshots, read_file images)
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let si = 0; si < block.content.length; si++) {
          const sub = block.content[si];
          if (sub.type === "image" && sub.source?.data) {
            refs.push({
              msgIdx: mi,
              blockIdx: bi,
              subIdx: si,
              bytes: sub.source.data.length,
            });
          }
        }
      }
    }
  }

  if (refs.length === 0) return;

  // Phase 1: Remove any individual images that exceed the API per-image limit.
  // These would be rejected by the API regardless of total budget.
  // This also handles old session files written before the scrubbing fix.
  let totalBytes = 0;
  for (const ref of refs) {
    if (ref.bytes > MAX_SINGLE_IMAGE_BASE64) {
      replaceWithPlaceholder(messages, ref);
      ref.bytes = 0; // Mark as removed
    } else {
      totalBytes += ref.bytes;
    }
  }

  if (totalBytes <= MAX_TOTAL_IMAGE_BASE64) return;

  // Phase 2: Over budget — remove oldest images first until under budget.
  // Never remove images from the last user message (current turn).
  const lastUserMsgIdx = findLastUserMessageIndex(messages);

  for (const ref of refs) {
    if (totalBytes <= MAX_TOTAL_IMAGE_BASE64) break;
    if (ref.bytes === 0) continue; // Already removed in Phase 1

    // Don't remove images from the current turn
    if (ref.msgIdx >= lastUserMsgIdx) continue;

    replaceWithPlaceholder(messages, ref);
    totalBytes -= ref.bytes;
  }
}

/** Replace an image ref with a text placeholder. */
function replaceWithPlaceholder(messages: ChatMessage[], ref: ImageRef): void {
  if (ref.subIdx != null) {
    const block = messages[ref.msgIdx].content[ref.blockIdx] as any;
    block.content[ref.subIdx] = { type: "text", text: SCREENSHOT_PLACEHOLDER };
  } else {
    messages[ref.msgIdx].content[ref.blockIdx] = {
      type: "text",
      text: IMAGE_PLACEHOLDER,
    } as any;
  }
}

function findLastUserMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return messages.length;
}
