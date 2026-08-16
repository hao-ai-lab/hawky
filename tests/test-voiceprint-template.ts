import { describe, expect, test } from "bun:test";
import {
  assessVoiceprintEnrollment,
  buildVoiceprintTemplateArtifact,
  ownerEmbeddingsFromVoiceprintTemplateArtifact,
  tombstoneVoiceprintTemplate,
  validateVoiceprintTemplateArtifact,
} from "../src/identity/voiceprint/index.js";

const createdAt = "2026-06-24T00:00:00.000Z";
const model = {
  provider: "custom" as const,
  modelId: "template-test-model",
  version: "1",
};
const storage = {
  templateUri: "local-voiceprint://owner/template-1.enc",
  encrypted: true as const,
  localOnly: true as const,
  keyRef: "voiceprint-owner-template-key",
};

describe("voiceprint template enrollment", () => {
  test("builds deterministic local-only owner template artifacts", () => {
    const artifact = buildVoiceprintTemplateArtifact({
      model,
      sources: [
        {
          artifactId: "enroll_audio_1",
          embedding: [1, 0],
          speechMs: 1400,
          route: "iphone_mic",
          qualityStatus: "accepted",
        },
        {
          artifactId: "enroll_audio_2",
          embedding: [0.8, 0.2],
          startMs: 0,
          endMs: 1200,
          route: "iphone_mic",
          qualityStatus: "accepted",
        },
      ],
      storage,
      createdAt,
      minSpeechMs: 2000,
    });
    const again = buildVoiceprintTemplateArtifact({
      model,
      sources: [
        {
          artifactId: "enroll_audio_1",
          embedding: [1, 0],
          speechMs: 1400,
          route: "iphone_mic",
          qualityStatus: "accepted",
        },
        {
          artifactId: "enroll_audio_2",
          embedding: [0.8, 0.2],
          startMs: 0,
          endMs: 1200,
          route: "iphone_mic",
          qualityStatus: "accepted",
        },
      ],
      storage,
      createdAt,
      minSpeechMs: 2000,
    });

    expect(artifact.template.id).toBe(again.template.id);
    expect(artifact.template.subject).toEqual({ type: "owner" });
    expect(artifact.template.embeddingDim).toBe(2);
    expect(artifact.template.enrollment).toMatchObject({
      sourceArtifactIds: ["enroll_audio_1", "enroll_audio_2"],
      speechMs: 2600,
      quality: "good",
      sourceCount: 2,
      route: "iphone_mic",
    });
    expect(artifact.template.storage).toEqual(storage);
    expect(artifact.centroid).toEqual([0.9, 0.1]);
    expect(ownerEmbeddingsFromVoiceprintTemplateArtifact(artifact)).toEqual([[0.9, 0.1]]);
    expect(JSON.stringify(artifact.template)).not.toContain("0.9");
    validateVoiceprintTemplateArtifact(artifact);
  });

  test("assesses rejected enrollment without producing a template", () => {
    const assessment = assessVoiceprintEnrollment({
      sources: [
        {
          artifactId: "short_enrollment",
          embedding: [1, 0],
          speechMs: 500,
          qualityStatus: "accepted",
        },
      ],
      minSpeechMs: 1000,
    });

    expect(assessment).toMatchObject({
      status: "rejected",
      reasons: ["not_enough_speech"],
      speechMs: 500,
      sourceCount: 1,
      quality: "rejected",
    });
    expect(() =>
      buildVoiceprintTemplateArtifact({
        model,
        sources: [
          {
            artifactId: "short_enrollment",
            embedding: [1, 0],
            speechMs: 500,
            qualityStatus: "accepted",
          },
        ],
        storage,
        minSpeechMs: 1000,
      }),
    ).toThrow(/rejected enrollment.*not_enough_speech/);
  });

  test("rejects malformed enrollment vectors and duplicate artifacts", () => {
    expect(() =>
      buildVoiceprintTemplateArtifact({
        model,
        sources: [
          { artifactId: "bad_vector", embedding: [0, 0], speechMs: 1200 },
        ],
        storage,
        minSpeechMs: 1000,
      }),
    ).toThrow(/unusable embedding/);

    expect(() =>
      buildVoiceprintTemplateArtifact({
        model,
        sources: [
          { artifactId: "dup", embedding: [1, 0], speechMs: 1200 },
          { artifactId: "dup", embedding: [0, 1], speechMs: 1200 },
        ],
        storage,
        minSpeechMs: 1000,
      }),
    ).toThrow(/Duplicate voiceprint enrollment artifact id/);
  });

  test("deleted owner templates no longer provide scorer embeddings", () => {
    const artifact = buildVoiceprintTemplateArtifact({
      model,
      sources: [
        { artifactId: "owner_enroll", embedding: [1, 0], speechMs: 1200 },
      ],
      storage,
      createdAt,
      minSpeechMs: 1000,
    });
    const deleted = tombstoneVoiceprintTemplate(
      artifact.template,
      "2026-06-24T00:01:00.000Z",
    );

    expect(deleted.deletedAt).toBe("2026-06-24T00:01:00.000Z");
    expect(() =>
      ownerEmbeddingsFromVoiceprintTemplateArtifact({
        ...artifact,
        template: deleted,
      }),
    ).toThrow(/deleted/);
  });
});
