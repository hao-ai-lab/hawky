// =============================================================================
// Session Subscription Registry
//
// Bidirectional maps tracking which connections are subscribed to which sessions.
// Matches a proven SessionMessageSubscriberRegistry pattern.
//
// - sessionToConnIds: look up all subscribers for a session (for broadcast)
// - connToSessionKeys: look up all subscriptions for a connection (for cleanup)
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/subscriptions");

export interface SubscriptionRegistry {
  /** Subscribe a connection to a session's events. */
  subscribe(connId: string, sessionKey: string): void;
  /** Unsubscribe a connection from a session. */
  unsubscribe(connId: string, sessionKey: string): void;
  /** Unsubscribe a connection from ALL sessions (on disconnect). */
  unsubscribeAll(connId: string): void;
  /** Get all connection IDs subscribed to a session. */
  getSubscribers(sessionKey: string): ReadonlySet<string>;
  /** Get all session keys a connection is subscribed to. */
  getSubscribedSessions(connId: string): ReadonlySet<string>;
  /** Subscribe a connection to multiple sessions at once. */
  subscribeAll(connId: string, sessionKeys: string[]): void;
  /** Move all subscribers of `oldKey` onto `newKey`. Used by session rename. */
  rename(oldKey: string, newKey: string): void;
  /** Reset (for testing). */
  reset(): void;
}

export function createSubscriptionRegistry(): SubscriptionRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  const connToSessionKeys = new Map<string, Set<string>>();

  return {
    subscribe(connId: string, sessionKey: string): void {
      // Session → connection
      let conns = sessionToConnIds.get(sessionKey);
      if (!conns) {
        conns = new Set();
        sessionToConnIds.set(sessionKey, conns);
      }
      conns.add(connId);

      // Connection → session
      let sessions = connToSessionKeys.get(connId);
      if (!sessions) {
        sessions = new Set();
        connToSessionKeys.set(connId, sessions);
      }
      sessions.add(sessionKey);
    },

    unsubscribe(connId: string, sessionKey: string): void {
      const conns = sessionToConnIds.get(sessionKey);
      if (conns) {
        conns.delete(connId);
        if (conns.size === 0) sessionToConnIds.delete(sessionKey);
      }
      const sessions = connToSessionKeys.get(connId);
      if (sessions) {
        sessions.delete(sessionKey);
        if (sessions.size === 0) connToSessionKeys.delete(connId);
      }
    },

    unsubscribeAll(connId: string): void {
      const sessions = connToSessionKeys.get(connId);
      if (!sessions) return;
      for (const sessionKey of sessions) {
        const conns = sessionToConnIds.get(sessionKey);
        if (conns) {
          conns.delete(connId);
          if (conns.size === 0) sessionToConnIds.delete(sessionKey);
        }
      }
      connToSessionKeys.delete(connId);
      log.debug("unsubscribed all", { connId, count: sessions.size });
    },

    getSubscribers(sessionKey: string): ReadonlySet<string> {
      return sessionToConnIds.get(sessionKey) ?? new Set();
    },

    getSubscribedSessions(connId: string): ReadonlySet<string> {
      return connToSessionKeys.get(connId) ?? new Set();
    },

    subscribeAll(connId: string, sessionKeys: string[]): void {
      for (const key of sessionKeys) {
        this.subscribe(connId, key);
      }
      log.debug("subscribed to all sessions", { connId, count: sessionKeys.length });
    },

    rename(oldKey: string, newKey: string): void {
      if (oldKey === newKey) return;
      const conns = sessionToConnIds.get(oldKey);
      if (!conns || conns.size === 0) {
        sessionToConnIds.delete(oldKey);
        return;
      }
      // Merge into any existing subscribers of newKey (rare but possible if
      // a client subscribed to the new key before the rename landed).
      const merged = sessionToConnIds.get(newKey) ?? new Set<string>();
      for (const connId of conns) {
        merged.add(connId);
        const sessions = connToSessionKeys.get(connId);
        if (sessions) {
          sessions.delete(oldKey);
          sessions.add(newKey);
        }
      }
      sessionToConnIds.set(newKey, merged);
      sessionToConnIds.delete(oldKey);
      log.debug("subscriptions renamed", { oldKey, newKey, count: conns.size });
    },

    reset(): void {
      sessionToConnIds.clear();
      connToSessionKeys.clear();
    },
  };
}
