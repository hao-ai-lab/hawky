import {
  queueLiveVoiceprintTurn,
  type LiveVoiceprintQueueInput,
  type LiveVoiceprintQueueResult,
  type LiveVoiceprintQueuedTurn,
  type LiveVoiceprintSkippedQueueTurn,
} from "./live-queue.js";
import {
  buildVoiceprintTranscriptIdentityStatePatches,
  markVoiceprintTranscriptStateError,
  type VoiceprintTranscriptIdentityErrorCode,
  type VoiceprintStaleUpdateHandling,
  type VoiceprintTranscriptIdentityState,
  type VoiceprintTranscriptIdentityStatePatch,
} from "./transcript-state.js";
import {
  buildVoiceprintStorageBundle,
  type VoiceprintStorageBundle,
} from "./persistence.js";
import type {
  LiveVoiceprintScoringBatchResult,
  LiveVoiceprintScoringJobContext,
} from "./live-sidecar-runner.js";
import { runLiveVoiceprintScoringJobs } from "./live-sidecar-runner.js";
import type { EmbeddingSidecarCommand } from "./sidecar-client.js";
import type { VoiceprintModelInfo, VoiceprintThresholds } from "./types.js";
import type { IsoTime } from "./contracts.js";

export interface LiveVoiceprintPlanItemInput extends LiveVoiceprintQueueInput {
  ownerEmbeddings: number[][];
  thresholds?: Partial<VoiceprintThresholds>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  expectedModel?: VoiceprintModelInfo;
}

export type LiveVoiceprintPlanStatus = "empty" | "queued" | "partial" | "skipped";

export interface LiveVoiceprintScoringPlan {
  version: 1;
  status: LiveVoiceprintPlanStatus;
  queueResults: LiveVoiceprintQueueResult[];
  queued: LiveVoiceprintQueuedTurn[];
  skipped: LiveVoiceprintSkippedQueueTurn[];
  jobContexts: LiveVoiceprintScoringJobContext[];
  states: VoiceprintTranscriptIdentityState[];
}

export type LiveVoiceprintScoringPlanRunStatus =
  | "empty"
  | "skipped"
  | "scored"
  | "partial"
  | "error";

export type LiveVoiceprintScoringPlanSidecarErrorHandling = "mark_error" | "throw";

export interface LiveVoiceprintScoringPlanRun {
  version: 1;
  status: LiveVoiceprintScoringPlanRunStatus;
  plan: LiveVoiceprintScoringPlan;
  batch: LiveVoiceprintScoringBatchResult | null;
  patches: VoiceprintTranscriptIdentityStatePatch[];
  states: VoiceprintTranscriptIdentityState[];
  storageBundle: VoiceprintStorageBundle | null;
  error?: {
    code: VoiceprintTranscriptIdentityErrorCode;
    message: string;
  };
}

export function buildLiveVoiceprintScoringPlan(input: {
  turns: readonly LiveVoiceprintPlanItemInput[];
}): LiveVoiceprintScoringPlan {
  rejectDuplicatePlanTurns(input.turns);

  const queueResults = input.turns.map((turn) => queueLiveVoiceprintTurn(turn));
  const queued: LiveVoiceprintQueuedTurn[] = [];
  const skipped: LiveVoiceprintSkippedQueueTurn[] = [];
  const jobContexts: LiveVoiceprintScoringJobContext[] = [];
  const states: VoiceprintTranscriptIdentityState[] = [];

  for (const [index, result] of queueResults.entries()) {
    const turn = input.turns[index]!;
    states.push(result.state);

    if (result.status === "queued") {
      queued.push(result);
      jobContexts.push({
        job: result.job,
        ownerEmbeddings: turn.ownerEmbeddings,
        thresholds: turn.thresholds,
        consent: turn.consent,
        templateLearningReviewed: turn.templateLearningReviewed,
        eventId: turn.eventId,
        createdAt: turn.createdAt,
        expectedModel: turn.expectedModel,
      });
    } else {
      skipped.push(result);
    }
  }

  return {
    version: 1,
    status: planStatus(queued.length, skipped.length),
    queueResults,
    queued,
    skipped,
    jobContexts,
    states,
  };
}

export async function runLiveVoiceprintScoringPlan(input: {
  sidecar: EmbeddingSidecarCommand;
  turns: readonly LiveVoiceprintPlanItemInput[];
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  staleUpdateHandling?: VoiceprintStaleUpdateHandling;
  sidecarErrorHandling?: LiveVoiceprintScoringPlanSidecarErrorHandling;
}): Promise<LiveVoiceprintScoringPlanRun> {
  const plan = buildLiveVoiceprintScoringPlan({ turns: input.turns });
  if (plan.jobContexts.length === 0) {
    return {
      version: 1,
      status: plan.status === "empty" ? "empty" : "skipped",
      plan,
      batch: null,
      patches: [],
      states: plan.states,
      storageBundle: storageBundleForPlanRun({
        states: plan.states,
        patches: [],
        createdAt: input.updatedAt ?? input.createdAt,
      }),
    };
  }

  let batch: LiveVoiceprintScoringBatchResult;
  try {
    batch = await runLiveVoiceprintScoringJobs({
      sidecar: input.sidecar,
      jobs: plan.jobContexts,
    });
  } catch (error) {
    if (input.sidecarErrorHandling === "throw") {
      throw error;
    }
    const message = errorMessage(error);
    const states = markLiveVoiceprintScoringPlanErrorStates({
      plan,
      code: "sidecar_failed",
      message,
      updatedAt: input.updatedAt,
    });
    return {
      version: 1,
      status: "error",
      plan,
      batch: null,
      patches: [],
      states,
      storageBundle: storageBundleForPlanRun({
        states,
        patches: [],
        createdAt: input.updatedAt ?? input.createdAt,
      }),
      error: {
        code: "sidecar_failed",
        message,
      },
    };
  }

  const patches = buildLiveVoiceprintScoringPlanPatches({
    plan,
    batch,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    staleUpdateHandling: input.staleUpdateHandling,
  });

  const states = applyLiveVoiceprintScoringPlanPatches({ plan, patches });
  return {
    version: 1,
    status: runStatus(plan, batch),
    plan,
    batch,
    patches,
    states,
    storageBundle: storageBundleForPlanRun({
      states,
      patches,
      createdAt: input.updatedAt ?? input.createdAt,
    }),
  };
}

export function markLiveVoiceprintScoringPlanErrorStates(input: {
  plan: LiveVoiceprintScoringPlan;
  code?: VoiceprintTranscriptIdentityErrorCode;
  message: string;
  updatedAt?: IsoTime;
}): VoiceprintTranscriptIdentityState[] {
  if (!input.message.trim()) {
    throw new Error("Live voiceprint scoring plan error requires message.");
  }

  return input.plan.states.map((state) => {
    if (state.lifecycle !== "scoring") {
      return state;
    }
    return markVoiceprintTranscriptStateError({
      state,
      code: input.code,
      message: input.message,
      updatedAt: input.updatedAt,
    });
  });
}

export function buildLiveVoiceprintScoringPlanPatches(input: {
  plan: LiveVoiceprintScoringPlan;
  batch: LiveVoiceprintScoringBatchResult;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  staleUpdateHandling?: VoiceprintStaleUpdateHandling;
}): VoiceprintTranscriptIdentityStatePatch[] {
  return buildVoiceprintTranscriptIdentityStatePatches({
    batch: input.batch,
    existingStates: input.plan.states,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    staleUpdateHandling: input.staleUpdateHandling ?? "ignore",
  });
}

export function applyLiveVoiceprintScoringPlanPatches(input: {
  plan: LiveVoiceprintScoringPlan;
  patches: readonly VoiceprintTranscriptIdentityStatePatch[];
}): VoiceprintTranscriptIdentityState[] {
  const states = [...input.plan.states];
  const indexByJoin = new Map<string, number>();

  for (const [index, state] of states.entries()) {
    indexByJoin.set(transcriptJoinKey(state.sessionKey, state.transcriptItemId), index);
  }

  const seenPatches = new Set<string>();
  for (const patch of input.patches) {
    const key = transcriptJoinKey(patch.sessionKey, patch.transcriptItemId);
    if (seenPatches.has(key)) {
      throw new Error(
        `Duplicate live voiceprint state patch: ${patch.sessionKey}/${patch.transcriptItemId}.`,
      );
    }
    seenPatches.add(key);

    const index = indexByJoin.get(key);
    if (index === undefined) {
      indexByJoin.set(key, states.length);
      states.push(patch.state);
    } else {
      states[index] = patch.state;
    }
  }

  return states;
}

function storageBundleForPlanRun(input: {
  states: readonly VoiceprintTranscriptIdentityState[];
  patches: readonly VoiceprintTranscriptIdentityStatePatch[];
  createdAt?: IsoTime;
}): VoiceprintStorageBundle | null {
  if (input.states.length === 0 && input.patches.length === 0) {
    return null;
  }
  return buildVoiceprintStorageBundle({
    states: input.states,
    patches: input.patches,
    createdAt: input.createdAt,
  });
}

function planStatus(queuedCount: number, skippedCount: number): LiveVoiceprintPlanStatus {
  if (queuedCount === 0 && skippedCount === 0) {
    return "empty";
  }
  if (queuedCount === 0) {
    return "skipped";
  }
  if (skippedCount === 0) {
    return "queued";
  }
  return "partial";
}

function runStatus(
  plan: LiveVoiceprintScoringPlan,
  batch: LiveVoiceprintScoringBatchResult,
): LiveVoiceprintScoringPlanRunStatus {
  if (batch.status === "skipped") {
    return plan.skipped.length > 0 ? "partial" : "skipped";
  }
  if (plan.skipped.length > 0 || batch.skipped.length > 0 || batch.status === "partial") {
    return "partial";
  }
  return "scored";
}

function rejectDuplicatePlanTurns(turns: readonly LiveVoiceprintPlanItemInput[]): void {
  const seen = new Set<string>();
  for (const turn of turns) {
    const key = transcriptJoinKey(turn.sessionKey, turn.transcriptItemId);
    if (seen.has(key)) {
      throw new Error(
        `Duplicate live voiceprint plan turn: ${turn.sessionKey}/${turn.transcriptItemId}.`,
      );
    }
    seen.add(key);
  }
}

function transcriptJoinKey(sessionKey: string, transcriptItemId: string): string {
  return JSON.stringify([sessionKey, transcriptItemId]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Live voiceprint sidecar failed.";
}
