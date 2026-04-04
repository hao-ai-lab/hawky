// =============================================================================
// Combined Image + Document Attachment Budget
//
// image-sanitize.ts and document-sanitize.ts each enforce their own bucket
// (10MB base64 for images, 50MB base64 for documents). But the Anthropic
// request body has a combined ceiling — if a session lives long enough to
// fill both buckets, the replayed history can still blow past it.
//
// This module runs *after* the two per-bucket sanitizers and, if the
// combined base64 total still exceeds the gateway-matched ceiling, drops
// oldest attachments first (across both buckets) until it fits.
// =============================================================================

import type { ChatMessage } from "./types.js";

/** Combined cap, base64 chars. Matches gateway ingress MAX_COMBINED_BASE64
 *  so a message that got in cannot later become unsendable as history grows. */
const MAX_COMBINED_ATTACHMENT_BASE64 = 55 * 1024 * 1024;

/** Placeholder used by the individual sanitizers. */
const IMAGE_PLACEHOLDER = "[image was previously shown to you]";
const SCREENSHOT_PLACEHOLDER = "[screenshot was previously shown to you]";
const DOCUMENT_PLACEHOLDER = "[document was previously shown to you]";

interface Ref {
  msgIdx: number;
  blockIdx: number;
  subIdx?: number;
  bytes: number;
  kind: "image" | "document";
}

/**
 * Trim attachments so combined base64 payload fits under the combined cap.
 * Runs oldest-first across both buckets. No current-turn exemption — this
 * is a hard upper bound from the provider, not a soft UX budget.
 */
export function sanitizeCombinedAttachmentBudget(messages: ChatMessage[]): void {
  const refs: Ref[] = [];
  let total = 0;

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi] as any;

      if (block.type === "image" && block.source?.data) {
        refs.push({ msgIdx: mi, blockIdx: bi, bytes: block.source.data.length, kind: "image" });
        total += block.source.data.length;
      }
      if (block.type === "document" && block.source?.data) {
        refs.push({ msgIdx: mi, blockIdx: bi, bytes: block.source.data.length, kind: "document" });
        total += block.source.data.length;
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let si = 0; si < block.content.length; si++) {
          const sub = block.content[si];
          if ((sub.type === "image" || sub.type === "document") && sub.source?.data) {
            refs.push({
              msgIdx: mi,
              blockIdx: bi,
              subIdx: si,
              bytes: sub.source.data.length,
              kind: sub.type,
            });
            total += sub.source.data.length;
          }
        }
      }
    }
  }

  if (total <= MAX_COMBINED_ATTACHMENT_BASE64) return;

  for (const ref of refs) {
    if (total <= MAX_COMBINED_ATTACHMENT_BASE64) break;
    const placeholder = ref.kind === "document"
      ? DOCUMENT_PLACEHOLDER
      : ref.subIdx != null ? SCREENSHOT_PLACEHOLDER : IMAGE_PLACEHOLDER;
    replaceWithPlaceholder(messages, ref, placeholder);
    total -= ref.bytes;
  }
}

function replaceWithPlaceholder(messages: ChatMessage[], ref: Ref, placeholder: string): void {
  if (ref.subIdx != null) {
    const block = messages[ref.msgIdx].content[ref.blockIdx] as any;
    block.content[ref.subIdx] = { type: "text", text: placeholder };
  } else {
    messages[ref.msgIdx].content[ref.blockIdx] = {
      type: "text",
      text: placeholder,
    } as any;
  }
}
