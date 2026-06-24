import { describe, expect, test } from "bun:test";
import {
  buildLiveVoiceprintScoringBatchRequest,
  buildLiveVoiceprintScoringJob,
  prepareLiveVoiceprintTurn,
  scoreLiveVoiceprintScoringJobResponse,
  type LiveVoiceprintReadyTurn,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("live voiceprint sidecar jobs", () => {
  test("builds deterministic queued jobs and embedding batch requests", () => {
    const prepared = readyTurn();
    const job = buildLiveVoiceprintScoringJob({
      prepared,
      audioPath: "/tmp/live-turn.wav",
      targetSampleRate: 16000,
      ownerTemplateRef: "owner-template:v1",
      createdAt: "2026-06-23T00:00:00.000Z",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });
    const again = buildLiveVoiceprintScoringJob({
      prepared,
      audioPath: "/tmp/live-turn.wav",
      targetSampleRate: 16000,
      ownerTemplateRef: "owner-template:v1",
      createdAt: "2026-06-23T00:00:00.000Z",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });

    expect(job.version).toBe(1);
    expect(job.status).toBe("queued");
    expect(job.id).toBe(again.id);
    expect(job.embeddingRequest.id).toBe(`${job.id}_embedding`);
    expect(job.embeddingRequest.audioPath).toBe("/tmp/live-turn.wav");
    expect(job.embeddingRequest.route).toBe("iphone_mic");
    expect(job.attempts).toEqual({ current: 0, max: 2 });

    const batch = buildLiveVoiceprintScoringBatchRequest([job]);
    expect(batch.requests).toEqual([job.embeddingRequest]);
    expect(() => buildLiveVoiceprintScoringBatchRequest([job, again])).toThrow(/Duplicate/);

    const sliced = buildLiveVoiceprintScoringJob({
      prepared,
      audioPath: "/tmp/live-turn.wav",
      requestStartMs: 100,
      requestEndMs: 900,
      targetSampleRate: 8000,
      ownerTemplateRef: "owner-template:v1",
      createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(sliced.id).not.toBe(job.id);
    expect(sliced.embeddingRequest.id).not.toBe(job.embeddingRequest.id);
    expect(buildLiveVoiceprintScoringBatchRequest([job, sliced]).requests).toHaveLength(2);

    const routeChanged = buildLiveVoiceprintScoringJob({
      prepared: readyTurn("speaker"),
      audioPath: "/tmp/live-turn.wav",
      targetSampleRate: 16000,
      ownerTemplateRef: "owner-template:v1",
      createdAt: "2026-06-23T00:00:00.000Z",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });
    expect(routeChanged.embeddingRequest.route).toBe("speaker");
    expect(routeChanged.id).not.toBe(job.id);
    expect(routeChanged.embeddingRequest.id).not.toBe(job.embeddingRequest.id);
    expect(buildLiveVoiceprintScoringBatchRequest([job, routeChanged]).requests).toHaveLength(2);
  });

  test("scores a matching sidecar response through the live scoring flow", () => {
    const prepared = readyTurn();
    const job = buildLiveVoiceprintScoringJob({
      prepared,
      audioPath: "/tmp/live-turn.wav",
    });

    const result = scoreLiveVoiceprintScoringJobResponse({
      job,
      response: {
        id: job.embeddingRequest.id,
        embedding: [1, 0],
        model: { provider: "custom", modelId: "live-sidecar", version: "1" },
      },
      expectedModel: { provider: "custom", modelId: "live-sidecar", version: "1" },
      ownerEmbeddings: [[1, 0], [0.98, 0.02]],
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      eventId: "event_live_1",
      createdAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("scored");
    expect(result.jobId).toBe(job.id);
    expect(result.requestId).toBe(job.embeddingRequest.id);
    expect(result.result.score.decision).toBe("owner_speaking");
    expect(result.result.score.records.transcriptSpeakerAnnotation.transcriptItemId).toBe("rt_live_job");
    expect(result.result.score.records.eventParticipation?.actor).toEqual({ type: "owner" });
    expect(result.response.model.version).toBe("1");
  });

  test("rejects mismatched sidecar responses and unsafe job options", () => {
    const prepared = readyTurn();
    const job = buildLiveVoiceprintScoringJob({
      prepared,
      audioPath: "/tmp/live-turn.wav",
    });

    expect(() =>
      scoreLiveVoiceprintScoringJobResponse({
        job,
        response: {
          id: "different_request",
          embedding: [1, 0],
          model: { provider: "custom", modelId: "live-sidecar" },
        },
        ownerEmbeddings: [[1, 0]],
      }),
    ).toThrow(/does not match job request id/);

    expect(() =>
      scoreLiveVoiceprintScoringJobResponse({
        job,
        response: {
          id: job.embeddingRequest.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "live-sidecar", version: "2" },
        },
        expectedModel: { provider: "custom", modelId: "live-sidecar", version: "1" },
        ownerEmbeddings: [[1, 0]],
      }),
    ).toThrow(/does not match expected/);

    expect(() =>
      buildLiveVoiceprintScoringJob({
        prepared,
        audioPath: "/tmp/live-turn.wav",
        attempt: 1,
      }),
    ).toThrow(/attempt must be less than maxAttempts/);

    expect(() =>
      buildLiveVoiceprintScoringJob({
        prepared: {
          ...prepared,
          turn: { ...prepared.turn, startMs: Number.NaN },
        },
        audioPath: "/tmp/live-turn.wav",
      }),
    ).toThrow(/finite startMs and endMs/);
  });
});

function readyTurn(route: "iphone_mic" | "speaker" = "iphone_mic"): LiveVoiceprintReadyTurn {
  const prepared = prepareLiveVoiceprintTurn({
    sessionKey: "live:voiceprint-job",
    transcriptItemId: "rt_live_job",
    role: "user",
    text: "remember this came from the owner",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId: "audio_live_job",
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
