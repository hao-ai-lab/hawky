// =============================================================================
// fire.ts — fireIntention: buildPushItem → deliver → store.transition("surfaced")
// Single fire→deliver path for cron fire and region-entry reports.
// All dependencies are injected for testability.
// =============================================================================

import type { Intention } from "./intention.js";
import type { IntentionStore } from "./intention-store.js";
import { buildPushItem } from "./broker.js";
import type { DeliverResult, NodeInvoker } from "./delivery-service.js";
import type { ScoreContext } from "./delivery-gate.js";
import { deliver } from "./delivery-service.js";
import { termKey, isArmable } from "./trigger.js";

// -----------------------------------------------------------------------------
// FireDeps — injected dependencies
// -----------------------------------------------------------------------------

export interface FireDeps {
  store: IntentionStore;
  nodes: NodeInvoker | undefined;
  scoreCtx?: ScoreContext;
  /** Override the deliver function (for tests). Defaults to the real deliver(). */
  deliverFn?: (
    item: ReturnType<typeof buildPushItem>,
    ctx: ScoreContext | undefined,
    nodes: NodeInvoker | undefined,
  ) => Promise<DeliverResult>;
  /**
   * Fix 8: Optional callback to disarm where-regions when the intention reaches a
   * terminal state (surfaced). Called after store.transition("surfaced") so stale
   * regions are removed from the device's monitored set.
   */
  disarmFn?: (intention: Intention) => Promise<void>;
}

// -----------------------------------------------------------------------------
// Term-satisfaction latch
// Keyed by intentionId → Set of satisfied trigger kinds.
// Cleared when intention fires or is reset.
// -----------------------------------------------------------------------------

const _satisfiedTerms = new Map<string, Set<string>>();

/** Exported for test teardown. */
export function _resetSatisfiedTerms(): void {
  _satisfiedTerms.clear();
  _inFlight.clear();
}

/** Exported for test inspection only. */
export function _getSatisfiedTerms(intentionId: string): Set<string> | undefined {
  return _satisfiedTerms.get(intentionId);
}

// -----------------------------------------------------------------------------
// In-flight claim Set (atomicity guard) — SHARED by fireIntention (armable path)
// and surfaceLatent (match-only path) via deliverAndMark. Prevents the poll clock
// and the model-pull tool from both delivering the same intention. Claimed inside
// deliverAndMark, i.e. AFTER fireIntention's conjunction check, so partial-term
// calls never hold the lock and block a peer that completes the conjunction.
// -----------------------------------------------------------------------------

const _inFlight = new Set<string>();

/** Returns true if the intention is currently being delivered (claim held by deliverAndMark). */
export function isInFlight(id: string): boolean {
  return _inFlight.has(id);
}

// -----------------------------------------------------------------------------
// fireIntention
// -----------------------------------------------------------------------------

/**
 * Fire an Intention into the delivery spine:
 *   buildPushItem → deliver → store.transition("surfaced")
 *
 * @param intention     - The intention (should be in "armed" state)
 * @param firedTermKey  - The termKey() of the trigger term that just fired (e.g. "when", "where::grocery:")
 * @param deps          - Injected dependencies
 *
 * For composite `all` triggers: all distinct term keys must fire before delivery.
 * For single-term triggers: fires immediately on the first term.
 *
 * Idempotent: if the intention is not in "armed" state (e.g. already surfaced), returns
 * {delivered:false} without delivering again.
 *
 * Resolves when delivery completes (or fails). On a delivered result the Intention
 * transitions to "surfaced"; on failure the Intention is left in "armed" state so the
 * caller can decide on retry policy.
 */
export async function fireIntention(intention: Intention, firedTermKey: string, deps: FireDeps): Promise<DeliverResult> {
  // Idempotency guard — re-fetch to check current state.
  const current = await deps.store.get(intention.id);
  if (!current || current.state !== "armed") {
    // Prune stale latch for non-armed intentions.
    _satisfiedTerms.delete(intention.id);
    return { delivered: false, voiceStatus: "dropped", reason: "not_armed" };
  }

  // Guard: the fired term key must actually be part of this intention's trigger
  // (e.g. don't deliver a when-only intention on a spurious "where" fire).
  const allTerms = current.trigger.all ?? [];
  const triggerKeys = new Set<string>(allTerms.map((t) => termKey(t)));
  if (!triggerKeys.has(firedTermKey)) {
    return { delivered: false, voiceStatus: "dropped", reason: "kind_not_in_trigger" };
  }

  // Match-only latent intentions must never enter the fire→deliver path.
  // An intention is match-only when NONE of its trigger terms are armable
  // (i.e. all terms are topic/who/category-only where). Such intentions are
  // surfaced by the broker, never driven through fireIntention.
  // Intentions with at least one armable term (when, or where with a place)
  // are legitimately armable and may fire via their armable terms.
  const intentionIsArmable = allTerms.some((t) => isArmable(t));
  if (!intentionIsArmable && allTerms.length > 0) {
    return { delivered: false, voiceStatus: "dropped", reason: "not_armable" };
  }

  // Record term satisfaction BEFORE any delivery check so that concurrent calls
  // for different composite terms always have their terms latched.
  // The in-flight guard is claimed only AFTER the conjunction check passes,
  // so partial-term calls return conjunction_incomplete without blocking peers.
  const conjunctionTerms = current.trigger.all;
  if (conjunctionTerms && conjunctionTerms.length > 1) {
    let satisfied = _satisfiedTerms.get(intention.id);
    if (!satisfied) {
      satisfied = new Set<string>();
      _satisfiedTerms.set(intention.id, satisfied);
    }
    satisfied.add(firedTermKey);

    // Check whether all required term keys are now satisfied.
    const requiredKeys = new Set(conjunctionTerms.map((t) => termKey(t)));
    for (const key of requiredKeys) {
      if (!satisfied.has(key)) {
        // Not all terms satisfied yet — do not deliver.
        return { delivered: false, voiceStatus: "dropped", reason: "conjunction_incomplete" };
      }
    }
    // All terms satisfied — fall through to delivery.
  }

  // Deliver via the shared deliver+transition tail (owns the in-flight claim).
  const result = await deliverAndMark(current, deps);
  if (result.delivered) {
    // Clear latch only after successful delivery so a retry can re-fire.
    _satisfiedTerms.delete(intention.id);
  }
  return result;
}

// -----------------------------------------------------------------------------
// deliverAndMark — shared deliver + transition("surfaced") tail.
// Owns the in-flight claim so fire (armable) and surface (match-only) can never
// double-deliver the same intention across the poll and the model-pull tool.
// On a delivered result the intention transitions armed -> surfaced; on failure
// it is left as-is so the caller decides retry policy.
// -----------------------------------------------------------------------------

export async function deliverAndMark(intention: Intention, deps: FireDeps): Promise<DeliverResult> {
  if (_inFlight.has(intention.id)) {
    return { delivered: false, voiceStatus: "dropped", reason: "in_flight" };
  }
  _inFlight.add(intention.id);
  try {
    // Re-fetch immediately after claiming to guard against a concurrent
    // decline/satisfaction-sweep that may have moved the intention to
    // suppressed/resolved/superseded between the caller's read and this claim.
    const current = await deps.store.get(intention.id);
    if (!current || current.state !== "armed") {
      return { delivered: false, voiceStatus: "dropped", reason: "not_armed" };
    }
    const item = buildPushItem({ kind: "intention", intention: current });
    const deliverFn = deps.deliverFn ?? deliver;
    const result = await deliverFn(item, deps.scoreCtx, deps.nodes);
    if (result.delivered) {
      // Re-fetch after awaiting delivery: the state may have changed during the
      // async deliver call (e.g. satisfaction sweep suppressed the intention).
      // Only transition to "surfaced" if still "armed"; otherwise return the
      // delivery result without transitioning so no illegal-transition is thrown.
      const afterDelivery = await deps.store.get(current.id);
      if (afterDelivery?.state === "armed") {
        try {
          await deps.store.transition(current.id, "surfaced");
        } catch {
          // Final-race guard: if a concurrent write moved the state between our
          // re-fetch and the transition call, treat it as a state_changed result.
          return { delivered: result.delivered, voiceStatus: result.voiceStatus, reason: "state_changed" };
        }
        // Fix 8: disarm where-regions on a successful surface so stale regions don't keep firing.
        if (deps.disarmFn) {
          await deps.disarmFn(current).catch(() => {});
        }
      }
      // If state is no longer "armed" (e.g. suppressed mid-delivery), skip
      // the transition (and disarm) and return the delivery result as-is.
    }
    return result;
  } finally {
    _inFlight.delete(intention.id);
  }
}

// -----------------------------------------------------------------------------
// surfaceLatent — surface a match-only latent intention (poll / model-pull clock).
// Match-only latents never enter fireIntention (not_armable); they surface here
// when matchLatent decides the context is right. No retry on a missing frontend
// node — a soft suggestion simply re-attempts on the next poll while still armed.
// -----------------------------------------------------------------------------

export async function surfaceLatent(intention: Intention, deps: FireDeps): Promise<DeliverResult> {
  const current = await deps.store.get(intention.id);
  if (!current || current.state !== "armed" || current.origin !== "latent") {
    return { delivered: false, voiceStatus: "dropped", reason: "not_surfaceable" };
  }
  return deliverAndMark(current, deps);
}
