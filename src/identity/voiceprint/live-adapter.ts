import {
  assessVoiceprintAudioQuality,
  type VoiceprintAudioQualityAssessment,
  type VoiceprintAudioQualityThresholds,
} from "./quality.js";
import {
  scoreVoiceprintTurnFromEmbedding,
  type VoiceprintTurnScoreInput,
  type VoiceprintTurnScoreResult,
} from "./turn-scoring.js";
import type { SpeechTurn } from "./contracts.js";
import { voiceprintConsentAllowsProcessing } from "./policy.js";
import { validateIdentifierNotEmpty, validateTimeBounds } from "./live-validators.js";

export type LiveVoiceprintSkipReason =
  | "non_user_turn"
  | "quality_rejected"
  | "consent_denied";

export interface LiveVoiceprintTurnCandidate {
  sessionKey: string;
  transcriptItemId: string;
  role: SpeechTurn["role"];
  text?: string;
  startMs: number;
  endMs: number;
  audioArtifactId?: string;
  route?: SpeechTurn["route"];
  samples?: Float32Array;
  sampleRate?: number;
  quality?: VoiceprintAudioQualityAssessment;
}

export interface LiveVoiceprintPreparationOptions {
  qualityThresholds?: Partial<VoiceprintAudioQualityThresholds>;
}

export interface LiveVoiceprintReadyTurn {
  status: "ready";
  turn: SpeechTurn;
  quality: VoiceprintAudioQualityAssessment;
}

export interface LiveVoiceprintSkippedTurn {
  status: "skipped";
  reason: LiveVoiceprintSkipReason;
  turn?: SpeechTurn;
  quality?: VoiceprintAudioQualityAssessment;
}

export type LiveVoiceprintPreparation =
  | LiveVoiceprintReadyTurn
  | LiveVoiceprintSkippedTurn;

export interface LiveVoiceprintScoredTurn {
  status: "scored";
  turn: SpeechTurn;
  quality: VoiceprintAudioQualityAssessment;
  score: VoiceprintTurnScoreResult;
}

export type LiveVoiceprintProcessingResult =
  | LiveVoiceprintScoredTurn
  | LiveVoiceprintSkippedTurn;

export interface LiveVoiceprintProcessingInput
  extends LiveVoiceprintTurnCandidate,
    Omit<VoiceprintTurnScoreInput, "turn" | "quality"> {
  qualityThresholds?: Partial<VoiceprintAudioQualityThresholds>;
}

export function prepareLiveVoiceprintTurn(
  input: LiveVoiceprintTurnCandidate,
  options: LiveVoiceprintPreparationOptions = {},
): LiveVoiceprintPreparation {
  if (input.role !== "user") {
    return { status: "skipped", reason: "non_user_turn" };
  }

  const turn = buildSpeechTurnFromLiveCandidate(input);
  const quality = resolveLiveVoiceprintQuality(input, options);
  if (!quality.allowedUses.scoring) {
    return { status: "skipped", reason: "quality_rejected", turn, quality };
  }

  return { status: "ready", turn, quality };
}

export function scorePreparedLiveVoiceprintTurn(input: {
  prepared: LiveVoiceprintReadyTurn;
} & Omit<VoiceprintTurnScoreInput, "turn" | "quality">): LiveVoiceprintScoredTurn {
  const { prepared, ...scoreInput } = input;
  const score = scoreVoiceprintTurnFromEmbedding({
    ...scoreInput,
    turn: prepared.turn,
    quality: prepared.quality,
  });

  return {
    status: "scored",
    turn: prepared.turn,
    quality: prepared.quality,
    score,
  };
}

export function processLiveVoiceprintTurn(
  input: LiveVoiceprintProcessingInput,
): LiveVoiceprintProcessingResult {
  if (!voiceprintConsentAllowsProcessing(input.consent)) {
    return { status: "skipped", reason: "consent_denied" };
  }

  const prepared = prepareLiveVoiceprintTurn(input, {
    qualityThresholds: input.qualityThresholds,
  });
  if (prepared.status === "skipped") {
    return prepared;
  }

  return scorePreparedLiveVoiceprintTurn({
    prepared,
    ownerEmbeddings: input.ownerEmbeddings,
    sampleEmbedding: input.sampleEmbedding,
    model: input.model,
    thresholds: input.thresholds,
    consent: input.consent,
    templateLearningReviewed: input.templateLearningReviewed,
    eventId: input.eventId,
    createdAt: input.createdAt,
  });
}

export function buildSpeechTurnFromLiveCandidate(
  input: LiveVoiceprintTurnCandidate,
): SpeechTurn {
  const turn: SpeechTurn = {
    sessionKey: input.sessionKey,
    transcriptItemId: input.transcriptItemId,
    role: input.role,
    text: input.text,
    startMs: input.startMs,
    endMs: input.endMs,
    audioArtifactId: input.audioArtifactId ?? "",
    route: input.route,
  };
  validateLiveSpeechTurn(turn);
  return turn;
}

function resolveLiveVoiceprintQuality(
  input: LiveVoiceprintTurnCandidate,
  options: LiveVoiceprintPreparationOptions,
): VoiceprintAudioQualityAssessment {
  if (input.quality) {
    return input.quality;
  }
  if (!input.samples) {
    throw new Error("Live voiceprint turn requires samples or a precomputed quality assessment.");
  }
  if (!input.sampleRate) {
    throw new Error("Live voiceprint turn requires sampleRate when samples are provided.");
  }
  return assessVoiceprintAudioQuality(input.samples, input.sampleRate, options.qualityThresholds);
}

function validateLiveSpeechTurn(turn: SpeechTurn): void {
  validateIdentifierNotEmpty(turn.sessionKey, "Live voiceprint turn requires sessionKey.");
  validateIdentifierNotEmpty(
    turn.transcriptItemId,
    "Live voiceprint turn requires transcriptItemId.",
  );
  validateIdentifierNotEmpty(
    turn.audioArtifactId,
    "Live voiceprint turn requires audioArtifactId.",
  );
  validateTimeBounds(turn.startMs, turn.endMs, "Live voiceprint turn");
}
