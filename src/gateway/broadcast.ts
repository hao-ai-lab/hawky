// =============================================================================
// Event Broadcast
//
// Distributes EventFrames to connected clients. Supports broadcasting to all
// clients or only those bound to a specific session.
//
// Backpressure: Bun's ws.send() returns -1 when the client can't keep up.
// We log and skip events for slow consumers to prevent memory leaks.
//
// Pattern: a proven server-broadcast.ts.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { GatewayConnection } from "./connection.js";
import type { EventFrame } from "./protocol.js";
import type { SubscriptionRegistry } from "./subscriptions.js";

const log = createSubsystemLogger("gateway/broadcast");

// Global sequence counter for event ordering.
let eventSeq = 0;

/**
 * Broadcast an event to all authenticated connections.
 */
export function broadcast(
  connections: Map<string, GatewayConnection>,
  event: string,
  payload?: unknown,
): void {
  eventSeq++;
  const frame: EventFrame = { type: "event", event, payload, seq: eventSeq };

  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    const sent = conn.sendEvent(frame);
    if (!sent) {
      log.warn("event dropped (backpressure or closed)", { connId: conn.connId, event });
    }
  }
}

/**
 * Broadcast an event to all connections interested in a specific session.
 * Checks both subscription registry (web clients) and legacy session binding (TUI clients).
 * Payload is tagged with sessionKey so clients can route events.
 *
 * `excludeClientId` skips every connection that belongs to the acting
 * client — used by `user.message` and `session.rewound` to avoid echoing
 * a client's own action back to itself. We exclude by clientId, not by
 * the originating socket's connId, because one logical client can have
 * multiple sockets open at once (PWA service worker, dev tunnel,
 * reconnect overlap). Excluding only the originating socket would let
 * the broadcast leak back via the sibling socket and produce visible
 * echoes (duplicate user bubble, history-refetch racing the optimistic
 * bubble in chat.rewind).
 */
export function broadcastToSession(
  connections: Map<string, GatewayConnection>,
  sessionKey: string,
  event: string,
  payload?: unknown,
  subscriptions?: SubscriptionRegistry,
  excludeClientId?: string,
): number {
  eventSeq++;
  // Tag payload with sessionKey for client-side routing
  const taggedPayload = payload && typeof payload === "object"
    ? { ...payload, _sessionKey: sessionKey }
    : { _sessionKey: sessionKey, ...(payload != null ? { data: payload } : {}) };
  const frame: EventFrame = { type: "event", event, payload: taggedPayload, seq: eventSeq };

  const subscribers = subscriptions?.getSubscribers(sessionKey);

  let delivered = 0;
  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    if (excludeClientId && conn.clientId === excludeClientId) continue;
    // Match if: subscribed via registry OR legacy session binding
    const subscribed = subscribers?.has(conn.connId) ?? false;
    const legacyBound = conn.sessionKey === sessionKey;
    if (!subscribed && !legacyBound) continue;
    const sent = conn.sendEvent(frame);
    if (sent) {
      delivered++;
    } else {
      log.warn("event dropped (backpressure or closed)", { connId: conn.connId, event });
    }
  }
  return delivered;
}

/**
 * Get the current event sequence number (for testing).
 */
export function getEventSeq(): number {
  return eventSeq;
}

/**
 * Reset the event sequence counter. For testing only.
 */
export function resetBroadcast(): void {
  eventSeq = 0;
}
