import { createHash } from "node:crypto";
import type { VoiceprintModelInfo, VoiceprintThresholds } from "./types.js";
import type { VoiceprintAudioQualityAssessment } from "./quality.js";
import { voiceprintModelIdentityParts } from "./model.js";
import {
  allowedUsesForVoiceprintResult,
  assertVoiceprintConsentAllowsProcessing,
  type VoiceprintAnnotationAllowedUses,
  type VoiceprintConsentSnapshot,
  type VoiceprintSpeakerResult,
} from "./policy.js";

export type RecordId = string;
export type IsoTime = string;

export type RetentionClass =
  | "ephemeral"
  | "session"
  | "rolling_7d"
  | "rolling_30d"
  | "durable"
  | "delete_on_close";

export type ReviewState =
  | "unreviewed"
  | "confirmed"
  | "rejected"
  | "suppressed"
  | "deleted";

export interface EvidenceRef {
  artifactId: RecordId;
  transcriptItemId?: string;
  transcriptRange?: { startMs: number; endMs: number };
  textRange?: { start: number; end: number };
  excerptHash?: string;
}

export interface SpeechTurn {
  sessionKey: string;
  transcriptItemId: string;
  role: "user" | "assistant";
  text?: string;
  startMs: number;
  endMs: number;
  audioArtifactId: RecordId;
  route?: "iphone_mic" | "airpods" | "glasses" | "desktop" | "unknown" | string;
}

export interface SpeakerTurnTag {
  id: RecordId;
  sessionKey: string;
  transcriptItemId: string;
  audioArtifactId: RecordId;
  startMs: number;
  endMs: number;
  identitySignalId: RecordId;
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">;
  confidence: number;
  thresholdUsed: number;
  modelId: string;
  route?: string;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
  };
}

export interface VoiceprintIdentitySignal {
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  signalType: "owner_speaking" | "speaker_turn" | "non_owner_voice_cluster";
  subject:
    | { type: "owner" }
    | { type: "unknown_cluster"; id: RecordId }
    | { type: "unknown_speaker" };
  evidenceRefs: EvidenceRef[];
  confidence: number;
  thresholdUsed: number;
  sensitivity: "biometric" | "sensitive" | "private";
  consent: VoiceprintConsentSnapshot;
  storage: {
    encrypted: boolean;
    localOnly: boolean;
    templateUri?: string;
    keyRef?: string;
  };
  retention: RetentionClass;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
  };
  allowedUses: {
    tagSession: boolean;
    promoteMemory: boolean;
    proposeRelationship: boolean;
    exportContext: boolean;
    triggerAction: boolean;
  };
  expiresAt?: IsoTime;
  metadata: {
    source: "voiceprint";
    model: VoiceprintModelInfo;
    route?: string;
    transcriptItemId: string;
    score?: number;
    quality?: Pick<
      VoiceprintAudioQualityAssessment,
      "status" | "reasons" | "metrics" | "allowedUses"
    >;
  };
}

export interface TranscriptSpeakerAnnotation {
  sessionKey: string;
  transcriptItemId: string;
  speakerTurnTagId: RecordId;
  identitySignalId: RecordId;
  result: VoiceprintSpeakerResult;
  confidence: number;
  thresholdUsed: number;
  evidenceRefs: EvidenceRef[];
  allowedUses: VoiceprintAnnotationAllowedUses;
}

export interface EventParticipation {
  id: RecordId;
  eventId: RecordId;
  actor:
    | { type: "owner" }
    | { type: "unknown_cluster"; clusterId: RecordId }
    | { type: "unknown_speaker" };
  role: "speaker" | "participant" | "mentioned" | "actor" | "observer";
  claim: string;
  evidenceRefs: EvidenceRef[];
  supportingSignalIds: RecordId[];
  confidence: number;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
  };
  allowedUses: {
    memoryPromotion: boolean;
    actionProposal: boolean;
    contextExport: boolean;
  };
}

export interface VoiceprintTurnScoring {
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">;
  confidence: number;
  score?: number;
  thresholdUsed: number;
  model: VoiceprintModelInfo;
  clusterId?: RecordId;
  quality?: VoiceprintAudioQualityAssessment;
}

export interface VoiceprintTurnRecords {
  evidenceRefs: EvidenceRef[];
  speakerTurnTag: SpeakerTurnTag;
  identitySignal: VoiceprintIdentitySignal;
  transcriptSpeakerAnnotation: TranscriptSpeakerAnnotation;
  eventParticipation?: EventParticipation;
}

export function buildVoiceprintTurnRecords(input: {
  turn: SpeechTurn;
  scoring: VoiceprintTurnScoring;
  consent?: Partial<VoiceprintConsentSnapshot>;
  templateLearningReviewed?: boolean;
  clusterReviewed?: boolean;
  thresholds?: Partial<VoiceprintThresholds>;
  createdAt?: IsoTime;
  eventId?: RecordId;
}): VoiceprintTurnRecords {
  validateSpeechTurn(input.turn);

  const createdAt = input.createdAt ?? new Date().toISOString();
  const reviewState = reviewStateForResult(input.scoring.result, {
    clusterReviewed: input.clusterReviewed === true,
  });
  const consent = assertVoiceprintConsentAllowsProcessing(input.consent);
  const subject = subjectForResult(input.scoring.result, input.scoring.clusterId);
  const evidenceRefs: EvidenceRef[] = [
    {
      artifactId: input.turn.audioArtifactId,
      transcriptItemId: input.turn.transcriptItemId,
      transcriptRange: {
        startMs: input.turn.startMs,
        endMs: input.turn.endMs,
      },
      excerptHash: input.turn.text ? hashText(input.turn.text) : undefined,
    },
  ];

  const baseId = makeVoiceprintRecordId("vp", [
    input.turn.sessionKey,
    input.turn.transcriptItemId,
    input.turn.audioArtifactId,
    input.turn.startMs,
    input.turn.endMs,
    input.scoring.result,
    subject,
    voiceprintModelIdentityParts(input.scoring.model),
  ]);
  const identitySignalId = `${baseId}_signal`;
  const speakerTurnTagId = `${baseId}_tag`;

  const allowedUses = applyQualityGateToAllowedUses(
    allowedUsesForVoiceprintResult({
      result: input.scoring.result,
      confidence: input.scoring.confidence,
      score: input.scoring.score,
      thresholdUsed: input.scoring.thresholdUsed,
      thresholds: input.thresholds,
      consent,
      reviewed: reviewedForAllowedUses({
        result: input.scoring.result,
        templateLearningReviewed: input.templateLearningReviewed === true,
        clusterReviewed: input.clusterReviewed === true,
      }),
    }),
    input.scoring.quality,
  );

  const speakerTurnTag: SpeakerTurnTag = {
    id: speakerTurnTagId,
    sessionKey: input.turn.sessionKey,
    transcriptItemId: input.turn.transcriptItemId,
    audioArtifactId: input.turn.audioArtifactId,
    startMs: input.turn.startMs,
    endMs: input.turn.endMs,
    identitySignalId,
    result: input.scoring.result,
    confidence: input.scoring.confidence,
    thresholdUsed: input.scoring.thresholdUsed,
    modelId: input.scoring.model.modelId,
    route: input.turn.route,
    review: { state: reviewState },
  };

  const identitySignal: VoiceprintIdentitySignal = {
    id: identitySignalId,
    createdAt,
    updatedAt: createdAt,
    signalType: signalTypeForResult(input.scoring.result),
    subject,
    evidenceRefs,
    confidence: input.scoring.confidence,
    thresholdUsed: input.scoring.thresholdUsed,
    sensitivity: input.scoring.result === "unknown_speaker" ? "private" : "biometric",
    consent,
    storage: {
      encrypted: true,
      localOnly: true,
    },
    retention:
      input.scoring.result === "unknown_cluster" ? "rolling_7d" : "session",
    review: { state: reviewState },
    allowedUses: {
      tagSession: allowedUses.transcriptDisplay,
      promoteMemory: allowedUses.memoryPromotion,
      proposeRelationship:
        input.scoring.result === "unknown_cluster" &&
        reviewState === "confirmed" &&
        allowedUses.eventGraph,
      exportContext: allowedUses.contextExport,
      triggerAction: allowedUses.actionProposal,
    },
    metadata: {
      source: "voiceprint",
      model: input.scoring.model,
      route: input.turn.route,
      transcriptItemId: input.turn.transcriptItemId,
      score: input.scoring.score,
      quality: input.scoring.quality
        ? {
            status: input.scoring.quality.status,
            reasons: input.scoring.quality.reasons,
            metrics: input.scoring.quality.metrics,
            allowedUses: input.scoring.quality.allowedUses,
          }
        : undefined,
    },
  };

  const transcriptSpeakerAnnotation: TranscriptSpeakerAnnotation = {
    sessionKey: input.turn.sessionKey,
    transcriptItemId: input.turn.transcriptItemId,
    speakerTurnTagId,
    identitySignalId,
    result: input.scoring.result,
    confidence: input.scoring.confidence,
    thresholdUsed: input.scoring.thresholdUsed,
    evidenceRefs,
    allowedUses,
  };

  const eventParticipation =
    input.eventId && allowedUses.eventGraph
      ? buildEventParticipation({
          eventId: input.eventId,
          turn: input.turn,
          scoring: input.scoring,
          identitySignalId,
          evidenceRefs,
          allowedUses,
          reviewState,
        })
      : undefined;

  return {
    evidenceRefs,
    speakerTurnTag,
    identitySignal,
    transcriptSpeakerAnnotation,
    eventParticipation,
  };
}

export function makeVoiceprintRecordId(prefix: string, parts: readonly unknown[]): RecordId {
  const hash = createHash("sha256")
    .update(stableStringify(parts))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${hash}`;
}

function buildEventParticipation(input: {
  eventId: RecordId;
  turn: SpeechTurn;
  scoring: VoiceprintTurnScoring;
  identitySignalId: RecordId;
  evidenceRefs: EvidenceRef[];
  allowedUses: VoiceprintAnnotationAllowedUses;
  reviewState: ReviewState;
}): EventParticipation {
  return {
    id: makeVoiceprintRecordId("vpevent", [
      input.eventId,
      input.turn.transcriptItemId,
      input.scoring.result,
      input.identitySignalId,
    ]),
    eventId: input.eventId,
    actor: actorForResult(input.scoring.result, input.scoring.clusterId),
    role: "speaker",
    claim: input.turn.text ?? "",
    evidenceRefs: input.evidenceRefs,
    supportingSignalIds: [input.identitySignalId],
    confidence: input.scoring.confidence,
    review: { state: input.reviewState },
    allowedUses: {
      memoryPromotion: input.allowedUses.memoryPromotion,
      actionProposal: input.allowedUses.actionProposal,
      contextExport: input.allowedUses.contextExport,
    },
  };
}

function applyQualityGateToAllowedUses(
  allowedUses: VoiceprintAnnotationAllowedUses,
  quality?: VoiceprintAudioQualityAssessment,
): VoiceprintAnnotationAllowedUses {
  if (!quality) {
    return allowedUses;
  }

  return {
    diagnostics: allowedUses.diagnostics && quality.allowedUses.diagnostics,
    transcriptDisplay: allowedUses.transcriptDisplay && quality.allowedUses.transcriptDisplay,
    memoryPromotion: allowedUses.memoryPromotion && quality.allowedUses.memoryPromotion,
    actionProposal: allowedUses.actionProposal && quality.allowedUses.actionProposal,
    eventGraph: allowedUses.eventGraph && quality.allowedUses.eventGraph,
    contextExport: allowedUses.contextExport && quality.allowedUses.contextExport,
    templateLearning: allowedUses.templateLearning && quality.allowedUses.templateLearning,
  };
}

function validateSpeechTurn(turn: SpeechTurn): void {
  if (!turn.sessionKey.trim()) {
    throw new Error("Voiceprint SpeechTurn requires sessionKey.");
  }
  if (!turn.transcriptItemId.trim()) {
    throw new Error("Voiceprint SpeechTurn requires transcriptItemId.");
  }
  if (!turn.audioArtifactId.trim()) {
    throw new Error("Voiceprint SpeechTurn requires audioArtifactId.");
  }
  if (!Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs)) {
    throw new Error("Voiceprint SpeechTurn requires finite startMs and endMs.");
  }
  if (turn.endMs <= turn.startMs) {
    throw new Error("Voiceprint SpeechTurn requires endMs > startMs.");
  }
}

function signalTypeForResult(
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">,
): VoiceprintIdentitySignal["signalType"] {
  if (result === "owner_speaking" || result === "possible_owner") {
    return "owner_speaking";
  }
  if (result === "unknown_cluster") {
    return "non_owner_voice_cluster";
  }
  return "speaker_turn";
}

function reviewStateForResult(
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">,
  options: { clusterReviewed?: boolean } = {},
): ReviewState {
  if (result === "unknown_cluster" && options.clusterReviewed === true) {
    return "confirmed";
  }
  if (result === "possible_owner" || result === "unknown_cluster") {
    return "unreviewed";
  }
  return "confirmed";
}

function reviewedForAllowedUses(input: {
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">;
  templateLearningReviewed: boolean;
  clusterReviewed: boolean;
}): boolean {
  if (input.result === "owner_speaking") {
    return input.templateLearningReviewed;
  }
  if (input.result === "unknown_cluster") {
    return input.clusterReviewed;
  }
  return false;
}

function subjectForResult(
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">,
  clusterId?: RecordId,
): VoiceprintIdentitySignal["subject"] {
  if (result === "owner_speaking" || result === "possible_owner") {
    return { type: "owner" };
  }
  if (result === "unknown_cluster") {
    const normalizedClusterId = clusterId?.trim();
    if (!normalizedClusterId) {
      throw new Error("Voiceprint unknown_cluster result requires clusterId.");
    }
    return { type: "unknown_cluster", id: normalizedClusterId };
  }
  return { type: "unknown_speaker" };
}

function actorForResult(
  result: Exclude<VoiceprintSpeakerResult, "confirmed_person">,
  clusterId?: RecordId,
): EventParticipation["actor"] {
  if (result === "owner_speaking") {
    return { type: "owner" };
  }
  if (result === "unknown_cluster") {
    const normalizedClusterId = clusterId?.trim();
    if (!normalizedClusterId) {
      throw new Error("Voiceprint unknown_cluster result requires clusterId.");
    }
    return { type: "unknown_cluster", clusterId: normalizedClusterId };
  }
  return { type: "unknown_speaker" };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
