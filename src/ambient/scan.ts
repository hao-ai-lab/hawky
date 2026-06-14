// =============================================================================
// scan.ts — read-only latent surfacing helper (M10 model-pull).
//
// scanLatent lists the user's GLOBAL pending latent intentions (armed OR surfaced),
// evaluates them through the shared surfacingGate against the CURRENT session's
// context window, revalidates each matched id per its initial state, and returns
// the top MAX_SCAN_RESULTS verdicts sorted by confidence desc.
//
// "surfaced" latents (shown once by the poll, not yet acted on) are now eligible
// so an explicit user scan ("what's on my shopping list") can see a need the poll
// already mentioned.
//
// Read-only: does NOT deliver or transition state.  Reserves returned ids via
// LatentService.markScanned so the M9 poll won't also surface them (surface-once).
// =============================================================================

import type { IntentionStore } from "./intention-store.js";
import type { LatentService } from "./latent-service.js";
import type { RelevanceGate } from "./relevance-gate.js";
import { projectMode, type Mode } from "./modes.js";
import { isInFlight } from "./fire.js";

// Cap on results returned to the model from one scan. Set high enough that an
// explicit "what's on my list" request (the relevance gate surfaces every
// pending need) returns a complete list, not a truncated 3 (#531 review).
export const MAX_SCAN_RESULTS = 10;

export interface ScanLatentDeps {
  store: IntentionStore;
  latentService: LatentService;
  gate: RelevanceGate;
  sessionKey: string;
  /** The session's ambient mode — quiet → always returns []. */
  mode: Mode;
  now: number;
  tz: string;
}

export interface ScanMatch {
  id: string;
  content: string;
  confidence: number;
  matchedTerms: string[];
}

export interface ScanLatentResult {
  matches: ScanMatch[];
}

export async function scanLatent(deps: ScanLatentDeps): Promise<ScanLatentResult> {
  const { store, latentService, gate, sessionKey, mode, now, tz } = deps;

  // Quiet sessions never surface latent intentions (consistent with the M9 poll's
  // per-session mode gate) — a quiet-mode scan returns nothing.
  if (!projectMode(mode).latentIntentionEnabled) return { matches: [] };

  // GLOBAL set — latents are user-global; the sessionKey supplies ONLY the context
  // window, not a filter on which latents are eligible (M10 §6).
  // Include both armed (pending surface) and surfaced (pending acknowledgement) latents.
  // surfaced = shown once by the poll but not yet acted on; an explicit scan must see them.
  const candidates = await store.list({ state: ["armed", "surfaced"], origin: "latent" });
  if (candidates.length === 0) return { matches: [] };

  // Record each candidate's state at list time so revalidation can apply the
  // correct rule: initially-surfaced ids are fine to return as-is; initially-armed
  // ids may have raced with the poll between list and revalidate.
  const initialStates = new Map(candidates.map((c) => [c.id, c.state]));

  const verdicts = await gate.evaluate({
    armed: candidates,
    window: latentService.windowFor(sessionKey),
    now,
    tz,
    location: latentService.locationFor(sessionKey),
  });

  // Revalidate: check current state per id to guard against races.
  // - initially surfaced → keep iff still surfaced (poll only ever queries armed, so no new race).
  // - initially armed → keep iff still armed AND not currently being delivered by the poll.
  // Drop anything that reached a terminal state or changed state unexpectedly.
  const hits: ScanMatch[] = [];
  for (const v of verdicts) {
    if (!v.surface) continue;
    const fresh = await store.get(v.id);
    const init = initialStates.get(v.id);
    if (!fresh || !init) continue;
    if (init === "surfaced") {
      if (fresh.state !== "surfaced") continue;
    } else {
      // init === "armed"
      if (fresh.state !== "armed" || isInFlight(v.id)) continue;
    }
    hits.push({
      id: v.id,
      content: fresh.content,
      confidence: v.confidence,
      matchedTerms: v.matchedTerms,
    });
  }

  hits.sort((a, b) => b.confidence - a.confidence);
  const matches = hits.slice(0, MAX_SCAN_RESULTS);

  // Reserve the returned ids synchronously immediately after revalidation so the
  // M9 surfacing poll won't also surface them (surface-once). No awaits between
  // revalidation and markScanned to minimise the armed-path race window.
  latentService.markScanned(matches.map((m) => m.id));
  return { matches };
}
