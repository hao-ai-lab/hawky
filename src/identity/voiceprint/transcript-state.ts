import {
  makeVoiceprintRecordId,
  type IsoTime,
  type RecordId,
} from "./contracts.js";
import type { VoiceprintAnnotationAllowedUses } from "./policy.js";
import type { LiveVoiceprintScoringJob } from "./live-sidecar-jobs.js";
import {
  buildVoiceprintTranscriptIdentityUpdate,
  type LiveVoiceprintScoringBatchResult,
  type LiveVoiceprintSkippedScoringJob,
  type VoiceprintTranscriptIdentityUpdate,
} from "./live-sidecar-runner.js";
import type { LiveVoiceprintSkipReason } from "./live-adapter.js";

export type VoiceprintTranscriptIdentityLifecycle =
  | "not_applicable"
  | "pending"
  | "scoring"
  | "resolved"
  | "unknown"
  | "review_required"
  | "skipped"
  | "error";

export type VoiceprintTranscriptPolicyState =
  | "none"
  | "diagnostics_only"
  | "policy_allowed_use"
  | "review_required";

export type VoiceprintTranscriptIdentityErrorCode =
  | "sidecar_failed"
  | "scoring_failed"
  | "annotation_failed"
  | "unknown";

export type VoiceprintTranscriptIdentitySkipReason =
  | LiveVoiceprintSkipReason
  | LiveVoiceprintSkippedScoringJob["reason"]
  | "missing_audio_artifact"
  | "client_embedding_rejected";

export interface VoiceprintTranscriptIdentityState {
  version: 1;
  id: RecordId;
  source: "voiceprint";
  sessionKey: string;
  transcriptItemId: string;
  lifecycle: VoiceprintTranscriptIdentityLifecycle;
  policyState: VoiceprintTranscriptPolicyState;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  jobId?: RecordId;
  requestId?: string;
  updateId?: RecordId;
  speakerTurnTagId?: RecordId;
  identitySignalId?: RecordId;
  result?: VoiceprintTranscriptIdentityUpdate["transcriptSpeakerAnnotation"]["result"];
  confidence?: number;
  thresholdUsed?: number;
  skipReason?: VoiceprintTranscriptIdentitySkipReason;
  error?: {
    code: VoiceprintTranscriptIdentityErrorCode;
    message: string;
  };
}

export type VoiceprintTranscriptIdentityStatePatchKind = "scored" | "skipped";

interface VoiceprintTranscriptIdentityStatePatchBase {
  sessionKey: string;
  transcriptItemId: string;
  state: VoiceprintTranscriptIdentityState;
}

export type VoiceprintTranscriptIdentityStatePatch =
  | (VoiceprintTranscriptIdentityStatePatchBase & {
      kind: "scored";
      update: VoiceprintTranscriptIdentityUpdate;
    })
  | (VoiceprintTranscriptIdentityStatePatchBase & {
      kind: "skipped";
      skipped: LiveVoiceprintSkippedScoringJob;
    });

export type VoiceprintStaleUpdateHandling = "throw" | "ignore";

export class StaleVoiceprintTranscriptIdentityUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVoiceprintTranscriptIdentityUpdateError";
  }
}

export function buildVoiceprintTranscriptIdentityState(input: {
  sessionKey: string;
  transcriptItemId: string;
  lifecycle?: Extract<VoiceprintTranscriptIdentityLifecycle, "pending" | "not_applicable">;
  createdAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  validateTranscriptJoin(input.sessionKey, input.transcriptItemId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const lifecycle = input.lifecycle ?? "pending";

  return {
    version: 1,
    id: makeVoiceprintRecordId("vpstate", [input.sessionKey, input.transcriptItemId]),
    source: "voiceprint",
    sessionKey: input.sessionKey,
    transcriptItemId: input.transcriptItemId,
    lifecycle,
    policyState: lifecycle === "not_applicable" ? "none" : "diagnostics_only",
    createdAt,
    updatedAt: createdAt,
  };
}

export function buildVoiceprintTranscriptIdentityStatePatches(input: {
  batch: LiveVoiceprintScoringBatchResult;
  existingStates?: readonly VoiceprintTranscriptIdentityState[];
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  staleUpdateHandling?: VoiceprintStaleUpdateHandling;
}): VoiceprintTranscriptIdentityStatePatch[] {
  const existingByJoin = buildExistingStateMap(input.existingStates ?? []);
  const patches: VoiceprintTranscriptIdentityStatePatch[] = [];
  const seenPatchJoins = new Set<string>();
  const staleUpdateHandling = input.staleUpdateHandling ?? "throw";

  for (const result of input.batch.results) {
    const update = buildVoiceprintTranscriptIdentityUpdate({
      result,
      createdAt: input.createdAt,
    });
    const baseState = stateForJoin({
      existingByJoin,
      sessionKey: update.sessionKey,
      transcriptItemId: update.transcriptItemId,
      createdAt: input.createdAt,
    });
    const state = applyTranscriptUpdateOrNull({
      state: baseState,
      update,
      updatedAt: input.updatedAt,
      staleUpdateHandling,
    });
    if (!state) {
      continue;
    }

    addTranscriptStatePatch(patches, seenPatchJoins, {
      kind: "scored",
      sessionKey: update.sessionKey,
      transcriptItemId: update.transcriptItemId,
      state,
      update,
    });
  }

  for (const skipped of input.batch.skipped) {
    const baseState = stateForJoin({
      existingByJoin,
      sessionKey: skipped.sessionKey,
      transcriptItemId: skipped.transcriptItemId,
      createdAt: input.createdAt,
    });
    const state = applySkippedScoringJobOrNull({
      state: baseState,
      skipped,
      updatedAt: input.updatedAt,
      staleUpdateHandling,
    });
    if (!state) {
      continue;
    }

    addTranscriptStatePatch(patches, seenPatchJoins, {
      kind: "skipped",
      sessionKey: skipped.sessionKey,
      transcriptItemId: skipped.transcriptItemId,
      state,
      skipped,
    });
  }

  return patches;
}

function applyTranscriptUpdateOrNull(input: {
  state: VoiceprintTranscriptIdentityState;
  update: VoiceprintTranscriptIdentityUpdate;
  updatedAt?: IsoTime;
  staleUpdateHandling: VoiceprintStaleUpdateHandling;
}): VoiceprintTranscriptIdentityState | null {
  try {
    return applyVoiceprintTranscriptIdentityUpdate({
      state: input.state,
      update: input.update,
      updatedAt: input.updatedAt,
    });
  } catch (error) {
    if (
      input.staleUpdateHandling === "ignore" &&
      error instanceof StaleVoiceprintTranscriptIdentityUpdateError
    ) {
      return null;
    }
    throw error;
  }
}

function applySkippedScoringJobOrNull(input: {
  state: VoiceprintTranscriptIdentityState;
  skipped: LiveVoiceprintSkippedScoringJob;
  updatedAt?: IsoTime;
  staleUpdateHandling: VoiceprintStaleUpdateHandling;
}): VoiceprintTranscriptIdentityState | null {
  try {
    return applyVoiceprintSkippedScoringJob({
      state: input.state,
      skipped: input.skipped,
      updatedAt: input.updatedAt,
    });
  } catch (error) {
    if (
      input.staleUpdateHandling === "ignore" &&
      error instanceof StaleVoiceprintTranscriptIdentityUpdateError
    ) {
      return null;
    }
    throw error;
  }
}

export function markVoiceprintTranscriptStateScoring(input: {
  state: VoiceprintTranscriptIdentityState;
  job: LiveVoiceprintScoringJob;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  assertSameTranscriptJoin(input.state, {
    sessionKey: input.job.prepared.turn.sessionKey,
    transcriptItemId: input.job.prepared.turn.transcriptItemId,
  });

  return {
    ...input.state,
    lifecycle: "scoring",
    policyState: "diagnostics_only",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    jobId: input.job.id,
    requestId: input.job.embeddingRequest.id,
    updateId: undefined,
    speakerTurnTagId: undefined,
    identitySignalId: undefined,
    result: undefined,
    confidence: undefined,
    thresholdUsed: undefined,
    error: undefined,
    skipReason: undefined,
  };
}

export function applyVoiceprintTranscriptIdentityUpdate(input: {
  state: VoiceprintTranscriptIdentityState;
  update: VoiceprintTranscriptIdentityUpdate;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  assertSameTranscriptJoin(input.state, input.update);
  assertCurrentVoiceprintJobRef(input.state, {
    jobId: input.update.jobId,
    requestId: input.update.requestId,
  });
  const annotation = input.update.transcriptSpeakerAnnotation;

  return {
    ...input.state,
    lifecycle: lifecycleForUpdate(input.update),
    policyState: policyStateForUpdate(input.update),
    updatedAt: input.updatedAt ?? input.update.createdAt,
    jobId: input.update.jobId,
    requestId: input.update.requestId,
    updateId: input.update.id,
    speakerTurnTagId: annotation.speakerTurnTagId,
    identitySignalId: annotation.identitySignalId,
    result: annotation.result,
    confidence: annotation.confidence,
    thresholdUsed: annotation.thresholdUsed,
    error: undefined,
    skipReason: undefined,
  };
}

export function applyVoiceprintSkippedScoringJob(input: {
  state: VoiceprintTranscriptIdentityState;
  skipped: LiveVoiceprintSkippedScoringJob;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  assertSameTranscriptJoin(input.state, input.skipped);
  assertCurrentVoiceprintJobRef(input.state, {
    jobId: input.skipped.jobId,
    requestId: input.skipped.requestId,
  });
  return markVoiceprintTranscriptStateSkipped({
    state: input.state,
    reason: input.skipped.reason,
    jobId: input.skipped.jobId,
    requestId: input.skipped.requestId,
    updatedAt: input.updatedAt,
  });
}

export function markVoiceprintTranscriptStateSkipped(input: {
  state: VoiceprintTranscriptIdentityState;
  reason: VoiceprintTranscriptIdentitySkipReason;
  jobId?: RecordId;
  requestId?: string;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  return {
    ...input.state,
    lifecycle: "skipped",
    policyState: "none",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    jobId: input.jobId,
    requestId: input.requestId,
    updateId: undefined,
    speakerTurnTagId: undefined,
    identitySignalId: undefined,
    result: undefined,
    confidence: undefined,
    thresholdUsed: undefined,
    skipReason: input.reason,
    error: undefined,
  };
}

export function markVoiceprintTranscriptStateNotApplicable(input: {
  state: VoiceprintTranscriptIdentityState;
  reason: Extract<VoiceprintTranscriptIdentitySkipReason, "non_user_turn">;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  return {
    ...input.state,
    lifecycle: "not_applicable",
    policyState: "none",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    jobId: undefined,
    requestId: undefined,
    updateId: undefined,
    speakerTurnTagId: undefined,
    identitySignalId: undefined,
    result: undefined,
    confidence: undefined,
    thresholdUsed: undefined,
    skipReason: input.reason,
    error: undefined,
  };
}

export function markVoiceprintTranscriptStateError(input: {
  state: VoiceprintTranscriptIdentityState;
  code?: VoiceprintTranscriptIdentityErrorCode;
  message: string;
  jobId?: RecordId;
  requestId?: string;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  if (!input.message.trim()) {
    throw new Error("Voiceprint transcript identity error requires message.");
  }

  return {
    ...input.state,
    lifecycle: "error",
    policyState: "none",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    jobId: input.jobId ?? input.state.jobId,
    requestId: input.requestId ?? input.state.requestId,
    updateId: undefined,
    speakerTurnTagId: undefined,
    identitySignalId: undefined,
    result: undefined,
    confidence: undefined,
    thresholdUsed: undefined,
    skipReason: undefined,
    error: {
      code: input.code ?? "unknown",
      message: input.message,
    },
  };
}

function lifecycleForUpdate(
  update: VoiceprintTranscriptIdentityUpdate,
): VoiceprintTranscriptIdentityLifecycle {
  if (update.status === "identity_resolved") {
    return "resolved";
  }
  if (update.status === "review_required") {
    return "review_required";
  }
  return "unknown";
}

function policyStateForUpdate(
  update: VoiceprintTranscriptIdentityUpdate,
): VoiceprintTranscriptPolicyState {
  if (update.status === "review_required") {
    return "review_required";
  }
  return hasPolicyAllowedUse(update.transcriptSpeakerAnnotation.allowedUses)
    ? "policy_allowed_use"
    : "diagnostics_only";
}

function hasPolicyAllowedUse(allowedUses: VoiceprintAnnotationAllowedUses): boolean {
  return (
    allowedUses.memoryPromotion ||
    allowedUses.actionProposal ||
    allowedUses.eventGraph ||
    allowedUses.contextExport ||
    allowedUses.templateLearning
  );
}

function buildExistingStateMap(
  states: readonly VoiceprintTranscriptIdentityState[],
): Map<string, VoiceprintTranscriptIdentityState> {
  const byJoin = new Map<string, VoiceprintTranscriptIdentityState>();
  for (const state of states) {
    validateTranscriptJoin(state.sessionKey, state.transcriptItemId);
    const key = transcriptJoinKey(state.sessionKey, state.transcriptItemId);
    if (byJoin.has(key)) {
      throw new Error(
        `Duplicate voiceprint transcript identity state: ${state.sessionKey}/${state.transcriptItemId}.`,
      );
    }
    byJoin.set(key, state);
  }
  return byJoin;
}

function stateForJoin(input: {
  existingByJoin: ReadonlyMap<string, VoiceprintTranscriptIdentityState>;
  sessionKey: string;
  transcriptItemId: string;
  createdAt?: IsoTime;
}): VoiceprintTranscriptIdentityState {
  validateTranscriptJoin(input.sessionKey, input.transcriptItemId);
  const existing = input.existingByJoin.get(
    transcriptJoinKey(input.sessionKey, input.transcriptItemId),
  );
  if (existing) {
    return existing;
  }
  return buildVoiceprintTranscriptIdentityState({
    sessionKey: input.sessionKey,
    transcriptItemId: input.transcriptItemId,
    createdAt: input.createdAt,
  });
}

function addTranscriptStatePatch(
  patches: VoiceprintTranscriptIdentityStatePatch[],
  seenPatchJoins: Set<string>,
  patch: VoiceprintTranscriptIdentityStatePatch,
): void {
  const key = transcriptJoinKey(patch.sessionKey, patch.transcriptItemId);
  if (seenPatchJoins.has(key)) {
    throw new Error(
      `Duplicate voiceprint transcript identity patch: ${patch.sessionKey}/${patch.transcriptItemId}.`,
    );
  }
  seenPatchJoins.add(key);
  patches.push(patch);
}

function assertSameTranscriptJoin(
  state: Pick<VoiceprintTranscriptIdentityState, "sessionKey" | "transcriptItemId">,
  other: { sessionKey: string; transcriptItemId: string },
): void {
  if (state.sessionKey !== other.sessionKey || state.transcriptItemId !== other.transcriptItemId) {
    throw new Error(
      `Voiceprint transcript identity join mismatch: state=${state.sessionKey}/${state.transcriptItemId} update=${other.sessionKey}/${other.transcriptItemId}.`,
    );
  }
}

function assertCurrentVoiceprintJobRef(
  state: Pick<VoiceprintTranscriptIdentityState, "lifecycle" | "jobId" | "requestId">,
  incoming: { jobId: RecordId; requestId: string },
): void {
  if (state.lifecycle === "pending" && !state.jobId && !state.requestId) {
    return;
  }
  if (state.lifecycle !== "scoring") {
    throw new StaleVoiceprintTranscriptIdentityUpdateError(
      `Stale voiceprint transcript identity update for job ${incoming.jobId}; current state is ${state.lifecycle}.`,
    );
  }
  if (!state.jobId || !state.requestId) {
    throw new StaleVoiceprintTranscriptIdentityUpdateError(
      `Stale voiceprint transcript identity update for job ${incoming.jobId}; current scoring state has no active job request.`,
    );
  }
  if (state.jobId !== incoming.jobId) {
    throw new StaleVoiceprintTranscriptIdentityUpdateError(
      `Stale voiceprint transcript identity update for job ${incoming.jobId}; current job is ${state.jobId}.`,
    );
  }
  if (state.requestId !== incoming.requestId) {
    throw new StaleVoiceprintTranscriptIdentityUpdateError(
      `Stale voiceprint transcript identity update for request ${incoming.requestId}; current request is ${state.requestId}.`,
    );
  }
}

function transcriptJoinKey(sessionKey: string, transcriptItemId: string): string {
  return JSON.stringify([sessionKey, transcriptItemId]);
}

function validateTranscriptJoin(sessionKey: string, transcriptItemId: string): void {
  if (!sessionKey.trim()) {
    throw new Error("Voiceprint transcript identity state requires sessionKey.");
  }
  if (!transcriptItemId.trim()) {
    throw new Error("Voiceprint transcript identity state requires transcriptItemId.");
  }
}
