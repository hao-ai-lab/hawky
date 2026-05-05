// =============================================================================
// slack_list_members tool (#535)
//
// Lists the members of a Slack channel by a loose name ("research", "ambient",
// "my team" → whatever channel the user means). Reads the persisted Slack
// directory + relationship graph (src/gateway/adapters/slack-directory.ts) via
// the channel registry, so it answers "who's in #x" without per-call API fan-out.
//
// Pairs with send_message: use this to discover recipients, then send_message to
// reach one of them (or each, if the agent loops).
// =============================================================================

import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";
import type { ChannelRegistry } from "../gateway/channel.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/slack_list_members");

let _channels: ChannelRegistry | null = null;

export function setSlackListMembersDeps(channels: ChannelRegistry | null): void {
  _channels = channels;
}

export function resetSlackListMembersDeps(): void {
  _channels = null;
}

interface SlackListMembersInput {
  channel: string;
}

type Member = { id: string; label: string; handle?: string };

export async function executeSlackListMembers(
  input: SlackListMembersInput,
  _context: ToolContext,
): Promise<ToolResult> {
  const channel = typeof input.channel === "string" ? input.channel.trim() : "";
  if (!channel) {
    return { type: "error", content: "Missing required parameter: channel (a channel name or #channel)." };
  }
  if (!_channels) {
    return { type: "error", content: "slack_list_members is not available in this context (channel registry not injected)." };
  }

  const adapter = _channels.getOutbound("slack") as
    | { isReady?: () => boolean; getChannelMembersByName?: (name: string) => Promise<Member[]> }
    | undefined;
  if (!adapter) {
    return { type: "error", content: "slack is not configured on the gateway. Set channels.slack in ~/.hawky/config.json and restart." };
  }
  if (typeof adapter.getChannelMembersByName !== "function") {
    return { type: "error", content: "This gateway's Slack adapter does not support member lookup." };
  }
  if (adapter.isReady && !adapter.isReady()) {
    return { type: "error", content: "slack adapter is registered but not ready (check tokens / connection)." };
  }

  let members: Member[] = [];
  try {
    members = await adapter.getChannelMembersByName(channel);
  } catch (err) {
    return { type: "error", content: `Could not list members of "${channel}": ${err instanceof Error ? err.message : String(err)}` };
  }

  if (members.length === 0) {
    return {
      type: "text",
      content: `No members found for a Slack channel matching "${channel}" (the channel may not exist, the bot may not be in it, or membership isn't cached yet).`,
    };
  }

  const list = members.map((m) => `- ${m.label}${m.handle ? ` (@${m.handle})` : ""} [${m.id}]`).join("\n");
  log.info("slack_list_members", { channel, count: members.length });
  return {
    type: "text",
    content: `${members.length} member${members.length === 1 ? "" : "s"} in the Slack channel matching "${channel}":\n${list}`,
    metadata: { channel, members },
  };
}

export const slackListMembersToolDefinition: ToolDefinition<SlackListMembersInput> = {
  name: "slack_list_members",
  description:
    "List the members of a Slack channel by name (e.g. \"engineering\", \"#research\", or a loose name). " +
    "Use to answer \"who's in #x\" or to find the people on a team before messaging them. " +
    "Reads a cached directory, so it's fast and doesn't require the exact channel id.",
  input_schema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name or #channel (fuzzy-matched). e.g. \"research\", \"#general\".",
      },
    },
    required: ["channel"],
  },
  permission: "auto_approve",
  execute: executeSlackListMembers as any,
};
