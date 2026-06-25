import { describe, expect, test } from "bun:test";
import {
  allowedUsesForIdentitySignal,
  assertIdentitySignalAllowedUsesSafe,
  assertIdentitySignalBase,
  buildIdentitySignalBase,
  identitySignalBaseSchema,
  identitySignalCanExportContext,
  identitySignalCanInfluenceMemory,
  identitySignalCanTriggerAction,
  intersectIdentityAllowedUses,
  makeIdentityAllowedUses,
  NO_IDENTITY_ALLOWED_USES,
} from "../src/identity/core/index.js";

const createdAt = "2026-06-26T00:00:00.000Z";

describe("identity core contracts", () => {
  test("builds a first-class owner identity signal with evidence and allowed uses", () => {
    const allowedUses = allowedUsesForIdentitySignal({
      subject: { type: "owner" },
      reviewState: "confirmed",
      confidence: 0.94,
      consent: {
        memoryPromotionAllowed: true,
        actionProposalAllowed: true,
        templateLearningAllowed: true,
      },
    });
    const signal = buildIdentitySignalBase({
      id: "idsig_owner_1",
      createdAt,
      signalType: "owner_speaking",
      source: "voiceprint",
      modality: "voice",
      subject: { type: "owner" },
      evidenceRefs: [
        {
          type: "audio",
          artifactId: "audio_1",
          transcriptItemId: "rt_1",
          transcriptRange: { startMs: 100, endMs: 900 },
        },
      ],
      confidence: 0.94,
      thresholdUsed: 0.9,
      sensitivity: "biometric",
      retention: "session",
      review: { state: "confirmed" },
      allowedUses,
      metadata: { source: "voiceprint", model: "fixture" },
    });

    expect(signal.schemaVersion).toBe(1);
    expect(signal.allowedUses.tagSession).toBe(true);
    expect(identitySignalCanInfluenceMemory(signal)).toBe(true);
    expect(identitySignalCanTriggerAction(signal)).toBe(true);
    expect(() => assertIdentitySignalAllowedUsesSafe(signal)).not.toThrow();
  });

  test("blocks unreviewed non-owner candidate signals from memory, action, export, and profile promotion", () => {
    const allowedUses = allowedUsesForIdentitySignal({
      subject: { type: "person_candidate", candidateId: "cand_1" },
      reviewState: "unreviewed",
      confidence: 0.88,
      consent: {
        memoryPromotionAllowed: true,
        actionProposalAllowed: true,
        contextExportAllowed: true,
        relationshipProposalAllowed: true,
        profilePromotionAllowed: true,
      },
    });

    expect(allowedUses.diagnostics).toBe(true);
    expect(allowedUses.promoteMemory).toBe(false);
    expect(allowedUses.triggerAction).toBe(false);
    expect(allowedUses.exportContext).toBe(false);
    expect(allowedUses.profilePromotion).toBe(false);

    // The unsafe allowedUses combination is now rejected AT CONSTRUCTION:
    // buildIdentitySignalBase enforces the policy invariant, so an unreviewed
    // candidate carrying promoteMemory can never be built.
    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_unsafe_candidate",
        createdAt,
        signalType: "face_match",
        source: "face",
        modality: "face",
        subject: { type: "person_candidate", candidateId: "cand_1" },
        sourceSession: { sessionKey: "realtime:candidate" },
        confidence: 0.88,
        sensitivity: "biometric",
        review: { state: "unreviewed" },
        allowedUses: { promoteMemory: true },
        metadata: { source: "face" },
      }),
    ).toThrow(/Only confirmed owner or person/);
  });

  test("lets confirmed candidates promote profiles without memory, action, or export rights", () => {
    const subject = { type: "person_candidate", candidateId: "cand_reviewed" } as const;
    const allowedUses = allowedUsesForIdentitySignal({
      subject,
      reviewState: "confirmed",
      confidence: 0.92,
      consent: {
        memoryPromotionAllowed: true,
        actionProposalAllowed: true,
        contextExportAllowed: true,
        relationshipProposalAllowed: true,
        profilePromotionAllowed: true,
      },
    });

    expect(allowedUses.profilePromotion).toBe(true);
    expect(allowedUses.proposeRelationship).toBe(true);
    expect(allowedUses.promoteMemory).toBe(false);
    expect(allowedUses.triggerAction).toBe(false);
    expect(allowedUses.exportContext).toBe(false);

    const signal = buildIdentitySignalBase({
      id: "idsig_reviewed_candidate",
      createdAt,
      signalType: "face_candidate_review",
      source: "face",
      modality: "face",
      subject,
      evidenceRefs: [{ type: "frame", frameId: "frame_reviewed" }],
      confidence: 0.92,
      sensitivity: "biometric",
      review: { state: "confirmed" },
      allowedUses,
      metadata: { source: "face" },
    });
    expect(() => assertIdentitySignalAllowedUsesSafe(signal)).not.toThrow();

    // Even a CONFIRMED candidate cannot carry promoteMemory — only confirmed
    // owner/person may. The build now rejects it (invariant enforced at construction).
    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_reviewed_candidate_unsafe",
        createdAt,
        signalType: "face_candidate_review",
        source: "face",
        modality: "face",
        subject,
        evidenceRefs: [{ type: "frame", frameId: "frame_reviewed" }],
        confidence: 0.92,
        sensitivity: "biometric",
        review: { state: "confirmed" },
        allowedUses: { ...allowedUses, promoteMemory: true },
        metadata: { source: "face" },
      }),
    ).toThrow(/Only confirmed owner or person/);
  });

  test("lets confirmed person signals export context only when policy allows it", () => {
    const allowedUses = allowedUsesForIdentitySignal({
      subject: { type: "person", personId: "person_sarah" },
      reviewState: "confirmed",
      confidence: 0.91,
      consent: {
        memoryPromotionAllowed: true,
        contextExportAllowed: true,
      },
    });
    const signal = buildIdentitySignalBase({
      id: "idsig_person_sarah",
      createdAt,
      signalType: "manual_introduction",
      source: "manual_introduction",
      modality: "manual",
      subject: { type: "person", personId: "person_sarah" },
      evidenceRefs: [{ type: "transcript", transcriptItemId: "rt_intro", artifactId: "session_jsonl" }],
      confidence: 0.91,
      sensitivity: "private",
      review: { state: "confirmed" },
      allowedUses,
      metadata: { source: "manual_introduction" },
    });

    expect(identitySignalCanInfluenceMemory(signal)).toBe(true);
    expect(identitySignalCanExportContext(signal)).toBe(true);
    expect(signal.allowedUses.triggerAction).toBe(false);
    expect(() => assertIdentitySignalAllowedUsesSafe(signal)).not.toThrow();
  });

  test("requires either evidence refs or source session", () => {
    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_no_evidence",
        createdAt,
        signalType: "face_match",
        source: "face",
        modality: "face",
        subject: { type: "unknown_person", modality: "face" },
        confidence: 0.5,
        sensitivity: "biometric",
        metadata: {},
      }),
    ).toThrow(/evidenceRefs or sourceSession/);

    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_empty_evidence",
        createdAt,
        signalType: "face_match",
        source: "face",
        modality: "face",
        subject: { type: "unknown_person", modality: "face" },
        evidenceRefs: [{}],
        confidence: 0.5,
        sensitivity: "biometric",
        metadata: {},
      }),
    ).toThrow(/inspectable source pointer/);

    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_range_without_source",
        createdAt,
        signalType: "face_match",
        source: "face",
        modality: "face",
        subject: { type: "unknown_person", modality: "face" },
        evidenceRefs: [{ type: "image", imageRegion: { x: 0, y: 0, width: 10, height: 10 } }],
        confidence: 0.5,
        sensitivity: "biometric",
        metadata: {},
      }),
    ).toThrow(/inspectable source pointer/);

    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_session_evidence",
        createdAt,
        signalType: "manual_review",
        source: "manual_introduction",
        modality: "manual",
        subject: { type: "person_candidate", candidateId: "cand_session" },
        evidenceRefs: [{ type: "manual", sourceSession: { sessionKey: "realtime:session" } }],
        confidence: 0.8,
        sensitivity: "private",
        metadata: {},
      }),
    ).not.toThrow();
  });

  test("round-trips a voiceprint-like signal without losing source-specific fields", () => {
    const signal = buildIdentitySignalBase({
      id: "idsig_voiceprint_roundtrip",
      createdAt,
      updatedAt: "2026-06-26T00:00:01.000Z",
      signalType: "non_owner_voice_cluster",
      source: "voiceprint",
      modality: "voice",
      subject: { type: "unknown_cluster", id: "cluster_1", modality: "voice" },
      evidenceRefs: [
        {
          artifactId: "audio_roundtrip",
          transcriptItemId: "rt_roundtrip",
          transcriptRange: { startMs: 0, endMs: 1200 },
          excerptHash: "abc123",
        },
      ],
      confidence: 0.86,
      thresholdUsed: 0.72,
      sensitivity: "biometric",
      consent: {
        captureAllowed: true,
        biometricAllowed: true,
        memoryPromotionAllowed: false,
      },
      storage: {
        encrypted: true,
        localOnly: true,
        templateUri: "voiceprint://template/cluster_1",
        keyRef: "local-key",
      },
      retention: "rolling_7d",
      review: { state: "unreviewed" },
      allowedUses: allowedUsesForIdentitySignal({
        subject: { type: "unknown_cluster", id: "cluster_1", modality: "voice" },
        confidence: 0.86,
      }),
      metadata: {
        source: "voiceprint",
        model: { provider: "custom", modelId: "fixture-model" },
        route: "iphone_mic",
        transcriptItemId: "rt_roundtrip",
        score: 0.86,
      },
    });

    const parsed = JSON.parse(JSON.stringify(signal));
    assertIdentitySignalBase(parsed);
    expect(parsed).toEqual(signal);
    expect(parsed.metadata.model.modelId).toBe("fixture-model");
    expect(parsed.storage.templateUri).toBe("voiceprint://template/cluster_1");
  });

  test("intersects allowed uses for quality or consent gates", () => {
    const base = makeIdentityAllowedUses({
      diagnostics: true,
      tagSession: true,
      promoteMemory: true,
      exportContext: true,
    });
    const quality = makeIdentityAllowedUses({
      diagnostics: true,
      tagSession: true,
      promoteMemory: false,
      exportContext: true,
    });

    const gated = intersectIdentityAllowedUses(base, quality);
    expect(gated.diagnostics).toBe(true);
    expect(gated.tagSession).toBe(true);
    expect(gated.promoteMemory).toBe(false);
    expect(gated.exportContext).toBe(true);
  });

  test("exports a schema with required first-class identity signal fields", () => {
    expect(identitySignalBaseSchema.required).toContain("evidenceRefs");
    expect(identitySignalBaseSchema.required).toContain("allowedUses");
    expect(identitySignalBaseSchema.properties?.subject).toBeTruthy();
    expect(identitySignalBaseSchema.properties?.metadata).toBeTruthy();
  });

  // --- Policy deny-path coverage (previously only the happy path was tested) ---

  test("denies owner promoteMemory/triggerAction below the confidence floor", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "owner" },
      reviewState: "confirmed",
      confidence: 0.89, // just under ownerMemoryConfidence (0.9)
      consent: { memoryPromotionAllowed: true, actionProposalAllowed: true, templateLearningAllowed: true },
    });
    expect(uses.promoteMemory).toBe(false);
    expect(uses.triggerAction).toBe(false);
    expect(uses.templateLearning).toBe(false);
    // Non-sensitive confirmed-owner uses are still granted.
    expect(uses.tagSession).toBe(true);
  });

  test("grants owner sensitive uses exactly AT the confidence floor (>=)", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "owner" },
      reviewState: "confirmed",
      confidence: 0.9,
      consent: { memoryPromotionAllowed: true, templateLearningAllowed: true },
    });
    expect(uses.promoteMemory).toBe(true);
    expect(uses.templateLearning).toBe(true);
  });

  test("denies person promoteMemory just below the person floor (0.85)", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "person", personId: "p1" },
      reviewState: "confirmed",
      confidence: 0.84,
      consent: { memoryPromotionAllowed: true, contextExportAllowed: true },
    });
    expect(uses.promoteMemory).toBe(false);
    expect(uses.exportContext).toBe(false);
  });

  test("consent kill-switch (captureAllowed:false) denies ALL uses regardless of confidence", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "owner" },
      reviewState: "confirmed",
      confidence: 0.99,
      consent: { captureAllowed: false, memoryPromotionAllowed: true, diagnosticsAllowed: true },
    });
    for (const key of Object.keys(uses) as (keyof typeof uses)[]) {
      expect(uses[key]).toBe(false);
    }
  });

  test("identityProcessingAllowed:false also denies all uses", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "person", personId: "p1" },
      reviewState: "confirmed",
      confidence: 0.99,
      consent: { identityProcessingAllowed: false, memoryPromotionAllowed: true },
    });
    expect(Object.values(uses).every((v) => v === false)).toBe(true);
  });

  test("sensitive uses require consent === true (omitted consent denies, fail-closed)", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "owner" },
      reviewState: "confirmed",
      confidence: 0.99,
      consent: {}, // no memory/action/template flags
    });
    expect(uses.promoteMemory).toBe(false);
    expect(uses.triggerAction).toBe(false);
    expect(uses.templateLearning).toBe(false);
  });

  test("templateLearning is owner-only: a person never gets it even when consented", () => {
    const uses = allowedUsesForIdentitySignal({
      subject: { type: "person", personId: "p1" },
      reviewState: "confirmed",
      confidence: 0.99,
      consent: { templateLearningAllowed: true },
    });
    expect(uses.templateLearning).toBe(false);
  });

  test("assertIdentitySignalAllowedUsesSafe blocks templateLearning on a non-owner", () => {
    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_template_nonowner",
        createdAt,
        signalType: "face_match",
        source: "face",
        modality: "face",
        subject: { type: "person", personId: "p1" },
        evidenceRefs: [{ id: "e1" }],
        confidence: 0.99,
        sensitivity: "biometric",
        review: { state: "confirmed" },
        allowedUses: { templateLearning: true },
      }),
    ).toThrow(/owner/i);
  });

  test("assertIdentitySignalAllowedUsesSafe blocks a confirmed person with promoteMemory below the floor", () => {
    expect(() =>
      buildIdentitySignalBase({
        id: "idsig_lowconf_person",
        createdAt,
        signalType: "face_match",
        source: "face",
        modality: "face",
        subject: { type: "person", personId: "p1" },
        evidenceRefs: [{ id: "e1" }],
        confidence: 0.1,
        sensitivity: "biometric",
        review: { state: "confirmed" },
        allowedUses: { promoteMemory: true },
      }),
    ).toThrow(/confidence floor|promote memory/i);
  });

  test("intersectIdentityAllowedUses ANDs every key (no key wrongly left open)", () => {
    const allTrue = makeIdentityAllowedUses({
      diagnostics: true, tagSession: true, transcriptDisplay: true, eventGraph: true,
      promoteMemory: true, proposeRelationship: true, exportContext: true,
      triggerAction: true, templateLearning: true, profilePromotion: true,
    });
    const allFalse = makeIdentityAllowedUses();
    const result = intersectIdentityAllowedUses(allTrue, allFalse);
    for (const key of Object.keys(result) as (keyof typeof result)[]) {
      expect(result[key]).toBe(false);
    }
    // AND with itself is identity.
    const same = intersectIdentityAllowedUses(allTrue, allTrue);
    for (const key of Object.keys(same) as (keyof typeof same)[]) {
      expect(same[key]).toBe(true);
    }
  });

  test("NO_IDENTITY_ALLOWED_USES is frozen (deny-all baseline cannot be mutated)", () => {
    // @ts-expect-error — runtime mutation must throw on a frozen object (strict mode).
    expect(() => { (NO_IDENTITY_ALLOWED_USES as Record<string, boolean>).promoteMemory = true; }).toThrow();
    expect(NO_IDENTITY_ALLOWED_USES.promoteMemory).toBe(false);
  });
});
