// =============================================================================
// Display-only Notifications
//
// Broadcasts an ephemeral `notification.received` event to all clients
// subscribed to a session. Unlike `deliverToSession`, this path does NOT:
//   - push into the agent's in-memory history
//   - append to the session JSONL
//   - broadcast `agent.text` / `agent.done` events
//
// The payload is intended purely for UI display (distinct from agent
// speech) so external signals — heartbeat status, cron run summaries —
// don't pollute conversation context. Clients choose how to render
// notifications (dedicated card, toast, etc.) and may offer a copy
// action so the user can paste the content back into the input if they
// want to chat about it.
// =============================================================================

import { randomUUID } from "node:crypto";
import type { GatewayServer } from "./server.js";
import { createSubsystemLogger } from "./../logging/index.js";
import { sanitizeDeliveredText } from "./agent-turn.js";

const log = createSubsystemLogger("gateway/notification");

export interface BroadcastNotificationRequest {
  /** Target session that should see the notification (routing hint only). */
  sessionKey: string;
  /** Origin identifier — "heartbeat", "cron:standup", etc. */
  origin: string;
  /** Notification body — rendered inline in the chat area as a non-message card. */
  body: string;
  /** Optional short title; defaults to the origin. */
  title?: string;
}

export interface NotificationPayload {
  /** Unique id so clients can dedupe after reconnect. */
  id: string;
  sessionKey: string;
  origin: string;
  title: string;
  body: string;
  /** ISO timestamp. */
  timestamp: string;
}

/**
 * Broadcast a display-only notification to subscribers of `sessionKey`.
 *
 * Fire-and-forget. Never writes to disk. Never mutates session history.
 * Returns false if the body is empty (after scrubbing); otherwise true.
 *
 * Note: this intentionally does NOT go through the session lane — there
 * is nothing to serialize against and no in-flight turn to wait on.
 * Notifications are pure UI signals.
 */
export function broadcastNotification(
  request: BroadcastNotificationRequest,
  deps: { server: GatewayServer },
): boolean {
  const clean = sanitizeDeliveredText(request.body);
  if (!clean) {
    log.debug("notification skipped — body empty after scrubbing", {
      sessionKey: request.sessionKey,
      origin: request.origin,
    });
    return false;
  }

  const payload: NotificationPayload = {
    id: randomUUID(),
    sessionKey: request.sessionKey,
    origin: request.origin,
    title: request.title ?? request.origin,
    body: clean,
    timestamp: new Date().toISOString(),
  };

  deps.server.broadcastToSession(request.sessionKey, "notification.received", payload);

  log.info("notification broadcast", {
    sessionKey: request.sessionKey,
    origin: request.origin,
    bodyLength: clean.length,
  });
  return true;
}
