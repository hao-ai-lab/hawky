import { describe, expect, test } from "bun:test";
import {
  applyLiveVoiceprintScoringPlanPatches,
  applyVoiceprintStorageBundle,
  buildLiveVoiceprintScoringPlan,
  buildLiveVoiceprintScoringPlanPatches,
  buildVoiceprintStorageBundle,
  emptyVoiceprintStorageSnapshot,
  scoreLiveVoiceprintScoringBatchResponse,
  type LiveVoiceprintPlanItemInput,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const createdAt = "2026-06-23T00:00:00.000Z";
const updatedAt = "2026-06-23T00:00:01.000Z";
const sidecarModel = { provider: "custom" as const, modelId: "persistence-sidecar", version: "1" };
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
  memoryPromotionAllowed: true,
};

describe("voiceprint persistence bundle", () => {
  test("builds storage-ready records from scored and skipped live plan output", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_scored", "audio_persist_scored", {
          audioPath: "/tmp/audio_persist_scored.wav",
          consent: processingConsent,
        }),
        turn("rt_persist_skipped", "audio_persist_skipped", {
          audioPath: "/tmp/audio_persist_skipped.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
      ],
    });
    const batch = scoreBatch(plan.jobContexts, [1, 0]);
    const patches = buildLiveVoiceprintScoringPlanPatches({
      plan,
      batch,
      createdAt,
      updatedAt,
    });
    const states = applyLiveVoiceprintScoringPlanPatches({ plan, patches });

    const bundle = buildVoiceprintStorageBundle({
      states,
      patches,
      createdAt,
    });
    const snapshot = applyVoiceprintStorageBundle({
      snapshot: emptyVoiceprintStorageSnapshot(),
      bundle,
    });

    expect(bundle.version).toBe(1);
    expect(bundle.source).toBe("voiceprint");
    expect(bundle.sessionKey).toBe("live:voiceprint-persistence");
    expect(bundle.transcriptIdentityStates.map((state) => state.lifecycle)).toEqual([
      "resolved",
      "skipped",
    ]);
    expect(bundle.speakerTurnTags).toHaveLength(1);
    expect(bundle.identitySignals).toHaveLength(1);
    expect(bundle.transcriptSpeakerAnnotations).toHaveLength(1);
    expect(bundle.eventParticipations).toHaveLength(1);
    expect(bundle.clearTranscriptIdentity).toEqual([
      {
        sessionKey: "live:voiceprint-persistence",
        transcriptItemId: "rt_persist_skipped",
      },
    ]);
    expect(snapshot.transcriptIdentityStates).toHaveLength(2);
    expect(snapshot.transcriptSpeakerAnnotations[0]?.transcriptItemId).toBe("rt_persist_scored");
    expect(snapshot.eventParticipations[0]?.supportingSignalIds).toEqual([
      snapshot.identitySignals[0]?.id,
    ]);
  });

  test("clears stale current identity records when a later plan skips the transcript", () => {
    const scoredPlan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_clear", "audio_persist_clear", {
          audioPath: "/tmp/audio_persist_clear.wav",
          consent: processingConsent,
        }),
      ],
    });
    const scoredBatch = scoreBatch(scoredPlan.jobContexts, [1, 0]);
    const scoredPatches = buildLiveVoiceprintScoringPlanPatches({
      plan: scoredPlan,
      batch: scoredBatch,
      createdAt,
      updatedAt,
    });
    const scoredStates = applyLiveVoiceprintScoringPlanPatches({
      plan: scoredPlan,
      patches: scoredPatches,
    });
    const scoredSnapshot = applyVoiceprintStorageBundle({
      snapshot: emptyVoiceprintStorageSnapshot(),
      bundle: buildVoiceprintStorageBundle({
        states: scoredStates,
        patches: scoredPatches,
        createdAt,
      }),
    });

    const skippedPlan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_clear", "audio_persist_clear_retry", {
          audioPath: "/tmp/audio_persist_clear_retry.wav",
          amplitude: 0.001,
          consent: processingConsent,
          existingState: scoredSnapshot.transcriptIdentityStates[0],
        }),
      ],
    });
    const skippedBundle = buildVoiceprintStorageBundle({
      states: skippedPlan.states,
      createdAt: "2026-06-23T00:00:02.000Z",
    });
    const clearedSnapshot = applyVoiceprintStorageBundle({
      snapshot: scoredSnapshot,
      bundle: skippedBundle,
    });

    expect(scoredSnapshot.transcriptSpeakerAnnotations).toHaveLength(1);
    expect(scoredSnapshot.speakerTurnTags).toHaveLength(1);
    expect(scoredSnapshot.identitySignals).toHaveLength(1);
    expect(scoredSnapshot.eventParticipations).toHaveLength(1);
    expect(skippedBundle.clearTranscriptIdentity).toEqual([
      {
        sessionKey: "live:voiceprint-persistence",
        transcriptItemId: "rt_persist_clear",
      },
    ]);
    expect(clearedSnapshot.transcriptIdentityStates[0]?.lifecycle).toBe("skipped");
    expect(clearedSnapshot.transcriptIdentityStates[0]?.skipReason).toBe("quality_rejected");
    expect(clearedSnapshot.transcriptSpeakerAnnotations).toEqual([]);
    expect(clearedSnapshot.speakerTurnTags).toEqual([]);
    expect(clearedSnapshot.identitySignals).toEqual([]);
    expect(clearedSnapshot.eventParticipations).toEqual([]);
  });

  test("replaces old identity records when a transcript item is rescored", () => {
    const firstPlan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_rescore", "audio_persist_rescore_old", {
          audioPath: "/tmp/audio_persist_rescore_old.wav",
          consent: processingConsent,
        }),
      ],
    });
    const firstBatch = scoreBatch(firstPlan.jobContexts, [1, 0]);
    const firstPatches = buildLiveVoiceprintScoringPlanPatches({
      plan: firstPlan,
      batch: firstBatch,
      createdAt,
      updatedAt,
    });
    const firstStates = applyLiveVoiceprintScoringPlanPatches({
      plan: firstPlan,
      patches: firstPatches,
    });
    const firstSnapshot = applyVoiceprintStorageBundle({
      snapshot: emptyVoiceprintStorageSnapshot(),
      bundle: buildVoiceprintStorageBundle({
        states: firstStates,
        patches: firstPatches,
        createdAt,
      }),
    });
    const oldTagId = firstSnapshot.speakerTurnTags[0]?.id;
    const oldSignalId = firstSnapshot.identitySignals[0]?.id;
    const oldEventId = firstSnapshot.eventParticipations[0]?.id;

    const retryPlan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_rescore", "audio_persist_rescore_new", {
          audioPath: "/tmp/audio_persist_rescore_new.wav",
          consent: processingConsent,
          existingState: firstSnapshot.transcriptIdentityStates[0],
        }),
      ],
    });
    const retryBatch = scoreBatch(retryPlan.jobContexts, [1, 0]);
    const retryPatches = buildLiveVoiceprintScoringPlanPatches({
      plan: retryPlan,
      batch: retryBatch,
      createdAt: "2026-06-23T00:00:02.000Z",
      updatedAt: "2026-06-23T00:00:03.000Z",
    });
    const retryStates = applyLiveVoiceprintScoringPlanPatches({
      plan: retryPlan,
      patches: retryPatches,
    });
    const rescoredSnapshot = applyVoiceprintStorageBundle({
      snapshot: firstSnapshot,
      bundle: buildVoiceprintStorageBundle({
        states: retryStates,
        patches: retryPatches,
        createdAt: "2026-06-23T00:00:03.000Z",
      }),
    });

    expect(oldTagId).toBeTruthy();
    expect(oldSignalId).toBeTruthy();
    expect(oldEventId).toBeTruthy();
    expect(rescoredSnapshot.transcriptSpeakerAnnotations).toHaveLength(1);
    expect(rescoredSnapshot.speakerTurnTags).toHaveLength(1);
    expect(rescoredSnapshot.identitySignals).toHaveLength(1);
    expect(rescoredSnapshot.eventParticipations).toHaveLength(1);
    expect(rescoredSnapshot.speakerTurnTags[0]?.audioArtifactId).toBe(
      "audio_persist_rescore_new",
    );
    expect(rescoredSnapshot.speakerTurnTags[0]?.id).not.toBe(oldTagId);
    expect(rescoredSnapshot.identitySignals[0]?.id).not.toBe(oldSignalId);
    expect(rescoredSnapshot.eventParticipations[0]?.id).not.toBe(oldEventId);
    expect(
      rescoredSnapshot.transcriptSpeakerAnnotations[0]?.speakerTurnTagId,
    ).toBe(rescoredSnapshot.speakerTurnTags[0]?.id);
    expect(
      rescoredSnapshot.eventParticipations[0]?.supportingSignalIds,
    ).toEqual([rescoredSnapshot.identitySignals[0]?.id]);
  });

  test("rejects mixed-session storage bundles", () => {
    const first = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_mixed_a", "audio_persist_mixed_a", {
          audioPath: "/tmp/audio_persist_mixed_a.wav",
          consent: processingConsent,
        }),
      ],
    });
    const second = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_mixed_b", "audio_persist_mixed_b", {
          sessionKey: "live:voiceprint-other-session",
          audioPath: "/tmp/audio_persist_mixed_b.wav",
          consent: processingConsent,
        }),
      ],
    });

    expect(() =>
      buildVoiceprintStorageBundle({
        states: [...first.states, ...second.states],
        createdAt,
      }),
    ).toThrow(/cannot mix session keys/);
  });

  test("rejects resolved states without matching scored records", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_persist_dangling", "audio_persist_dangling", {
          audioPath: "/tmp/audio_persist_dangling.wav",
          consent: processingConsent,
        }),
      ],
    });
    const batch = scoreBatch(plan.jobContexts, [1, 0]);
    const patches = buildLiveVoiceprintScoringPlanPatches({
      plan,
      batch,
      createdAt,
      updatedAt,
    });
    const states = applyLiveVoiceprintScoringPlanPatches({ plan, patches });

    expect(() =>
      buildVoiceprintStorageBundle({
        states,
        createdAt,
      }),
    ).toThrow(/no matching annotation/);
  });

  test("rejects orphan biometric records before storing bundles", () => {
    const bundle = scoredStorageBundle("rt_persist_orphan", "audio_persist_orphan");
    const orphanTag = {
      ...bundle.speakerTurnTags[0]!,
      id: "vp_orphan_tag",
    };
    const orphanSignal = {
      ...bundle.identitySignals[0]!,
      id: "vp_orphan_signal",
    };
    const orphanEvent = {
      ...bundle.eventParticipations[0]!,
      id: "vp_orphan_event",
      supportingSignalIds: [orphanSignal.id],
    };

    expect(() =>
      applyVoiceprintStorageBundle({
        snapshot: emptyVoiceprintStorageSnapshot(),
        bundle: {
          ...bundle,
          speakerTurnTags: [...bundle.speakerTurnTags, orphanTag],
        },
      }),
    ).toThrow(/orphan speaker tag/);
    expect(() =>
      applyVoiceprintStorageBundle({
        snapshot: emptyVoiceprintStorageSnapshot(),
        bundle: {
          ...bundle,
          identitySignals: [...bundle.identitySignals, orphanSignal],
        },
      }),
    ).toThrow(/orphan identity signal/);
    expect(() =>
      applyVoiceprintStorageBundle({
        snapshot: emptyVoiceprintStorageSnapshot(),
        bundle: {
          ...bundle,
          identitySignals: [...bundle.identitySignals, orphanSignal],
          eventParticipations: [...bundle.eventParticipations, orphanEvent],
        },
      }),
    ).toThrow(/unowned identity signal/);
  });
});

function scoreBatch(
  contexts: ReturnType<typeof buildLiveVoiceprintScoringPlan>["jobContexts"],
  embedding: number[],
) {
  return scoreLiveVoiceprintScoringBatchResponse({
    jobs: contexts,
    response: {
      version: 1,
      responses: contexts.map((context) => ({
        id: context.job.embeddingRequest.id,
        embedding,
        model: sidecarModel,
      })),
    },
  });
}

function scoredStorageBundle(transcriptItemId: string, audioArtifactId: string) {
  const plan = buildLiveVoiceprintScoringPlan({
    turns: [
      turn(transcriptItemId, audioArtifactId, {
        audioPath: `/tmp/${audioArtifactId}.wav`,
        consent: processingConsent,
      }),
    ],
  });
  const batch = scoreBatch(plan.jobContexts, [1, 0]);
  const patches = buildLiveVoiceprintScoringPlanPatches({
    plan,
    batch,
    createdAt,
    updatedAt,
  });
  const states = applyLiveVoiceprintScoringPlanPatches({ plan, patches });
  return buildVoiceprintStorageBundle({
    states,
    patches,
    createdAt,
  });
}

function turn(
  transcriptItemId: string,
  audioArtifactId: string,
  options: Partial<LiveVoiceprintPlanItemInput> & {
    audioPath?: string;
    amplitude?: number;
  } = {},
): LiveVoiceprintPlanItemInput {
  const amplitude = options.amplitude ?? 0.1;
  return {
    sessionKey: "live:voiceprint-persistence",
    transcriptItemId,
    role: "user",
    text: "this is the owner speaking",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId,
    route: "iphone_mic",
    samples: sineWave(1500, amplitude),
    sampleRate,
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    expectedModel: sidecarModel,
    eventId: `event:${transcriptItemId}`,
    createdAt,
    ...options,
  };
}

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
