import {
  validateEmbeddingBatchResponse,
  type VoiceprintEmbeddingBatchRequest,
  type VoiceprintEmbeddingRequest,
  type VoiceprintEmbeddingBatchResponse,
} from "./sidecar-protocol.js";
import {
  runEmbeddingSidecar,
  type EmbeddingSidecarCommand,
} from "./sidecar-client.js";
import {
  buildLiveVoiceprintScoringBatchRequest,
  scoreLiveVoiceprintScoringJobResponse,
  type LiveVoiceprintScoringJob,
  type LiveVoiceprintScoringJobResult,
} from "./live-sidecar-jobs.js";
import {
  makeVoiceprintRecordId,
  type EventParticipation,
  type IsoTime,
  type RecordId,
  type SpeakerTurnTag,
  type TranscriptSpeakerAnnotation,
  type VoiceprintIdentitySignal,
} from "./contracts.js";
import {
  formatVoiceprintModel,
  sameVoiceprintModel,
} from "./model.js";
import {
  voiceprintConsentAllowsProcessing,
  type VoiceprintConsentSnapshot,
} from "./policy.js";
import type { VoiceprintModelInfo, VoiceprintThresholds } from "./types.js";
import type { VoiceprintTurnAsNormOptions } from "./turn-scoring.js";

export interface LiveVoiceprintScoringJobContext {
  job: LiveVoiceprintScoringJob;
  ownerEmbeddings: number[][];
  thresholds?: Partial<VoiceprintThresholds>;
  consent?: Partial<VoiceprintConsentSnapshot>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  createdAt?: IsoTime;
  expectedModel?: VoiceprintModelInfo;
  /**
   * A5 production guard: when true, refuse to score any sidecar response whose
   * returned model tag is the non-discriminative reference backend. This is a
   * runtime check against the model the sidecar ACTUALLY emitted. Default off.
   */
  requireDiscriminativeModel?: boolean;
  /** OPT-IN A3 AS-Norm normalization (default OFF; see turn-scoring.ts). */
  asNorm?: VoiceprintTurnAsNormOptions;
}

export interface LiveVoiceprintScoringBatchResult {
  status: "scored" | "partial" | "skipped";
  request: VoiceprintEmbeddingBatchRequest | null;
  model?: VoiceprintModelInfo;
  results: LiveVoiceprintScoringJobResult[];
  skipped: LiveVoiceprintSkippedScoringJob[];
}

export interface LiveVoiceprintSkippedScoringJob {
  status: "skipped";
  jobId: RecordId;
  requestId: string;
  sessionKey: string;
  transcriptItemId: string;
  reason: "consent_denied";
}

export type VoiceprintTranscriptIdentityStatus =
  | "identity_resolved"
  | "identity_unknown"
  | "review_required";

export interface VoiceprintTranscriptIdentityUpdate {
  version: 1;
  id: RecordId;
  source: "voiceprint";
  jobId: RecordId;
  requestId: string;
  sessionKey: string;
  transcriptItemId: string;
  status: VoiceprintTranscriptIdentityStatus;
  createdAt: IsoTime;
  speakerTurnTag: SpeakerTurnTag;
  identitySignal: VoiceprintIdentitySignal;
  transcriptSpeakerAnnotation: TranscriptSpeakerAnnotation;
  eventParticipation?: EventParticipation;
}

export async function runLiveVoiceprintScoringJobs(input: {
  sidecar: EmbeddingSidecarCommand;
  jobs: readonly LiveVoiceprintScoringJobContext[];
}): Promise<LiveVoiceprintScoringBatchResult> {
  const partition = partitionJobContextsByConsent(input.jobs);
  if (partition.processable.length === 0) {
    return {
      status: "skipped",
      request: null,
      results: [],
      skipped: partition.skipped,
    };
  }

  const request = buildBatchRequestFromContexts(partition.processable);
  const response = await runEmbeddingSidecar({
    sidecar: {
      ...input.sidecar,
      timeoutMs: effectiveSidecarTimeoutMs(input.sidecar.timeoutMs, partition.processable),
    },
    request,
  });
  return scoreLiveVoiceprintScoringBatchResponse({
    request,
    response,
    jobs: input.jobs,
  });
}

export function scoreLiveVoiceprintScoringBatchResponse(input: {
  request?: VoiceprintEmbeddingBatchRequest;
  response: VoiceprintEmbeddingBatchResponse;
  jobs: readonly LiveVoiceprintScoringJobContext[];
}): LiveVoiceprintScoringBatchResult {
  const partition = partitionJobContextsByConsent(input.jobs);
  if (partition.processable.length === 0) {
    return {
      status: "skipped",
      request: null,
      results: [],
      skipped: partition.skipped,
    };
  }

  const request = input.request ?? buildBatchRequestFromContexts(partition.processable);
  validateRequestMatchesJobs(request, partition.processable);
  const requestIds = request.requests.map((item) => item.id);
  validateEmbeddingBatchResponse(input.response, requestIds);
  const model = commonBatchModel(input.response);
  const responseById = new Map(input.response.responses.map((item) => [item.id, item] as const));

  const results = partition.processable.map((context) => {
    const response = responseById.get(context.job.embeddingRequest.id);
    if (!response) {
      throw new Error(
        `Missing live voiceprint sidecar response for ${context.job.embeddingRequest.id}.`,
      );
    }
    return scoreLiveVoiceprintScoringJobResponse({
      ...context,
      response,
    });
  });

  return {
    status: partition.skipped.length > 0 ? "partial" : "scored",
    request,
    model,
    results,
    skipped: partition.skipped,
  };
}

export function buildVoiceprintTranscriptIdentityUpdate(input: {
  result: LiveVoiceprintScoringJobResult;
  createdAt?: IsoTime;
}): VoiceprintTranscriptIdentityUpdate {
  const records = input.result.result.score.records;
  const annotation = records.transcriptSpeakerAnnotation;
  const id = makeVoiceprintRecordId("vpupdate", [
    input.result.jobId,
    annotation.sessionKey,
    annotation.transcriptItemId,
    annotation.identitySignalId,
  ]);

  return {
    version: 1,
    id,
    source: "voiceprint",
    jobId: input.result.jobId,
    requestId: input.result.requestId,
    sessionKey: annotation.sessionKey,
    transcriptItemId: annotation.transcriptItemId,
    status: identityStatusForAnnotation(annotation),
    createdAt: input.createdAt ?? new Date().toISOString(),
    speakerTurnTag: records.speakerTurnTag,
    identitySignal: records.identitySignal,
    transcriptSpeakerAnnotation: annotation,
    eventParticipation: records.eventParticipation,
  };
}

export function buildVoiceprintTranscriptIdentityUpdates(input: {
  results: readonly LiveVoiceprintScoringJobResult[];
  createdAt?: IsoTime;
}): VoiceprintTranscriptIdentityUpdate[] {
  return input.results.map((result) =>
    buildVoiceprintTranscriptIdentityUpdate({
      result,
      createdAt: input.createdAt,
    }),
  );
}

function buildBatchRequestFromContexts(
  jobs: readonly LiveVoiceprintScoringJobContext[],
): VoiceprintEmbeddingBatchRequest {
  if (jobs.length === 0) {
    throw new Error("Live voiceprint scoring runner requires at least one job.");
  }
  return buildLiveVoiceprintScoringBatchRequest(jobs.map((item) => item.job));
}

function effectiveSidecarTimeoutMs(
  sidecarTimeoutMs: number | undefined,
  jobs: readonly LiveVoiceprintScoringJobContext[],
): number | undefined {
  let timeoutMs = sidecarTimeoutMs;
  for (const context of jobs) {
    const jobTimeoutMs = context.job.timeoutMs;
    if (jobTimeoutMs === undefined) {
      continue;
    }
    timeoutMs = timeoutMs === undefined ? jobTimeoutMs : Math.min(timeoutMs, jobTimeoutMs);
  }
  return timeoutMs;
}

function partitionJobContextsByConsent(
  jobs: readonly LiveVoiceprintScoringJobContext[],
): {
  processable: LiveVoiceprintScoringJobContext[];
  skipped: LiveVoiceprintSkippedScoringJob[];
} {
  const processable: LiveVoiceprintScoringJobContext[] = [];
  const skipped: LiveVoiceprintSkippedScoringJob[] = [];

  for (const context of jobs) {
    if (voiceprintConsentAllowsProcessing(context.consent)) {
      processable.push(context);
    } else {
      skipped.push({
        status: "skipped",
        jobId: context.job.id,
        requestId: context.job.embeddingRequest.id,
        sessionKey: context.job.prepared.turn.sessionKey,
        transcriptItemId: context.job.prepared.turn.transcriptItemId,
        reason: "consent_denied",
      });
    }
  }

  return { processable, skipped };
}

function validateRequestMatchesJobs(
  request: VoiceprintEmbeddingBatchRequest,
  jobs: readonly LiveVoiceprintScoringJobContext[],
): void {
  const duplicateJobId = firstDuplicate(jobs.map((context) => context.job.id));
  if (duplicateJobId) {
    throw new Error(`Duplicate live voiceprint scoring job id: ${duplicateJobId}.`);
  }
  const duplicateEmbeddingRequestId = firstDuplicate(
    jobs.map((context) => context.job.embeddingRequest.id),
  );
  if (duplicateEmbeddingRequestId) {
    throw new Error(`Duplicate live voiceprint job request id: ${duplicateEmbeddingRequestId}.`);
  }

  const expectedById = new Map(
    jobs.map((context) => [context.job.embeddingRequest.id, context.job.embeddingRequest] as const),
  );
  const seen = new Set<string>();
  for (const item of request.requests) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate live voiceprint request id: ${item.id}.`);
    }
    seen.add(item.id);

    const expected = expectedById.get(item.id);
    if (!expected) {
      throw new Error(`Live voiceprint request includes a non-processable job: ${item.id}.`);
    }
    if (!embeddingRequestsMatch(item, expected)) {
      throw new Error(`Live voiceprint request details do not match job request: ${item.id}.`);
    }
  }
  if (request.requests.length !== expectedById.size) {
    throw new Error("Live voiceprint request does not match processable jobs.");
  }
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
}

function embeddingRequestsMatch(
  actual: VoiceprintEmbeddingRequest,
  expected: VoiceprintEmbeddingRequest,
): boolean {
  return (
    actual.id === expected.id &&
    actual.audioPath === expected.audioPath &&
    actual.startMs === expected.startMs &&
    actual.endMs === expected.endMs &&
    actual.targetSampleRate === expected.targetSampleRate &&
    actual.route === expected.route
  );
}

function commonBatchModel(response: VoiceprintEmbeddingBatchResponse): VoiceprintModelInfo {
  const [first] = response.responses;
  if (!first) {
    throw new Error("Live voiceprint sidecar returned no responses.");
  }
  for (const item of response.responses.slice(1)) {
    if (!sameVoiceprintModel(first.model, item.model)) {
      throw new Error(
        `Live voiceprint sidecar returned mixed models: ${formatVoiceprintModel(first.model)} and ${formatVoiceprintModel(item.model)}.`,
      );
    }
  }
  return { ...first.model };
}

function identityStatusForAnnotation(
  annotation: TranscriptSpeakerAnnotation,
): VoiceprintTranscriptIdentityStatus {
  if (annotation.result === "owner_speaking" || annotation.result === "confirmed_person") {
    return "identity_resolved";
  }
  if (annotation.result === "possible_owner" || annotation.result === "unknown_cluster") {
    return "review_required";
  }
  return "identity_unknown";
}
