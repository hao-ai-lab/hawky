// =============================================================================
// send_message tool
//
// Lets the background agent send a message to an EXTERNAL messaging platform.
// Phase 1 supports Slack; the `platform` enum is the extension point for
// iMessage (BlueBubbles REST / Mac node) and others later.
//
// Slack reuses the already-registered Slack channel adapter
// (src/gateway/adapters/slack.ts → ChannelOutboundAdapter.sendText, which calls
// chat.postMessage), mirroring LangChain's Slack send-message tool. Nothing
// here talks to Slack directly — we go through the channel registry so config,
// tokens, and identity all stay in one place.
//
// NOTE: distinct from channel_send.ts, which posts into ANOTHER agent session's
// history. This sends OUT to a real messaging app.
// =============================================================================

import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";
import type { ChannelRegistry } from "../gateway/channel.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/send_message");

// Injected at gateway startup. Null in CLI/test contexts — the tool returns a
// clear error rather than importing the gateway (avoids a module cycle).
let _channels: ChannelRegistry | null = null;

export function setSendMessageDeps(channels: ChannelRegistry | null): void {
  _channels = channels;
}

export function resetSendMessageDeps(): void {
  _channels = null;
}

/** Platforms the tool can route to. Slack is live; others are reserved. */
const SUPPORTED_PLATFORMS = ["slack"] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

interface SendMessageInput {
  platform: Platform;
  to: string;
  text: string;
  thread_id?: string;
}

export async function executeSendMessage(
  input: SendMessageInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const platform = typeof input.platform === "string" ? input.platform.trim().toLowerCase() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const text = typeof input.text === "string" ? input.text : "";
  const threadId = typeof input.thread_id === "string" && input.thread_id.trim() ? input.thread_id.trim() : undefined;

  if (!platform) {
    return { type: "error", content: "Missing required parameter: platform (e.g. \"slack\")." };
  }
  if (!SUPPORTED_PLATFORMS.includes(platform as Platform)) {
    return {
      type: "error",
      content: `Unsupported platform "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}.`,
    };
  }
  if (!to) {
    return { type: "error", content: "Missing required parameter: to (channel, user id, or DM target)." };
  }
  if (!text.trim()) {
    return { type: "error", content: "Missing required parameter: text." };
  }

  if (!_channels) {
    return {
      type: "error",
      content: "send_message is not available in this context (channel registry not injected).",
    };
  }

  const adapter = _channels.getOutbound(platform);
  if (!adapter) {
    return {
      type: "error",
      content:
        `${platform} is not configured on the gateway. ` +
        `Set channels.${platform} in ~/.hawky/config.json and restart.`,
    };
  }
  if (!adapter.isReady()) {
    return {
      type: "error",
      content: `${platform} adapter is registered but not ready (check tokens / connection).`,
    };
  }

  // Resolve a human name to a concrete recipient. `to` is taken as-is when it
  // already looks like a channel (#name / C… / G…) or an id (U…/W…/D…);
  // otherwise it's treated as a name and fuzzy-matched against users AND
  // channels. The matched id (U… → DM, C…/G… → channel) is routed by sendText.
  let recipient = to;
  const looksLikeChannelOrId = /^[#@]/.test(to) || /^[CGUWD][A-Z0-9]{6,}$/.test(to);
  type Candidate = { id: string; label: string; kind?: "user" | "channel" };
  const resolver = (adapter as { resolveRecipients?: (q: string) => Promise<Candidate[]> }).resolveRecipients;
  if (!looksLikeChannelOrId && typeof resolver === "function") {
    let candidates: Candidate[] = [];
    try {
      candidates = await resolver.call(adapter, to);
    } catch (err) {
      return { type: "error", content: `Could not look up "${to}" on ${platform}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (candidates.length === 0) {
      return { type: "error", content: `No ${platform} user or channel matched "${to}". Ask the user for the exact name, @handle, or #channel.` };
    }
    if (candidates.length > 1) {
      const fmt = (c: Candidate) => `- ${c.label}${c.kind === "channel" ? " (#channel)" : ""} (${c.id})`;
      const list = candidates.slice(0, 8).map(fmt).join("\n");
      return {
        type: "text",
        content: `Multiple ${platform} matches for "${to}" — ask the user which one, then resend with their id:\n${list}`,
        metadata: { ambiguous: true, candidates },
      };
    }
    recipient = candidates[0].id;
    log.info("send_message resolved name", { query: to, resolved: recipient, label: candidates[0].label, kind: candidates[0].kind });
  }

  try {
    const result = await adapter.sendText({ to: recipient, text, threadId });
    if (!result.ok) {
      return { type: "error", content: `${platform} send failed: ${result.error ?? "unknown error"}` };
    }
    log.info("send_message delivered", { platform, to: recipient, chars: text.length, messageId: result.messageId });
    const sentLabel = recipient === to ? to : `${to} (${recipient})`;
    return {
      type: "text",
      content: `ok: sent to ${sentLabel} on ${platform}${result.messageId ? ` (id ${result.messageId})` : ""}`,
      metadata: { platform, to: recipient, query: to, messageId: result.messageId },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "error", content: `${platform} send failed: ${message}` };
  }
}

export const sendMessageToolDefinition: ToolDefinition<SendMessageInput> = {
  name: "send_message",
  description:
    "Send a message to an external messaging app on the user's behalf. " +
    "Currently supports Slack (DMs and channels). Use this to proactively reach " +
    "the user or their team outside the app — e.g. post to a Slack channel or DM. " +
    "This sends to a real messaging platform; use channel_send instead to move " +
    "content between Hawky sessions.",
  input_schema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: [...SUPPORTED_PLATFORMS],
        description: "Messaging platform to send through. Currently: \"slack\".",
      },
      to: {
        type: "string",
        description:
          "Recipient. Slack: a channel (\"#general\" or channel ID), a user ID for a DM, " +
          "OR a person's name/handle (e.g. \"xinkai\") — names are fuzzy-matched to a user " +
          "automatically; if several people match, the tool returns the candidates to ask about.",
      },
      text: {
        type: "string",
        description: "The message body to send.",
      },
      thread_id: {
        type: "string",
        description: "Optional. Slack thread_ts to reply within an existing thread.",
      },
    },
    required: ["platform", "to", "text"],
  },
  // Sending to an external system is a side effect — prompt the first time.
  // The permission cache can remember the approval afterward.
  permission: "ask_user",
  execute: executeSendMessage as any,
};
