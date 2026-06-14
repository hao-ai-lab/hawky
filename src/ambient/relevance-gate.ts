// =============================================================================
// relevance-gate.ts — M11: LLM-primary relevance gate for latent surfacing.
//
// The gate decides which of a session's armed latent intentions are genuinely
// apt to surface RIGHT NOW. An LLM judges contextual aptness (handling paraphrase
// + incidental-mention false positives); on no model / call failure / bad output
// it returns no surfaced results — never crashes the ambient loop.
//
// Cost: ONE batched LLM call per evaluation (per surfacing tick per session, and
// per scan), listing all eligible armed latents — not one call per intention.
// =============================================================================

import type { Intention } from "./intention.js";
import type { TranscriptTurn } from "./transcript-window.js";
import { matchLatent, SURFACE_THRESHOLD, type ContextSnapshot } from "./matcher.js";
import { isTransientError } from "./latent-recognizer.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("ambient/relevance-gate");
import { termKey, isArmable } from "./trigger.js";

export interface RelevanceInput {
  /** The session's armed latent intentions (caller excludes same-tick mints). */
  armed: Intention[];
  /** Recent transcript turns, oldest-first. */
  window: TranscriptTurn[];
  now: number;
  tz: string;
  location?: { place?: string; category?: string };
}

export interface RelevanceVerdict {
  id: string;
  surface: boolean;
  confidence: number;
  matchedTerms: string[];
}

export interface RelevanceGate {
  evaluate(input: RelevanceInput): Promise<RelevanceVerdict[]>;
}

export type GateModelInvokeFn = (prompt: string) => Promise<string>;

/**
 * Only armed latent intentions with at least one match-only (non-armable) term
 * are eligible for context-surfacing — armable terms (provided `when`, `where`
 * with a place) fire via their adapters, not the gate. This keeps match-only
 * semantics even when the LLM is judging.
 */
function isMatchSurfaceable(i: Intention): boolean {
  if (i.origin !== "latent") return false;
  const terms = i.trigger.all ?? [];
  return terms.some((t) => !isArmable(t));
}

/** Match-only term keys for an intention (for the verdict's matchedTerms). */
function matchOnlyTermKeys(i: Intention): string[] {
  return (i.trigger.all ?? []).filter((t) => !isArmable(t)).map((t) => termKey(t));
}

// -----------------------------------------------------------------------------
// DeterministicRelevanceGate — matchLatent per intention. Used by tests and callers
// that explicitly choose local matching; production wires makeRelevanceGate().
// -----------------------------------------------------------------------------

export class DeterministicRelevanceGate implements RelevanceGate {
  async evaluate(input: RelevanceInput): Promise<RelevanceVerdict[]> {
    const ctx: ContextSnapshot = {
      now: input.now,
      tz: input.tz,
      transcriptWindow: input.window,
      location: input.location,
    };
    return input.armed.filter(isMatchSurfaceable).map((i) => {
      const v = matchLatent(i, ctx);
      return { id: i.id, surface: v.surface, confidence: v.confidence, matchedTerms: v.matchedTerms };
    });
  }
}

// -----------------------------------------------------------------------------
// LlmRelevanceGate — one batched call. THROWS on invoke/parse failure so the
// makeRelevanceGate wrapper owns fail-soft behavior.
// -----------------------------------------------------------------------------

export class LlmRelevanceGate implements RelevanceGate {
  constructor(private readonly invoke: GateModelInvokeFn) {}

  async evaluate(input: RelevanceInput): Promise<RelevanceVerdict[]> {
    const eligible = input.armed.filter(isMatchSurfaceable);
    if (eligible.length === 0) return [];

    const raw = await this.invoke(buildPrompt(eligible, input)); // may throw → fail soft
    const verdicts = parseVerdicts(raw, eligible); // throws on unparseable → fail soft

    // An eligible id the LLM omits is treated as "do not surface". We do NOT
    // backfill with the deterministic matcher — that would override the LLM's
    // own judgment with a weaker substring signal.
    return verdicts;
  }
}

// -----------------------------------------------------------------------------
// makeRelevanceGate — LLM-only. No model, or model failure → [] (surface nothing)
// + log. Latent surfacing is nice-to-have: never degrade to the substring matcher,
// never surface the failure to the realtime model.
// -----------------------------------------------------------------------------

export function makeRelevanceGate(invoke?: GateModelInvokeFn): RelevanceGate {
  if (!invoke) return { async evaluate(): Promise<RelevanceVerdict[]> { return []; } };
  const llm = new LlmRelevanceGate(invoke);
  return {
    async evaluate(input: RelevanceInput): Promise<RelevanceVerdict[]> {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const verdicts = await llm.evaluate(input);
          // Privacy (#484): never log raw transcript text or need content —
          // counts + ids only.
          log.info("relevance gate (llm)", {
            eligible: input.armed.length,
            surfaced: verdicts.filter((v) => v.surface).length,
            windowTurns: input.window.length,
            verdicts: verdicts.map((v) => ({ id: v.id.slice(0, 8), surface: v.surface, conf: v.confidence })),
          });
          return verdicts;
        } catch (err) {
          // Retry once on a transient model failure; otherwise skip silently.
          if (attempt === 0 && isTransientError(err)) continue;
          log.warn("relevance gate: llm unavailable — skipping surfacing (returning none)", {
            error: String(err).slice(0, 120),
          });
          return [];
        }
      }
      return []; // unreachable; satisfies the type checker
    },
  };
}

// -----------------------------------------------------------------------------
// Prompt + fail-closed parse
// -----------------------------------------------------------------------------

function buildPrompt(eligible: Intention[], input: RelevanceInput): string {
  const windowText = input.window.map((t) => `[${t.role}] ${t.text}`).join("\n") || "(empty)";
  const needs = eligible
    .map((i) => `- id=${i.id} :: ${i.content} (topics: ${matchOnlyTermKeys(i).join(", ") || "none"})`)
    .join("\n");
  return `You decide which of a user's stored background "needs" (real pending tasks/errands they mentioned earlier) to bring up in the CURRENT conversation. Judge each need independently: is now the right moment to surface it?

Surface a need (surface:true, high confidence) when the recent conversation makes it genuinely apt — for example:
- EXPLICIT REQUEST: the user asks for their needs/tasks/list — e.g. "what do I need", "what's on my shopping list", "make my to-do list", "what errands do I have", "remind me what I needed to get". Then surface EVERY genuine pending need (the user wants the full list) — do not withhold.
- ON-TOPIC: the conversation is about the need's item or topic (e.g. talk about coffee → a "buy coffee" need).
- RIGHT CONTEXT: the user mentions a place, time, or activity where the need would be acted on (e.g. heading to the store → shopping needs; "on my way out" / running errands → errands).

Do NOT surface (surface:false) when:
- the need is only tangential, or the conversation is on an unrelated topic;
- the item is mentioned only in passing — a comment, opinion, or complaint ABOUT it (its price, taste, the news) is NOT a cue to surface; only surface when the user actually wants/needs/is about to get or use it, is in the right place/moment to act, or explicitly asks;
- it is a hypothetical, idle chatter, or a question about something else;
- the need already appears handled or cancelled in the conversation.

Calibration: for an explicit request, return surface:true with high confidence for all real needs. Otherwise be conservative — surfacing the wrong thing at the wrong moment is worse than waiting.

## Recent conversation (oldest → newest)
${windowText}

## Stored needs
${needs}

## Output
Return ONLY a JSON array, one object per stored need, no prose:
[{"id":"<id>","surface":true|false,"confidence":0.0-1.0}]`;
}

/** Parse + validate. Throws on structurally-bad output so the wrapper falls back. */
function parseVerdicts(raw: string, eligible: Intention[]): RelevanceVerdict[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const parsed = JSON.parse(trimmed); // throws on non-JSON → fail soft
  if (!Array.isArray(parsed)) throw new Error("relevance-gate: expected a JSON array");

  const byId = new Map(eligible.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: RelevanceVerdict[] = [];
  for (const v of parsed) {
    if (!v || typeof v !== "object") continue;
    const id = (v as { id?: unknown }).id;
    if (typeof id !== "string" || !byId.has(id) || seen.has(id)) continue; // unknown/dupe → drop
    seen.add(id);
    const c = (v as { confidence?: unknown }).confidence;
    if (typeof c !== "number" || !Number.isFinite(c)) continue; // bad confidence → drop
    const confidence = Math.min(1, Math.max(0, c));
    const surfaceFlag = (v as { surface?: unknown }).surface === true;
    // Effective surface gates on BOTH the flag and the confidence threshold.
    out.push({
      id,
      surface: surfaceFlag && confidence >= SURFACE_THRESHOLD,
      confidence,
      matchedTerms: matchOnlyTermKeys(byId.get(id)!),
    });
  }
  return out;
}
