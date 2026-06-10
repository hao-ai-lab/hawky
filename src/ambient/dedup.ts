// =============================================================================
// dedupAndSupersede — write-time supersession per MASTER §2/§3b.
// Two recognizer-sourced Intentions are considered the same item if their
// content matches case-insensitively. An existing Intention is superseded (not
// a duplicate) when the new evidence post-dates it.
// M8 §3.7: active-duplicate states now include surfaced; suppressed content
// blocks re-minting entirely.
// =============================================================================

import type { Intention } from "./intention.js";
import type { MintedIntention } from "./latent-recognizer.js";

export interface DedupResult {
  /** New MintedIntentions to create */
  create: MintedIntention[];
  /** Existing Intention ids to resolve (superseded by the paired MintedIntention content) */
  supersede: { id: string; by: string }[];
}

export function dedupAndSupersede(
  minted: MintedIntention[],
  existing: Intention[],
  /**
   * Additional normalized content keys to suppress (from the LatentService's
   * persistent in-memory SuppressionStore). These survive prune() clearing
   * the suppressed state from the IntentionStore.
   */
  extraSuppressed: ReadonlySet<string> = new Set(),
): DedupResult {
  const create: MintedIntention[] = [];
  const supersede: { id: string; by: string }[] = [];

  // Suppression check: content already declined by the user must not be re-minted.
  // Combines store-based suppressed state with the persistent in-memory keys.
  const suppressedNorms = new Set([
    ...existing
      .filter((c) => c.state === "suppressed")
      .map((c) => c.content.toLowerCase().trim()),
    ...extraSuppressed,
  ]);

  // Active states (pending_arm|armed|surfaced) are duplicate blockers — any
  // origin. Active latent items are also eligible for supersession only when
  // they are NOT in an active state (i.e. no supersession while active).
  // Fix(M8): active states always BLOCK — no supersede+create regardless of ts.
  const activeStates = new Set(["pending_arm", "armed", "surfaced"]);
  const active = existing.filter((c) => activeStates.has(c.state));

  // Non-active latent Intentions may be superseded by newer evidence.
  // (e.g. state=fired or resolved — re-occurrence should mint fresh.)
  // Currently none of the existing callers rely on this path, but kept for
  // completeness.  Active latent items are handled by the block path above.
  const inactiveRecognized = existing.filter(
    (c) => c.origin === "latent" && !activeStates.has(c.state) && c.state !== "suppressed",
  );

  // Track items already decided within this batch to avoid intra-batch duplicates
  const batchSeen = new Set<string>();

  for (const m of minted) {
    const contentNorm = m.content.toLowerCase().trim();

    // Intra-batch dedup: skip if already decided within this minted batch
    if (batchSeen.has(contentNorm)) continue;
    batchSeen.add(contentNorm);

    // Suppression check: never re-mint content the user already declined.
    if (suppressedNorms.has(contentNorm)) continue;

    // Active duplicate check (any origin): always block — no supersede, no create.
    const activeMatch = active.find((c) => c.content.toLowerCase().trim() === contentNorm);
    if (activeMatch) continue;

    // Inactive latent duplicate: supersede with newer evidence, then create.
    const inactiveMatch = inactiveRecognized.find((c) => c.content.toLowerCase().trim() === contentNorm);
    if (inactiveMatch) {
      const existingTs = new Date(inactiveMatch.evidence.ts).getTime();
      const newTs = new Date(m.evidence.ts).getTime();
      if (newTs > existingTs) {
        supersede.push({ id: inactiveMatch.id, by: m.content });
        create.push(m);
      }
      // else: same or older evidence — skip
      continue;
    }

    // Brand new item — create
    create.push(m);
  }

  return { create, supersede };
}
