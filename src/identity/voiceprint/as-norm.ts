import type { VoiceprintModelInfo, VoiceprintThresholds } from "./types.js";
import { sameVoiceprintModel } from "./model.js";
import { bestOwnerClip, isUsableEmbeddingVector, safeCosineSimilarity } from "./similarity.js";

/**
 * AS-Norm (Adaptive Symmetric Normalization) score normalization for voiceprint
 * scoring.
 *
 * WHY. A raw owner<->test cosine is condition-dependent: the same owner scores
 * ~0.88 within one recording session but ~0.60 across recordings, while a
 * different real speaker scores ~0.38. A single scalar threshold cannot span
 * those recording conditions. AS-Norm normalizes the raw cosine against a COHORT
 * of impostor (non-owner) embeddings, so the genuine distribution tightens and
 * scores become comparable across conditions. It is the principled fix for the
 * scoring-calibration section of the ambient-agent plan.
 *
 * This module is PURE: no IO, no Date.now, no randomness. It computes a
 * z-score-like normalized value from the raw cosine plus cohort statistics.
 *
 * OFF BY DEFAULT. This module is pure algorithm; nothing here enables AS-Norm.
 * The opt-in wiring lives in turn-scoring.ts and is engaged ONLY when a caller
 * passes an explicit `asNorm` option. With that option omitted, turn scoring is
 * byte-for-byte the pre-AS-Norm raw-cosine path — that invariant is deliberate.
 *
 * HONESTY / PRODUCTION READINESS (follow-up, tracked in the plan's
 * "Threshold & scoring calibration strategy" section). A real production cohort
 * needs HUNDREDS of diverse non-owner speakers embedded with the SAME model as
 * the owner template, and the normalized thresholds must be CALIBRATED on real
 * data at a chosen FAR/FRR operating point (the threshold-calibration follow-up).
 * Until a real cohort + calibrated normalized thresholds are provisioned, AS-Norm
 * MUST stay off in production; the defaults below are illustrative placeholders,
 * not shippable numbers. The wiring here ships the algorithm and an opt-in path
 * only.
 */

/**
 * A model-tagged cohort of impostor (non-owner) embeddings used as the AS-Norm
 * normalization reference. The `model` MUST match the owner template model
 * (checked with {@link sameVoiceprintModel}) — cohort cosines are only
 * comparable to owner<->test cosines when produced by the same model+version.
 *
 * NO-BIOMETRIC GUARANTEE. A cohort holds ONLY non-owner (impostor) embeddings; it
 * carries no owner biometric data. Nothing here reads the owner template, and the
 * owner<->test cosine is passed in as an opaque scalar (`rawScore`), never derived
 * from the cohort. That separation is what makes cohort-based normalization — and
 * the threshold calibration built on top of it — a fixed background asset that
 * ships without exposing any owner biometric secret.
 *
 * HOW THIS FEEDS THRESHOLD CALIBRATION. AS-Norm re-expresses the raw cosine as a
 * z-score against THIS cohort's impostor distribution, so the operating point
 * (FAR/FRR) is defined against the impostor scores, not against replayed owner
 * audio. The calibration follow-up (see the plan's "Threshold & scoring
 * calibration strategy") therefore fits the normalized thresholds from the cohort
 * distribution plus a modest set of genuine samples — it does not require, and
 * this asset never stores, a broad owner biometric corpus.
 */
export interface VoiceprintCohort {
  model: VoiceprintModelInfo;
  embeddings: number[][];
}

/** Default top-N cap. AS-Norm uses the topN largest cohort cosines. */
export const DEFAULT_AS_NORM_TOP_N = 300;

/**
 * The z-score-like value AS-Norm emits is NOT a cosine, so it needs its OWN
 * thresholds — do NOT reuse the raw-cosine 0.82/0.72. These defaults are
 * illustrative placeholders for tests/demo ONLY and MUST be calibrated on real
 * data before production use.
 */
export const PLACEHOLDER_AS_NORM_THRESHOLDS: VoiceprintThresholds = {
  ownerAccept: 2.5,
  ownerPossible: 1.5,
};

export interface AsNormScoreInput {
  /** Raw owner<->test cosine similarity (e.g. from ownerSimilarity). */
  rawScore: number;
  /** The test/sample embedding that produced `rawScore`. */
  testEmbedding: readonly number[];
  /** The enrolled owner embeddings the raw score was measured against. */
  ownerEmbeddings: readonly (readonly number[])[];
  /** The model-tagged impostor cohort. */
  cohort: VoiceprintCohort;
  /** Number of top cohort cosines to average. Defaults to min(300, cohort length). */
  topN?: number;
}

export type AsNormRejectionReason =
  | "cohort_empty"
  | "cohort_vector_invalid"
  | "cohort_dimension_mismatch"
  | "cohort_model_mismatch"
  | "owner_embeddings_empty"
  | "test_embedding_invalid"
  | "top_n_invalid";

export class AsNormError extends Error {
  readonly reason: AsNormRejectionReason;
  constructor(reason: AsNormRejectionReason, message: string) {
    super(message);
    this.name = "AsNormError";
    this.reason = reason;
  }
}

/**
 * Validate a cohort against the owner template model. Throws {@link AsNormError}
 * on any problem: empty cohort, non-finite/zero-norm cohort vector, dimension
 * mismatch vs the owner template, or a cohort model that does not match the owner
 * template model. Returns the resolved dimension on success.
 *
 * The model match is a HARD requirement: a cohort embedded with a different model
 * (or version) produces cosines on a different scale and would corrupt the
 * normalization silently, so it is rejected rather than tolerated.
 */
export function validateVoiceprintCohort(
  cohort: VoiceprintCohort,
  ownerModel: VoiceprintModelInfo,
  expectedDim: number,
): void {
  if (!sameVoiceprintModel(cohort.model, ownerModel)) {
    throw new AsNormError(
      "cohort_model_mismatch",
      "AS-Norm cohort model does not match the owner template model; cohort cosines are not comparable.",
    );
  }
  if (!Array.isArray(cohort.embeddings) || cohort.embeddings.length === 0) {
    throw new AsNormError("cohort_empty", "AS-Norm cohort must contain at least one embedding.");
  }
  for (const [index, vector] of cohort.embeddings.entries()) {
    if (!isUsableEmbeddingVector(vector)) {
      throw new AsNormError(
        "cohort_vector_invalid",
        `AS-Norm cohort embedding at index ${index} is not a finite, non-zero-norm vector.`,
      );
    }
    if (vector.length !== expectedDim) {
      throw new AsNormError(
        "cohort_dimension_mismatch",
        `AS-Norm cohort embedding at index ${index} has dimension ${vector.length}; expected ${expectedDim} to match the owner template.`,
      );
    }
  }
}

interface CohortStats {
  mean: number;
  std: number;
}

/**
 * Compute the mean/std of the topN largest cosines between `reference` and each
 * cohort vector. Cohort vectors are assumed pre-validated (finite, right dim).
 */
function topNCohortStats(
  reference: readonly number[],
  cohort: readonly (readonly number[])[],
  topN: number,
): CohortStats {
  const cosines: number[] = [];
  for (const vector of cohort) {
    cosines.push(safeCosineSimilarity(reference, vector));
  }
  // Descending sort; take the topN largest (most impostor-like near matches).
  cosines.sort((a, b) => b - a);
  const take = Math.max(1, Math.min(topN, cosines.length));
  const top = cosines.slice(0, take);

  let sum = 0;
  for (const value of top) {
    sum += value;
  }
  const mean = sum / top.length;

  let variance = 0;
  for (const value of top) {
    const delta = value - mean;
    variance += delta * delta;
  }
  // Population std over the selected top cohort scores.
  const std = Math.sqrt(variance / top.length);

  return { mean, std };
}

/**
 * Symmetric AS-Norm. `raw` is the owner<->test cosine being normalized (the
 * max-over-clips {@link ownerSimilarity} score). The normalized output is a
 * z-score-like value, NOT a cosine, and needs its own thresholds:
 *
 *   se = topN-largest cosines of the TEST  embedding   vs the cohort -> mu_e, sd_e
 *   so = topN-largest cosines of the OWNER representation vs the cohort -> mu_o, sd_o
 *   normalized = 0.5 * ((raw - mu_e) / sd_e + (raw - mu_o) / sd_o)
 *
 * The owner representation used for `so` is the enrolled owner clip that produced
 * `raw` — the ARGMAX clip from the SAME {@link bestOwnerClip} that computes
 * ownerSimilarity, so `raw` and mu_o/sd_o are defined by one identical clip. This
 * is textbook symmetric AS-Norm for any clip count: the zero-std guard below then
 * applies to that clip's own top-N cohort std — a degenerate clip cannot be masked
 * by averaging std across clips. (Averaging per-clip means/stds instead would
 * understate spread and mismatch which clip defined `raw`; the argmax clip avoids
 * both.)
 *
 * GUARDS. If either std is 0 or non-finite (degenerate/tiny cohort, or a cohort
 * of identical vectors), that side cannot normalize; we fall back to the RAW
 * score for the whole computation (a documented safe value) rather than emit
 * NaN/Infinity. A NaN raw score likewise returns the raw score unchanged.
 *
 * @returns the normalized z-score-like value, or the raw score when a guard fires.
 */
export function asNormScore(input: AsNormScoreInput): number {
  const { rawScore, testEmbedding, ownerEmbeddings, cohort } = input;

  if (!Number.isFinite(rawScore)) {
    // Nothing to normalize; propagate the raw not-a-match convention.
    return rawScore;
  }
  if (!isUsableEmbeddingVector(testEmbedding)) {
    throw new AsNormError("test_embedding_invalid", "AS-Norm test embedding must be finite and non-zero-norm.");
  }

  const usableOwners = ownerEmbeddings.filter(isUsableEmbeddingVector);
  if (usableOwners.length === 0) {
    throw new AsNormError("owner_embeddings_empty", "AS-Norm requires at least one usable owner embedding.");
  }

  const expectedDim = testEmbedding.length;
  // Passing cohort.model as the ownerModel makes the model-match check a no-op on
  // purpose: asNormScore does not know the owner TEMPLATE model, so it only
  // validates cohort dim + finiteness here. The cohort-vs-owner-template model
  // match is the caller's responsibility (turn-scoring.ts enforces it before ever
  // calling this) — a mismatched cohort would silently corrupt the normalization.
  validateVoiceprintCohort(cohort, cohort.model, expectedDim);

  // A caller-supplied topN must be a positive integer. Without this guard a
  // topN <= 0 silently collapses the top slice to a single element, forcing
  // std = 0 and a raw-score fallback — AS-Norm would no-op instead of failing
  // loudly on a nonsensical config. Fail loud rather than degrade silently.
  if (input.topN !== undefined && (!Number.isInteger(input.topN) || input.topN <= 0)) {
    throw new AsNormError(
      "top_n_invalid",
      `AS-Norm topN must be a positive integer; received ${input.topN}.`,
    );
  }
  const topN = input.topN ?? Math.min(DEFAULT_AS_NORM_TOP_N, cohort.embeddings.length);

  const testStats = topNCohortStats(testEmbedding, cohort.embeddings, topN);

  // Owner side: use the enrolled clip that produced the raw (max-over-clips)
  // score — the argmax of cosine(owner_i, test), from the SAME shared
  // {@link bestOwnerClip} that computes ownerSimilarity's raw score. This keeps
  // the owner representation that defined `raw` identical to the one that defines
  // mu_o/sd_o, and the zero-std guard below then applies to that clip's own top-N
  // cohort std (never averaged away by another clip). For a single enrolled clip
  // this is trivially that clip. `usableOwners` is non-empty here, so bestOwnerClip
  // cannot return undefined.
  const bestOwner = bestOwnerClip(usableOwners, testEmbedding)!.clip;
  const ownerStats = topNCohortStats(bestOwner, cohort.embeddings, topN);

  if (!isUsableStd(testStats.std) || !isUsableStd(ownerStats.std)) {
    // Degenerate cohort statistics: fall back to the raw score (documented safe
    // value) rather than dividing by zero / emitting NaN.
    return rawScore;
  }

  const eTerm = (rawScore - testStats.mean) / testStats.std;
  const oTerm = (rawScore - ownerStats.mean) / ownerStats.std;
  const normalized = 0.5 * (eTerm + oTerm);

  if (!Number.isFinite(normalized)) {
    return rawScore;
  }
  return normalized;
}

function isUsableStd(std: number): boolean {
  return Number.isFinite(std) && std > 0;
}
