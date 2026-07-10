import {
  buildEmbeddingBatchRequest,
  buildEmbeddingRequest,
  validateEmbeddingResponse,
  type VoiceprintEmbeddingBatchRequest,
  type VoiceprintEmbeddingRequest,
  type VoiceprintEmbeddingResponse,
} from "./sidecar-protocol.js";
import {
  makeVoiceprintRecordId,
  type IsoTime,
  type RecordId,
} from "./contracts.js";
import {
  scorePreparedLiveVoiceprintTurn,
  type LiveVoiceprintReadyTurn,
  type LiveVoiceprintScoredTurn,
} from "./live-adapter.js";
import type { VoiceprintTurnAsNormOptions } from "./turn-scoring.js";
import {
  formatVoiceprintModel,
  sameVoiceprintModel,
} from "./model.js";
import type { VoiceprintConsentSnapshot } from "./policy.js";
import type { VoiceprintModelInfo, VoiceprintThresholds } from "./types.js";

export interface LiveVoiceprintScoringJob {
  version: 1;
  id: RecordId;
  status: "queued";
  createdAt: IsoTime;
  prepared: LiveVoiceprintReadyTurn;
  embeddingRequest: VoiceprintEmbeddingRequest;
  ownerTemplateRef?: string;
  attempts: {
    current: number;
    max: number;
  };
  timeoutMs?: number;
}

export interface LiveVoiceprintScoringJobResult {
  status: "scored";
  jobId: RecordId;
  requestId: string;
  turn: LiveVoiceprintReadyTurn["turn"];
  response: VoiceprintEmbeddingResponse;
  result: LiveVoiceprintScoredTurn;
}

export function buildLiveVoiceprintScoringJob(input: {
  prepared: LiveVoiceprintReadyTurn;
  audioPath: string;
  requestStartMs?: number;
  requestEndMs?: number;
  targetSampleRate?: number;
  ownerTemplateRef?: string;
  createdAt?: IsoTime;
  attempt?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}): LiveVoiceprintScoringJob {
  validateJobOptions(input);
  validatePreparedTurnForJob(input.prepared);

  const turn = input.prepared.turn;
  const jobId = makeVoiceprintRecordId("vpjob", [
    turn.sessionKey,
    turn.transcriptItemId,
    turn.audioArtifactId,
    turn.startMs,
    turn.endMs,
    turn.route,
    input.audioPath,
    input.requestStartMs,
    input.requestEndMs,
    input.targetSampleRate,
    input.ownerTemplateRef,
  ]);
  const embeddingRequest = buildEmbeddingRequest({
    id: `${jobId}_embedding`,
    audioPath: input.audioPath,
    startMs: input.requestStartMs,
    endMs: input.requestEndMs,
    targetSampleRate: input.targetSampleRate,
    route: turn.route,
  });

  return {
    version: 1,
    id: jobId,
    status: "queued",
    createdAt: input.createdAt ?? new Date().toISOString(),
    prepared: input.prepared,
    embeddingRequest,
    ownerTemplateRef: input.ownerTemplateRef,
    attempts: {
      current: input.attempt ?? 0,
      max: input.maxAttempts ?? 1,
    },
    timeoutMs: input.timeoutMs,
  };
}

export function buildLiveVoiceprintScoringBatchRequest(
  jobs: readonly LiveVoiceprintScoringJob[],
): VoiceprintEmbeddingBatchRequest {
  if (jobs.length === 0) {
    throw new Error("Live voiceprint scoring batch requires at least one job.");
  }

  const jobIds = new Set<string>();
  for (const job of jobs) {
    if (jobIds.has(job.id)) {
      throw new Error(`Duplicate live voiceprint scoring job id: ${job.id}.`);
    }
    jobIds.add(job.id);
  }

  return buildEmbeddingBatchRequest(jobs.map((job) => job.embeddingRequest));
}

export function scoreLiveVoiceprintScoringJobResponse(input: {
  job: LiveVoiceprintScoringJob;
  response: VoiceprintEmbeddingResponse;
  ownerEmbeddings: number[][];
  thresholds?: Partial<VoiceprintThresholds>;
  consent?: Partial<VoiceprintConsentSnapshot>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  createdAt?: IsoTime;
  expectedModel?: VoiceprintModelInfo;
  /** OPT-IN A3 AS-Norm normalization (default OFF; see turn-scoring.ts). */
  asNorm?: VoiceprintTurnAsNormOptions;
}): LiveVoiceprintScoringJobResult {
  validateEmbeddingResponse(input.response);
  if (input.response.id !== input.job.embeddingRequest.id) {
    throw new Error(
      `Live voiceprint sidecar response id ${input.response.id} does not match job request id ${input.job.embeddingRequest.id}.`,
    );
  }
  if (
    input.expectedModel &&
    !sameVoiceprintModel(input.expectedModel, input.response.model)
  ) {
    throw new Error(
      `Live voiceprint sidecar model ${formatVoiceprintModel(input.response.model)} does not match expected ${formatVoiceprintModel(input.expectedModel)}.`,
    );
  }

  const result = scorePreparedLiveVoiceprintTurn({
    prepared: input.job.prepared,
    ownerEmbeddings: input.ownerEmbeddings,
    sampleEmbedding: input.response.embedding,
    model: input.response.model,
    thresholds: input.thresholds,
    consent: input.consent,
    templateLearningReviewed: input.templateLearningReviewed,
    eventId: input.eventId,
    createdAt: input.createdAt,
    asNorm: input.asNorm,
  });

  return {
    status: "scored",
    jobId: input.job.id,
    requestId: input.response.id,
    turn: input.job.prepared.turn,
    response: input.response,
    result,
  };
}

function validateJobOptions(input: {
  audioPath: string;
  requestStartMs?: number;
  requestEndMs?: number;
  targetSampleRate?: number;
  attempt?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}): void {
  if (!input.audioPath.trim()) {
    throw new Error("Live voiceprint scoring job requires audioPath.");
  }
  const attempt = input.attempt ?? 0;
  const maxAttempts = input.maxAttempts ?? 1;
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("Live voiceprint scoring job attempt must be a non-negative integer.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("Live voiceprint scoring job maxAttempts must be a positive integer.");
  }
  if (attempt >= maxAttempts) {
    throw new Error("Live voiceprint scoring job attempt must be less than maxAttempts.");
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw new Error("Live voiceprint scoring job timeoutMs must be positive.");
  }
  if (
    input.requestStartMs !== undefined &&
    input.requestEndMs !== undefined &&
    input.requestEndMs <= input.requestStartMs
  ) {
    throw new Error("Live voiceprint scoring job requestEndMs must be greater than requestStartMs.");
  }
}

function validatePreparedTurnForJob(prepared: LiveVoiceprintReadyTurn): void {
  const turn = prepared.turn;
  if (!turn.sessionKey.trim()) {
    throw new Error("Live voiceprint scoring job requires sessionKey.");
  }
  if (!turn.transcriptItemId.trim()) {
    throw new Error("Live voiceprint scoring job requires transcriptItemId.");
  }
  if (!turn.audioArtifactId.trim()) {
    throw new Error("Live voiceprint scoring job requires audioArtifactId.");
  }
  if (!Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs)) {
    throw new Error("Live voiceprint scoring job requires finite startMs and endMs.");
  }
  if (turn.endMs <= turn.startMs) {
    throw new Error("Live voiceprint scoring job requires endMs > startMs.");
  }
  if (!prepared.quality.allowedUses.scoring) {
    throw new Error("Live voiceprint scoring job requires quality that allows scoring.");
  }
}
