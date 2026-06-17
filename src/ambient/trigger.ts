// =============================================================================
// Trigger — arming adapter interface (device-ack; logic in M3).
// =============================================================================

import type { Intention, TriggerTerm } from "./intention.js";

export interface ArmResult {
  ok: boolean;
  state: "armed" | "arm_failed";
  reason?: string;
  /**
   * #481: the prepare did not succeed yet, but the failure is RECOVERABLE — the
   * device is still working on it (e.g. waiting for the user to grant "Always"
   * location auth, which can't happen inside the arm timeout). The intention must
   * be left in pending_arm (NOT terminal arm_failed) so a late device ack can
   * still arm it. Only the where adapter sets this, on device_ack_timeout.
   */
  deferred?: boolean;
}

/**
 * One per trigger kind. Two-phase arming protocol:
 *   PHASE 1 — prepare(): slow/failable setup; does NOT make the trigger live.
 *   PHASE 2 — activate(): make the trigger live; called ONLY after the store is "armed".
 * Invariant: the store is always "armed" before any trigger fires.
 */
export interface ArmAdapter {
  kind: TriggerTerm["kind"];
  /** Phase 1: validate and set up (may be slow/failable). Does NOT schedule the trigger. */
  prepare(intention: Intention): Promise<ArmResult>;
  /** Phase 2: make the trigger live. Called only after store is "armed". */
  activate(intention: Intention): void | Promise<void>;
  disarm(intention: Intention): Promise<void>;
}

/**
 * Stable, unique key for a trigger term.
 * Encodes the kind + discriminating fields so that two `where` terms with
 * different place/category values produce distinct keys.
 */
export function termKey(term: TriggerTerm): string {
  switch (term.kind) {
    case "when":   return term.provenance === "inferred" && term.window ? `when:slot:${term.window.start}-${term.window.end}` : "when";
    case "where":  return `where:${term.place ?? ""}:${term.category ?? ""}`;
    case "who":    return `who:${term.entity ?? ""}:${term.scene ?? ""}`;
    case "topic":  return `topic:${term.topic}`;
    case "manual": return "manual";
  }
}

/**
 * Returns true when the term requires an arming adapter to become active.
 * Match-only terms (`where` with only category, `who`, `topic`, and inferred
 * `when` slot) need no adapter — they are evaluated by the matcher, not scheduled.
 * Provided `when` terms (alarms/relative timers) are armable and scheduled normally.
 */
export function isArmable(term: TriggerTerm): boolean {
  switch (term.kind) {
    case "when":   return term.provenance !== "inferred";
    case "where":  return !!term.place;
    case "who":    return false;
    case "topic":  return false;
    case "manual": return false;
  }
}
