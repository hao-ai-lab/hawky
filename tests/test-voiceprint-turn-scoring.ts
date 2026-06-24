import { describe, expect, test } from "bun:test";
import {
  assessVoiceprintAudioQuality,
  confidenceFromCosineSimilarity,
  scoreVoiceprintTurnFromEmbedding,
} from "../src/identity/voiceprint/index.js";

const turn = {
  sessionKey: "live:test",
  transcriptItemId: "rt_456",
  role: "user" as const,
  text: "please remind me later",
  startMs: 1000,
  endMs: 2600,
  audioArtifactId: "audio_xyz",
};

const model = {
  provider: "external-json" as const,
  modelId: "test-embedding-model",
};

const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("voiceprint turn scorer", () => {
  test("scores owner-like embedding and emits policy-allowed records", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: [[1, 0], [0.98, 0.02]],
      sampleEmbedding: [0.99, 0.01],
      model,
      thresholds: { ownerAccept: 0.82, ownerPossible: 0.72 },
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      eventId: "event_1",
      createdAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.decision).toBe("owner_speaking");
    expect(result.similarity).toBeGreaterThan(0.99);
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(true);
    expect(result.records.eventParticipation?.actor).toEqual({ type: "owner" });
  });

  test("keeps similar-but-under-accept sample diagnostic-only", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: [[1, 0]],
      sampleEmbedding: [0.75, 0.66],
      model,
      thresholds: { ownerAccept: 0.9, ownerPossible: 0.72 },
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      eventId: "event_1",
    });

    expect(result.decision).toBe("possible_owner");
    expect(result.thresholdUsed).toBe(0.72);
    expect(result.records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(false);
    expect(result.records.eventParticipation).toBeUndefined();
  });

  test("stores possible threshold for unknown speaker decisions", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: [[1, 0]],
      sampleEmbedding: [0, 1],
      model,
      thresholds: { ownerAccept: 0.82, ownerPossible: 0.72 },
      consent: processingConsent,
    });

    expect(result.decision).toBe("unknown_speaker");
    expect(result.thresholdUsed).toBe(0.72);
    expect(result.records.speakerTurnTag.thresholdUsed).toBe(0.72);
    expect(result.records.transcriptSpeakerAnnotation.thresholdUsed).toBe(0.72);
  });

  test("invalid embeddings fail before records are created", () => {
    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[0, 0]],
        sampleEmbedding: [0, 0],
        model,
        consent: { biometricAllowed: false },
      }),
    ).toThrow(/consent does not allow capture\/biometric processing/);

    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [0, 0],
        model,
        consent: { ...processingConsent, memoryPromotionAllowed: true },
      }),
    ).toThrow(/sample embedding/);

    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[0, 0]],
        sampleEmbedding: [1, 0],
        model,
        consent: processingConsent,
      }),
    ).toThrow(/owner embedding/);

    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[1, 0, 0]],
        sampleEmbedding: [1, 0],
        model,
        consent: processingConsent,
      }),
    ).toThrow(/sample embedding.*dimension 2.*expected 3/);

    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[1, 0], [-1, 0]],
        sampleEmbedding: [0, 1],
        model,
        consent: processingConsent,
      }),
    ).toThrow(/zero norm/);
  });

  test("rejected audio quality fails before records are created", () => {
    const rejectedQuality = assessVoiceprintAudioQuality(new Float32Array(16000), 16000);

    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [1, 0],
        model,
        quality: rejectedQuality,
        consent: processingConsent,
      }),
    ).toThrow(/quality does not allow scoring/);
  });

  test("rejects unsafe threshold overrides before classifying", () => {
    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [0, 1],
        model,
        thresholds: { ownerAccept: -1, ownerPossible: -1 },
        consent: { ...processingConsent, memoryPromotionAllowed: true },
      }),
    ).toThrow(/ownerAccept/);

    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [1, 0],
        model,
        thresholds: { ownerAccept: 0.7, ownerPossible: 0.8 },
        consent: processingConsent,
      }),
    ).toThrow(/ownerAccept >= ownerPossible/);
  });

  test("maps cosine similarity into bounded confidence", () => {
    expect(confidenceFromCosineSimilarity(-1)).toBe(0);
    expect(confidenceFromCosineSimilarity(0)).toBe(0.5);
    expect(confidenceFromCosineSimilarity(1)).toBe(1);
    expect(confidenceFromCosineSimilarity(Number.NaN)).toBe(0);
  });
});
