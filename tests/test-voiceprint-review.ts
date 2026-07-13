import { describe, expect, test } from "bun:test";
import {
  applyVoiceprintReviewDecision,
  assessVoiceprintAudioQuality,
  buildVoiceprintTurnRecords,
} from "../src/identity/voiceprint/index.js";

const reviewedAt = "2026-06-23T00:05:00.000Z";
const sampleRate = 16000;
const turn = {
  sessionKey: "live:test-review",
  transcriptItemId: "rt_review_1",
  role: "user" as const,
  text: "this came from an unknown recurring voice",
  startMs: 1200,
  endMs: 3400,
  audioArtifactId: "audio_review_abc",
  route: "iphone_mic",
};
const model = {
  provider: "custom" as const,
  modelId: "review-model",
  version: "1",
};
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
  memoryPromotionAllowed: true,
  templateLearningAllowed: true,
};

describe("voiceprint review decisions", () => {
  test("confirms an unknown cluster and creates reviewed event participation", () => {
    const records = unknownClusterRecords();

    const patch = applyVoiceprintReviewDecision({
      records,
      decision: "confirm_cluster",
      eventId: "event_review_1",
      claim: "unknown recurring voice participated",
      reviewedAt,
    });

    expect(records.identitySignal.review.state).toBe("unreviewed");
    expect(records.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(false);
    expect(records.eventParticipation).toBeUndefined();
    expect(patch.version).toBe(1);
    expect(patch.decision).toBe("confirm_cluster");
    expect(patch.records.speakerTurnTag.review).toEqual({
      state: "confirmed",
      reviewedAt,
    });
    expect(patch.records.identitySignal.review).toEqual({
      state: "confirmed",
      reviewedAt,
    });
    expect(patch.records.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(true);
    expect(patch.records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(false);
    expect(patch.records.identitySignal.allowedUses.proposeRelationship).toBe(true);
    expect(patch.records.eventParticipation?.actor).toEqual({
      type: "unknown_cluster",
      clusterId: "cluster_review_1",
    });
    expect(patch.records.eventParticipation?.claim).toBe("unknown recurring voice participated");
    expect(patch.records.eventParticipation?.review).toEqual({
      state: "confirmed",
      reviewedAt,
    });
    expect(patch.records.eventParticipation?.allowedUses).toEqual({
      memoryPromotion: false,
      actionProposal: false,
      contextExport: false,
    });
  });

  test("preserves quality event graph gates when confirming an unknown cluster", () => {
    const quality = assessVoiceprintAudioQuality(sineWave(900, 0.1), sampleRate);
    const records = buildVoiceprintTurnRecords({
      turn: {
        ...turn,
        transcriptItemId: "rt_review_marginal_quality",
        startMs: 0,
        endMs: 900,
        audioArtifactId: "audio_review_marginal_quality",
      },
      scoring: {
        result: "unknown_cluster",
        clusterId: "cluster_review_marginal_quality",
        confidence: 0.87,
        thresholdUsed: 0.72,
        model,
        quality,
      },
      consent: processingConsent,
      eventId: "event_review_quality",
    });

    const patch = applyVoiceprintReviewDecision({
      records,
      decision: "confirm_cluster",
      eventId: "event_review_quality",
      reviewedAt,
    });

    expect(quality.status).toBe("marginal");
    expect(records.identitySignal.metadata.quality?.allowedUses.eventGraph).toBe(false);
    expect(records.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(false);
    expect(patch.records.transcriptSpeakerAnnotation.allowedUses.eventGraph).toBe(false);
    expect(patch.records.identitySignal.allowedUses.proposeRelationship).toBe(false);
    expect(patch.records.eventParticipation).toBeUndefined();
  });

  test("suppresses a reviewed identity signal and clears dependent event participation", () => {
    const records = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "unknown_cluster",
        clusterId: "cluster_review_2",
        confidence: 0.87,
        thresholdUsed: 0.72,
        model,
      },
      consent: processingConsent,
      clusterReviewed: true,
      eventId: "event_review_2",
    });

    const patch = applyVoiceprintReviewDecision({
      records,
      decision: "suppress_identity",
      reason: "background media",
      reviewedAt,
    });

    expect(records.eventParticipation).toBeTruthy();
    expect(patch.reason).toBe("background media");
    expect(patch.deletedEventParticipationId).toBe(records.eventParticipation?.id);
    expect(patch.records.speakerTurnTag.review.state).toBe("suppressed");
    expect(patch.records.identitySignal.review.state).toBe("suppressed");
    expect(patch.records.identitySignal.allowedUses).toEqual({
      tagSession: false,
      promoteMemory: false,
      proposeRelationship: false,
      exportContext: false,
      triggerAction: false,
    });
    expect(
      Object.values(patch.records.transcriptSpeakerAnnotation.allowedUses).every(
        (value) => value === false,
      ),
    ).toBe(true);
    expect(patch.records.eventParticipation).toBeUndefined();
  });

  test("rejects a false owner match without keeping memory or action permissions", () => {
    const records = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.94,
        score: 0.94,
        thresholdUsed: 0.82,
        model,
      },
      consent: processingConsent,
      templateLearningReviewed: true,
      eventId: "event_review_3",
    });

    const patch = applyVoiceprintReviewDecision({
      records,
      decision: "reject_identity",
      reason: "false owner match",
      reviewedAt,
    });

    expect(records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(true);
    expect(records.eventParticipation?.actor).toEqual({ type: "owner" });
    expect(patch.deletedEventParticipationId).toBe(records.eventParticipation?.id);
    expect(patch.records.speakerTurnTag.review.state).toBe("rejected");
    expect(patch.records.identitySignal.review.state).toBe("rejected");
    expect(patch.records.transcriptSpeakerAnnotation.allowedUses.diagnostics).toBe(true);
    expect(patch.records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(false);
    expect(patch.records.transcriptSpeakerAnnotation.allowedUses.actionProposal).toBe(false);
    expect(patch.records.identitySignal.allowedUses.triggerAction).toBe(false);
    expect(patch.records.eventParticipation).toBeUndefined();
  });

  test("does not confirm owner records as unknown clusters", () => {
    const ownerRecords = buildVoiceprintTurnRecords({
      turn,
      scoring: {
        result: "owner_speaking",
        confidence: 0.94,
        thresholdUsed: 0.82,
        model,
      },
      consent: processingConsent,
    });

    expect(() =>
      applyVoiceprintReviewDecision({
        records: ownerRecords,
        decision: "confirm_cluster",
        eventId: "event_review_4",
      }),
    ).toThrow(/unknown_cluster record/);
  });
});

function unknownClusterRecords() {
  return buildVoiceprintTurnRecords({
    turn,
    scoring: {
      result: "unknown_cluster",
      clusterId: "cluster_review_1",
      confidence: 0.87,
      thresholdUsed: 0.72,
      model,
    },
    consent: processingConsent,
    eventId: "event_review_1",
  });
}

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
