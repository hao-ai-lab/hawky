// A10 — Voiceprint threshold CALIBRATION machinery (pure, server-side, dep-free).
//
// WHAT THIS IS. Everything before A10 shipped a THRESHOLD (0.82/0.72) that was
// hand-picked and PROVISIONAL. There was nowhere in the codebase that turned a
// distribution of genuine vs impostor scores into a defensible operating point.
// This module is that missing machinery: given genuine (owner-vs-owner) and
// impostor (non-owner-vs-owner) score arrays it computes FAR/FRR at candidate
// thresholds, the EER (equal-error-rate) and its threshold, and a recommended
// { ownerAccept, ownerPossible } via a STATED rule. It also derives those score
// arrays from the A7 privacy-safe score histograms so a running deployment's
// field telemetry can drive calibration, and it carries a per-model PROFILE
// structure so CAM++ raw-cosine can hold its own PROVISIONAL calibrated numbers
// while the reference backend + everything else keep DEFAULT_VOICEPRINT_THRESHOLDS.
//
// WHAT THIS IS NOT (HONESTY, non-negotiable). This module ships the MATH and a
// PROVISIONAL CAM++ profile — NOT a production-calibrated operating point. A
// production operating point requires a REAL, DIVERSE HUMAN IMPOSTOR COHORT
// (hundreds of speakers, same mic/room diversity as the field), embedded with the
// SAME model as the owner template. TTS ("say") impostors sit at cos ~0.10 — far
// from any human voice — so a TTS-only calibration sets the threshold much too
// loose and is explicitly REFUSED as a calibration source (see the mic-smoke
// header, scripts/voiceprint-mic-smoke.sh). The bundled CAM++ profile is derived
// from the documented real margins + the sr-data fixture operating point and is
// clearly labeled PROVISIONAL / uncalibrated-for-production.
//
// WIRING IS OPT-IN. Nothing here changes DEFAULT_VOICEPRINT_THRESHOLDS or the
// live default. The live scoring path only picks up a calibrated profile when an
// operator EXPLICITLY provides one via config; with no profile supplied,
// resolveVoiceprintThresholdsForModel returns DEFAULT unchanged.

import {
  DEFAULT_VOICEPRINT_THRESHOLDS,
  type VoiceprintModelInfo,
  type VoiceprintThresholds,
} from "./types.js";
import {
  MIN_OWNER_ACCEPT_THRESHOLD,
  validateVoiceprintThresholds,
} from "./thresholds.js";
import { sameVoiceprintModel } from "./model.js";
import type {
  VoiceprintScoreHistogram,
  VoiceprintScoreTelemetryAggregate,
} from "./scoring-telemetry.js";

/**
 * The score space a threshold lives in. Raw cosine ([-1, 1], validated by the
 * raw-cosine {@link validateVoiceprintThresholds}) vs the AS-Norm z-score-like
 * value (unbounded, its own thresholds). A calibration result and a profile are
 * always tagged with the space they were fit in — thresholds from one space are
 * meaningless in the other.
 */
export type VoiceprintScoreSpace = "raw_cosine" | "asnorm_zscore";

// ── Operating-point / EER / FAR-FRR math ─────────────────────────────────────

export interface VoiceprintOperatingPointOptions {
  /**
   * Target FALSE-ACCEPT rate for ownerAccept. The recommended ownerAccept is the
   * LOWEST candidate threshold whose FAR <= this target (accept as many genuine
   * owners as possible while holding impostor accepts under the budget). Default 0.01.
   */
  targetFar?: number;
  /**
   * Target FALSE-REJECT rate for ownerPossible. The recommended ownerPossible is
   * the HIGHEST candidate threshold whose FRR <= this target (a lower "possible"
   * band that still lets most genuine owners through), clamped to be <= ownerAccept.
   * Default 0.05.
   */
  targetFrr?: number;
  /**
   * Explicit candidate thresholds to evaluate. When omitted, candidates are
   * derived from the observed score range (all distinct scores plus midpoints),
   * so the sweep is deterministic and data-driven with no arbitrary grid.
   */
  candidateThresholds?: readonly number[];
  /**
   * The score space these scores live in. Governs whether the recommended
   * thresholds are validated by the raw-cosine {@link validateVoiceprintThresholds}
   * (raw_cosine) or only ordered/finite (asnorm_zscore). Default "raw_cosine".
   */
  scoreSpace?: VoiceprintScoreSpace;
}

/** FAR/FRR at one candidate threshold. */
export interface VoiceprintFarFrrPoint {
  threshold: number;
  /** P(impostor score >= threshold) — impostors wrongly accepted. */
  far: number;
  /** P(genuine score < threshold) — genuine owners wrongly rejected. */
  frr: number;
}

export type VoiceprintOperatingPoint =
  | {
      kind: "insufficient_data";
      /** Why calibration was refused rather than emitting a bogus threshold. */
      reason:
        | "genuine_empty"
        | "impostor_empty"
        | "non_finite_scores"
        | "no_valid_candidates";
      genuineCount: number;
      impostorCount: number;
    }
  | {
      kind: "operating_point";
      scoreSpace: VoiceprintScoreSpace;
      genuineCount: number;
      impostorCount: number;
      /** FAR/FRR at every evaluated candidate threshold, ascending by threshold. */
      curve: VoiceprintFarFrrPoint[];
      /** The equal-error-rate: the point where |FAR - FRR| is minimized. */
      eer: {
        /** The threshold at (closest to) the FAR==FRR crossover. */
        threshold: number;
        /** The equal error rate itself (max(FAR, FRR) at that threshold). */
        rate: number;
        far: number;
        frr: number;
      };
      /**
       * The recommended thresholds, chosen by the documented targetFar/targetFrr
       * rule and GUARANTEED to pass {@link validateVoiceprintThresholds} for the
       * declared score space (raw_cosine goes through the full raw validator).
       */
      recommended: VoiceprintThresholds;
      /** The targets that produced `recommended` (for reproducibility). */
      targets: { targetFar: number; targetFrr: number };
    };

const DEFAULT_TARGET_FAR = 0.01;
const DEFAULT_TARGET_FRR = 0.05;

/**
 * Compute an operating point (FAR/FRR curve + EER + recommended thresholds) from
 * genuine (owner-vs-owner) and impostor (non-owner-vs-owner) score arrays.
 *
 * DETERMINISTIC, dependency-free. Empty or one-sided input is REFUSED (returns an
 * `insufficient_data` result) rather than emitting a bogus threshold — you cannot
 * calibrate an operating point without BOTH distributions. Non-finite scores are
 * likewise refused (a NaN would silently corrupt every rate).
 *
 * RECOMMENDATION RULE (stated, not magic):
 *   - ownerAccept  = the LOWEST candidate threshold whose FAR <= targetFar. This
 *     admits as many genuine owners as possible while keeping impostor accepts
 *     under the FAR budget. If no threshold meets targetFar (heavy overlap), we
 *     fall back to the EER threshold (the best achievable balance).
 *   - ownerPossible = the HIGHEST candidate threshold BELOW ownerAccept whose
 *     FRR <= targetFrr, i.e. a lower "possible owner" band that still lets most
 *     genuine owners in while staying STRICTLY below ownerAccept (so the
 *     possible_owner interval [ownerPossible, ownerAccept) is non-empty on
 *     separable data). If none qualifies below accept, fall back to the EER
 *     threshold (which lies in the separating gap, below accept).
 *   - Both are then floored into the valid range and run through
 *     {@link validateVoiceprintThresholds} (for raw_cosine) so the result can NEVER
 *     be ownerAccept < MIN_OWNER_ACCEPT_THRESHOLD or ownerAccept < ownerPossible.
 *
 * TIES / OVERLAP are handled explicitly: FAR uses `>=` (a score exactly at the
 * threshold is ACCEPTED, matching the classifier), FRR uses `<` (a genuine score
 * exactly at the threshold is NOT rejected). Candidate thresholds include the
 * midpoints between adjacent distinct scores so a separating threshold that sits
 * strictly BETWEEN the two clouds is always reachable even on integer-like data.
 */
export function computeVoiceprintOperatingPoint(
  genuineScores: readonly number[],
  impostorScores: readonly number[],
  options: VoiceprintOperatingPointOptions = {},
): VoiceprintOperatingPoint {
  const scoreSpace = options.scoreSpace ?? "raw_cosine";
  const genuineCount = genuineScores.length;
  const impostorCount = impostorScores.length;

  if (genuineCount === 0) {
    return { kind: "insufficient_data", reason: "genuine_empty", genuineCount, impostorCount };
  }
  if (impostorCount === 0) {
    return { kind: "insufficient_data", reason: "impostor_empty", genuineCount, impostorCount };
  }
  if (
    !genuineScores.every(Number.isFinite) ||
    !impostorScores.every(Number.isFinite)
  ) {
    return {
      kind: "insufficient_data",
      reason: "non_finite_scores",
      genuineCount,
      impostorCount,
    };
  }

  const candidates = resolveCandidateThresholds(
    genuineScores,
    impostorScores,
    options.candidateThresholds,
  );

  // A caller-supplied candidate list can filter down to empty (e.g. every value
  // was non-finite). An empty sweep yields an empty curve, which findEqualErrorRate
  // cannot search — refuse via a typed result rather than dereferencing curve[0].
  // (The data-derived sweep is always non-empty, so this only guards the explicit
  // candidate path.)
  if (candidates.length === 0) {
    return {
      kind: "insufficient_data",
      reason: "no_valid_candidates",
      genuineCount,
      impostorCount,
    };
  }

  const curve: VoiceprintFarFrrPoint[] = candidates.map((threshold) => ({
    threshold,
    // FAR: impostor accepted when score >= threshold (matches the classifier's
    // `similarity >= ownerAccept`). FRR: genuine rejected when score < threshold.
    far: fraction(impostorScores, (s) => s >= threshold),
    frr: fraction(genuineScores, (s) => s < threshold),
  }));

  const eer = findEqualErrorRate(curve);

  const targetFar = options.targetFar ?? DEFAULT_TARGET_FAR;
  const targetFrr = options.targetFrr ?? DEFAULT_TARGET_FRR;

  // ownerAccept: lowest threshold with FAR <= targetFar (curve is ascending in
  // threshold, so FAR is monotone non-increasing — the first hit is the lowest).
  const acceptHit = curve.find((p) => p.far <= targetFar);
  const acceptRaw = acceptHit?.threshold ?? eer.threshold;

  // ownerPossible: a LOWER "possible owner" band that must sit STRICTLY BELOW
  // ownerAccept (the classifier only fires possible_owner on ownerPossible <= s <
  // ownerAccept, so an equal pair would make that interval empty and collapse the
  // two-tier design to a single threshold). We take the highest threshold with
  // FRR <= targetFrr, but only among candidates BELOW ownerAccept. On separable
  // data FRR is ~0 well below the accept point, so this keeps a genuine lower band
  // instead of clamping back up to ownerAccept. If no qualifying threshold sits
  // below accept (e.g. every FRR<=targetFrr point is at/above accept), we fall
  // back to the EER threshold, which by construction lies in the separating gap
  // below accept; that too is capped strictly below accept in clamp.
  let possibleRaw = eer.threshold;
  for (const p of curve) {
    if (p.threshold < acceptRaw && p.frr <= targetFrr) {
      possibleRaw = p.threshold;
    }
  }
  // If even the EER fallback is not below accept (pathological), pull it below.
  if (possibleRaw >= acceptRaw) {
    possibleRaw = eer.threshold < acceptRaw ? eer.threshold : acceptRaw;
  }

  const recommended = clampRecommendedThresholds(
    { ownerAccept: acceptRaw, ownerPossible: possibleRaw },
    scoreSpace,
  );

  return {
    kind: "operating_point",
    scoreSpace,
    genuineCount,
    impostorCount,
    curve,
    eer,
    recommended,
    targets: { targetFar, targetFrr },
  };
}

/** Fraction of `values` satisfying `pred`. Assumes non-empty (guarded by caller). */
function fraction(values: readonly number[], pred: (v: number) => boolean): number {
  let hits = 0;
  for (const v of values) {
    if (pred(v)) {
      hits += 1;
    }
  }
  return hits / values.length;
}

/**
 * Build the ascending, de-duplicated candidate-threshold sweep. When the caller
 * supplies explicit candidates we use those (sorted/deduped). Otherwise we use
 * every distinct observed score PLUS the midpoint between each pair of adjacent
 * distinct scores — this guarantees a threshold that sits strictly between the two
 * clouds (perfect separation => EER 0) is always in the sweep, and it needs no
 * arbitrary grid resolution.
 */
function resolveCandidateThresholds(
  genuineScores: readonly number[],
  impostorScores: readonly number[],
  explicit?: readonly number[],
): number[] {
  if (explicit && explicit.length > 0) {
    return dedupeSorted(explicit.filter(Number.isFinite));
  }
  const distinct = dedupeSorted([...genuineScores, ...impostorScores]);
  const withMidpoints: number[] = [];
  for (let i = 0; i < distinct.length; i += 1) {
    withMidpoints.push(distinct[i]!);
    if (i + 1 < distinct.length) {
      withMidpoints.push((distinct[i]! + distinct[i + 1]!) / 2);
    }
  }
  // Extend just past both ends so FAR can reach 0 (threshold above every score)
  // and FRR can reach 0 (threshold below every score); the EER search needs both.
  const lo = distinct[0]!;
  const hi = distinct[distinct.length - 1]!;
  const pad = Math.max(1e-6, (hi - lo) * 1e-3);
  return dedupeSorted([lo - pad, ...withMidpoints, hi + pad]);
}

function dedupeSorted(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || out[out.length - 1] !== v) {
      out.push(v);
    }
  }
  return out;
}

/**
 * The equal-error-rate: the curve point minimizing |FAR - FRR|. On a perfectly
 * separable set some threshold has FAR == FRR == 0, so EER is 0. On overlapping
 * data the crossover is where FAR and FRR are closest; we report max(FAR, FRR)
 * there as the rate (the conservative side of the crossover). Ties broken toward
 * the lower rate then the lower threshold for determinism.
 */
function findEqualErrorRate(
  curve: readonly VoiceprintFarFrrPoint[],
): { threshold: number; rate: number; far: number; frr: number } {
  let best = curve[0]!;
  let bestGap = Math.abs(best.far - best.frr);
  let bestRate = Math.max(best.far, best.frr);
  for (const p of curve) {
    const gap = Math.abs(p.far - p.frr);
    const rate = Math.max(p.far, p.frr);
    if (gap < bestGap || (gap === bestGap && rate < bestRate)) {
      best = p;
      bestGap = gap;
      bestRate = rate;
    }
  }
  return {
    threshold: best.threshold,
    rate: Math.max(best.far, best.frr),
    far: best.far,
    frr: best.frr,
  };
}

/**
 * Floor a raw recommendation into a VALID VoiceprintThresholds and validate it.
 *
 * For raw_cosine we push ownerAccept up to MIN_OWNER_ACCEPT_THRESHOLD and cap at
 * 1, clamp ownerPossible into [0, ownerAccept], and then run the FULL raw-cosine
 * {@link validateVoiceprintThresholds} — so a recommendation can NEVER escape the
 * documented invariants (ownerAccept >= 0.5, ownerAccept >= ownerPossible). For
 * asnorm_zscore we only enforce finiteness + ordering (the z-score scale is
 * unbounded), mirroring turn-scoring's resolveAsNormThresholds contract.
 */
function clampRecommendedThresholds(
  raw: VoiceprintThresholds,
  scoreSpace: VoiceprintScoreSpace,
): VoiceprintThresholds {
  let ownerAccept = raw.ownerAccept;
  let ownerPossible = Math.min(raw.ownerPossible, ownerAccept);

  if (scoreSpace === "raw_cosine") {
    ownerAccept = Math.min(1, Math.max(MIN_OWNER_ACCEPT_THRESHOLD, ownerAccept));
    ownerPossible = Math.min(ownerAccept, Math.max(0, ownerPossible));
    const thresholds: VoiceprintThresholds = { ownerAccept, ownerPossible };
    // Reuse the production validator: any out-of-range recommendation is a hard
    // error rather than a silent bad threshold.
    validateVoiceprintThresholds(thresholds);
    return thresholds;
  }

  // asnorm_zscore: unbounded scale, only finiteness + ordering required.
  if (!Number.isFinite(ownerAccept) || !Number.isFinite(ownerPossible)) {
    throw new Error("Voiceprint AS-Norm calibrated thresholds must be finite numbers.");
  }
  return { ownerAccept, ownerPossible: Math.min(ownerAccept, ownerPossible) };
}

// ── Histogram -> representative scores derivation (A7 field-data bridge) ──────

/**
 * Approximate the raw scores that produced a histogram by emitting, for each bin,
 * `count` copies of that bin's REPRESENTATIVE score (the bin's midpoint). This
 * lets the A7 privacy-safe telemetry histograms (which retain only per-bin counts,
 * never raw scores) drive calibration.
 *
 * APPROXIMATION (documented): within-bin position is lost, so every observation in
 * a bin collapses to its midpoint. The FAR/FRR of the derived arrays is therefore
 * accurate to the bin WIDTH; narrower bins => a tighter approximation. This is a
 * deliberate privacy/precision trade — the histogram never stored the raw score,
 * so the exact value is unrecoverable by construction.
 */
export function voiceprintScoresFromHistogram(
  histogram: VoiceprintScoreHistogram,
): number[] {
  const width = (histogram.max - histogram.min) / histogram.binCount;
  const scores: number[] = [];
  for (let i = 0; i < histogram.binCount; i += 1) {
    const count = histogram.bins[i] ?? 0;
    if (count <= 0) {
      continue;
    }
    const midpoint = histogram.min + width * (i + 0.5);
    for (let n = 0; n < count; n += 1) {
      scores.push(midpoint);
    }
  }
  return scores;
}

/**
 * Derive (genuine, impostor) score arrays from an A7 telemetry aggregate for
 * calibration.
 *
 * LABELING MODEL. The telemetry aggregate holds per-DECISION histograms, not
 * ground-truth genuine/impostor labels — the scorer does not know truth at score
 * time. So this bridge treats the decision classes as a PROXY, configurable via
 * `genuineDecisions` / `impostorDecisions`. The default proxy is:
 *   - genuine  <- the `owner_speaking` histogram (accepted-as-owner scores), and
 *   - impostor <- the `unknown_speaker` histogram (rejected-as-non-owner scores).
 * The `possible_owner` band is AMBIGUOUS by construction and is left OUT of both
 * arrays by default (assigning it to either side would bias the operating point).
 *
 * HONESTY. This is a self-labeled proxy over the CURRENT threshold's own
 * decisions, NOT ground truth. It is fit for watching drift and for a coarse
 * field-data operating point, but a PRODUCTION recalibration still needs
 * ground-truth-labeled genuine/impostor scores (a real human impostor cohort),
 * not the scorer's own past decisions. Callers can override the decision->label
 * mapping when they DO have labeled telemetry streams.
 */
export function voiceprintCalibrationScoresFromTelemetry(
  aggregate: VoiceprintScoreTelemetryAggregate,
  options: {
    genuineDecisions?: readonly ("owner_speaking" | "possible_owner" | "unknown_speaker")[];
    impostorDecisions?: readonly ("owner_speaking" | "possible_owner" | "unknown_speaker")[];
  } = {},
): { genuineScores: number[]; impostorScores: number[] } {
  const genuineDecisions = options.genuineDecisions ?? ["owner_speaking"];
  const impostorDecisions = options.impostorDecisions ?? ["unknown_speaker"];

  const genuineScores: number[] = [];
  for (const decision of genuineDecisions) {
    genuineScores.push(...voiceprintScoresFromHistogram(aggregate.histograms[decision]));
  }
  const impostorScores: number[] = [];
  for (const decision of impostorDecisions) {
    impostorScores.push(...voiceprintScoresFromHistogram(aggregate.histograms[decision]));
  }
  return { genuineScores, impostorScores };
}

// ── Per-model calibration PROFILE + resolver ─────────────────────────────────

/**
 * A calibration profile: thresholds keyed by MODEL identity (provider + modelId
 * [+ optional version]) AND score space. A profile is the unit an operator ships
 * so a specific model in a specific score space carries its own calibrated (or
 * provisionally-calibrated) thresholds without touching DEFAULT.
 */
export interface VoiceprintCalibrationProfile {
  model: VoiceprintModelInfo;
  scoreSpace: VoiceprintScoreSpace;
  thresholds: VoiceprintThresholds;
  /**
   * TRUE when these thresholds are PROVISIONAL (not calibrated on a real human
   * cohort). Shipped profiles here are provisional; a real deployment overrides
   * with `provisional: false` only after a real cohort calibration.
   */
  provisional: boolean;
  /** Human-readable provenance: what data produced these numbers. */
  notes: string;
}

/**
 * The CAM++ (3D-Speaker via sherpa-onnx) model tag. This is the discriminative
 * production embedding model whose real operating margins are documented in
 * scripts/voiceprint-mic-smoke.sh.
 */
export const CAMPLUSPLUS_VOICEPRINT_MODEL: VoiceprintModelInfo = {
  provider: "sherpa-onnx",
  modelId: "3dspeaker-campplus",
};

/**
 * PROVISIONAL CAM++ raw-cosine profile.
 *
 * PROVENANCE (documented, verifiable): scripts/voiceprint-mic-smoke.sh records
 * owner-vs-owner (different words) at cos ~0.88, a DIFFERENT REAL person at
 * ~0.38, and a TTS voice at ~0.10; the sr-data onnx e2e sees owner-A-vs-A ~0.599
 * and A-vs-B ~0.049. The real separating operating point sits at ~0.5-0.55, so
 * the shipped DEFAULT (0.82 accept) would FALSE-REJECT a genuine owner on a
 * cross-recording. This profile places ownerAccept at 0.55 (above the real-human
 * impostor ~0.38, below the cross-recording owner ~0.60) with a lower
 * ownerPossible band at 0.45.
 *
 * PROVISIONAL / NOT PRODUCTION-CALIBRATED. These numbers come from a HANDFUL of
 * clips + fixtures + one real-human impostor — NOT a diverse human impostor
 * cohort. TTS impostors (~0.10) are explicitly excluded from the derivation (they
 * would loosen the threshold). The FINAL production operating point requires a
 * real, diverse human impostor cohort embedded with this exact model, run through
 * {@link computeVoiceprintOperatingPoint}. Until then this profile stays
 * PROVISIONAL and is OPT-IN only — it does NOT change any live default.
 */
export const CAMPLUSPLUS_PROVISIONAL_RAW_COSINE_PROFILE: VoiceprintCalibrationProfile = {
  model: CAMPLUSPLUS_VOICEPRINT_MODEL,
  scoreSpace: "raw_cosine",
  thresholds: { ownerAccept: 0.55, ownerPossible: 0.45 },
  provisional: true,
  notes:
    "PROVISIONAL. Derived from documented CAM++ real margins (owner~0.88, cross-recording owner~0.60, real-human impostor~0.38; TTS~0.10 EXCLUDED) + sr-data fixture operating point. NOT calibrated on a real human impostor cohort; do not treat as a production operating point.",
};

/** The provisional profiles this module ships. Reference model is intentionally absent. */
export const BUILTIN_VOICEPRINT_CALIBRATION_PROFILES: readonly VoiceprintCalibrationProfile[] = [
  CAMPLUSPLUS_PROVISIONAL_RAW_COSINE_PROFILE,
];

/**
 * Pick the calibrated thresholds for a given model + score space, or fall back to
 * DEFAULT_VOICEPRINT_THRESHOLDS when no profile matches.
 *
 * MATCHING: a profile matches when its `scoreSpace` equals `scoreSpace` AND its
 * `model` equals `model` under {@link sameVoiceprintModel} (provider + modelId +
 * version). So the reference backend and any un-profiled model resolve to DEFAULT
 * unchanged — this is what keeps live behavior byte-for-byte identical unless an
 * operator explicitly ships a matching profile.
 *
 * `...overrides` are applied on top of the resolved thresholds (partial, like
 * {@link resolveVoiceprintThresholds}); for raw_cosine the result is validated.
 *
 * DEFAULT PROFILE SET. Callers wire the live path through here with `profiles`
 * ABSENT (=> BUILTIN set is NOT auto-applied to live; see note) — the built-in
 * CAM++ profile is only consulted when explicitly passed. This keeps A10's opt-in
 * contract: no profile argument => DEFAULT thresholds, exactly as today.
 */
export function resolveVoiceprintThresholdsForModel(
  model: VoiceprintModelInfo,
  scoreSpace: VoiceprintScoreSpace,
  options: {
    profiles?: readonly VoiceprintCalibrationProfile[];
    overrides?: Array<Partial<VoiceprintThresholds> | undefined>;
  } = {},
): VoiceprintThresholds {
  const profiles = options.profiles ?? [];
  const match = profiles.find(
    (p) => p.scoreSpace === scoreSpace && sameVoiceprintModel(p.model, model),
  );

  const base = match ? match.thresholds : DEFAULT_VOICEPRINT_THRESHOLDS;
  const merged = Object.assign(
    {},
    base,
    ...(options.overrides ?? []).filter((o): o is Partial<VoiceprintThresholds> => o !== undefined),
  ) as VoiceprintThresholds;

  // raw_cosine goes through the full raw validator; asnorm_zscore only needs
  // finiteness + ordering (its scale is unbounded).
  if (scoreSpace === "raw_cosine") {
    validateVoiceprintThresholds(merged);
  } else {
    if (!Number.isFinite(merged.ownerAccept) || !Number.isFinite(merged.ownerPossible)) {
      throw new Error("Voiceprint AS-Norm thresholds must be finite numbers.");
    }
    if (merged.ownerAccept < merged.ownerPossible) {
      throw new Error("Voiceprint AS-Norm thresholds require ownerAccept >= ownerPossible.");
    }
  }
  return merged;
}
