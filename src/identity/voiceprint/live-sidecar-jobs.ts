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
import { isReferenceVoiceprintModel } from "./model-lifecycle.js";
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

/**
 * FAIL-CLOSED marker: a single sidecar RESPONSE carried a per-turn embedding that
 * is unusable for scoring (empty / NaN / infinite / zero-norm / wrong dimension).
 * This is a DATA-QUALITY fault isolated to ONE turn — never a batch-integrity or
 * security-guard fault — so the batch scorer catches it and marks ONLY that turn
 * skipped (fail-closed: skipped never resolves) instead of throwing out and losing
 * the good turns. Structural faults (id/model mismatch, reference-model guard,
 * duplicate ids) are NOT this error and still throw as clean typed precondition
 * failures.
 */
export class UnusableVoiceprintEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableVoiceprintEmbeddingError";
  }
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
  /**
   * A5 production guard: when true, refuse ANY response whose returned model tag
   * is the non-discriminative reference backend, independent of expectedModel.
   * This is the definitive runtime check at the point the model tag exists — the
   * declared sidecar env is only the REQUESTED backend, not proof of what ran.
   */
  requireDiscriminativeModel?: boolean;
  /** OPT-IN A3 AS-Norm normalization (default OFF; see turn-scoring.ts). */
  asNorm?: VoiceprintTurnAsNormOptions;
}): LiveVoiceprintScoringJobResult {
  // A per-turn UNUSABLE embedding (empty / NaN / infinite / zero-norm) is a
  // data-quality fault isolated to THIS turn — surface it as the fail-closed
  // marker so the batch scorer can skip only this turn (never resolve it) instead
  // of throwing out of the whole batch and losing the good turns. Other response
  // faults (missing id/model) stay hard throws (batch-integrity precondition).
  try {
    validateEmbeddingResponse(input.response);
  } catch (error) {
    throw reclassifyUnusableEmbeddingError(error);
  }
  if (input.response.id !== input.job.embeddingRequest.id) {
    throw new Error(
      `Live voiceprint sidecar response id ${input.response.id} does not match job request id ${input.job.embeddingRequest.id}.`,
    );
  }
  // A5 PRODUCTION GUARD (runtime): the reference backend is non-discriminative,
  // so a "score" it produces is meaningless for a real user. Refuse it based on
  // the model the sidecar ACTUALLY returned — this holds even when expected_model
  // is unset and even if a misconfigured/wrapper sidecar emitted a reference tag
  // despite a non-reference declared env.
  if (
    input.requireDiscriminativeModel &&
    isReferenceVoiceprintModel(input.response.model)
  ) {
    throw new Error(
      `Live voiceprint sidecar returned the non-discriminative reference model ${formatVoiceprintModel(input.response.model)}; require_discriminative_model refuses to score it.`,
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

  let result: LiveVoiceprintScoredTurn;
  try {
    result = scorePreparedLiveVoiceprintTurn({
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
  } catch (error) {
    // A wrong-dimension / unusable SAMPLE embedding (the sidecar-returned vector)
    // is a per-turn data fault: reclassify so the batch scorer skips only this
    // turn. Owner-template / consent / quality faults are NOT reclassified — they
    // are configuration or precondition faults and keep throwing.
    throw reclassifyUnusableSampleEmbeddingError(error);
  }

  return {
    status: "scored",
    jobId: input.job.id,
    requestId: input.response.id,
    turn: input.job.prepared.turn,
    response: input.response,
    result,
  };
}

/**
 * Reclassify a {@link validateEmbeddingResponse} failure: only the "finite
 * non-empty embedding" fault is an unusable-embedding (per-turn) fault. Missing
 * id/model faults are batch-integrity preconditions and keep throwing as-is.
 */
function reclassifyUnusableEmbeddingError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("finite non-empty embedding")) {
    return new UnusableVoiceprintEmbeddingError(message);
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Reclassify a scoring failure: only an unusable/wrong-dimension SAMPLE embedding
 * (the sidecar-returned vector) is a per-turn data fault. Owner-embedding, consent,
 * and quality faults are configuration/precondition faults and keep throwing.
 */
function reclassifyUnusableSampleEmbeddingError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("sample embedding is invalid") ||
    message.includes("sample embedding has dimension")
  ) {
    return new UnusableVoiceprintEmbeddingError(message);
  }
  return error instanceof Error ? error : new Error(message);
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
