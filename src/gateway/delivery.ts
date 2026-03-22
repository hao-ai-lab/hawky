// =============================================================================
// Delivery System
//
// Routes notifications to the appropriate delivery channel.
// Implements: "none" (session only), "push" (Web Push), "announce" (channel adapter).
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { PushService, PushNotificationPayload } from "./push.js";
import type { ChannelRegistry } from "./channel.js";

const log = createSubsystemLogger("gateway/delivery");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DeliveryMode = "none" | "push" | "announce" | "webhook";

export interface DeliveryConfig {
  mode: DeliveryMode;
  channel?: string;  // Future: "slack", "web", "telegram"
  to?: string;       // Future: "#standup", "tab-1", webhook URL
}

export interface DeliveryResult {
  delivered: boolean;
  mode: DeliveryMode;
  error?: string;
}

// -----------------------------------------------------------------------------
// Delivery dispatcher
// -----------------------------------------------------------------------------

/** Global push service reference (set during gateway startup) */
let pushServiceRef: PushService | null = null;

/** Global channel registry reference (set during gateway startup) */
let channelRegistryRef: ChannelRegistry | null = null;

export function setPushService(service: PushService | null): void {
  pushServiceRef = service;
}

export function setChannelRegistry(registry: ChannelRegistry | null): void {
  channelRegistryRef = registry;
}

export function deliver(opts: {
  config: DeliveryConfig | undefined;
  title: string;
  message: string;
  isError?: boolean;
  /** Optional session key for notification click routing */
  sessionKey?: string;
}): DeliveryResult {
  const mode = opts.config?.mode ?? "none";

  switch (mode) {
    case "none":
      return { delivered: false, mode };

    case "push":
      if (!pushServiceRef?.enabled) {
        return { delivered: false, mode, error: "push not configured" };
      }
      void pushServiceRef.sendToAll({
        title: opts.title,
        body: opts.message,
        data: { sessionKey: opts.sessionKey, url: "/" },
      }).catch((err) => {
        log.warn("push delivery failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { delivered: true, mode };

    case "announce": {
      const channelId = opts.config?.channel;
      const to = opts.config?.to;
      if (!channelId || !to) {
        return { delivered: false, mode, error: "announce requires channel and to" };
      }
      if (!channelRegistryRef) {
        return { delivered: false, mode, error: "no channel registry configured" };
      }
      const adapter = channelRegistryRef.getOutbound(channelId);
      if (!adapter?.isReady()) {
        return { delivered: false, mode, error: `channel ${channelId} not ready` };
      }
      void adapter.sendText({ to, text: opts.message }).then((result) => {
        if (!result.ok) {
          log.warn("announce delivery returned error", {
            channelId,
            to,
            error: result.error,
          });
        }
      }).catch((err) => {
        log.warn("announce delivery failed (non-fatal)", {
          channelId,
          to,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { delivered: true, mode };
    }

    case "webhook":
      // Future: HTTP POST
      log.debug("webhook delivery not yet implemented", {
        to: opts.config?.to,
      });
      return { delivered: false, mode, error: "webhook delivery not yet implemented" };

    default:
      return { delivered: false, mode };
  }
}
