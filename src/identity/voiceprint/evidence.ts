import type { VoiceprintDecision } from "./types.js";
import { normalizeCosineSimilarityToConfidence } from "./similarity.js";

/**
 * Session-level speaker evidence accumulator.
 *
 * The per-turn classifier {@link classifyOwnerSimilarity} judges a SINGLE turn's
 * cosine similarity in isolation and returns one of `owner_speaking`,
 * `possible_owner`, or `unknown_speaker`. That per-turn verdict is intentionally
 * jumpy: a borderline turn can land in the grey band or briefly read as unknown.
 *
 * This module folds that stream of per-turn decisions into a STABILIZED,
 * product-level verdict ("is the owner speaking in this session?") using a
 * hysteresis policy so a single outlier turn cannot flip a settled verdict.
 *
 * It is a PURE layer on top of the per-turn classifier:
 *   - no IO, no Date.now(), no Math.random() — fully deterministic;
 *   - it does NOT change per-turn thresholds or semantics;
 *   - callers must opt in; nothing here runs unless a caller reduces turns.
 */

/** Stabilized, session-level verdict. */
export type SpeakerEvidenceVerdict =
  | "owner_present"
  | "provisional"
  | "not_owner"
  | "unknown";

/** A single per-turn observation fed into the accumulator. */
export interface SpeakerEvidenceTurn {
  /** The per-turn classifier decision (from classifyOwnerSimilarity). */
  decision: VoiceprintDecision;
  /** Optional raw cosine similarity for this turn (diagnostics/confidence). */
  score?: number;
  /** Optional monotonic timestamp (ms) for this turn, used for staleness decay. */
  atMs?: number;
}

/** One entry in the bounded ring of recent per-turn decisions. */
export interface SpeakerEvidenceObservation {
  decision: VoiceprintDecision;
  score?: number;
  atMs?: number;
}

export interface SpeakerEvidenceState {
  verdict: SpeakerEvidenceVerdict;
  /** Consecutive owner-ish (owner_speaking) turns observed most recently. */
  ownerStreak: number;
  /** Consecutive non-owner (unknown_speaker) turns observed most recently. */
  nonOwnerStreak: number;
  /** Bounded ring of recent per-turn observations (most recent last). */
  recent: SpeakerEvidenceObservation[];
  /** Timestamp of the most recent folded turn, if any turn carried one. */
  updatedAtMs?: number;
}

export interface SpeakerEvidenceConfig {
  /**
   * Consecutive strong-owner (`owner_speaking`) turns required to flip the
   * verdict to `owner_present`. Also the count of consistent `unknown_speaker`
   * turns required to flip to `not_owner` — unless the direction-specific
   * overrides below are set.
   */
  flipThreshold: number;
  /**
   * ASYMMETRIC HYSTERESIS overrides. On a personal device "the owner is
   * speaking" is the default assumption: establishing `owner_present` should be
   * fast (low `ownerFlipThreshold`) while overturning it should require
   * sustained clear non-owner evidence (higher `nonOwnerFlipThreshold`) — the
   * cost of briefly mislabeling the owner as unknown is a broken conversation,
   * while the cost of a slow guest flip is a few unlabeled guest turns. Each
   * defaults to `flipThreshold` when unset, preserving symmetric behavior.
   */
  ownerFlipThreshold?: number;
  nonOwnerFlipThreshold?: number;
  /**
   * INSTANT-ESTABLISH fast path: a single `owner_speaking` turn whose score
   * (the classifier's normalized confidence) clears this bar establishes
   * `owner_present` immediately, without waiting for the consecutive streak.
   * Motivated by cold start: a fresh session otherwise needs K turns before
   * the identity reaches the agent, and users ask "do you know me?" early.
   * Safe only because the confidence separation is wide (owner's clean turns
   * measured 0.85+, different real speakers far below); unset disables it.
   */
  instantOwnerConfidence?: number;
  /**
   * Bounded window over which the majority signal is evaluated and the size of
   * the retained `recent` ring.
   */
  windowSize: number;
  /**
   * If the gap between the previous turn and the incoming turn exceeds this many
   * ms, accumulated evidence is considered stale and decays back toward
   * `unknown` before the incoming turn is folded in. `undefined`/`<= 0` disables
   * time-based decay.
   */
  staleTimeoutMs?: number;
}

export const DEFAULT_SPEAKER_EVIDENCE_CONFIG: SpeakerEvidenceConfig = {
  flipThreshold: 3,
  windowSize: 5,
  // 10 minutes, matching production. The original 60s default silently decays
  // a settled owner during natural conversation pauses — the evidence-layer
  // benchmark (scripts/bench-voiceprint-evidence.ts, "sparse owner" scenario)
  // shows a 60s default NEVER establishes on sparse conversations. Deployments
  // relying on this default (no evidence block in config) now get the measured
  // value instead of the footgun.
  staleTimeoutMs: 600_000,
};

export function initialSpeakerEvidenceState(): SpeakerEvidenceState {
  return {
    verdict: "unknown",
    ownerStreak: 0,
    nonOwnerStreak: 0,
    recent: [],
  };
}

function resolveConfig(
  config?: Partial<SpeakerEvidenceConfig>,
): SpeakerEvidenceConfig {
  const merged: SpeakerEvidenceConfig = {
    ...DEFAULT_SPEAKER_EVIDENCE_CONFIG,
    ...config,
  };
  if (!Number.isInteger(merged.flipThreshold) || merged.flipThreshold < 1) {
    throw new Error("SpeakerEvidence flipThreshold must be a positive integer.");
  }
  if (!Number.isInteger(merged.windowSize) || merged.windowSize < 1) {
    throw new Error("SpeakerEvidence windowSize must be a positive integer.");
  }
  if (merged.flipThreshold > merged.windowSize) {
    throw new Error(
      "SpeakerEvidence flipThreshold must be <= windowSize; otherwise the verdict can never flip.",
    );
  }
  for (const key of ["ownerFlipThreshold", "nonOwnerFlipThreshold"] as const) {
    const value = merged[key];
    if (value === undefined) {
      continue;
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`SpeakerEvidence ${key} must be a positive integer.`);
    }
  }
  return merged;
}

/**
 * Fold a decayed/stale state back toward `unknown`. Streaks reset and the ring
 * is cleared, but we keep the verdict as `unknown` rather than resetting to the
 * initial object so downstream selectors observe the decay explicitly.
 */
function decayedState(prev: SpeakerEvidenceState): SpeakerEvidenceState {
  return {
    verdict: "unknown",
    ownerStreak: 0,
    nonOwnerStreak: 0,
    recent: [],
    updatedAtMs: prev.updatedAtMs,
  };
}

function isStale(
  prev: SpeakerEvidenceState,
  turn: SpeakerEvidenceTurn,
  cfg: SpeakerEvidenceConfig,
): boolean {
  if (
    cfg.staleTimeoutMs === undefined ||
    cfg.staleTimeoutMs <= 0 ||
    prev.updatedAtMs === undefined ||
    turn.atMs === undefined
  ) {
    return false;
  }
  return turn.atMs - prev.updatedAtMs > cfg.staleTimeoutMs;
}

function countInWindow(
  recent: readonly SpeakerEvidenceObservation[],
  predicate: (decision: VoiceprintDecision) => boolean,
): number {
  let count = 0;
  for (const obs of recent) {
    if (predicate(obs.decision)) {
      count += 1;
    }
  }
  return count;
}

/**
 * A "hard" verdict is one reached only via a confirmed K-in-a-row flip
 * (`owner_present` or `not_owner`). These are the sticky states that hysteresis
 * protects: once settled, a single outlier turn — or even a lone owner-ish
 * grey-band match — must never soften or flip them; only another hard flip (or
 * time-based decay) may move them.
 */
function isSettledHardVerdict(verdict: SpeakerEvidenceVerdict): boolean {
  return verdict === "owner_present" || verdict === "not_owner";
}

/**
 * Decide the stabilized verdict from streaks + a bounded window, applying
 * hysteresis so a single outlier turn cannot flip a settled verdict.
 *
 * Flip rules:
 *   - Flip to `owner_present` once `flipThreshold` (K) consecutive
 *     `owner_speaking` turns are seen.
 *   - Flip to `not_owner` once `flipThreshold` (K) consecutive `unknown_speaker`
 *     turns are seen.
 *   - Otherwise keep the current verdict UNLESS there is meaningful owner-ish
 *     evidence in the window (any owner_speaking or possible_owner), in which
 *     case move toward `provisional`. `possible_owner` is weak/partial owner
 *     evidence: it can hold or move toward `provisional`, but on its own never
 *     produces a hard flip to `owner_present`.
 */
function nextVerdict(
  prev: SpeakerEvidenceState,
  ownerStreak: number,
  nonOwnerStreak: number,
  recent: readonly SpeakerEvidenceObservation[],
  cfg: SpeakerEvidenceConfig,
): SpeakerEvidenceVerdict {
  const windowOwner = countInWindow(recent, (d) => d === "owner_speaking");
  const windowPossible = countInWindow(recent, (d) => d === "possible_owner");

  // A hard flip requires K consecutive turns of the same strong signal. Using a
  // consecutive streak (rather than a bounded-window majority) is what kills
  // flapping: an alternating owner/unknown pattern never reaches K-in-a-row of
  // either, so it cannot oscillate between owner_present and not_owner. A single
  // outlier turn resets only the relevant streak, never the settled verdict.
  // The two directions may use different K (asymmetric hysteresis — see
  // SpeakerEvidenceConfig.ownerFlipThreshold/nonOwnerFlipThreshold).
  const latest = recent[recent.length - 1];
  const instantOwner =
    cfg.instantOwnerConfidence !== undefined &&
    latest?.decision === "owner_speaking" &&
    latest.score !== undefined &&
    latest.score >= cfg.instantOwnerConfidence;
  const ownerConfirmed =
    ownerStreak >= (cfg.ownerFlipThreshold ?? cfg.flipThreshold) || instantOwner;
  const nonOwnerConfirmed = nonOwnerStreak >= (cfg.nonOwnerFlipThreshold ?? cfg.flipThreshold);

  // A confirmed strong-owner signal always wins over a confirmed non-owner one:
  // sustained genuine owner turns should hold the owner verdict.
  if (ownerConfirmed) {
    return "owner_present";
  }
  if (nonOwnerConfirmed) {
    return "not_owner";
  }

  // No hard flip. If there is any owner-ish evidence in the window (strong or
  // weak/partial), settle at `provisional` rather than leaving a stale verdict.
  const hasOwnerishEvidence = windowOwner > 0 || windowPossible > 0;
  if (hasOwnerishEvidence) {
    // Do not silently downgrade an already-settled hard verdict on a single
    // borderline turn: hysteresis keeps it until another hard flip. This is
    // symmetric — a stray owner-ish turn (even a weak possible_owner grey-band
    // match) must NOT soften a settled not_owner back to provisional, exactly as
    // it does not soften a settled owner_present.
    if (isSettledHardVerdict(prev.verdict)) {
      return prev.verdict;
    }
    return "provisional";
  }

  // No owner-ish evidence and no confirmed non-owner flip: keep the current
  // verdict (hysteresis) or fall back to unknown when nothing is settled.
  //
  // A settled hard verdict is held here too. And once a verdict is
  // `provisional`, this branch keeps it `provisional` — it is intentionally
  // terminal-until-hard-flip: it only leaves via a hard flip to
  // owner_present/not_owner or via time-based decay (see staleTimeoutMs /
  // decayedState), never by spontaneously falling back to `unknown` on a run of
  // ambiguous turns, because hysteresis prefers a stable verdict over churn.
  //
  // Returning `prev.verdict` covers all three sticky cases (owner_present,
  // not_owner, provisional) and correctly returns `unknown` only when the prior
  // verdict was already `unknown` — nothing else can reach this line.
  return prev.verdict;
}

/**
 * Fold one per-turn observation into the session-level evidence state and return
 * a NEW state (the input is not mutated). Pure and deterministic.
 */
export function reduceSpeakerEvidence(
  state: SpeakerEvidenceState,
  turn: SpeakerEvidenceTurn,
  config?: Partial<SpeakerEvidenceConfig>,
): SpeakerEvidenceState {
  const cfg = resolveConfig(config);
  const base = isStale(state, turn, cfg) ? decayedState(state) : state;

  const ownerStreak =
    turn.decision === "owner_speaking" ? base.ownerStreak + 1 : 0;
  const nonOwnerStreak =
    turn.decision === "unknown_speaker" ? base.nonOwnerStreak + 1 : 0;

  const observation: SpeakerEvidenceObservation = {
    decision: turn.decision,
    ...(turn.score !== undefined ? { score: turn.score } : {}),
    ...(turn.atMs !== undefined ? { atMs: turn.atMs } : {}),
  };
  const recent = [...base.recent, observation];
  if (recent.length > cfg.windowSize) {
    recent.splice(0, recent.length - cfg.windowSize);
  }

  const verdict = nextVerdict(base, ownerStreak, nonOwnerStreak, recent, cfg);

  return {
    verdict,
    ownerStreak,
    nonOwnerStreak,
    recent,
    updatedAtMs: turn.atMs ?? base.updatedAtMs,
  };
}

export interface SpeakerEvidenceReading {
  verdict: SpeakerEvidenceVerdict;
  /**
   * Confidence in the stabilized verdict, in [0, 1]. Derived deterministically
   * from the fraction of the recent window that agrees with the verdict, blended
   * with the mean per-turn score for that agreeing subset when scores are
   * present.
   */
  confidence: number;
  ownerStreak: number;
  nonOwnerStreak: number;
  windowSize: number;
}

/**
 * Read the current stabilized verdict + a confidence from an evidence state.
 * Pure; does not mutate or advance the state.
 */
export function readSpeakerEvidence(
  state: SpeakerEvidenceState,
): SpeakerEvidenceReading {
  const window = state.recent;
  const reading: SpeakerEvidenceReading = {
    verdict: state.verdict,
    confidence: 0,
    ownerStreak: state.ownerStreak,
    nonOwnerStreak: state.nonOwnerStreak,
    windowSize: window.length,
  };

  if (window.length === 0) {
    return reading;
  }

  const agreeing = window.filter((obs) =>
    observationAgreesWithVerdict(obs.decision, state.verdict),
  );
  if (agreeing.length === 0) {
    // A settled verdict with no agreeing turns in-window (e.g. right after a
    // borderline turn under hysteresis) gets a small floor of confidence.
    reading.confidence = state.verdict === "unknown" ? 0 : 0.25;
    return reading;
  }

  const agreementFraction = agreeing.length / window.length;
  const scored = agreeing.filter((obs) => obs.score !== undefined);
  if (scored.length === 0) {
    reading.confidence = clamp01(agreementFraction);
    return reading;
  }

  const meanScore =
    scored.reduce(
      (sum, obs) => sum + verdictScoreContribution(state.verdict, obs.score!),
      0,
    ) / scored.length;
  reading.confidence = clamp01((agreementFraction + meanScore) / 2);
  return reading;
}

/**
 * Map a per-turn cosine similarity to its contribution to the confidence of a
 * given verdict, in [0, 1].
 *
 * For owner-ish verdicts (`owner_present`/`provisional`) the agreeing turns are
 * owner_speaking/possible_owner, so a HIGHER cosine (closer to the owner
 * template) means MORE confidence — use `normalizeCosineSimilarityToConfidence`
 * directly.
 *
 * For `not_owner` the agreeing turns are `unknown_speaker`, which by
 * construction sit BELOW the owner threshold. A clearly-different speaker has a
 * low (even negative) cosine and should read as HIGH not_owner confidence, while
 * a borderline speaker just under the threshold is less certain. The score
 * contribution must therefore be INVERTED (`1 - normalized`); otherwise the
 * more obviously-not-the-owner a speaker is, the lower the reported confidence.
 */
function verdictScoreContribution(
  verdict: SpeakerEvidenceVerdict,
  score: number,
): number {
  const normalized = normalizeCosineSimilarityToConfidence(score);
  return verdict === "not_owner" ? 1 - normalized : normalized;
}

function observationAgreesWithVerdict(
  decision: VoiceprintDecision,
  verdict: SpeakerEvidenceVerdict,
): boolean {
  switch (verdict) {
    case "owner_present":
      return decision === "owner_speaking" || decision === "possible_owner";
    case "not_owner":
      return decision === "unknown_speaker";
    case "provisional":
      return decision === "possible_owner" || decision === "owner_speaking";
    case "unknown":
      return false;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Convenience: fold an ordered sequence of per-turn observations into a single
 * stabilized state (starting from `initialSpeakerEvidenceState()` unless a seed
 * is provided). Useful for scoring a whole session's turn states at once.
 */
export function foldSpeakerEvidence(
  turns: readonly SpeakerEvidenceTurn[],
  config?: Partial<SpeakerEvidenceConfig>,
  seed?: SpeakerEvidenceState,
): SpeakerEvidenceState {
  let state = seed ?? initialSpeakerEvidenceState();
  for (const turn of turns) {
    state = reduceSpeakerEvidence(state, turn, config);
  }
  return state;
}
