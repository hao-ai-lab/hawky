// =============================================================================
// Session Binding Service
//
// Maps external messaging conversations (Slack DMs, iMessage chats) to
// internal Hawky sessions. Enables bidirectional relay: inbound messages
// route to the bound session, and session responses relay to bound channels.
//
// For v1: simple in-memory bindings. All Slack bot DMs bind to a single
// configurable session (default: "web:general").
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/session-binding");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SessionBinding {
  /** Channel identifier (e.g., "slack"). */
  channelId: string;
  /** External conversation ID (e.g., Slack DM channel ID), or "*" for wildcard. */
  conversationId: string;
  /** Bound Hawky session key (e.g., "web:general"). */
  sessionKey: string;
  /** When this binding was created (epoch ms). */
  boundAt: number;
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class SessionBindingService {
  /** Key: "channelId:conversationId" → binding */
  private byConversation = new Map<string, SessionBinding>();

  /**
   * Bind an external conversation to a Hawky session.
   * Use conversationId="*" for wildcard (all conversations on this channel).
   */
  bind(channelId: string, conversationId: string, sessionKey: string): SessionBinding {
    const key = `${channelId}:${conversationId}`;
    const binding: SessionBinding = {
      channelId,
      conversationId,
      sessionKey,
      boundAt: Date.now(),
    };
    this.byConversation.set(key, binding);
    log.info("session binding created", { channelId, conversationId, sessionKey });
    return binding;
  }

  /**
   * Resolve which session an inbound message should route to.
   * Checks exact match first, then wildcard ("*").
   */
  resolve(channelId: string, conversationId: string): string | undefined {
    // Exact match
    const exact = this.byConversation.get(`${channelId}:${conversationId}`);
    if (exact) return exact.sessionKey;

    // Wildcard match
    const wildcard = this.byConversation.get(`${channelId}:*`);
    if (wildcard) return wildcard.sessionKey;

    return undefined;
  }

  /**
   * Resolve the session for an inbound message AND promote wildcard matches
   * to exact bindings. Call this when an inbound message arrives — it ensures
   * outbound relay (via listBySession) has a real conversationId to send to.
   *
   * Returns the bound session key, or undefined if no binding matches.
   */
  resolveAndBind(channelId: string, conversationId: string): string | undefined {
    // Exact match — no promotion needed
    const exact = this.byConversation.get(`${channelId}:${conversationId}`);
    if (exact) return exact.sessionKey;

    // Wildcard match — promote to exact binding so outbound can target it
    const wildcard = this.byConversation.get(`${channelId}:*`);
    if (wildcard) {
      this.bind(channelId, conversationId, wildcard.sessionKey);
      return wildcard.sessionKey;
    }

    return undefined;
  }

  /**
   * List all non-wildcard bindings for a given session key.
   * Used for outbound relay: when a session produces output,
   * relay it to all bound external conversations.
   *
   * Wildcard ("*") bindings are excluded — you can't send a message to "*".
   */
  listBySession(sessionKey: string): SessionBinding[] {
    const result: SessionBinding[] = [];
    for (const binding of this.byConversation.values()) {
      if (binding.sessionKey === sessionKey && binding.conversationId !== "*") {
        result.push(binding);
      }
    }
    return result;
  }

  /** Remove a specific binding. */
  unbind(channelId: string, conversationId: string): boolean {
    const key = `${channelId}:${conversationId}`;
    const existed = this.byConversation.has(key);
    this.byConversation.delete(key);
    if (existed) {
      log.info("session binding removed", { channelId, conversationId });
    }
    return existed;
  }

  /** List all bindings. */
  listAll(): SessionBinding[] {
    return Array.from(this.byConversation.values());
  }

  /** Clear all bindings. */
  clear(): void {
    this.byConversation.clear();
  }

  /**
   * Redirect all bindings from `oldKey` to `newKey`. Returns the number of
   * bindings updated. Used by session rename to keep inbound channel routing
   * pointed at the renamed session.
   */
  rebindAll(oldKey: string, newKey: string): number {
    if (oldKey === newKey) return 0;
    let count = 0;
    for (const binding of this.byConversation.values()) {
      if (binding.sessionKey === oldKey) {
        binding.sessionKey = newKey;
        count++;
      }
    }
    if (count > 0) {
      log.info("session bindings rebound", { oldKey, newKey, count });
    }
    return count;
  }
}
