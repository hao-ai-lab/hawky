// =============================================================================
// Delivery Gate — scored delivery decision (§7).
//
// v1: a fired HARD intention is delivered definitively (spoken); soft/other →
// silent context. The seam (Channel, ScoreContext, ScoreResult, scoreDelivery)
// is preserved for future milestones; the richer factor math is still a stub.
// =============================================================================

import type { PushItem, DeliveryDecision } from "./delivery.js";
import type { Mode } from "./modes.js";

// -----------------------------------------------------------------------------
// Channel
// -----------------------------------------------------------------------------

export type Channel = "silent_card" | "haptic" | "earcon" | "speak" | "suggest";

// -----------------------------------------------------------------------------
// Score context
// -----------------------------------------------------------------------------

export interface ScoreContext {
  /** Current ambient mode — influences latent-origin delivery assertiveness. */
  mode?: Mode;
}

// -----------------------------------------------------------------------------
// Result
// -----------------------------------------------------------------------------

export interface ScoreResult {
  score: number;
  decision: DeliveryDecision;
  channel: Channel;
}

// -----------------------------------------------------------------------------
// scoreDelivery
// -----------------------------------------------------------------------------

/**
 * Delivery scoring:
 *   hard  → definitive spoken delivery (queued)                   channel:"speak"
 *   latent + directive mode → assertive spoken delivery (queued)  channel:"speak"
 *   latent + ambient/unset  → cautious suggest delivery (queued)  channel:"suggest"
 *   else  → silent context                                         channel:"silent_card"
 */
export function scoreDelivery(item: PushItem, ctx?: ScoreContext): ScoreResult {
  if (item.strength === "hard") {
    return {
      score: 1,
      decision: { push: true, deliver: "speak", busy: "queue" },
      channel: "speak",
    };
  }
  if (item.origin === "latent") {
    if (ctx?.mode === "directive") {
      return {
        score: 1,
        decision: { push: true, deliver: "speak", busy: "queue" },
        channel: "speak",
      };
    }
    // ambient or unset → cautious suggest
    return {
      score: 1,
      decision: { push: true, deliver: "speak", busy: "queue" },
      channel: "suggest",
    };
  }
  return {
    score: 1,
    decision: { push: true, deliver: "context", busy: "downgrade" },
    channel: "silent_card",
  };
}
