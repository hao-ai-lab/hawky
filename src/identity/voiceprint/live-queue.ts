import {
  buildLiveVoiceprintScoringJob,
  type LiveVoiceprintScoringJob,
} from "./live-sidecar-jobs.js";
import {
  prepareLiveVoiceprintTurn,
  type LiveVoiceprintPreparationOptions,
  type LiveVoiceprintReadyTurn,
  type LiveVoiceprintSkippedTurn,
  type LiveVoiceprintTurnCandidate,
} from "./live-adapter.js";
import {
  buildVoiceprintTranscriptIdentityState,
  markVoiceprintTranscriptStateNotApplicable,
  markVoiceprintTranscriptStateScoring,
  markVoiceprintTranscriptStateSkipped,
  type VoiceprintTranscriptIdentityState,
  type VoiceprintTranscriptIdentitySkipReason,
} from "./transcript-state.js";
import {
  voiceprintConsentAllowsProcessing,
  type VoiceprintConsentSnapshot,
} from "./policy.js";
import type { IsoTime } from "./contracts.js";

export interface LiveVoiceprintQueueInput extends LiveVoiceprintTurnCandidate {
  audioPath?: string;
  requestStartMs?: number;
  requestEndMs?: number;
  targetSampleRate?: number;
  ownerTemplateRef?: string;
  existingState?: VoiceprintTranscriptIdentityState;
  consent?: Partial<VoiceprintConsentSnapshot>;
  qualityThresholds?: LiveVoiceprintPreparationOptions["qualityThresholds"];
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  attempt?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface LiveVoiceprintQueuedTurn {
  status: "queued";
  prepared: LiveVoiceprintReadyTurn;
  job: LiveVoiceprintScoringJob;
  baseState: VoiceprintTranscriptIdentityState;
  state: VoiceprintTranscriptIdentityState;
}

export interface LiveVoiceprintSkippedQueueTurn {
  status: "skipped";
  reason: VoiceprintTranscriptIdentitySkipReason;
  baseState: VoiceprintTranscriptIdentityState;
  state: VoiceprintTranscriptIdentityState;
  preparation?: LiveVoiceprintSkippedTurn;
}

export type LiveVoiceprintQueueResult =
  | LiveVoiceprintQueuedTurn
  | LiveVoiceprintSkippedQueueTurn;

export function queueLiveVoiceprintTurn(
  input: LiveVoiceprintQueueInput,
): LiveVoiceprintQueueResult {
  const baseState = baseStateForQueueInput(input);

  if (input.role !== "user") {
    const preparation = prepareLiveVoiceprintTurn(input, {
      qualityThresholds: input.qualityThresholds,
    });
    if (preparation.status !== "skipped") {
      throw new Error("Live voiceprint queue expected non-user turn to be skipped.");
    }
    return skippedQueueResult({
      baseState,
      preparation,
      reason: preparation.reason,
      updatedAt: input.updatedAt,
    });
  }

  if (!voiceprintConsentAllowsProcessing(input.consent)) {
    return skippedQueueResult({
      baseState,
      reason: "consent_denied",
      updatedAt: input.updatedAt,
    });
  }

  const audioArtifactId = input.audioArtifactId?.trim();
  const audioPath = input.audioPath?.trim();
  if (!audioArtifactId || !audioPath) {
    return skippedQueueResult({
      baseState,
      reason: "missing_audio_artifact",
      updatedAt: input.updatedAt,
    });
  }

  const preparation = prepareLiveVoiceprintTurn(input, {
    qualityThresholds: input.qualityThresholds,
  });
  if (preparation.status === "skipped") {
    return skippedQueueResult({
      baseState,
      preparation,
      reason: preparation.reason,
      updatedAt: input.updatedAt,
    });
  }

  const job = buildLiveVoiceprintScoringJob({
    prepared: preparation,
    audioPath,
    requestStartMs: input.requestStartMs ?? preparation.turn.startMs,
    requestEndMs: input.requestEndMs ?? preparation.turn.endMs,
    targetSampleRate: input.targetSampleRate,
    ownerTemplateRef: input.ownerTemplateRef,
    createdAt: input.createdAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timeoutMs: input.timeoutMs,
  });

  return {
    status: "queued",
    prepared: preparation,
    job,
    baseState,
    state: markVoiceprintTranscriptStateScoring({
      state: baseState,
      job,
      updatedAt: input.updatedAt,
    }),
  };
}

function baseStateForQueueInput(
  input: Pick<
    LiveVoiceprintQueueInput,
    "existingState" | "sessionKey" | "transcriptItemId" | "createdAt"
  >,
): VoiceprintTranscriptIdentityState {
  if (input.existingState) {
    if (
      input.existingState.sessionKey !== input.sessionKey ||
      input.existingState.transcriptItemId !== input.transcriptItemId
    ) {
      throw new Error(
        `Live voiceprint queue state join mismatch: state=${input.existingState.sessionKey}/${input.existingState.transcriptItemId} candidate=${input.sessionKey}/${input.transcriptItemId}.`,
      );
    }
    return input.existingState;
  }

  return buildVoiceprintTranscriptIdentityState({
    sessionKey: input.sessionKey,
    transcriptItemId: input.transcriptItemId,
    createdAt: input.createdAt,
  });
}

function skippedQueueResult(input: {
  baseState: VoiceprintTranscriptIdentityState;
  reason: VoiceprintTranscriptIdentitySkipReason;
  updatedAt?: IsoTime;
  preparation?: LiveVoiceprintSkippedTurn;
}): LiveVoiceprintSkippedQueueTurn {
  const state =
    input.reason === "non_user_turn"
      ? markVoiceprintTranscriptStateNotApplicable({
          state: input.baseState,
          reason: input.reason,
          updatedAt: input.updatedAt,
        })
      : markVoiceprintTranscriptStateSkipped({
          state: input.baseState,
          reason: input.reason,
          updatedAt: input.updatedAt,
        });

  return {
    status: "skipped",
    reason: input.reason,
    baseState: input.baseState,
    state,
    preparation: input.preparation,
  };
}
