// =============================================================================
// Intention normalization helpers — shared by InMemoryIntentionStore and
// FileIntentionStore so the two implementations cannot drift.
// =============================================================================

import type { TriggerPredicate, TriggerTerm } from "./intention.js";

export function clampConfidence(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  // MED-8: Math.max/min pass NaN through; reject non-finite values → drop the
  // field (undefined) so callers see a sensible default rather than NaN.
  if (!Number.isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v));
}

export function normalizeTopic(topic: string): string {
  return topic.toLowerCase().trim();
}

/** Apply confidence clamping and provenance defaulting to all trigger terms in-place. */
export function normalizeTrigger(trigger: TriggerPredicate): TriggerPredicate {
  const normTerms = (terms: TriggerTerm[] | undefined): TriggerTerm[] | undefined => {
    if (!terms) return terms;
    return terms.map((t) => {
      const base = {
        provenance: t.provenance ?? ("provided" as const),
        confidence: clampConfidence(t.confidence),
      };
      if (t.kind === "topic") {
        return { ...t, ...base, topic: normalizeTopic(t.topic) };
      }
      return { ...t, ...base };
    });
  };
  return {
    all: normTerms(trigger.all),
  };
}
