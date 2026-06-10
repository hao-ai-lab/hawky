// =============================================================================
// Delivery — delivery-core surface, ported from C1a (realtime-proactive.ts).
// M0: types + baseline decideDelivery mapping only; M1 replaces with scored gate.
// =============================================================================

export type DeliverMode = "context" | "speak";
export type BusyPolicy  = "downgrade" | "cancel" | "queue";
export type VoiceStatus = "spoken" | "waiting" | "context" | "dropped";

/** Source-agnostic push item (§7) */
export interface PushItem {
  id: string;
  title: string;
  body: string;
  source: "intention" | "task" | "external";
  intentionId?: string;
  at?: string;
  /** Intention strength (drives must-deliver vs optional). Set for intention sources. */
  strength?: "hard" | "soft";
  /** Delivery-treatment hint for non-intention sources (e.g. "critical", external itemKind). */
  kind?: string;
  /** Intention origin — propagated from Intention.origin. "latent" → cautious suggest channel. */
  origin?: "obvious" | "latent";
  /** Latent confidence score [0,1] — propagated from Intention.confidence. */
  confidence?: number;
}

export interface DeliveryDecision {
  push: boolean;
  deliver: DeliverMode;
  busy: BusyPolicy;
}

/**
 * Baseline mapping ported from C1a.
 * M1 replaces this with a scored gate.
 *
 * Cases:
 *   at: set (time-critical) or kind:"critical"  → speak + cancel
 *   strength:"hard" (must-deliver intention)     → speak + queue
 *   everything else (soft intention / fact / context) → context + downgrade
 */
export function decideDelivery(item: PushItem): DeliveryDecision {
  if (item.at !== undefined || item.kind === "critical") {
    return { push: true, deliver: "speak", busy: "cancel" };
  }
  if (item.strength === "hard") {
    return { push: true, deliver: "speak", busy: "queue" };
  }
  // soft intention / fact / low-priority context (baseline; M1's scored gate replaces this)
  return { push: false, deliver: "context", busy: "downgrade" };
}
