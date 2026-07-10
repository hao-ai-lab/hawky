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
  classifyOwnerSimilarity,
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
}

export interface VoiceprintTurnScoreResult {
  similarity: number;
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
  const evidence = reduceSpeakerEvidence(
    priorEvidence,
    {
      decision: result.decision,
      score: result.similarity,
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
  const similarity = ownerSimilarity(input.ownerEmbeddings, input.sampleEmbedding);
  const decision = classifyOwnerSimilarity(similarity, thresholds);
  const confidence = confidenceFromCosineSimilarity(similarity);
  const thresholdUsed = thresholdForDecision(decision, thresholds);

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
    thresholds,
    eventId: input.eventId,
    createdAt: input.createdAt,
  });

  return {
    similarity,
    confidence,
    decision,
    thresholdUsed,
    records,
  };
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
