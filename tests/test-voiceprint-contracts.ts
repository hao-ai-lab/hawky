import { describe, expect, test } from "bun:test";
import { buildVoiceprintTurnRecords } from "../src/identity/voiceprint/index.js";

const turn = {
  sessionKey: "live:test",
  transcriptItemId: "rt_123",
  role: "user" as const,
  text: "remind me to buy milk",
  startMs: 1200,
  endMs: 3400,
  audioArtifactId: "audio_abc",
  route: "iphone_mic",
};

const model = {
  provider: "external-json" as const,
  modelId: "test-model",
};

const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("voiceprint turn contracts", () => {
  test("builds deterministic owner annotation records with policy gates", () => {
    const records = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.91,
        thresholdUsed: 0.82,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      createdAt: "2026-06-23T00:00:00.000Z",
      eventId: "event_1",
    });

    expect(records.speakerTurnTag.transcriptItemId).toBe("rt_123");
    expect(records.speakerTurnTag.result).toBe("owner_speaking");
    expect(records.identitySignal.subject).toEqual({ type: "owner" });
    expect(records.identitySignal.allowedUses.promoteMemory).toBe(true);
    expect(records.transcriptSpeakerAnnotation.allowedUses.actionProposal).toBe(true);
    expect(records.eventParticipation?.actor).toEqual({ type: "owner" });

    const again = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.91,
        thresholdUsed: 0.82,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      createdAt: "2026-06-23T00:00:00.000Z",
      eventId: "event_1",
    });
    expect(again.speakerTurnTag.id).toBe(records.speakerTurnTag.id);
    expect(again.identitySignal.id).toBe(records.identitySignal.id);
  });

  test("keeps template learning off unless explicitly reviewed", () => {
    const unreviewed = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.95,
        score: 0.95,
        thresholdUsed: 0.82,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true, templateLearningAllowed: true },
    });
    expect(unreviewed.transcriptSpeakerAnnotation.allowedUses.templateLearning).toBe(false);

    const reviewed = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.95,
        score: 0.95,
        thresholdUsed: 0.82,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true, templateLearningAllowed: true },
      templateLearningReviewed: true,
    });
    expect(reviewed.transcriptSpeakerAnnotation.allowedUses.templateLearning).toBe(true);
  });

  test("keeps possible owner out of event graph and memory/action", () => {
    const records = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "possible_owner",
        confidence: 0.76,
        thresholdUsed: 0.82,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      eventId: "event_1",
    });

    expect(records.transcriptSpeakerAnnotation.allowedUses.diagnostics).toBe(true);
    expect(records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(false);
    expect(records.transcriptSpeakerAnnotation.allowedUses.actionProposal).toBe(false);
    expect(records.eventParticipation).toBeUndefined();
  });

  test("keeps unknown cluster event graph gated by cluster review, not template review", () => {
    const templateReviewed = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "unknown_cluster",
        clusterId: "cluster_review_gate",
        confidence: 0.86,
        thresholdUsed: 0.72,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true, templateLearningAllowed: true },
      templateLearningReviewed: true,
      eventId: "event_unknown_cluster",
    });
    const clusterReviewed = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "unknown_cluster",
        clusterId: "cluster_review_gate",
        confidence: 0.86,
        thresholdUsed: 0.72,
        model,
      },
      consent: { ...processingConsent, memoryPromotionAllowed: true, templateLearningAllowed: true },
      clusterReviewed: true,
      eventId: "event_unknown_cluster",
    });

    expect(templateReviewed.speakerTurnTag.review.state).toBe("unreviewed");
    expect(templateReviewed.identitySignal.review.state).toBe("unreviewed");
    expect(templateReviewed.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(false);
    expect(templateReviewed.identitySignal.allowedUses.proposeRelationship).toBe(false);
    expect(templateReviewed.eventParticipation).toBeUndefined();

    expect(clusterReviewed.speakerTurnTag.review.state).toBe("confirmed");
    expect(clusterReviewed.identitySignal.review.state).toBe("confirmed");
    expect(clusterReviewed.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(true);
    expect(clusterReviewed.identitySignal.allowedUses.proposeRelationship).toBe(true);
    expect(clusterReviewed.eventParticipation?.actor).toEqual({
      type: "unknown_cluster",
      clusterId: "cluster_review_gate",
    });
    expect(clusterReviewed.eventParticipation?.review.state).toBe("confirmed");
  });

  test("does not emit records when capture or biometric consent is denied", () => {
    expect(() =>
      buildVoiceprintTurnRecords({
        turn,
        scoring: {
          result: "owner_speaking",
          confidence: 0.91,
          thresholdUsed: 0.82,
          model,
        },
        consent: { captureAllowed: false },
      }),
    ).toThrow(/consent does not allow capture\/biometric processing/);

    expect(() =>
      buildVoiceprintTurnRecords({
        turn,
        scoring: {
          result: "owner_speaking",
          confidence: 0.91,
          thresholdUsed: 0.82,
          model,
        },
        consent: { biometricAllowed: false },
      }),
    ).toThrow(/consent does not allow capture\/biometric processing/);
  });

  test("requires stable turn joins", () => {
    expect(() =>
      buildVoiceprintTurnRecords({
        turn: { ...turn, transcriptItemId: "" },
        scoring: {
          result: "owner_speaking",
          confidence: 0.91,
          thresholdUsed: 0.82,
          model,
        },
      }),
    ).toThrow(/transcriptItemId/);

    expect(() =>
      buildVoiceprintTurnRecords({
        turn: { ...turn, startMs: Number.NaN },
        scoring: {
          result: "owner_speaking",
          confidence: 0.91,
          thresholdUsed: 0.82,
          model,
        },
      }),
    ).toThrow(/finite startMs and endMs/);

    expect(() =>
      buildVoiceprintTurnRecords({
        turn: { ...turn, endMs: Number.POSITIVE_INFINITY },
        scoring: {
          result: "owner_speaking",
          confidence: 0.91,
          thresholdUsed: 0.82,
          model,
        },
      }),
    ).toThrow(/finite startMs and endMs/);
  });

  test("includes full model identity in record ids", () => {
    const base = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.91,
        thresholdUsed: 0.82,
        model: { provider: "custom", modelId: "shared-model", version: "1" },
      },
      consent: processingConsent,
    });
    const differentProvider = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.91,
        thresholdUsed: 0.82,
        model: { provider: "speechbrain", modelId: "shared-model", version: "1" },
      },
      consent: processingConsent,
    });
    const differentVersion = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.91,
        thresholdUsed: 0.82,
        model: { provider: "custom", modelId: "shared-model", version: "2" },
      },
      consent: processingConsent,
    });

    expect(differentProvider.speakerTurnTag.id).not.toBe(base.speakerTurnTag.id);
    expect(differentProvider.identitySignal.id).not.toBe(base.identitySignal.id);
    expect(differentVersion.speakerTurnTag.id).not.toBe(base.speakerTurnTag.id);
    expect(differentVersion.identitySignal.id).not.toBe(base.identitySignal.id);
  });

  test("includes unknown cluster id in record ids", () => {
    const clusterA = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "unknown_cluster",
        clusterId: "cluster_a",
        confidence: 0.86,
        thresholdUsed: 0.72,
        model,
      },
      consent: processingConsent,
    });
    const clusterB = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "unknown_cluster",
        clusterId: "cluster_b",
        confidence: 0.86,
        thresholdUsed: 0.72,
        model,
      },
      consent: processingConsent,
    });

    expect(clusterA.identitySignal.subject).toEqual({ type: "unknown_cluster", id: "cluster_a" });
    expect(clusterB.identitySignal.subject).toEqual({ type: "unknown_cluster", id: "cluster_b" });
    expect(clusterA.speakerTurnTag.id).not.toBe(clusterB.speakerTurnTag.id);
    expect(clusterA.identitySignal.id).not.toBe(clusterB.identitySignal.id);
    expect(clusterA.transcriptSpeakerAnnotation.identitySignalId).not.toBe(
      clusterB.transcriptSpeakerAnnotation.identitySignalId,
    );
  });

  test("requires a real cluster id for unknown cluster records", () => {
    expect(() =>
      buildVoiceprintTurnRecords({
        turn,
        scoring: {
          result: "unknown_cluster",
          confidence: 0.86,
          thresholdUsed: 0.72,
          model,
        },
        consent: processingConsent,
      }),
    ).toThrow(/requires clusterId/);

    expect(() =>
      buildVoiceprintTurnRecords({
        turn,
        scoring: {
          result: "unknown_cluster",
          clusterId: "   ",
          confidence: 0.86,
          thresholdUsed: 0.72,
          model,
        },
        consent: processingConsent,
      }),
    ).toThrow(/requires clusterId/);
  });
});
