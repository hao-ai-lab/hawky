// =============================================================================
// Channel Registry
//
// Central registry for messaging app adapters. Each adapter registers here
// and the rest of the system (delivery, agent-turn, etc.) looks up adapters
// by channel ID without knowing about specific implementations.
// =============================================================================

import type {
  ChannelOutboundAdapter,
  ChannelInboundAdapter,
} from "./channel-types.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/channel");

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export class ChannelRegistry {
  private adapters = new Map<string, ChannelOutboundAdapter & Partial<ChannelInboundAdapter>>();

  /** Register a channel adapter. Replaces any existing adapter with the same channelId. */
  register(adapter: ChannelOutboundAdapter & Partial<ChannelInboundAdapter>): void {
    const id = adapter.channelId;
    if (this.adapters.has(id)) {
      log.warn("replacing existing channel adapter", { channelId: id });
    }
    this.adapters.set(id, adapter);
    log.info("channel adapter registered", { channelId: id });
  }

  /** Get the outbound adapter for a channel. */
  getOutbound(channelId: string): ChannelOutboundAdapter | undefined {
    return this.adapters.get(channelId);
  }

  /** Get the inbound adapter for a channel (if it supports inbound). */
  getInbound(channelId: string): ChannelInboundAdapter | undefined {
    const adapter = this.adapters.get(channelId);
    if (adapter && "start" in adapter && "onMessage" in adapter) {
      return adapter as ChannelInboundAdapter;
    }
    return undefined;
  }

  /** Check if a channel adapter is registered. */
  has(channelId: string): boolean {
    return this.adapters.has(channelId);
  }

  /** List all registered channel IDs. */
  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  /** Stop all adapters gracefully. */
  async stopAll(): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const [id, adapter] of this.adapters) {
      log.info("stopping channel adapter", { channelId: id });
      stops.push(
        adapter.stop().catch((err) => {
          log.warn("error stopping channel adapter", {
            channelId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }
    await Promise.all(stops);
    this.adapters.clear();
  }
}
