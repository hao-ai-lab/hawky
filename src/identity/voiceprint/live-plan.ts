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
  markVoiceprintTranscriptStateSkipped,
  type VoiceprintTranscriptIdentityErrorCode,
  type VoiceprintStaleUpdateHandling,
  type VoiceprintTranscriptIdentityState,
  type VoiceprintTranscriptIdentityStatePatch,
} from "./transcript-state.js";
import {
  scoreClientEmbeddingForQueuedTurn,
  type ClientEmbeddingRejectionReason,
} from "./live-client-embedding.js";
import type { LiveVoiceprintScoringJobResult } from "./live-sidecar-jobs.js";
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
import type { VoiceprintTurnAsNormOptions } from "./turn-scoring.js";
import type { IsoTime } from "./contracts.js";

export interface LiveVoiceprintPlanItemInput extends LiveVoiceprintQueueInput {
  ownerEmbeddings: number[][];
  thresholds?: Partial<VoiceprintThresholds>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  expectedModel?: VoiceprintModelInfo;
  /**
   * A5 PRODUCTION GUARD: when true, refuse to score any sidecar/client embedding
   * whose returned model tag is the non-discriminative reference backend. This is
   * a runtime check against the model the sidecar ACTUALLY emitted (the declared
   * sidecar env is only the requested backend, not proof of what ran). Default
   * false: off preserves the existing reference-backend dev/test behavior.
   */
  requireDiscriminativeModel?: boolean;
  /**
   * OPTIONAL client-supplied (on-device) embedding for this turn. When present
   * AND `acceptClientEmbeddings` is true, the turn is scored DIRECTLY against
   * the owner template without the sidecar / without any audio slice. See the
   * trust-boundary note in live-client-embedding.ts. When absent, or when
   * `acceptClientEmbeddings` is false, the turn keeps using the audio/sidecar
   * path exactly as before.
   */
  sampleEmbedding?: number[];
  /** Model+version that produced `sampleEmbedding`; must match the owner template. */
  sampleEmbeddingModel?: VoiceprintModelInfo;
  /**
   * Explicit opt-in for scoring this turn from a client-supplied embedding.
   * Default false: when false a `sampleEmbedding` is IGNORED for direct scoring
   * (the turn falls back to the audio/sidecar path, or is skipped if it has no
   * usable audio) — the server never silently trusts a client vector.
   */
  acceptClientEmbeddings?: boolean;
  /**
   * OPT-IN A3 AS-Norm normalization for this turn (default OFF). When present the
   * per-turn score is AS-Norm normalized against the cohort and classified with
   * the normalized thresholds; when absent, scoring is byte-for-byte the raw path.
   * Applies to BOTH the sidecar and client-embedding scoring paths.
   */
  asNorm?: VoiceprintTurnAsNormOptions;
}

export interface LiveVoiceprintClientEmbeddingSkip {
  sessionKey: string;
  transcriptItemId: string;
  reason: ClientEmbeddingRejectionReason;
  message: string;
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
  /**
   * Turns scored DIRECTLY from a client-supplied embedding (no sidecar). These
   * results are merged into the sidecar batch results before patch/state
   * building so they flow through the exact same downstream machinery.
   */
  clientScored: LiveVoiceprintScoringJobResult[];
  /** Turns that carried a client embedding but were rejected (invalid/mismatch). */
  clientRejected: LiveVoiceprintClientEmbeddingSkip[];
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
  const clientScored: LiveVoiceprintScoringJobResult[] = [];
  const clientRejected: LiveVoiceprintClientEmbeddingSkip[] = [];

  for (const [index, result] of queueResults.entries()) {
    const turn = input.turns[index]!;

    if (result.status !== "queued") {
      states.push(result.state);
      skipped.push(result);
      continue;
    }

    // A turn is only scored from its client embedding when it supplies one AND
    // the caller has explicitly opted in. Otherwise it takes the audio/sidecar
    // path exactly as before (opt-in OFF never silently trusts a client vector).
    if (turn.acceptClientEmbeddings === true && turn.sampleEmbedding !== undefined) {
      const outcome = scoreClientEmbeddingForQueuedTurn({
        queued: result,
        context: {
          ownerEmbeddings: turn.ownerEmbeddings,
          sampleEmbedding: turn.sampleEmbedding,
          sampleEmbeddingModel: turn.sampleEmbeddingModel,
          expectedModel: turn.expectedModel,
          requireDiscriminativeModel: turn.requireDiscriminativeModel,
          thresholds: turn.thresholds,
          consent: turn.consent,
          templateLearningReviewed: turn.templateLearningReviewed,
          eventId: turn.eventId,
          createdAt: turn.createdAt,
          asNorm: turn.asNorm,
        },
      });

      if (outcome.ok) {
        // Keep the "scoring" state; the merged client result produces the same
        // resolve/skip patch a sidecar-scored turn would, via the shared
        // patch/state machinery. No jobContext -> the sidecar is never invoked
        // for this turn.
        queued.push(result);
        states.push(result.state);
        clientScored.push(outcome.result);
      } else {
        // Rejected client embedding: never a spurious accept. Mark the turn
        // skipped with a clear reason and DO NOT queue it for the sidecar.
        states.push(
          markVoiceprintTranscriptStateSkipped({
            state: result.baseState,
            reason: "client_embedding_rejected",
            updatedAt: turn.updatedAt,
          }),
        );
        clientRejected.push({
          sessionKey: turn.sessionKey,
          transcriptItemId: turn.transcriptItemId,
          reason: outcome.reason,
          message: outcome.message,
        });
      }
      continue;
    }

    states.push(result.state);
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
      requireDiscriminativeModel: turn.requireDiscriminativeModel,
      asNorm: turn.asNorm,
    });
  }

  return {
    version: 1,
    status: planStatus(queued.length, skipped.length + clientRejected.length),
    queueResults,
    queued,
    skipped,
    jobContexts,
    states,
    clientScored,
    clientRejected,
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
  const createdAt = input.updatedAt ?? input.createdAt;
  if (plan.jobContexts.length === 0) {
    // No sidecar jobs. If any turns were scored from a client embedding, still
    // build their patches (from clientScored) without ever spawning the sidecar.
    if (plan.clientScored.length === 0) {
      return buildPlanRunResult({
        status: plan.status === "empty" ? "empty" : "skipped",
        plan,
        batch: null,
        patches: [],
        states: plan.states,
        createdAt,
      });
    }
    const clientBatch = clientOnlyBatchResult(plan);
    const patches = buildLiveVoiceprintScoringPlanPatches({
      plan,
      batch: clientBatch,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      staleUpdateHandling: input.staleUpdateHandling,
    });
    const states = applyLiveVoiceprintScoringPlanPatches({ plan, patches });
    return buildPlanRunResult({
      status: runStatus(plan, clientBatch),
      plan,
      batch: clientBatch,
      patches,
      states,
      createdAt,
    });
  }

  let batch: LiveVoiceprintScoringBatchResult;
  try {
    batch = mergeClientScoredIntoBatch(
      await runLiveVoiceprintScoringJobs({
        sidecar: input.sidecar,
        jobs: plan.jobContexts,
      }),
      plan,
    );
  } catch (error) {
    if (input.sidecarErrorHandling === "throw") {
      throw error;
    }
    const message = errorMessage(error);
    // Client-embedding-scored turns do NOT depend on the sidecar, so a sidecar
    // failure must not error them: apply their patches first, then error only
    // the remaining (sidecar-bound) scoring states.
    const clientPatches =
      plan.clientScored.length > 0
        ? buildLiveVoiceprintScoringPlanPatches({
            plan,
            batch: clientOnlyBatchResult(plan),
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
            staleUpdateHandling: input.staleUpdateHandling,
          })
        : [];
    const clientResolvedJoins = new Set(
      clientPatches.map((patch) => transcriptJoinKey(patch.sessionKey, patch.transcriptItemId)),
    );
    const erroredStates = markLiveVoiceprintScoringPlanErrorStates({
      plan,
      code: "sidecar_failed",
      message,
      updatedAt: input.updatedAt,
      skipJoins: clientResolvedJoins,
    });
    const states = applyLiveVoiceprintScoringPlanPatches({
      plan: { ...plan, states: erroredStates },
      patches: clientPatches,
    });
    return {
      version: 1,
      status: "error",
      plan,
      batch: null,
      patches: clientPatches,
      states,
      storageBundle: storageBundleForPlanRun({
        states,
        patches: clientPatches,
        createdAt,
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
  return buildPlanRunResult({
    status: runStatus(plan, batch),
    plan,
    batch,
    patches,
    states,
    createdAt,
  });
}

export function markLiveVoiceprintScoringPlanErrorStates(input: {
  plan: LiveVoiceprintScoringPlan;
  code?: VoiceprintTranscriptIdentityErrorCode;
  message: string;
  updatedAt?: IsoTime;
  /** Transcript joins to leave untouched (e.g. client-embedding-scored turns). */
  skipJoins?: ReadonlySet<string>;
}): VoiceprintTranscriptIdentityState[] {
  if (!input.message.trim()) {
    throw new Error("Live voiceprint scoring plan error requires message.");
  }

  return input.plan.states.map((state) => {
    if (state.lifecycle !== "scoring") {
      return state;
    }
    if (input.skipJoins?.has(transcriptJoinKey(state.sessionKey, state.transcriptItemId))) {
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

/**
 * Assemble a non-error {@link LiveVoiceprintScoringPlanRun} from its computed
 * parts. The three success return paths (no-client-scored, client-only, and
 * sidecar) build byte-identical shapes — same `version`, same
 * `storageBundleForPlanRun` derivation — so they share this builder. The error
 * path is NOT routed here because it additionally carries an `error` field.
 */
function buildPlanRunResult(input: {
  status: LiveVoiceprintScoringPlanRunStatus;
  plan: LiveVoiceprintScoringPlan;
  batch: LiveVoiceprintScoringBatchResult | null;
  patches: VoiceprintTranscriptIdentityStatePatch[];
  states: VoiceprintTranscriptIdentityState[];
  createdAt?: IsoTime;
}): LiveVoiceprintScoringPlanRun {
  return {
    version: 1,
    status: input.status,
    plan: input.plan,
    batch: input.batch,
    patches: input.patches,
    states: input.states,
    storageBundle: storageBundleForPlanRun({
      states: input.states,
      patches: input.patches,
      createdAt: input.createdAt,
    }),
  };
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
  const skippedCount = plan.skipped.length + plan.clientRejected.length;
  if (batch.status === "skipped" && plan.clientScored.length === 0) {
    return skippedCount > 0 ? "partial" : "skipped";
  }
  if (skippedCount > 0 || batch.skipped.length > 0 || batch.status === "partial") {
    return "partial";
  }
  return "scored";
}

/**
 * Synthesize a batch result that carries ONLY the client-embedding-scored turns
 * (no sidecar involved). Its results flow through the same patch/state machinery
 * as sidecar-scored turns.
 */
function clientOnlyBatchResult(
  plan: LiveVoiceprintScoringPlan,
): LiveVoiceprintScoringBatchResult {
  return {
    status: "scored",
    request: null,
    model: plan.clientScored[0]?.response.model,
    results: [...plan.clientScored],
    skipped: [],
  };
}

/** Merge client-embedding-scored results into a sidecar batch's results. */
function mergeClientScoredIntoBatch(
  batch: LiveVoiceprintScoringBatchResult,
  plan: LiveVoiceprintScoringPlan,
): LiveVoiceprintScoringBatchResult {
  if (plan.clientScored.length === 0) {
    return batch;
  }
  return {
    ...batch,
    results: [...batch.results, ...plan.clientScored],
  };
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
