import {
  type VoiceprintDecision,
  type VoiceprintModelInfo,
  type VoiceprintThresholds,
} from "./types.js";
import { resolveVoiceprintThresholds } from "./thresholds.js";
import {
  buildVoiceprintTurnRecords,
  type SpeechTurn,
  type VoiceprintTurnRecords,
} from "./contracts.js";
import {
  classifyOwnerSimilarityWithResolvedThresholds,
  INVALID_VECTOR_SIMILARITY,
  isUsableEmbeddingVector,
  ownerSimilarity,
} from "./similarity.js";
import {
  assertVoiceprintConsentAllowsProcessing,
  type VoiceprintConsentSnapshot,
} from "./policy.js";
import type { VoiceprintAudioQualityAssessment } from "./quality.js";
import {
  initialSpeakerEvidenceState,
  reduceSpeakerEvidence,
  type SpeakerEvidenceConfig,
  type SpeakerEvidenceState,
} from "./evidence.js";
import {
  asNormScore,
  PLACEHOLDER_AS_NORM_THRESHOLDS,
  type VoiceprintCohort,
} from "./as-norm.js";
import { sameVoiceprintModel } from "./model.js";

/**
 * OPT-IN AS-Norm score normalization for a single turn (default OFF).
 *
 * When present, the raw owner<->test cosine is normalized against `cohort` and
 * the NORMALIZED score is classified with `thresholds` (a z-score-like scale, NOT
 * cosine — it must carry its own thresholds, never the raw 0.82/0.72). The
 * cohort model MUST match the owner template model or scoring throws.
 *
 * When this whole field is absent, scoring is BYTE-FOR-BYTE unchanged: raw cosine
 * classified with the raw thresholds. That off-by-default invariant is the point.
 */
export interface VoiceprintTurnAsNormOptions {
  cohort: VoiceprintCohort;
  thresholds: Partial<VoiceprintThresholds>;
  topN?: number;
}

export interface VoiceprintTurnScoreInput {
  turn: SpeechTurn;
  ownerEmbeddings: number[][];
  sampleEmbedding: number[];
  model: VoiceprintModelInfo;
  thresholds?: Partial<VoiceprintThresholds>;
  consent?: Partial<VoiceprintConsentSnapshot>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  createdAt?: string;
  quality?: VoiceprintAudioQualityAssessment;
  /**
   * OPT-IN AS-Norm normalization. Default OFF: when omitted, scoring is
   * byte-for-byte the pre-A3 raw-cosine path. See {@link VoiceprintTurnAsNormOptions}.
   */
  asNorm?: VoiceprintTurnAsNormOptions;
}

export interface VoiceprintTurnScoreResult {
  /**
   * The score that was classified. On the default (AS-Norm OFF) path this is the
   * raw owner<->test cosine. On the opt-in AS-Norm path this is the normalized
   * z-score-like value (NOT a cosine) — see {@link rawSimilarity} for the cosine.
   */
  similarity: number;
  /**
   * The raw owner<->test cosine in [-1, 1] regardless of AS-Norm. On the OFF path
   * this equals {@link similarity}; on the AS-Norm path it is the un-normalized
   * cosine, so cosine-scale consumers (evidence confidence, reports) stay correct
   * even when the classified `similarity` is on the z-score scale.
   */
  rawSimilarity: number;
  confidence: number;
  decision: VoiceprintDecision;
  thresholdUsed: number;
  records: VoiceprintTurnRecords;
}

/**
 * Fold a single scored turn into a session-level speaker-evidence accumulator
 * (see {@link reduceSpeakerEvidence}) and return the advanced state alongside the
 * per-turn result. This is a PURE, OPT-IN layer on top of the per-turn scorer:
 * per-turn semantics/thresholds are untouched, and existing callers that never
 * pass an evidence state keep the exact previous behavior.
 *
 * Callers thread the returned `evidence` back in as `priorEvidence` on the next
 * turn to accumulate a STABILIZED verdict across a session.
 */
export function scoreVoiceprintTurnWithEvidence(
  input: VoiceprintTurnScoreInput & {
    priorEvidence?: SpeakerEvidenceState;
    evidenceConfig?: Partial<SpeakerEvidenceConfig>;
    atMs?: number;
  },
): VoiceprintTurnScoreResult & { evidence: SpeakerEvidenceState } {
  const result = scoreVoiceprintTurnFromEmbedding(input);
  const priorEvidence = input.priorEvidence ?? initialSpeakerEvidenceState();
  // The evidence reducer's score contribution assumes a cosine in [-1, 1]
  // (normalizeScore maps it to [0, 1]). On the AS-Norm path `result.similarity`
  // is a z-score-like value that would clamp the confidence gradient, so feed the
  // raw cosine here. The per-turn DECISION is already computed correctly from the
  // normalized score vs normalized thresholds; only the confidence magnitude uses
  // the score. On the OFF path rawSimilarity === similarity, so this is unchanged.
  const evidence = reduceSpeakerEvidence(
    priorEvidence,
    {
      decision: result.decision,
      score: result.rawSimilarity,
      ...(input.atMs !== undefined ? { atMs: input.atMs } : {}),
    },
    input.evidenceConfig,
  );
  return { ...result, evidence };
}

export function scoreVoiceprintTurnFromEmbedding(
  input: VoiceprintTurnScoreInput,
): VoiceprintTurnScoreResult {
  assertVoiceprintConsentAllowsProcessing(input.consent);
  const thresholds = resolveVoiceprintThresholds(input.thresholds);
  validateTurnScoreEmbeddings(input.ownerEmbeddings, input.sampleEmbedding);
  validateTurnQuality(input.quality);
  // Score against the best-matching enrolled clip (max over per-clip cosine)
  // instead of a single mean centroid, so an owner recorded in a different
  // condition still matches the enrolled clip captured under a similar one.
  // For a single enrolled embedding this is identical to the old centroid score.
  const rawSimilarity = ownerSimilarity(input.ownerEmbeddings, input.sampleEmbedding);

  // OFF-BY-DEFAULT INVARIANT. With no `asNorm` option the score fed to
  // classification is the raw cosine and the thresholds are the raw thresholds —
  // byte-for-byte the pre-A3 behavior. Only when AS-Norm is explicitly supplied
  // do we substitute the normalized score AND its own (z-score-scale) thresholds.
  const useAsNorm = input.asNorm !== undefined;
  const { similarity, classifyThresholds } = useAsNorm
    ? resolveAsNormScoring(rawSimilarity, input, input.asNorm!)
    : { similarity: rawSimilarity, classifyThresholds: thresholds };

  // classifyThresholds is already fully resolved (raw thresholds for the OFF
  // path, normalized thresholds for the AS-Norm path). Use the non-revalidating
  // classifier so a z-score-scale threshold is not rejected by the raw-cosine
  // range validator. For the OFF path this is byte-for-byte the previous result.
  const decision = classifyOwnerSimilarityWithResolvedThresholds(similarity, classifyThresholds);
  const confidence = confidenceFromCosineSimilarity(rawSimilarity);
  const thresholdUsed = thresholdForDecision(decision, classifyThresholds);

  const records = buildVoiceprintTurnRecords({
    turn: input.turn,
    scoring: {
      result: decision,
      confidence,
      score: similarity,
      thresholdUsed,
      model: input.model,
      quality: input.quality,
    },
    consent: input.consent,
    templateLearningReviewed: input.templateLearningReviewed,
    thresholds: classifyThresholds,
    eventId: input.eventId,
    createdAt: input.createdAt,
  });

  return {
    similarity,
    rawSimilarity,
    confidence,
    decision,
    thresholdUsed,
    records,
  };
}

/**
 * Compute the AS-Norm normalized score and its own (z-score-scale) thresholds.
 *
 * Requirement: the cohort model MUST match the owner template model. We enforce
 * it here (not silently inside as-norm) so a mismatched cohort is rejected before
 * it can corrupt a score. The normalized thresholds are resolved via
 * {@link resolveAsNormThresholds} (NOT the raw-cosine validator): the AS-Norm
 * output is a z-score-like scale, so the caller supplies its own thresholds
 * (never the raw 0.82/0.72) and they are only checked for finiteness + ordering.
 *
 * When the raw score is the not-a-match sentinel (INVALID_VECTOR_SIMILARITY) we
 * DO NOT normalize a non-similarity value; we keep the raw sentinel and the raw
 * thresholds so an unusable sample stays `unknown_speaker` exactly as before.
 */
function resolveAsNormScoring(
  rawSimilarity: number,
  input: VoiceprintTurnScoreInput,
  asNorm: VoiceprintTurnAsNormOptions,
): { similarity: number; classifyThresholds: VoiceprintThresholds } {
  if (!sameVoiceprintModel(asNorm.cohort.model, input.model)) {
    throw new Error(
      "Voiceprint AS-Norm cohort model does not match the scored embedding model; refusing to normalize.",
    );
  }

  const classifyThresholds = resolveAsNormThresholds(asNorm.thresholds);

  if (rawSimilarity === INVALID_VECTOR_SIMILARITY) {
    // Unusable sample/owner: keep the raw not-a-match convention rather than
    // feeding -1 into the cohort statistics.
    return { similarity: rawSimilarity, classifyThresholds };
  }

  const similarity = asNormScore({
    rawScore: rawSimilarity,
    testEmbedding: input.sampleEmbedding,
    ownerEmbeddings: input.ownerEmbeddings,
    cohort: asNorm.cohort,
    topN: asNorm.topN,
  });

  return { similarity, classifyThresholds };
}

/**
 * Resolve the NORMALIZED (z-score-scale) thresholds for AS-Norm classification.
 *
 * This MUST NOT reuse {@link resolveVoiceprintThresholds}: that validator clamps
 * ownerAccept to the cosine range [0.5, 1], but the AS-Norm output is a
 * z-score-like value (routinely > 1). Here we only require finite values and
 * ownerAccept >= ownerPossible. Missing values fall back to the illustrative
 * {@link PLACEHOLDER_AS_NORM_THRESHOLDS} (which MUST be calibrated before prod).
 */
function resolveAsNormThresholds(
  thresholds: Partial<VoiceprintThresholds>,
): VoiceprintThresholds {
  const ownerAccept = thresholds.ownerAccept ?? PLACEHOLDER_AS_NORM_THRESHOLDS.ownerAccept;
  const ownerPossible = thresholds.ownerPossible ?? PLACEHOLDER_AS_NORM_THRESHOLDS.ownerPossible;
  if (!Number.isFinite(ownerAccept) || !Number.isFinite(ownerPossible)) {
    throw new Error("Voiceprint AS-Norm normalized thresholds must be finite numbers.");
  }
  if (ownerAccept < ownerPossible) {
    throw new Error("Voiceprint AS-Norm normalized thresholds require ownerAccept >= ownerPossible.");
  }
  return { ownerAccept, ownerPossible };
}

function validateTurnQuality(quality?: VoiceprintAudioQualityAssessment): void {
  if (quality && !quality.allowedUses.scoring) {
    throw new Error("Voiceprint turn quality does not allow scoring.");
  }
}

function validateTurnScoreEmbeddings(
  ownerEmbeddings: readonly number[][],
  sampleEmbedding: readonly number[],
): void {
  if (ownerEmbeddings.length === 0) {
    throw new Error("Voiceprint turn scoring requires at least one owner embedding.");
  }

  for (const [index, embedding] of ownerEmbeddings.entries()) {
    if (!isUsableEmbeddingVector(embedding)) {
      throw new Error(`Voiceprint owner embedding at index ${index} is invalid.`);
    }
  }

  if (!isUsableEmbeddingVector(sampleEmbedding)) {
    throw new Error("Voiceprint sample embedding is invalid.");
  }

  const expectedDim = ownerEmbeddings[0]!.length;
  for (const [index, embedding] of ownerEmbeddings.entries()) {
    if (embedding.length !== expectedDim) {
      throw new Error(
        `Voiceprint owner embedding at index ${index} has dimension ${embedding.length}; expected ${expectedDim}.`,
      );
    }
  }
  if (sampleEmbedding.length !== expectedDim) {
    throw new Error(
      `Voiceprint sample embedding has dimension ${sampleEmbedding.length}; expected ${expectedDim}.`,
    );
  }
}

export function confidenceFromCosineSimilarity(similarity: number): number {
  if (!Number.isFinite(similarity)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (similarity + 1) / 2));
}

export function thresholdForDecision(
  decision: VoiceprintDecision,
  thresholds: VoiceprintThresholds,
): number {
  if (decision === "possible_owner" || decision === "unknown_speaker") {
    return thresholds.ownerPossible;
  }
  return thresholds.ownerAccept;
}
