// =============================================================================
// arming.ts — armIntention
// Orchestrates the pending_arm → armed | arm_failed state machine.
// =============================================================================

import type { Intention, TriggerTerm } from "./intention.js";
import type { ArmAdapter } from "./trigger.js";
import { termKey, isArmable } from "./trigger.js";
import type { IntentionStore } from "./intention-store.js";

// -----------------------------------------------------------------------------
// armIntention
// -----------------------------------------------------------------------------

/**
 * Select the ArmAdapter for an Intention's trigger kind(s) and arm the Intention.
 *
 * All distinct armable terms in `all` must arm successfully. Match-only and
 * manual terms need no adapter and are accepted as-is. On partial failure the
 * already-armed adapters are rolled back (disarmed) and "arm_failed" is returned;
 * the intention is left in pending_arm so the caller can decide on retry policy.
 *
 * @param intention - Intention in pending_arm state
 * @param adapters  - Map of kind → ArmAdapter
 * @param store     - IntentionStore to transition the Intention state
 */
export async function armIntention(
  intention: Intention,
  adapters: Map<string, ArmAdapter>,
  store: IntentionStore,
): Promise<"armed" | "arm_failed" | "deferred"> {
  // Deduplicate by termKey (not by kind — two `where` terms can differ by place/category).
  const seen = new Set<string>();
  const allTerms: TriggerTerm[] = (intention.trigger.all ?? []).filter((t) => {
    const key = termKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Armable terms need an adapter (when, where+place). Match-only terms
  // (where.category-only, who, topic) and manual terms need none.
  const armable = allTerms.filter((t) => isArmable(t));

  // PHASE 1 (prepare): run all slow/failable setup WITHOUT making any trigger live.
  // Track successfully-prepared adapters for rollback on failure.
  const preparedAdapters: ArmAdapter[] = [];
  async function rollback(): Promise<void> {
    for (const adapter of preparedAdapters) {
      await adapter.disarm(intention);
    }
  }

  for (const term of armable) {
    const adapter = adapters.get(term.kind);
    if (!adapter) {
      await rollback();
      return "arm_failed";
    }
    // A thrown prepare() must roll back already-prepared adapters too — not only { ok:false }.
    let ok = false;
    let deferred = false;
    try {
      const result = await adapter.prepare(intention);
      ok = result.ok;
      deferred = result.deferred === true;
    } catch {
      await rollback();
      return "arm_failed";
    }
    if (!ok) {
      // #481: a deferred (device_ack_timeout) failure is RECOVERABLE — the device
      // is still working on it and a late ack can arm it. Do NOT roll back (that
      // would drop the where adapter's pending registration) and do NOT mark
      // terminal arm_failed; leave the intention in pending_arm. Only the where
      // adapter sets deferred, and a single armable term is the where v1 case.
      if (deferred) {
        return "deferred";
      }
      await rollback();
      return "arm_failed";
    }
    preparedAdapters.push(adapter);
  }

  // PHASE 2: all prepares succeeded → transition the store to "armed".
  // INVARIANT: store is "armed" before any trigger goes live.
  await store.transition(intention.id, "armed");

  // PHASE 3 (activate): make each trigger live now that the store is "armed".
  // If any activation fails, disarm everything and revoke the armed state so we
  // never leave a half-activated intention marked "armed".
  try {
    for (const adapter of preparedAdapters) {
      await adapter.activate(intention);
    }
  } catch {
    await rollback();
    await store.transition(intention.id, "arm_failed");
    return "arm_failed";
  }

  return "armed";
}
