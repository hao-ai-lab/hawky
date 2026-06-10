// =============================================================================
// create-intention.ts — structured obvious-intention build + precision gate.
//
// The realtime model fills the slots ({ content, when }) explicitly and calls
// the `intention.create` tool; this module turns those slots into a hard,
// obvious IntentionCreateRequest WITHOUT re-doing NLP on free text (the former
// priority:"timed" string-parse path). It only deterministically RESOLVES the
// explicit `when` expression to an absolute ISO timestamp, and enforces the
// precision gate: an obvious timed intention must have an ACTIONABLE time.
//
// Precision gate (validated 85%→96% in the rt-harness): if `when` does not
// resolve to a real time (missing, or a vague word like "later"/"soon"), we do
// NOT store — we return needsClarification so the model asks one question.
// =============================================================================

import type { IntentionCreateRequest } from "./rpc.js";
import { inferTrigger } from "./when-resolver.js";
import { isArmable } from "./trigger.js";
import { findWhenTerm } from "./intention.js";

export interface CreateIntentionArgs {
  /** What to be reminded of, as a short imperative ("Take your pills"). */
  content: string;
  /**
   * The trigger time, exactly as the model resolved it: a clock time ("8pm",
   * "17:30"), a relative offset ("in 10 minutes"), a day-qualified time
   * ("tomorrow at 8am", "Monday at 9am"), or an ISO timestamp.
   */
  when?: string;
  /**
   * Named place for a `where` trigger (e.g. "home", "the grocery store").
   * Must be a specific named place — bare category words ("a store",
   * "a coffee shop") are rejected by the precision gate.
   */
  where?: string;
}

export interface BuildOptions {
  /** Current time (Date or epoch ms). Defaults to Date.now(). */
  now?: Date | number;
  /** IANA timezone for resolving wall-clock times. Defaults to "UTC". */
  timezone?: string;
  /**
   * Override the AMBIENT_WHERE feature flag. When undefined (default), the
   * production value (process.env.AMBIENT_WHERE === "1") is used. Set to true
   * in tests that exercise the where path directly.
   */
  whereEnabled?: boolean;
}

export type BuildObviousIntentionResult =
  | { ok: true; request: IntentionCreateRequest }
  | { ok: false; needsClarification: true; ask: string; reason: string };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// A bare clock fragment with no leading keyword ("8pm", "5:30 pm", "17:00").
const BARE_CLOCK_RE = /^\d{1,2}(:\d{2})?\s*([ap]\.?m\.?)?$/i;
// Keywords inferTrigger already understands without a leading "at ".
const HAS_WHEN_KEYWORD_RE =
  /\b(in\s+\d|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s)/i;

/**
 * Normalise a known time-expression so inferTrigger (which expects sentence
 * fragments like "at 8pm") matches a bare clock the model may emit ("8pm").
 */
function normalizeWhen(when: string): string {
  const w = when.trim();
  if (HAS_WHEN_KEYWORD_RE.test(w)) return w;
  if (BARE_CLOCK_RE.test(w)) return `at ${w}`;
  return w;
}

/**
 * Returns true when `terms` mixes armable terms (provided when/where+place) with
 * match-only terms (topic/who/where-category/inferred when-slot). Such a trigger
 * is unfireable: armable halves fire via adapters; match-only halves via the
 * matcher — the two never co-fire, so the intention is permanently stuck.
 */
export function hasMixedTriggerTerms(terms: import("./intention.js").TriggerTerm[]): boolean {
  if (terms.length < 2) return false;
  const hasArmable   = terms.some((t) => isArmable(t));
  const hasMatchOnly = terms.some((t) => !isArmable(t));
  return hasArmable && hasMatchOnly;
}

const CLARIFY_ASK =
  "What time should I set this for? e.g. \"8pm\", \"in 10 minutes\", or \"tomorrow at 9am\".";

const CLARIFY_WHERE_ASK =
  "Where should this trigger? Please name a specific place, e.g. \"home\", \"the office\", or \"Whole Foods on Market Street\".";

// Bare-category patterns: reject generic/indefinite place phrases that cannot be geocoded.
// "a store", "an office", "any store", "a coffee shop", "grocery store", "coffee shop",
// standalone category nouns ("store", "coffee", "pharmacy").
const BARE_CATEGORY_RE = /^(a|an|any)\s+\w+(\s+\w+)?$/i;
// Standalone bare category nouns (no article) that are too generic to geocode.
const BARE_NOUN_CATEGORIES = new Set([
  "store", "stores",
  "coffee shop", "coffee shops",
  "grocery store", "grocery stores",
  "supermarket", "supermarkets",
  "pharmacy", "pharmacies",
  "restaurant", "restaurants",
  "cafe", "cafes", "café", "cafés",
  "coffee",
  "grocery",
  "bank", "banks",
  "gym", "gyms",
  "hospital", "hospitals",
  "school", "schools",
  "library", "libraries",
  "park", "parks",
]);

/**
 * Return true when `place` is too generic to geocode as a specific named place.
 * Rejects: indefinite-article-led generics ("a store", "an office", "any store"),
 * bare category nouns ("store", "coffee shop", "grocery store").
 * Allows: specific named places ("home", "Whole Foods", "the office", "my office",
 * "Safeway on Market Street").
 */
function isBareCategory(place: string): boolean {
  const p = place.trim().toLowerCase();
  if (BARE_NOUN_CATEGORIES.has(p)) return true;
  return BARE_CATEGORY_RE.test(place.trim());
}

/**
 * Build a hard/obvious IntentionCreateRequest from explicit slots, or bounce to
 * clarification when neither a resolvable `when` nor a named `where.place` is present
 * (the precision gate).
 *
 * Precision gate rules:
 *   - bare content with neither `when` nor `where` → needsClarification
 *   - `where` that is a bare category ("a store") → needsClarification
 *   - resolvable `when` alone → TriggerWhen only
 *   - named `where.place` alone → TriggerWhere only
 *   - both → TriggerWhen + TriggerWhere (composite)
 */
export function buildObviousIntention(
  args: CreateIntentionArgs,
  opts: BuildOptions = {},
): BuildObviousIntentionResult {
  const content = args.content?.trim();
  if (!content) {
    return {
      ok: false,
      needsClarification: true,
      ask: "What should this be about, and when?",
      reason: "missing_content",
    };
  }

  const nowMs =
    opts.now !== undefined
      ? opts.now instanceof Date
        ? opts.now.getTime()
        : opts.now
      : Date.now();
  const timezone = opts.timezone ?? "UTC";

  const whenRaw = args.when?.trim();
  const whereRaw = args.where?.trim();

  // Feature flag: where-triggers are unavailable until AMBIENT_WHERE=1 is set
  // (iOS CoreLocation wiring not yet complete). Injectable via opts.whereEnabled for tests.
  const whereEnabled = opts.whereEnabled !== undefined
    ? opts.whereEnabled
    : (typeof process !== "undefined" && process.env.AMBIENT_WHERE === "1");
  if (whereRaw && !whereEnabled) {
    return {
      ok: false,
      needsClarification: true,
      ask: "Location reminders aren't available yet.",
      reason: "where_unavailable",
    };
  }

  // Precision gate: neither trigger present → clarify.
  if (!whenRaw && !whereRaw) {
    return { ok: false, needsClarification: true, ask: CLARIFY_ASK, reason: "missing_when" };
  }

  // Precision gate: bare category place → not a named place.
  if (whereRaw && isBareCategory(whereRaw)) {
    return {
      ok: false,
      needsClarification: true,
      ask: CLARIFY_WHERE_ASK,
      reason: "bare_category_where",
    };
  }

  // Resolve optional `when`.
  let whenTrigger: import("./intention.js").TriggerWhen | undefined;
  if (whenRaw) {
    if (ISO_RE.test(whenRaw)) {
      const ms = Date.parse(whenRaw);
      if (!Number.isNaN(ms)) {
        whenTrigger = { kind: "when", at: new Date(ms).toISOString(), relative: whenRaw };
      }
    }
    if (!whenTrigger) {
      const resolved = inferTrigger(normalizeWhen(whenRaw), nowMs, timezone);
      if (!resolved) {
        // `when` was present but vague/unparseable ("later", "soon", "sometime").
        return { ok: false, needsClarification: true, ask: CLARIFY_ASK, reason: "unresolvable_when" };
      }
      // inferTrigger returns a TriggerPredicate; extract the when term.
      const t = findWhenTerm(resolved);
      if (t) whenTrigger = t;
    }
  }

  // Build trigger terms.
  const terms: import("./intention.js").TriggerTerm[] = [];
  if (whenTrigger) terms.push(whenTrigger);
  if (whereRaw) terms.push({ kind: "where", place: whereRaw, provenance: "provided" });

  // Guard: a trigger mixing armable + match-only terms is ambiguous — armable terms
  // fire via adapters while match-only terms are evaluated by the matcher, so the
  // two halves never co-fire. Reject at creation rather than let it get stuck.
  if (hasMixedTriggerTerms(terms)) {
    return {
      ok: false,
      needsClarification: true,
      ask: "Please specify either a time/place trigger or a topic/context trigger — not both together.",
      reason: "mixed_trigger_predicates",
    };
  }

  return {
    ok: true,
    request: {
      content,
      trigger: { all: terms },
      evidence: { ts: new Date(nowMs).toISOString() },
      sensitivity: "private",
    },
  };
}
