import { describe, expect, test } from "bun:test";
import {
  prepareLiveVoiceprintTurn,
  processLiveVoiceprintTurn,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const model = {
  provider: "external-json" as const,
  modelId: "test-live-embedding-model",
};

const baseCandidate = {
  sessionKey: "live:voiceprint",
  transcriptItemId: "rt_live_1",
  role: "user" as const,
  text: "please remember that I parked near the north gate",
  startMs: 1000,
  endMs: 2500,
  audioArtifactId: "audio_live_1",
  route: "iphone_mic",
};

const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("live voiceprint adapter", () => {
  test("scores accepted live user turns and preserves stable joins", () => {
    const result = processLiveVoiceprintTurn({
      ...baseCandidate,
      samples: sineWave(1500, 0.1),
      sampleRate,
      ownerEmbeddings: [[1, 0], [0.98, 0.02]],
      sampleEmbedding: [1, 0],
      model,
      consent: { ...processingConsent, memoryPromotionAllowed: true, templateLearningAllowed: true },
      templateLearningReviewed: true,
      eventId: "event_live_1",
      createdAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("scored");
    if (result.status !== "scored") {
      throw new Error("expected scored result");
    }
    expect(result.turn.transcriptItemId).toBe("rt_live_1");
    expect(result.score.decision).toBe("owner_speaking");
    expect(result.quality.status).toBe("accepted");
    expect(result.score.records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(true);
    expect(result.score.records.transcriptSpeakerAnnotation.allowedUses.templateLearning).toBe(true);
    expect(result.score.records.eventParticipation?.actor).toEqual({ type: "owner" });
    expect(result.score.records.identitySignal.metadata.quality?.status).toBe("accepted");
  });

  test("scores marginal live turns but keeps identity influence diagnostic-only", () => {
    const result = processLiveVoiceprintTurn({
      ...baseCandidate,
      transcriptItemId: "rt_live_short",
      endMs: 1900,
      audioArtifactId: "audio_live_short",
      samples: sineWave(900, 0.1),
      sampleRate,
      ownerEmbeddings: [[1, 0]],
      sampleEmbedding: [1, 0],
      model,
      consent: { ...processingConsent, memoryPromotionAllowed: true, templateLearningAllowed: true },
      templateLearningReviewed: true,
      eventId: "event_live_short",
    });

    expect(result.status).toBe("scored");
    if (result.status !== "scored") {
      throw new Error("expected scored result");
    }
    expect(result.quality.status).toBe("marginal");
    expect(result.score.decision).toBe("owner_speaking");
    expect(result.score.records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(false);
    expect(result.score.records.transcriptSpeakerAnnotation.allowedUses.actionProposal).toBe(false);
    expect(result.score.records.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(false);
    expect(result.score.records.transcriptSpeakerAnnotation.allowedUses.templateLearning).toBe(false);
    expect(result.score.records.eventParticipation).toBeUndefined();
  });

  test("skips rejected quality before scoring", () => {
    const result = processLiveVoiceprintTurn({
      ...baseCandidate,
      transcriptItemId: "rt_live_quiet",
      audioArtifactId: "audio_live_quiet",
      samples: sineWave(1500, 0.001),
      sampleRate,
      ownerEmbeddings: [[1, 0]],
      sampleEmbedding: [1, 0],
      model,
      consent: processingConsent,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("quality_rejected");
    expect(result.quality?.status).toBe("rejected");
  });

  test("skips denied consent before preparing live audio quality", () => {
    const result = processLiveVoiceprintTurn({
      ...baseCandidate,
      transcriptItemId: "rt_live_denied",
      audioArtifactId: "audio_live_denied",
      samples: new Float32Array([Number.NaN]),
      sampleRate,
      ownerEmbeddings: [[0, 0]],
      sampleEmbedding: [0, 0],
      model,
      consent: { captureAllowed: false },
    });

    expect(result).toEqual({ status: "skipped", reason: "consent_denied" });
  });

  test("skips assistant turns without requiring local audio evidence", () => {
    const result = prepareLiveVoiceprintTurn({
      ...baseCandidate,
      role: "assistant",
      transcriptItemId: "rt_assistant",
      audioArtifactId: "assistant_audio",
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("non_user_turn");
  });

  test("rejects unsafe live threshold overrides", () => {
    expect(() =>
      processLiveVoiceprintTurn({
        ...baseCandidate,
        transcriptItemId: "rt_live_bad_threshold",
        audioArtifactId: "audio_live_bad_threshold",
        samples: sineWave(1500, 0.1),
        sampleRate,
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [0, 1],
        model,
        thresholds: { ownerAccept: -1, ownerPossible: -1 },
        consent: { ...processingConsent, memoryPromotionAllowed: true },
      }),
    ).toThrow(/ownerAccept/);
  });
});

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
