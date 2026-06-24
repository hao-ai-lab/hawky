import { describe, expect, test } from "bun:test";
import {
  applyVoiceprintTranscriptIdentityUpdate,
  buildVoiceprintTranscriptIdentityState,
  buildVoiceprintTranscriptIdentityUpdate,
  queueLiveVoiceprintTurn,
  scoreLiveVoiceprintScoringJobResponse,
  type LiveVoiceprintQueueResult,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const createdAt = "2026-06-23T00:00:00.000Z";
const updatedAt = "2026-06-23T00:00:01.000Z";
const sidecarModel = { provider: "custom" as const, modelId: "queue-sidecar", version: "1" };
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("live voiceprint queue", () => {
  test("queues accepted user turns with pending and scoring states", () => {
    const queued = queueLiveVoiceprintTurn({
      ...candidate("rt_queue_ready", "audio_queue_ready"),
      audioPath: "/tmp/audio_queue_ready.wav",
      ownerTemplateRef: "owner-template:v1",
      consent: processingConsent,
      createdAt,
      updatedAt,
    });

    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued voiceprint turn");
    }
    expect(queued.baseState.lifecycle).toBe("pending");
    expect(queued.state.lifecycle).toBe("scoring");
    expect(queued.state.policyState).toBe("diagnostics_only");
    expect(queued.state.jobId).toBe(queued.job.id);
    expect(queued.state.requestId).toBe(queued.job.embeddingRequest.id);
    expect(queued.job.embeddingRequest.audioPath).toBe("/tmp/audio_queue_ready.wav");
    expect(queued.job.embeddingRequest.startMs).toBe(1000);
    expect(queued.job.embeddingRequest.endMs).toBe(2500);
    expect(queued.job.ownerTemplateRef).toBe("owner-template:v1");
  });

  test("defaults sidecar request bounds to the prepared turn window", () => {
    const queued = queueLiveVoiceprintTurn({
      ...candidate("rt_queue_window", "audio_queue_window"),
      startMs: 1250,
      endMs: 2800,
      audioPath: "/tmp/session_audio_queue_window.wav",
      consent: processingConsent,
      createdAt,
      updatedAt,
    });

    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued voiceprint turn");
    }
    expect(queued.job.embeddingRequest.audioPath).toBe("/tmp/session_audio_queue_window.wav");
    expect(queued.job.embeddingRequest.startMs).toBe(1250);
    expect(queued.job.embeddingRequest.endMs).toBe(2800);
  });

  test("preserves explicit sidecar request bounds when provided", () => {
    const queued = queueLiveVoiceprintTurn({
      ...candidate("rt_queue_window_override", "audio_queue_window_override"),
      startMs: 1250,
      endMs: 2800,
      audioPath: "/tmp/session_audio_queue_window_override.wav",
      requestStartMs: 1300,
      requestEndMs: 2700,
      consent: processingConsent,
      createdAt,
      updatedAt,
    });

    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued voiceprint turn");
    }
    expect(queued.job.embeddingRequest.startMs).toBe(1300);
    expect(queued.job.embeddingRequest.endMs).toBe(2700);
  });

  test("skips denied consent before audio quality work", () => {
    const skipped = queueLiveVoiceprintTurn({
      sessionKey: "live:voiceprint-queue",
      transcriptItemId: "rt_queue_denied",
      role: "user",
      startMs: 1000,
      endMs: 2500,
      audioArtifactId: "audio_queue_denied",
      audioPath: "/tmp/audio_queue_denied.wav",
      consent: { biometricAllowed: false },
      createdAt,
      updatedAt,
    });

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("consent_denied");
    expect(skipped.state.lifecycle).toBe("skipped");
    expect(skipped.state.policyState).toBe("none");
    expect(skipped.state.jobId).toBeUndefined();
    expect(skipped.state.requestId).toBeUndefined();
  });

  test("marks assistant turns as not applicable without requiring local audio", () => {
    const skipped = queueLiveVoiceprintTurn({
      sessionKey: "live:voiceprint-queue",
      transcriptItemId: "rt_queue_assistant",
      role: "assistant",
      startMs: 1000,
      endMs: 2500,
      audioArtifactId: "audio_queue_assistant",
      audioPath: "/tmp/audio_queue_assistant.wav",
      createdAt,
      updatedAt,
    });

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("non_user_turn");
    expect(skipped.state.lifecycle).toBe("not_applicable");
    expect(skipped.state.policyState).toBe("none");
    expect(skipped.state.skipReason).toBe("non_user_turn");
  });

  test("skips rejected audio quality before building sidecar jobs", () => {
    const skipped = queueLiveVoiceprintTurn({
      ...candidate("rt_queue_quiet", "audio_queue_quiet", 0.001),
      audioPath: "/tmp/audio_queue_quiet.wav",
      consent: processingConsent,
      createdAt,
      updatedAt,
    });

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("quality_rejected");
    expect(skipped.state.lifecycle).toBe("skipped");
    expect(skipped.state.jobId).toBeUndefined();
    expect(skipped.state.requestId).toBeUndefined();
    expect(skipped.preparation?.quality?.status).toBe("rejected");
  });

  test("skips missing audio artifacts before requiring audio samples", () => {
    const skipped = queueLiveVoiceprintTurn({
      sessionKey: "live:voiceprint-queue",
      transcriptItemId: "rt_queue_missing_audio_no_samples",
      role: "user",
      text: "this is the owner speaking",
      startMs: 1000,
      endMs: 2500,
      audioArtifactId: "audio_queue_missing_audio_no_samples",
      route: "iphone_mic",
      consent: processingConsent,
      createdAt,
      updatedAt,
    });

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("missing_audio_artifact");
    expect(skipped.state.lifecycle).toBe("skipped");
    expect(skipped.state.policyState).toBe("none");
    expect(skipped.state.jobId).toBeUndefined();
    expect(skipped.state.requestId).toBeUndefined();
    expect(skipped.preparation).toBeUndefined();
  });

  test("skips missing audio artifacts and clears stale identity state", () => {
    const ready = queueLiveVoiceprintTurn({
      ...candidate("rt_queue_missing_audio", "audio_queue_missing_audio"),
      audioPath: "/tmp/audio_queue_missing_audio.wav",
      consent: processingConsent,
      createdAt,
      updatedAt,
    });
    if (ready.status !== "queued") {
      throw new Error("expected queued voiceprint turn");
    }
    const resolvedState = resolveQueuedState(ready);

    const skipped = queueLiveVoiceprintTurn({
      ...candidate("rt_queue_missing_audio", "audio_queue_missing_audio"),
      existingState: resolvedState,
      consent: processingConsent,
      createdAt,
      updatedAt: "2026-06-23T00:00:02.000Z",
    });

    expect(resolvedState.result).toBe("owner_speaking");
    expect(resolvedState.jobId).toBe(ready.job.id);
    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("missing_audio_artifact");
    expect(skipped.state.lifecycle).toBe("skipped");
    expect(skipped.state.jobId).toBeUndefined();
    expect(skipped.state.requestId).toBeUndefined();
    expect(skipped.state.updateId).toBeUndefined();
    expect(skipped.state.result).toBeUndefined();
    expect(skipped.state.confidence).toBeUndefined();
    expect(skipped.state.thresholdUsed).toBeUndefined();
  });

  test("rejects existing states with a different transcript join", () => {
    const existingState = buildVoiceprintTranscriptIdentityState({
      sessionKey: "live:voiceprint-queue",
      transcriptItemId: "rt_queue_other",
      createdAt,
    });

    expect(() =>
      queueLiveVoiceprintTurn({
        ...candidate("rt_queue_mismatch", "audio_queue_mismatch"),
        audioPath: "/tmp/audio_queue_mismatch.wav",
        existingState,
        consent: processingConsent,
      }),
    ).toThrow(/join mismatch/);
  });
});

function resolveQueuedState(
  queued: Extract<LiveVoiceprintQueueResult, { status: "queued" }>,
) {
  const scored = scoreLiveVoiceprintScoringJobResponse({
    job: queued.job,
    response: {
      id: queued.job.embeddingRequest.id,
      embedding: [1, 0],
      model: sidecarModel,
    },
    expectedModel: sidecarModel,
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    consent: { ...processingConsent, memoryPromotionAllowed: true },
    eventId: `event:${queued.job.prepared.turn.transcriptItemId}`,
    createdAt,
  });
  const update = buildVoiceprintTranscriptIdentityUpdate({
    result: scored,
    createdAt,
  });
  return applyVoiceprintTranscriptIdentityUpdate({
    state: queued.state,
    update,
    updatedAt,
  });
}

function candidate(
  transcriptItemId: string,
  audioArtifactId: string,
  amplitude = 0.1,
) {
  return {
    sessionKey: "live:voiceprint-queue",
    transcriptItemId,
    role: "user" as const,
    text: "this is the owner speaking",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId,
    route: "iphone_mic" as const,
    samples: sineWave(1500, amplitude),
    sampleRate,
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
