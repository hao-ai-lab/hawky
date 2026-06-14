// =============================================================================
// matcher.ts — pure, stateless latent-intention matcher (M9 §9a).
// No side effects. No imports from adapters or stores.
// =============================================================================

import type { Intention, TriggerTerm } from "./intention.js";
import type { TranscriptTurn } from "./transcript-window.js";
import { isArmable } from "./trigger.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ContextSnapshot {
  /** Unix epoch milliseconds (Date.now()) */
  now: number;
  /** IANA tz name, e.g. "America/Los_Angeles" */
  tz: string;
  /** Recent transcript turns, oldest-first */
  transcriptWindow: TranscriptTurn[];
  location?: { place?: string; category?: string };
}

export interface MatchVerdict {
  surface: boolean;
  confidence: number;
  matchedTerms: string[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Minimum aggregate confidence required for surface:true.
 * A term with confidence 0.6 just barely crosses the threshold.
 */
export const SURFACE_THRESHOLD = 0.6;

/**
 * How many turns from the end of the window count as "recent".
 * Turns within the last RECENCY_WINDOW turns get recencyWeight=1.0;
 * turns outside the window do not contribute.
 */
const RECENCY_WINDOW = 10;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Returns true if `word` appears as a whole word in `text` (case-insensitive).
 * Uses a simple split-on-non-alpha check rather than a regex to avoid edge cases.
 */
function containsWord(text: string, word: string): boolean {
  const textTokens = normalize(text).split(/\W+/).filter(Boolean);
  const targetTokens = normalize(word).split(/\W+/).filter(Boolean);
  if (targetTokens.length === 0) return false;
  // Single token: exact whole-word match. Multi-token (e.g. "dish soap",
  // "paper towels"): match a contiguous token subsequence, preserving
  // whole-word semantics so multi-word topics/categories surface.
  for (let i = 0; i + targetTokens.length <= textTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < targetTokens.length; j++) {
      if (textTokens[i + j] !== targetTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * recencyWeight for a transcript turn at index `idx` in a window of `total` turns.
 * The last RECENCY_WINDOW turns (highest indices) get weight 1.0.
 * Older turns do not contribute (weight 0.0).
 *
 * Design rationale: simple binary cutoff at RECENCY_WINDOW turns from the end.
 * "Recent enough" is clear and easy to reason about.
 */
function recencyWeight(idx: number, total: number): number {
  return idx >= total - RECENCY_WINDOW ? 1.0 : 0.0;
}

/**
 * Returns true if the time-of-day represented by `nowMs` (in `tz`) falls within
 * the [start, end] slot (both "HH:MM" strings).  Handles slots that wrap past midnight.
 */
function inTimeSlot(nowMs: number, tz: string, start: string, end: string): boolean {
  // Extract local HH:MM from a Date in the given tz.
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  const parts = fmt.formatToParts(new Date(nowMs));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Normalise "24:xx" that some locales emit as midnight.
  const hh = hour === "24" ? "00" : hour.padStart(2, "0");
  const mm = minute.padStart(2, "0");
  const now = `${hh}:${mm}`;

  if (start <= end) {
    // Normal slot (e.g. 18:00–22:00)
    return now >= start && now <= end;
  } else {
    // Wraps past midnight (e.g. 22:00–06:00)
    return now >= start || now <= end;
  }
}

// -----------------------------------------------------------------------------
// matchLatent
// -----------------------------------------------------------------------------

/**
 * Evaluate whether an Intention should be surfaced given the current context.
 *
 * Only match-only terms are evaluated (armable terms — provided `when`, `where`
 * with a place — are ignored here; they fire via their arming adapters).
 *
 * Conjunction: ALL present match-only terms must match.
 * Aggregate confidence = MIN of per-term contributions.
 * Surfaced when all match AND aggregate >= SURFACE_THRESHOLD.
 *
 * Zero evaluable match-only terms → {surface:false, confidence:0, matchedTerms:[]}.
 */
export function matchLatent(intention: Intention, ctx: ContextSnapshot): MatchVerdict {
  const allTerms: TriggerTerm[] = intention.trigger.all ?? [];

  // Isolate match-only terms (non-armable ones).
  const matchOnlyTerms = allTerms.filter((t) => !isArmable(t));

  // No evaluable terms → do not surface.
  if (matchOnlyTerms.length === 0) {
    return { surface: false, confidence: 0, matchedTerms: [] };
  }

  const turns = ctx.transcriptWindow;
  const total = turns.length;

  let aggregate = Infinity; // will be min of per-term contributions
  const matchedTerms: string[] = [];

  for (const term of matchOnlyTerms) {
    let contribution = 0;
    let matched = false;

    switch (term.kind) {
      case "topic": {
        // Find the best (most recent) turn that contains the topic word.
        const needle = normalize(term.topic);
        for (let i = 0; i < total; i++) {
          const turn = turns[i];
          if (containsWord(turn.text, needle)) {
            const w = recencyWeight(i, total);
            if (w > 0) {
              const c = (term.confidence ?? 1.0) * w;
              if (c > contribution) contribution = c;
              matched = true;
            }
          }
        }
        if (matched) matchedTerms.push(`topic:${needle}`);
        break;
      }

      case "where": {
        // Only category-only `where` terms are match-only (place-bearing are armable).
        // Match if transcript mentions the category, or ctx.location.category equals it.
        const cat = term.category ?? "";
        let catMatched = false;
        if (ctx.location?.category && normalize(ctx.location.category) === normalize(cat)) {
          catMatched = true;
          contribution = term.confidence ?? 1.0;
        } else {
          for (let i = 0; i < total; i++) {
            const turn = turns[i];
            if (containsWord(turn.text, cat)) {
              const w = recencyWeight(i, total);
              if (w > 0) {
                const c = (term.confidence ?? 1.0) * w;
                if (c > contribution) contribution = c;
                catMatched = true;
              }
            }
          }
        }
        matched = catMatched;
        if (matched) matchedTerms.push(`where::${cat}`);
        break;
      }

      case "who": {
        // Match if entity or scene appears in a recent transcript turn.
        const target = normalize(term.entity ?? term.scene ?? "");
        if (!target) break;
        for (let i = 0; i < total; i++) {
          const turn = turns[i];
          if (containsWord(turn.text, target)) {
            const w = recencyWeight(i, total);
            if (w > 0) {
              const c = (term.confidence ?? 1.0) * w;
              if (c > contribution) contribution = c;
              matched = true;
            }
          }
        }
        if (matched) matchedTerms.push(`who:${term.entity ?? ""}:${term.scene ?? ""}`);
        break;
      }

      case "when": {
        // Only inferred `when` with a window is match-only (checked by isArmable, but guard here too).
        if (term.provenance !== "inferred" || !term.window) break;
        const { start, end } = term.window;
        if (inTimeSlot(ctx.now, ctx.tz, start, end)) {
          contribution = term.confidence ?? 1.0;
          matched = true;
          matchedTerms.push(`when:slot:${start}-${end}`);
        }
        break;
      }

      case "manual":
        // manual is not armable but also has no match semantics; skip.
        break;
    }

    if (!matched) {
      // Conjunction: one miss → the whole predicate fails.
      return { surface: false, confidence: 0, matchedTerms: [] };
    }

    aggregate = Math.min(aggregate, contribution);
  }

  const confidence = aggregate === Infinity ? 0 : aggregate;
  const surface = confidence >= SURFACE_THRESHOLD;
  return { surface, confidence, matchedTerms };
}
