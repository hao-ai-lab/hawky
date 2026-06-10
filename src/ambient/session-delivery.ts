// =============================================================================
// session-delivery.ts — build a NodeInvoker that delivers a fired/surfaced
// intention to a single live session via broadcast. Shared by IntentionService
// (timed fire) and LatentService (latent surfacing poll) so both delivery paths
// use ONE adapter rather than duplicating the frontend.message mapping.
// =============================================================================

import type { NodeInvoker } from "./delivery-service.js";

/** The gateway event the iOS bridge stream listens for (must use the `agent.` prefix). */
export const INTENTION_SURFACE_EVENT = "agent.intention_surface";

export interface SessionDeliveryDeps {
  /** server.broadcastToSession bound; returns the number of live connections that received the event. */
  broadcast: (sessionKey: string, event: string, payload: unknown) => number;
  /** True if any live connection is bound to sessionKey. */
  hasSession: (sessionKey: string) => boolean;
  /** The gateway event the iOS bridge listens for (e.g. INTENTION_SURFACE_EVENT). */
  event: string;
}

/**
 * A NodeInvoker that advertises a synthetic `frontend.message` node iff the
 * session is connected, and turns deliver()'s invoke into a broadcast of `event`.
 * Returns no_frontend_node when the event reaches zero live connections, so the
 * caller can react (fire: re-schedule a retry; surface: re-attempt next poll).
 */
export function makeSessionInvoker(
  sessionKey: string | undefined,
  deps: SessionDeliveryDeps,
): NodeInvoker {
  const { broadcast, hasSession, event } = deps;
  return {
    listConnected() {
      return sessionKey && hasSession(sessionKey)
        ? [{ nodeId: sessionKey, commands: ["frontend.message"] }]
        : [];
    },
    async invoke(nodeId, command, args) {
      if (command !== "frontend.message") return { ok: false, error: "unsupported_command" };
      const a = args as { id?: string; intentionId?: string; title?: string; body?: string; deliver?: string; busy?: string; cautious?: boolean };
      const delivered = broadcast(nodeId, event, {
        type: "intention_surface",
        id: a.id,
        intentionId: a.intentionId,
        title: a.title,
        body: a.body,
        speak: a.deliver === "speak",
        whenBusy: a.busy,
        cautious: a.cautious ?? false,
      });
      return delivered > 0 ? { ok: true } : { ok: false, error: "no_frontend_node" };
    },
  };
}
