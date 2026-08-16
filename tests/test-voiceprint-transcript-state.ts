import { describe, expect, test } from "bun:test";
import {
  applyVoiceprintSkippedScoringJob,
  applyVoiceprintTranscriptIdentityUpdate,
  buildLiveVoiceprintScoringJob,
  buildVoiceprintTranscriptIdentityState,
  buildVoiceprintTranscriptIdentityStatePatches,
  buildVoiceprintTranscriptIdentityUpdate,
  markVoiceprintTranscriptStateError,
  markVoiceprintTranscriptStateNotApplicable,
  markVoiceprintTranscriptStateScoring,
  markVoiceprintTranscriptStateSkipped,
  prepareLiveVoiceprintTurn,
  scoreLiveVoiceprintScoringJobResponse,
  type LiveVoiceprintReadyTurn,
  type LiveVoiceprintScoringJob,
  type LiveVoiceprintScoringJobResult,
  type LiveVoiceprintSkippedScoringJob,
  type VoiceprintTranscriptIdentityUpdate,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const createdAt = "2026-06-23T00:00:00.000Z";
const updatedAt = "2026-06-23T00:00:01.000Z";
const sidecarModel = { provider: "custom" as const, modelId: "state-sidecar", version: "1" };
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("voiceprint transcript identity state", () => {
  test("builds a pending state and marks the matching job as scoring", () => {
    const job = liveJob("rt_state_pending", "audio_state_pending");
    const state = buildVoiceprintTranscriptIdentityState({
      sessionKey: "live:voiceprint-state",
      transcriptItemId: "rt_state_pending",
      createdAt,
    });

    const scoring = markVoiceprintTranscriptStateScoring({
      state,
      job,
      updatedAt,
    });

    expect(state.lifecycle).toBe("pending");
    expect(state.policyState).toBe("diagnostics_only");
    expect(scoring.id).toBe(state.id);
    expect(scoring.lifecycle).toBe("scoring");
    expect(scoring.policyState).toBe("diagnostics_only");
    expect(scoring.jobId).toBe(job.id);
    expect(scoring.requestId).toBe(job.embeddingRequest.id);
    expect(scoring.updatedAt).toBe(updatedAt);
  });

  test("applies resolved owner updates as policy-allowed state", () => {
    const job = liveJob("rt_state_resolved", "audio_state_resolved");
    const state = markVoiceprintTranscriptStateScoring({
      state: buildState("rt_state_resolved"),
      job,
      updatedAt,
    });
    const update = transcriptUpdate(job, [1, 0]);

    const resolved = applyVoiceprintTranscriptIdentityUpdate({
      state,
      update,
      updatedAt: "2026-06-23T00:00:02.000Z",
    });

    expect(resolved.lifecycle).toBe("resolved");
    expect(resolved.policyState).toBe("policy_allowed_use");
    expect(resolved.result).toBe("owner_speaking");
    expect(resolved.jobId).toBe(job.id);
    expect(resolved.requestId).toBe(job.embeddingRequest.id);
    expect(update.requestId).toBe(job.embeddingRequest.id);
    expect(resolved.updateId).toBe(update.id);
    expect(resolved.speakerTurnTagId).toBe(update.transcriptSpeakerAnnotation.speakerTurnTagId);
    expect(resolved.identitySignalId).toBe(update.transcriptSpeakerAnnotation.identitySignalId);
    expect(resolved.thresholdUsed).toBe(0.82);
    expect(resolved.error).toBeUndefined();
    expect(resolved.skipReason).toBeUndefined();
  });

  test("keeps unknown speakers diagnostics-only", () => {
    const job = liveJob("rt_state_unknown", "audio_state_unknown");
    const update = transcriptUpdate(job, [0, 1]);

    const unknown = applyVoiceprintTranscriptIdentityUpdate({
      state: markVoiceprintTranscriptStateScoring({
        state: buildState("rt_state_unknown"),
        job,
      }),
      update,
    });

    expect(update.status).toBe("identity_unknown");
    expect(unknown.lifecycle).toBe("unknown");
    expect(unknown.policyState).toBe("diagnostics_only");
    expect(unknown.result).toBe("unknown_speaker");
    expect(unknown.thresholdUsed).toBe(0.72);
  });

  test("applies skipped jobs without retaining policy use", () => {
    const job = liveJob("rt_state_skipped", "audio_state_skipped");
    const skipped: LiveVoiceprintSkippedScoringJob = {
      status: "skipped",
      jobId: job.id,
      requestId: job.embeddingRequest.id,
      sessionKey: "live:voiceprint-state",
      transcriptItemId: "rt_state_skipped",
      reason: "consent_denied",
    };

    const state = applyVoiceprintSkippedScoringJob({
      state: buildState("rt_state_skipped"),
      skipped,
      updatedAt,
    });

    expect(state.lifecycle).toBe("skipped");
    expect(state.policyState).toBe("none");
    expect(state.jobId).toBe(job.id);
    expect(state.requestId).toBe(job.embeddingRequest.id);
    expect(state.skipReason).toBe("consent_denied");
    expect(state.updateId).toBeUndefined();
    expect(state.speakerTurnTagId).toBeUndefined();
    expect(state.identitySignalId).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.confidence).toBeUndefined();
    expect(state.thresholdUsed).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  test("clears stale identity fields when an existing resolved state is skipped", () => {
    const job = liveJob("rt_state_resolved_then_skipped", "audio_state_resolved_then_skipped");
    const resolved = applyVoiceprintTranscriptIdentityUpdate({
      state: buildState("rt_state_resolved_then_skipped"),
      update: transcriptUpdate(job, [1, 0]),
      updatedAt,
    });

    const state = markVoiceprintTranscriptStateSkipped({
      state: resolved,
      reason: "consent_denied",
      jobId: job.id,
      requestId: job.embeddingRequest.id,
      updatedAt: "2026-06-23T00:00:04.000Z",
    });

    expect(resolved.result).toBe("owner_speaking");
    expect(resolved.updateId).toBeTruthy();
    expect(state.lifecycle).toBe("skipped");
    expect(state.policyState).toBe("none");
    expect(state.jobId).toBe(job.id);
    expect(state.requestId).toBe(job.embeddingRequest.id);
    expect(state.updateId).toBeUndefined();
    expect(state.speakerTurnTagId).toBeUndefined();
    expect(state.identitySignalId).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.confidence).toBeUndefined();
    expect(state.thresholdUsed).toBeUndefined();
  });

  test("builds state patches from scored and skipped batch results", () => {
    const scoredJob = liveJob("rt_state_batch_scored", "audio_state_batch_scored");
    const skippedJob = liveJob("rt_state_batch_skipped", "audio_state_batch_skipped");
    const scoredResult = scoredJobResult(scoredJob, [1, 0]);
    const skipped = skippedJobResult(skippedJob);
    const existingScoring = markVoiceprintTranscriptStateScoring({
      state: buildState("rt_state_batch_scored"),
      job: scoredJob,
      updatedAt,
    });

    const patches = buildVoiceprintTranscriptIdentityStatePatches({
      batch: {
        status: "partial",
        request: null,
        results: [scoredResult],
        skipped: [skipped],
      },
      existingStates: [existingScoring],
      createdAt,
      updatedAt: "2026-06-23T00:00:03.000Z",
    });

    expect(patches).toHaveLength(2);
    const scoredPatch = patches[0];
    const skippedPatch = patches[1];
    if (!scoredPatch || scoredPatch.kind !== "scored") {
      throw new Error("expected scored patch");
    }
    if (!skippedPatch || skippedPatch.kind !== "skipped") {
      throw new Error("expected skipped patch");
    }
    expect(scoredPatch.state.lifecycle).toBe("resolved");
    expect(scoredPatch.state.policyState).toBe("policy_allowed_use");
    expect(scoredPatch.state.requestId).toBe(scoredJob.embeddingRequest.id);
    expect(scoredPatch.update.requestId).toBe(scoredJob.embeddingRequest.id);
    expect(scoredPatch.update.jobId).toBe(scoredJob.id);
    expect(skippedPatch.state.lifecycle).toBe("skipped");
    expect(skippedPatch.state.policyState).toBe("none");
    expect(skippedPatch.skipped).toEqual(skipped);
  });

  test("keeps request trace when batch patches create a fresh resolved state", () => {
    const scoredJob = liveJob("rt_state_batch_fresh", "audio_state_batch_fresh");
    const scoredResult = scoredJobResult(scoredJob, [1, 0]);

    const [patch] = buildVoiceprintTranscriptIdentityStatePatches({
      batch: {
        status: "scored",
        request: null,
        results: [scoredResult],
        skipped: [],
      },
      createdAt,
    });

    if (!patch || patch.kind !== "scored") {
      throw new Error("expected scored patch");
    }
    expect(patch.state.lifecycle).toBe("resolved");
    expect(patch.state.jobId).toBe(scoredJob.id);
    expect(patch.state.requestId).toBe(scoredJob.embeddingRequest.id);
    expect(patch.update.requestId).toBe(scoredJob.embeddingRequest.id);
  });

  test("rejects duplicate state patches for the same transcript item", () => {
    const job = liveJob("rt_state_duplicate_patch", "audio_state_duplicate_patch");
    const scoredResult = scoredJobResult(job, [1, 0]);
    const skipped = skippedJobResult(job);

    expect(() =>
      buildVoiceprintTranscriptIdentityStatePatches({
        batch: {
          status: "partial",
          request: null,
          results: [scoredResult],
          skipped: [skipped],
        },
        createdAt,
      }),
    ).toThrow(/Duplicate voiceprint transcript identity patch/);

    expect(() =>
      buildVoiceprintTranscriptIdentityStatePatches({
        batch: {
          status: "scored",
          request: null,
          results: [scoredResult],
          skipped: [],
        },
        existingStates: [
          buildState("rt_state_duplicate_patch"),
          buildState("rt_state_duplicate_patch"),
        ],
        createdAt,
      }),
    ).toThrow(/Duplicate voiceprint transcript identity state/);
  });

  test("rejects mismatched transcript joins", () => {
    const state = buildState("rt_state_a");
    const job = liveJob("rt_state_b", "audio_state_b");
    const update = transcriptUpdate(job, [1, 0]);
    const skipped: LiveVoiceprintSkippedScoringJob = {
      status: "skipped",
      jobId: job.id,
      requestId: job.embeddingRequest.id,
      sessionKey: "live:voiceprint-state",
      transcriptItemId: "rt_state_b",
      reason: "consent_denied",
    };

    expect(() => markVoiceprintTranscriptStateScoring({ state, job })).toThrow(/join mismatch/);
    expect(() => applyVoiceprintTranscriptIdentityUpdate({ state, update })).toThrow(/join mismatch/);
    expect(() => applyVoiceprintSkippedScoringJob({ state, skipped })).toThrow(/join mismatch/);
  });

  test("rejects stale updates after a transcript item is requeued", () => {
    const originalJob = liveJob("rt_state_requeued", "audio_state_requeued_old");
    const retryJob = liveJob("rt_state_requeued", "audio_state_requeued_new");
    const retryState = markVoiceprintTranscriptStateScoring({
      state: markVoiceprintTranscriptStateScoring({
        state: buildState("rt_state_requeued"),
        job: originalJob,
      }),
      job: retryJob,
      updatedAt,
    });

    const staleUpdate = transcriptUpdate(originalJob, [1, 0]);
    const staleSkipped = skippedJobResult(originalJob);

    expect(retryJob.id).not.toBe(originalJob.id);
    expect(retryJob.embeddingRequest.id).not.toBe(originalJob.embeddingRequest.id);
    expect(() =>
      applyVoiceprintTranscriptIdentityUpdate({
        state: retryState,
        update: staleUpdate,
      }),
    ).toThrow(/Stale voiceprint transcript identity update.*current job/);
    expect(() =>
      applyVoiceprintSkippedScoringJob({
        state: retryState,
        skipped: staleSkipped,
      }),
    ).toThrow(/Stale voiceprint transcript identity update.*current job/);
  });

  test("rejects stale updates after a transcript item is requeued with a different route", () => {
    const originalJob = liveJob("rt_state_route_changed", "audio_state_route_changed", "iphone_mic");
    const routeChangedJob = liveJob("rt_state_route_changed", "audio_state_route_changed", "speaker");
    const routeChangedState = markVoiceprintTranscriptStateScoring({
      state: markVoiceprintTranscriptStateScoring({
        state: buildState("rt_state_route_changed"),
        job: originalJob,
      }),
      job: routeChangedJob,
      updatedAt,
    });
    const staleUpdate = transcriptUpdate(originalJob, [1, 0]);

    expect(routeChangedJob.id).not.toBe(originalJob.id);
    expect(routeChangedJob.embeddingRequest.id).not.toBe(originalJob.embeddingRequest.id);
    expect(() =>
      applyVoiceprintTranscriptIdentityUpdate({
        state: routeChangedState,
        update: staleUpdate,
      }),
    ).toThrow(/Stale voiceprint transcript identity update.*current job/);
  });

  test("rejects stale sidecar replies after a transcript item leaves scoring", () => {
    const job = liveJob("rt_state_revoked", "audio_state_revoked");
    const scoring = markVoiceprintTranscriptStateScoring({
      state: buildState("rt_state_revoked"),
      job,
      updatedAt,
    });
    const staleUpdate = transcriptUpdate(job, [1, 0]);
    const staleSkipped = skippedJobResult(job);
    const terminalStates = [
      markVoiceprintTranscriptStateSkipped({
        state: scoring,
        reason: "consent_denied",
        updatedAt: "2026-06-23T00:00:02.000Z",
      }),
      markVoiceprintTranscriptStateNotApplicable({
        state: scoring,
        reason: "non_user_turn",
        updatedAt: "2026-06-23T00:00:02.000Z",
      }),
      markVoiceprintTranscriptStateError({
        state: scoring,
        code: "sidecar_failed",
        message: "cancelled after consent revoked",
        updatedAt: "2026-06-23T00:00:02.000Z",
      }),
    ];

    for (const state of terminalStates) {
      expect(() =>
        applyVoiceprintTranscriptIdentityUpdate({
          state,
          update: staleUpdate,
        }),
      ).toThrow(/Stale voiceprint transcript identity update.*current state/);
      expect(() =>
        applyVoiceprintSkippedScoringJob({
          state,
          skipped: staleSkipped,
        }),
      ).toThrow(/Stale voiceprint transcript identity update.*current state/);
    }
  });

  test("can ignore stale batch replies after a transcript item leaves scoring", () => {
    const job = liveJob("rt_state_ignore_after_skip", "audio_state_ignore_after_skip");
    const skippedState = markVoiceprintTranscriptStateSkipped({
      state: markVoiceprintTranscriptStateScoring({
        state: buildState("rt_state_ignore_after_skip"),
        job,
        updatedAt,
      }),
      reason: "consent_denied",
      updatedAt: "2026-06-23T00:00:02.000Z",
    });
    const staleScoredResult = scoredJobResult(job, [1, 0]);
    const staleSkipped = skippedJobResult(job);

    const scoredPatches = buildVoiceprintTranscriptIdentityStatePatches({
      batch: {
        status: "scored",
        request: null,
        results: [staleScoredResult],
        skipped: [],
      },
      existingStates: [skippedState],
      staleUpdateHandling: "ignore",
      createdAt,
    });
    const skippedPatches = buildVoiceprintTranscriptIdentityStatePatches({
      batch: {
        status: "skipped",
        request: null,
        results: [],
        skipped: [staleSkipped],
      },
      existingStates: [skippedState],
      staleUpdateHandling: "ignore",
      createdAt,
    });

    expect(scoredPatches).toEqual([]);
    expect(skippedPatches).toEqual([]);
  });

  test("allows fresh states without current job refs to accept first updates", () => {
    const job = liveJob("rt_state_fresh_first_update", "audio_state_fresh_first_update");
    const update = transcriptUpdate(job, [1, 0]);

    const state = applyVoiceprintTranscriptIdentityUpdate({
      state: buildState("rt_state_fresh_first_update"),
      update,
      updatedAt,
    });

    expect(state.lifecycle).toBe("resolved");
    expect(state.jobId).toBe(job.id);
    expect(state.requestId).toBe(job.embeddingRequest.id);
  });

  test("can ignore stale batch updates after a transcript item is requeued", () => {
    const originalJob = liveJob("rt_state_ignore_stale", "audio_state_ignore_stale_old");
    const retryJob = liveJob("rt_state_ignore_stale", "audio_state_ignore_stale_new");
    const retryState = markVoiceprintTranscriptStateScoring({
      state: markVoiceprintTranscriptStateScoring({
        state: buildState("rt_state_ignore_stale"),
        job: originalJob,
      }),
      job: retryJob,
      updatedAt,
    });

    const staleScoredResult = scoredJobResult(originalJob, [1, 0]);
    const staleSkipped = skippedJobResult(originalJob);

    const scoredPatches = buildVoiceprintTranscriptIdentityStatePatches({
      batch: {
        status: "scored",
        request: null,
        results: [staleScoredResult],
        skipped: [],
      },
      existingStates: [retryState],
      staleUpdateHandling: "ignore",
      createdAt,
    });
    const skippedPatches = buildVoiceprintTranscriptIdentityStatePatches({
      batch: {
        status: "skipped",
        request: null,
        results: [],
        skipped: [staleSkipped],
      },
      existingStates: [retryState],
      staleUpdateHandling: "ignore",
      createdAt,
    });

    expect(scoredPatches).toEqual([]);
    expect(skippedPatches).toEqual([]);
  });

  test("does not ignore non-stale batch data errors", () => {
    const job = liveJob("rt_state_ignore_only_stale", "audio_state_ignore_only_stale");
    const update = scoredJobResult(job, [1, 0]);
    const duplicateState = buildState("rt_state_ignore_only_stale");

    expect(() =>
      buildVoiceprintTranscriptIdentityStatePatches({
        batch: {
          status: "scored",
          request: null,
          results: [update],
          skipped: [],
        },
        existingStates: [duplicateState, duplicateState],
        staleUpdateHandling: "ignore",
        createdAt,
      }),
    ).toThrow(/Duplicate voiceprint transcript identity state/);
  });

  test("marks error state with existing job context", () => {
    const job = liveJob("rt_state_error", "audio_state_error");
    const scoring = markVoiceprintTranscriptStateScoring({
      state: buildState("rt_state_error"),
      job,
    });

    const errored = markVoiceprintTranscriptStateError({
      state: scoring,
      code: "sidecar_failed",
      message: "sidecar exited before returning an embedding",
      updatedAt,
    });

    expect(errored.lifecycle).toBe("error");
    expect(errored.policyState).toBe("none");
    expect(errored.jobId).toBe(job.id);
    expect(errored.requestId).toBe(job.embeddingRequest.id);
    expect(errored.error).toEqual({
      code: "sidecar_failed",
      message: "sidecar exited before returning an embedding",
    });
    expect(() =>
      markVoiceprintTranscriptStateError({
        state: scoring,
        message: " ",
      }),
    ).toThrow(/requires message/);
  });
});

function buildState(transcriptItemId: string) {
  return buildVoiceprintTranscriptIdentityState({
    sessionKey: "live:voiceprint-state",
    transcriptItemId,
    createdAt,
  });
}

function liveJob(
  transcriptItemId: string,
  audioArtifactId: string,
  route: "iphone_mic" | "speaker" = "iphone_mic",
): LiveVoiceprintScoringJob {
  return buildLiveVoiceprintScoringJob({
    prepared: readyTurn(transcriptItemId, audioArtifactId, route),
    audioPath: `/tmp/${audioArtifactId}.wav`,
    ownerTemplateRef: "owner-template:v1",
    createdAt,
  });
}

function transcriptUpdate(
  job: LiveVoiceprintScoringJob,
  embedding: number[],
): VoiceprintTranscriptIdentityUpdate {
  const result = scoredJobResult(job, embedding);

  return buildVoiceprintTranscriptIdentityUpdate({
    result,
    createdAt,
  });
}

function scoredJobResult(
  job: LiveVoiceprintScoringJob,
  embedding: number[],
): LiveVoiceprintScoringJobResult {
  return scoreLiveVoiceprintScoringJobResponse({
    job,
    response: {
      id: job.embeddingRequest.id,
      embedding,
      model: sidecarModel,
    },
    expectedModel: sidecarModel,
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    consent: { ...processingConsent, memoryPromotionAllowed: true },
    eventId: `event:${job.prepared.turn.transcriptItemId}`,
    createdAt,
  });
}

function skippedJobResult(job: LiveVoiceprintScoringJob): LiveVoiceprintSkippedScoringJob {
  return {
    status: "skipped",
    jobId: job.id,
    requestId: job.embeddingRequest.id,
    sessionKey: job.prepared.turn.sessionKey,
    transcriptItemId: job.prepared.turn.transcriptItemId,
    reason: "consent_denied",
  };
}

function readyTurn(
  transcriptItemId: string,
  audioArtifactId: string,
  route: "iphone_mic" | "speaker" = "iphone_mic",
): LiveVoiceprintReadyTurn {
  const prepared = prepareLiveVoiceprintTurn({
    sessionKey: "live:voiceprint-state",
    transcriptItemId,
    role: "user",
    text: "this is the owner speaking",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId,
    route,
    samples: sineWave(1500, 0.1),
    sampleRate,
  });
  if (prepared.status !== "ready") {
    throw new Error("expected ready voiceprint turn");
  }
  return prepared;
}

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
