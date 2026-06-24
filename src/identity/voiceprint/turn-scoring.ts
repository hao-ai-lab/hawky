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
  meanVector,
  safeCosineSimilarity,
} from "./similarity.js";
import {
  assertVoiceprintConsentAllowsProcessing,
  type VoiceprintConsentSnapshot,
} from "./policy.js";
import type { VoiceprintAudioQualityAssessment } from "./quality.js";

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

export function scoreVoiceprintTurnFromEmbedding(
  input: VoiceprintTurnScoreInput,
): VoiceprintTurnScoreResult {
  assertVoiceprintConsentAllowsProcessing(input.consent);
  const thresholds = resolveVoiceprintThresholds(input.thresholds);
  validateTurnScoreEmbeddings(input.ownerEmbeddings, input.sampleEmbedding);
  validateTurnQuality(input.quality);
  const ownerCentroid = meanVector(input.ownerEmbeddings);
  const similarity = safeCosineSimilarity(ownerCentroid, input.sampleEmbedding);
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
