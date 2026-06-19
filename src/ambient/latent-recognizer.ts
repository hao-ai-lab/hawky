// =============================================================================
// Latent recognizer — contract + implementations (M8 §3.1, §3.3).
//
// Preserved names for backward-compatibility with dedup.ts + barrel consumers:
//   MintedIntention — extended with origin:"latent" / strength:"soft" constraints
//   IntentionMinter — aliased to LatentRecognizer
// =============================================================================

import type { Intention, Sensitivity, TriggerPredicate } from "./intention.js";
import { createSubsystemLogger } from "../logging/index.js";

const recognizerLog = createSubsystemLogger("ambient/latent-recognizer");

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RecognizerInput {
  /** Recent transcript turns, oldest-first. */
  window: { role: "user" | "assistant"; text: string; ts: string }[];
  /** Already-stored intentions (for negative dedup). */
  recentIntentions: Intention[];
  /** Wall-clock timestamp (ms since epoch). */
  now: number;
  /** IANA timezone string, e.g. "America/Los_Angeles". */
  tz: string;
}

/** Shape emitted by any recognizer implementation. */
export interface MintedIntention {
  content: string;
  origin: "latent";
  strength: "soft";
  confidence: number;
  /** Match affordances only (topic/where.category); provenance:"inferred". Never an armed when. */
  trigger: TriggerPredicate;
  evidence: { spanRef?: string; ts: string };
  sensitivity: Sensitivity;
}

export interface LatentRecognizer {
  recognize(input: RecognizerInput): Promise<MintedIntention[]>;
}

/** Backward-compat alias so existing IntentionMinter references keep compiling. */
export type IntentionMinter = LatentRecognizer;

// ---------------------------------------------------------------------------
// isTransientError — classify errors that warrant a single retry
// ---------------------------------------------------------------------------

/** Returns true if err is a transient failure (network/timeout/rate-limit/server-error)
 *  that warrants one retry before falling back to the deterministic recognizer.
 *  User/program aborts (APIUserAbortError) are NOT retried — cancellation is intentional. */
export function isTransientError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  // Anthropic SDK structured error classes: APIConnectionError / APIConnectionTimeoutError
  // expose a constructor name that reliably identifies transient network failures even when
  // the default message ("Connection error.") doesn't match keyword patterns.
  // APIUserAbortError is intentional cancellation and is NOT retried.
  const ctorName = (err as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (/APIConnectionError|APIConnectionTimeoutError/.test(ctorName)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/econnreset|socket|fetch failed|network|timeout|connection error/.test(msg)) return true;
  if (/overloaded|rate limit|temporar/.test(msg)) return true;
  if (/\b(408|409|429|500|502|503|504|529)\b/.test(msg)) return true;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && [408, 409, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// DeterministicLatentRecognizer (rule/keyword-based; no model call)
// ---------------------------------------------------------------------------

// Patterns that signal a "we need X" / "out of X" latent need.
const NEED_PATTERNS = [
  // M9: extended to cover "ran out of" and "almost out of" / "we're almost out of"
  /\bwe(?:'re|'re|\s+are)?\s+(?:out\s+of|running\s+low\s+on|low\s+on|almost\s+out\s+of)\s+(.+)/i,
  /\bwe\s+ran\s+out\s+of\s+(.+)/i,
  /\b(?:we\s+)?need(?:s)?\s+(?:(?:more|some|to\s+buy|to\s+get)\s+)?(.+)/i,
  /\bwe\s+(?:don't|dont|do\s+not)\s+have\s+(?:any\s+)?(?:more\s+)?(.+)/i,
  /\bgetting\s+low\s+on\s+(.+)/i,
];

// Negative filters: skip turn if any match (question / hypothetical / satisfied / third-party / speculative).
const NEGATIVE_PATTERNS = [
  /\?/,
  /\bif\s+(?:we|I|you)\b/i,
  /\b(?:we\s+)?(?:bought|purchased|picked\s+up|got|ordered|have\s+enough|stocked\s+up)\b/i,
  // M9: speculative modal — "might need", "maybe need", "should need" are not firm assertions.
  /\b(?:might|maybe|perhaps|could)\s+(?:need|want|get|buy)\b/i,
  // MED-6: pronoun-subject third-party filter
  /\b(?:she|he|they|her|him|them)\s+(?:need|needs|want|wants|is\s+(?:out|low))\b/i,
  // MED-6: possessive-person subject third-party filter ("my mom needs", "my dad wants", etc.)
  /\bmy\s+(?:mom|mother|dad|father|sister|brother|friend|husband|wife|partner|son|daughter|boss|coworker|colleague|neighbor|roommate|[A-Z][a-z]{2,})\s+(?:need|needs|want|wants|is\s+(?:out|low))\b/i,
];

function inferTopic(item: string): string {
  return item
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

// Patterns that indicate a need has been satisfied within the window (topic-specific).
const SATISFY_PATTERNS = [
  /\b(?:we\s+)?(?:bought|purchased|picked\s+up|got|ordered|have\s+enough|stocked\s+up)\b/i,
  /\b(?:already\s+(?:have|got|bought|purchased))\b/i,
];

// MED-5: Generic-cancel signals — these drop the most-recent pending
// candidate(s) regardless of topic overlap (user said "never mind" etc.).
const GENERIC_CANCEL_PATTERNS = [
  /\b(?:never\s+mind|forget\s+it|cancel\s+that|ignore\s+that|disregard\s+that)\b/i,
];

/** Return a rough normalized "topic phrase" from a turn's text for overlap check. */
function extractTopics(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  // Return all 1–3-word subsequences as potential topic tokens.
  const topics: string[] = [];
  for (let i = 0; i < words.length; i++) {
    topics.push(words[i]);
    if (i + 1 < words.length) topics.push(`${words[i]} ${words[i + 1]}`);
    if (i + 2 < words.length) topics.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return topics;
}

/** True if `laterText` appears to satisfy or cancel the item described by `candidateContent`. */
function isSatisfiedBy(candidateContent: string, laterText: string): boolean {
  // MED-5: generic cancel drops the candidate regardless of topic overlap.
  if (GENERIC_CANCEL_PATTERNS.some((p) => p.test(laterText))) return true;
  if (!SATISFY_PATTERNS.some((p) => p.test(laterText))) return false;
  // For topic-specific satisfaction patterns, require content-overlap.
  const candidateTopics = extractTopics(candidateContent);
  const laterTopics = new Set(extractTopics(laterText));
  return candidateTopics.some((t) => laterTopics.has(t));
}

/**
 * Topic-SCOPED satisfaction/cancel classifier for the M9 cross-tick sweep over
 * already-armed latents. Unlike isSatisfiedBy (which lets a generic "never mind"
 * drop the most-recent in-window candidate), this REQUIRES topic overlap for
 * both cancel and satisfy, so a bare cancel never nukes unrelated armed latents.
 * Returns "satisfied" (→ resolve), "cancelled" (→ suppress), or null (no-op).
 */
export function classifySatisfaction(
  content: string,
  laterText: string,
): "satisfied" | "cancelled" | null {
  const cancel = GENERIC_CANCEL_PATTERNS.some((p) => p.test(laterText));
  const satisfy = SATISFY_PATTERNS.some((p) => p.test(laterText));
  if (!cancel && !satisfy) return null;
  const candidateTopics = extractTopics(content);
  const laterTopics = new Set(extractTopics(laterText));
  if (!candidateTopics.some((t) => laterTopics.has(t))) return null; // require topic overlap
  return cancel ? "cancelled" : "satisfied";
}

export class DeterministicLatentRecognizer implements LatentRecognizer {
  private readonly threshold: number;

  constructor(opts: { threshold?: number } = {}) {
    this.threshold = opts.threshold ?? 0.6;
  }

  async recognize(input: RecognizerInput): Promise<MintedIntention[]> {
    const results: MintedIntention[] = [];

    for (let i = 0; i < input.window.length; i++) {
      const turn = input.window[i];
      if (turn.role !== "user") continue;

      const text = turn.text.trim();
      if (NEGATIVE_PATTERNS.some((p) => p.test(text))) continue;

      for (const pattern of NEED_PATTERNS) {
        const m = pattern.exec(text);
        if (!m) continue;

        // M9: normalize captured item — strip trailing preposition phrases and leading
        // quantity words so the content is a clean noun-phrase ("buy batteries" not
        // "buy batteries for the remote"; "buy dish soap" not "buy more dish soap").
        const rawItem = m[1]
          .trim()
          .replace(/[.!]+$/, "")
          // strip trailing purpose/time/degree adverbs and preposition phrases
          .replace(/\s+(?:for|with|by|at|on\s+the\s+way|tonight|today|right\s+now|this\s+morning|this\s+evening|later|soon|halfway|actually|already)\b.*/i, "")
          // strip leading quantity words (more, some, a bit of, a few)
          .replace(/^(?:more|some|a\s+bit\s+of|a\s+few)\s+/i, "")
          .trim();
        if (!rawItem) continue;

        const content = `buy ${rawItem}`;
        const confidence = 0.7;
        if (confidence < this.threshold) continue;

        // Fix(M8 #4): Drop candidate if a LATER turn in the same window
        // satisfies or cancels it (e.g. "we're out of coffee" followed by
        // "we bought coffee" → no mint).
        const laterTurns = input.window.slice(i + 1);
        if (laterTurns.some((lt) => isSatisfiedBy(content, lt.text))) continue;

        const topic = inferTopic(rawItem);
        const trigger: TriggerPredicate = {
          all: [{ kind: "topic", topic, provenance: "inferred", confidence: 0.7 }],
        };

        results.push({
          content,
          origin: "latent",
          strength: "soft",
          confidence,
          trigger,
          evidence: { ts: turn.ts },
          sensitivity: "private",
        });

        break; // one mint per turn
      }
    }

    // Intra-batch dedup by normalized content.
    const seen = new Set<string>();
    return results.filter((r) => {
      const key = r.content.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// ModelLatentRecognizer
// ---------------------------------------------------------------------------
// #454 resolved: wired as production default in src/index.ts with a
// DeterministicLatentRecognizer fallback (Sonnet: 100% P / 100% R on held-out).

export type ModelInvokeFn = (prompt: string) => Promise<string>;

/**
 * Returns true when the config permits model-backed latent processing.
 * Exported so tests can verify the same gate used by the gateway wiring.
 *
 * Mirrors `gwConfig.ambient?.latent_model_processing !== false` in index.ts.
 * Default: true (model path) when the field is absent or undefined.
 */
export function isLatentModelEnabled(ambientConfig?: { latent_model_processing?: boolean }): boolean {
  return ambientConfig?.latent_model_processing !== false;
}

export class ModelLatentRecognizer implements LatentRecognizer {
  private readonly threshold: number;

  constructor(
    private readonly invoke: ModelInvokeFn,
    opts: { threshold?: number } = {},
  ) {
    this.threshold = opts.threshold ?? 0.6;
  }

  async recognize(input: RecognizerInput): Promise<MintedIntention[]> {
    if (input.window.length === 0) return [];

    // Format the transcript window for the prompt.
    const windowText = input.window
      .map((t) => `[${t.role.toUpperCase()} ${t.ts}] ${t.text}`)
      .join("\n");

    const alreadyActive =
      input.recentIntentions.length > 0
        ? input.recentIntentions
            .filter((i) => ["pending_arm", "armed", "surfaced"].includes(i.state))
            .map((i) => `- "${i.content}"`)
            .join("\n") || "none"
        : "none";

    const prompt = `You are a latent-intention recognizer for a personal ambient assistant.

## Task
Read the transcript window below and identify any LATENT NEEDS — things the user (or household) genuinely needs to do or acquire, expressed as factual assertions (not questions, not hypotheticals).

IMPORTANT: Only consider turns labeled [USER …]. Turns labeled [ASSISTANT …] are system responses — NEVER mint from them.

## Transcript window (oldest → newest)
${windowText}

## Already-active intentions (do NOT re-mint these)
${alreadyActive}

## Rules — DO NOT mint an intention if ANY of the following apply:

### 1. QUESTION — ABSOLUTE BLOCK
The turn is a question in ANY form. This is the STRONGEST filter: if the turn is asking rather than asserting, it MUST NOT mint, regardless of what is being asked about.
- Ends with "?" (literal question mark)
- Uses interrogative structure: "do we…", "does it…", "is there…", "are we…", "have we…", "did you…", "should we…", "what …?", "where …?", "when …?", "how …?", "which …?", "who …?", "can we…", "could we…"
- Rhetorical or open-ended questions ("what should we make for dinner?", "do we have any X left?")
A question seeks information — it is never a statement of need. NEVER mint from a question.

### 2. SURPLUS / ALREADY-HAVE / OVER-SUPPLIED — ABSOLUTE BLOCK
The turn describes having MORE than enough, or too much of something. These are the OPPOSITE of a need and must NEVER mint:
- "bought too much X", "we have plenty of X", "we're stocked up on X", "we have too much X"
- "way too much X", "we've got more than enough X"
- "we picked up extra X", "I overbought X"
Any statement of surplus or over-supply cannot be a need. NEVER mint from a surplus statement.

### 3. ALREADY-SATISFIED
A later turn in the same window shows the need is already met ("we bought", "we picked up", "we have enough", "we stocked up", "already got", "never mind", "forget it", "cancel that", "I already did X").

### 4. HYPOTHETICAL / CONDITIONAL / SPECULATIVE
The utterance is conditional, speculative, or counterfactual ("if we run out of…", "we might need…", "maybe we should…", "imagine if…", "what if we…").

### 5. THIRD-PARTY
The need belongs to someone other than the user/household ("my mom needs", "she needs", "he needs", "they need", "my friend needs", "my boss needs", "he's out of X").

### 6. CHIT-CHAT / SOCIAL / FIGURATIVE
Small talk, greetings, opinions, emotional venting, commentary, or figurative language with no literal actionable need:
- Emotional venting: "I'm tired", "that was fun", "the wifi keeps dropping" (frustration, not a task)
- Figurative "low on": "running low on patience", "out of ideas" — metaphors, never literal needs
- Opinions and observations: "this place has the best tacos", "the weather is nice"
- Habitual / recurrent descriptions: "we always get X on Sundays" — frequency habit, not a current depletion
- Past anecdotes WITHOUT a current depletion: "we used to run out of X constantly" — historical only

### NOTE on past-tense depletion and near-depletion
- "We ran out of X [halfway through / last weekend]" DOES signal a CURRENT need. The past tense says WHEN the depletion happened, not that it was resolved. Mint it UNLESS a later turn in the same window shows a purchase of that specific item.
- "We're almost out of X" / "running low on X" signals a current need. Mint it.
- A sentence with a hedged prefix and a concrete depletion clause ("maybe go to the store, we're almost out of milk") — the depletion clause IS real. Mint the concrete need (milk), not the hedged action ("going to the store").
- Satisfaction is ITEM-SPECIFIC. "We got coffee yesterday" resolves coffee only — it does NOT resolve milk or any other item in the same window.

### 7. IN-WINDOW STALE
If the need was expressed but then resolved or cancelled in a later turn within the same window, skip it.

## Self-check (apply before outputting each candidate)
Ask ALL of these questions:
1. Is the turn a question (ends in "?", uses interrogative phrasing)? If YES → DO NOT mint.
2. Is the turn expressing having too much, surplus, or being over-supplied? If YES → DO NOT mint.
3. Is this a concrete, currently-unmet need? Positive signals: "out of X", "ran out of X", "almost out of X", "low on X", "need X", "don't have X". If none present → DO NOT mint.
4. Is this a first-person assertion (user or household), not a third party's need? If third party → DO NOT mint.

## Output format
Return ONLY a JSON array (no markdown, no commentary). Each element:
{
  "content": "<imperative short description, e.g. 'buy coffee' — use the ITEM NAME only, no trailing qualifiers like 'for dinner' or 'for the remote' or 'this morning'>",
  "confidence": <0.0–1.0, reflect genuine uncertainty>,
  "topic": "<1–3 word normalized topic, lowercase>",
  "category": "<optional: grocery | errand | household | health | other>"
}

Content normalization rules:
- Use the pattern "buy <item>" where <item> is the shortest noun phrase naming the thing.
- STRIP trailing purpose phrases: "for dinner", "for the remote", "this morning", "tonight", "today", "soon".
- STRIP quantity words: "more", "some", "a bit of" — just the item name.
- Examples: "batteries for the remote" → "batteries"; "pasta for dinner tonight" → "pasta"; "more dish soap" → "dish soap".

If no latent needs are found, return [].`;

    // May throw on model failure — callers own the fallback (mirrors LlmRelevanceGate).
    const raw = await this.invoke(prompt);

    // Parse the JSON array from the model response. Throws on unparseable → fallback.
    const trimmed = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed: unknown = JSON.parse(trimmed); // throws on non-JSON → fallback
    if (!Array.isArray(parsed)) throw new Error("latent-recognizer: expected a JSON array");

    let candidates: Array<{
      content?: unknown;
      confidence?: unknown;
      topic?: unknown;
      category?: unknown;
    }> = parsed;

    // Build a set of already-active content keys for duplicate detection.
    const activeKeys = new Set(
      input.recentIntentions
        .filter((i) => ["pending_arm", "armed", "surfaced"].includes(i.state))
        .map((i) => i.content.toLowerCase().trim()),
    );

    const results: MintedIntention[] = [];
    const seen = new Set<string>();

    for (const c of candidates) {
      if (typeof c.content !== "string" || !c.content.trim()) continue;
      if (typeof c.confidence !== "number") continue;

      const confidence = Math.min(1, Math.max(0, c.confidence));
      if (confidence < this.threshold) continue;

      const content = c.content.trim();
      const key = content.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // --- Deterministic post-parse validation ---
      // Drop if content itself looks like a question, third-party assertion, or speculative.
      if (NEGATIVE_PATTERNS.some((p) => p.test(content))) continue;
      // Drop if already-active (dedup against live intentions in the input).
      if (activeKeys.has(key)) continue;
      // Drop if any turn AFTER the source/assertion turn satisfies or cancels this content.
      // We derive the source turn as the latest window turn whose text has topic overlap
      // with the candidate content AND is not itself a satisfaction/cancel turn for this
      // content (mirrors the deterministic recognizer's later-turns-only logic).
      // Satisfaction checks on EARLIER turns are false-positives (e.g. "we bought coffee
      // yesterday" before "we're out of coffee" must not drop the valid need).
      const candidateTopics = new Set(extractTopics(content));
      const sourceTurnIndex = (() => {
        for (let si = input.window.length - 1; si >= 0; si--) {
          const turn = input.window[si];
          // Skip turns that are themselves satisfaction/cancel turns — they are not
          // the assertion source, even if they share topic words.
          if (isSatisfiedBy(content, turn.text)) continue;
          const tt = extractTopics(turn.text);
          if (tt.some((t) => candidateTopics.has(t))) return si;
        }
        return input.window.length - 1; // fallback: last turn
      })();
      const turnsAfterSource = input.window.slice(sourceTurnIndex + 1);
      if (turnsAfterSource.some((t) => isSatisfiedBy(content, t.text))) continue;

      const topic =
        typeof c.topic === "string" && c.topic.trim()
          ? c.topic.toLowerCase().trim()
          : content
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, "")
              .trim()
              .split(/\s+/)
              .slice(0, 3)
              .join(" ");

      const trigger: TriggerPredicate = {
        all: [{ kind: "topic", topic, provenance: "inferred", confidence }],
      };

      // Optionally add a where.category affordance if the model returned one.
      if (typeof c.category === "string" && c.category.trim()) {
        (trigger.all as TriggerPredicate["all"])!.push({
          kind: "where",
          category: c.category.trim(),
          provenance: "inferred",
          confidence,
        });
      }

      results.push({
        content,
        origin: "latent",
        strength: "soft",
        confidence,
        trigger,
        evidence: { ts: input.window[input.window.length - 1]?.ts ?? new Date(input.now).toISOString() },
        sensitivity: "private",
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// makeRetryingRecognizer — production wrapper (#520)
// ---------------------------------------------------------------------------

/**
 * Production recognizer: ModelLatentRecognizer with ONE retry on a transient
 * model error. On any failure — or when no model is configured — returns []
 * (latent recognition is nice-to-have: never fall back to keyword matching,
 * never surface the failure to the realtime model). Exported so tests exercise
 * this exact closure rather than a hand-copied mirror (#520).
 */
export function makeRetryingRecognizer(invoke?: ModelInvokeFn): LatentRecognizer {
  if (!invoke) return { recognize: async () => [] };
  const model = new ModelLatentRecognizer(invoke);
  return {
    recognize: async (input: RecognizerInput): Promise<MintedIntention[]> => {
      try {
        return await model.recognize(input);
      } catch (err) {
        if (isTransientError(err)) {
          recognizerLog.warn("latent-recognizer: transient model error, retrying once");
          try {
            return await model.recognize(input);
          } catch (err2) {
            recognizerLog.warn("latent-recognizer: model unavailable after retry — skipping recognition", { error: String(err2).slice(0, 140) });
            return [];
          }
        }
        recognizerLog.warn("latent-recognizer: model call failed — skipping recognition", { error: String(err).slice(0, 140) });
        return [];
      }
    },
  };
}
