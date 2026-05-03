// =============================================================================
// Channel Relay
//
// Shared helper for relaying session text to bound external channels.
// Called from:
//   - agent-turn.ts (deliverToSession — heartbeat/cron proactive delivery)
//   - agent-methods.ts (chat.send — interactive web/TUI turns)
//
// Full sync invariant: any assistant text produced in a session
// with channel bindings gets relayed to all bound conversations,
// regardless of which interface originated the turn.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { ChannelRegistry } from "./channel.js";
import type { SessionBindingService } from "./session-binding.js";

const log = createSubsystemLogger("gateway/channel-relay");

export interface RelayOpts {
  /** Hawky session key (e.g., "web:general"). */
  sessionKey: string;
  /** Assistant text to relay. */
  text: string;
  /** Channel registry (null = no channels configured, no-op). */
  registry: ChannelRegistry | null;
  /** Session binding service (null = no bindings configured, no-op). */
  bindings: SessionBindingService | null;
  /** Optional origin label for logs (e.g., "chat.send", "heartbeat"). */
  origin?: string;
}

/**
 * Relay assistant text to all channels bound to the given session.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * Only exact (non-wildcard) bindings are targeted — listBySession filters
 * out wildcard bindings since "*" is not a valid outbound destination.
 */
export function relayToChannels(opts: RelayOpts): void {
  const { sessionKey, text, registry, bindings, origin } = opts;

  if (!text) return;
  if (!registry || !bindings) return;

  const sessionBindings = bindings.listBySession(sessionKey);
  if (sessionBindings.length === 0) return;

  for (const binding of sessionBindings) {
    const adapter = registry.getOutbound(binding.channelId);
    if (!adapter?.isReady()) continue;

    void adapter.sendText({
      to: binding.conversationId,
      text,
    }).then((result) => {
      if (!result.ok) {
        log.warn("channel relay returned error", {
          channelId: binding.channelId,
          sessionKey,
          origin,
          error: result.error,
        });
      }
    }).catch((err) => {
      log.warn("channel relay failed (non-fatal)", {
        channelId: binding.channelId,
        sessionKey,
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
