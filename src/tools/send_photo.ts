// =============================================================================
// send_photo tool
//
// Uploads a photo (the current camera frame, captured by the web/iOS frontend)
// to Slack. The realtime model calls this during a live session — e.g. "send a
// picture of this to Slack" — and the browser attaches the current video frame
// as base64 JPEG (same capture path as the Cocktail Party face tools).
//
// Like send_message.ts, nothing here talks to Slack directly: it goes through
// the already-registered Slack channel adapter (ChannelOutboundAdapter.sendFile
// → files.uploadV2), so tokens, identity, and the default-recipient gate all
// stay in one place. Declared on the tool.invoke surface so the frontend can call it.
// =============================================================================

import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";
import type { ChannelRegistry } from "../gateway/channel.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/send_photo");

// Injected at gateway startup (same pattern as send_message). Null in CLI/test
// contexts — the tool returns a clear error rather than importing the gateway.
let _channels: ChannelRegistry | null = null;

export function setSendPhotoDeps(channels: ChannelRegistry | null): void {
  _channels = channels;
}

export function resetSendPhotoDeps(): void {
  _channels = null;
}

/** Platforms the tool can route to. Slack is live; others are reserved. */
const SUPPORTED_PLATFORMS = ["slack"] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

// Slack rejects very large uploads and base64 in a WS frame is costly; the
// frontend already downsizes to a 640px JPEG (~tens of KB), so this cap only
// guards against a malformed/oversized payload.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB decoded

interface SendPhotoInput {
  /** Raw base64 JPEG/PNG bytes (NO data: prefix). Attached by the frontend. */
  image_base64: string;
  /** Optional recipient: "#channel", a channel/user id, or a person's name. */
  to?: string;
  /** Optional caption posted with the photo. */
  comment?: string;
  /** Optional platform (default "slack"). */
  platform?: Platform;
}

/** Decode a base64 string (tolerating a leading data: URL prefix) to a Buffer. */
function decodeBase64Image(raw: string): Buffer | null {
  const cleaned = raw.includes(",") && raw.trimStart().startsWith("data:")
    ? raw.slice(raw.indexOf(",") + 1)
    : raw;
  const buf = Buffer.from(cleaned, "base64");
  return buf.length > 0 ? buf : null;
}

/** Sniff a sensible filename extension from the magic bytes (jpg/png/webp). */
function filenameFor(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "photo.jpg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "photo.png";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "photo.webp";
  return null;
}

export async function executeSendPhoto(
  input: SendPhotoInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const platform = (typeof input.platform === "string" ? input.platform.trim().toLowerCase() : "slack") || "slack";
  if (!SUPPORTED_PLATFORMS.includes(platform as Platform)) {
    return { type: "error", content: `Unsupported platform "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}.` };
  }

  const raw = typeof input.image_base64 === "string" ? input.image_base64.trim() : "";
  if (!raw) {
    return { type: "error", content: "Missing required parameter: image_base64 (the camera frame). Turn the camera on and try again." };
  }
  const data = decodeBase64Image(raw);
  if (!data) {
    return { type: "error", content: "image_base64 did not decode to any image data." };
  }
  if (data.length > MAX_IMAGE_BYTES) {
    return { type: "error", content: `Image too large (${Math.round(data.length / 1024)} KB; max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).` };
  }
  const filename = filenameFor(data);
  if (!filename) {
    return { type: "error", content: "image_base64 must decode to a supported image format (jpg, png, or webp)." };
  }

  if (!_channels) {
    return { type: "error", content: "send_photo is not available in this context (channel registry not injected)." };
  }
  const adapter = _channels.getOutbound(platform);
  if (!adapter) {
    return {
      type: "error",
      content: `${platform} is not configured on the gateway. Set channels.${platform} in ~/.hawky/config.json and restart.`,
    };
  }
  if (!adapter.isReady()) {
    return { type: "error", content: `${platform} adapter is registered but not ready (check tokens / connection).` };
  }
  if (typeof adapter.sendFile !== "function") {
    return { type: "error", content: `${platform} does not support file uploads.` };
  }

  // Resolve the destination. Explicit `to` wins; otherwise fall back to the
  // configured default recipient (your own DM via default_dm_user).
  const requested = typeof input.to === "string" ? input.to.trim() : "";
  let recipient = requested;
  if (!recipient) {
    const getDefault = (adapter as { getDefaultRecipient?: () => string | null }).getDefaultRecipient;
    const fallback = typeof getDefault === "function" ? getDefault.call(adapter) : null;
    if (!fallback) {
      return { type: "error", content: `No destination given and no default recipient configured (set channels.${platform}.default_dm_user).` };
    }
    recipient = fallback;
  }

  // Fuzzy-resolve a human name (e.g. "xinkai" or "#team") to an id, mirroring
  // send_message. Ids / #channels / @handles are taken as-is.
  const looksLikeChannelOrId = /^[#@]/.test(recipient) || /^[CGUWD][A-Z0-9]{6,}$/.test(recipient);
  type Candidate = { id: string; label: string; kind?: "user" | "channel" };
  const resolver = (adapter as { resolveRecipients?: (q: string) => Promise<Candidate[]> }).resolveRecipients;
  if (!looksLikeChannelOrId && typeof resolver === "function") {
    let candidates: Candidate[] = [];
    try {
      candidates = await resolver.call(adapter, recipient);
    } catch (err) {
      return { type: "error", content: `Could not look up "${recipient}" on ${platform}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (candidates.length === 0) {
      return { type: "error", content: `No ${platform} user or channel matched "${recipient}". Ask the user for the exact name, @handle, or #channel.` };
    }
    if (candidates.length > 1) {
      const list = candidates.slice(0, 8).map((c) => `- ${c.label}${c.kind === "channel" ? " (#channel)" : ""} (${c.id})`).join("\n");
      return {
        type: "text",
        content: `Multiple ${platform} matches for "${recipient}" — ask the user which one, then resend with their id:\n${list}`,
        metadata: { ambiguous: true, candidates },
      };
    }
    recipient = candidates[0].id;
  }

  const comment = typeof input.comment === "string" && input.comment.trim() ? input.comment.trim() : undefined;

  try {
    const result = await adapter.sendFile({ to: recipient, data, filename, comment });
    if (!result.ok) {
      return { type: "error", content: `${platform} photo upload failed: ${result.error ?? "unknown error"}` };
    }
    const sentLabel = requested && requested !== recipient ? `${requested} (${recipient})` : recipient;
    log.info("send_photo delivered", { platform, to: recipient, bytes: data.length, messageId: result.messageId });
    return {
      type: "text",
      content: `ok: photo sent to ${sentLabel} on ${platform}${comment ? " with caption" : ""}.`,
      metadata: { platform, to: recipient, bytes: data.length, messageId: result.messageId },
    };
  } catch (err) {
    return { type: "error", content: `${platform} photo upload failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const sendPhotoToolDefinition: ToolDefinition<SendPhotoInput> = {
  name: "send_photo",
  description:
    "Send a photo of what the camera currently sees to Slack. Call this when the " +
    "user asks to share, send, or post a picture of what's in front of them (e.g. " +
    "\"send a photo of this to Slack\" or \"share this with the team\"). The current " +
    "camera frame is captured and uploaded automatically — you do NOT provide the " +
    "image. Optionally target a channel or person with `to` and add a `comment`; " +
    "with no `to`, it goes to the user's own Slack DM.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Optional destination. Slack: \"#channel\" or channel ID, a user ID for a DM, " +
          "or a person's name/handle (fuzzy-matched). Omit to send to the user's own DM.",
      },
      comment: {
        type: "string",
        description: "Optional caption to post alongside the photo.",
      },
    },
    // image_base64 is attached by the frontend, not the model — so it is NOT
    // listed as required here (the model must not try to invent image bytes).
    required: [],
  },
  // Mirrors the face tools: invoked from the live frontend, sends immediately.
  permission: "auto_approve",
  execute: executeSendPhoto as any,
};
