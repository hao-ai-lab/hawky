// =============================================================================
// Document History Sanitization
//
// Before each API call, scans conversation history for document blocks
// (currently only PDFs) and ensures total document payload stays within
// budget. Documents are kept for multi-turn reference, but oldest ones
// are replaced with text placeholders when the budget is exceeded.
//
// Separate from image-sanitize.ts — documents have a much larger per-item
// and per-session budget, and live in their own accounting bucket so a
// 10MB PDF does not boot photos out of the conversation (or vice versa).
// =============================================================================

import type { ChatMessage } from "./types.js";

/** Max total document payload (base64 string length) across all messages.
 *  Anthropic's API allows 32MB per document — we cap the whole session at
 *  50MB base64 (~37.5MB raw), giving room for a few PDFs without starving
 *  the image budget. */
const MAX_TOTAL_DOCUMENT_BASE64 = 50 * 1024 * 1024;

/** Max per-document base64 string length. Above this, the Anthropic API
 *  rejects the call outright, so we replace the offender with a placeholder
 *  regardless of total-session usage. ~26MB base64 ≈ 20MB raw, matching
 *  MAX_PDF_RAW_BYTES in src/tools/read_file.ts. */
const MAX_SINGLE_DOCUMENT_BASE64 = 27 * 1024 * 1024;

/** Placeholder for documents removed due to budget. */
const DOCUMENT_PLACEHOLDER = "[document was previously shown to you]";

interface DocumentRef {
  msgIdx: number;
  blockIdx: number;
  /** When the doc lives inside a tool_result.content[] array. */
  subIdx?: number;
  /** base64 string length (not raw bytes). */
  bytes: number;
}

/**
 * Sanitize documents in conversation history to stay within budget.
 * Mutates the messages array in place.
 *
 * Strategy mirrors image-sanitize: scan all documents, compute total size,
 * drop oldest first when over budget, never touch the current-turn docs.
 */
export function sanitizeHistoryDocuments(messages: ChatMessage[]): void {
  const refs: DocumentRef[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi] as any;

      // User-attached document (direct document block in a user message)
      if (block.type === "document" && block.source?.data) {
        refs.push({
          msgIdx: mi,
          blockIdx: bi,
          bytes: block.source.data.length,
        });
      }

      // Document returned by a tool (document block inside a tool_result)
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let si = 0; si < block.content.length; si++) {
          const sub = block.content[si];
          if (sub.type === "document" && sub.source?.data) {
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

  // Phase 1: strip any single doc above the per-item limit.
  let totalBytes = 0;
  for (const ref of refs) {
    if (ref.bytes > MAX_SINGLE_DOCUMENT_BASE64) {
      replaceWithPlaceholder(messages, ref);
      ref.bytes = 0;
    } else {
      totalBytes += ref.bytes;
    }
  }

  if (totalBytes <= MAX_TOTAL_DOCUMENT_BASE64) return;

  // Phase 2: drop oldest docs until under budget. Unlike image-sanitize we
  // do NOT exempt the current turn — a single turn can carry multiple large
  // PDFs (agent calls read_file on several in parallel), and the combined
  // payload must still fit or the next API call fails. Oldest-first means
  // the most-recent PDF in the current turn is the last one sacrificed.
  for (const ref of refs) {
    if (totalBytes <= MAX_TOTAL_DOCUMENT_BASE64) break;
    if (ref.bytes === 0) continue;
    replaceWithPlaceholder(messages, ref);
    totalBytes -= ref.bytes;
  }
}

function replaceWithPlaceholder(messages: ChatMessage[], ref: DocumentRef): void {
  if (ref.subIdx != null) {
    const block = messages[ref.msgIdx].content[ref.blockIdx] as any;
    block.content[ref.subIdx] = { type: "text", text: DOCUMENT_PLACEHOLDER };
  } else {
    messages[ref.msgIdx].content[ref.blockIdx] = {
      type: "text",
      text: DOCUMENT_PLACEHOLDER,
    } as any;
  }
}
