import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedUsesForIdentitySignal,
  assertIdentitySignalAllowedUsesSafe,
} from "../src/identity/core/index.js";
import {
  buildPersonCandidateReviewRecord,
  buildFaceIdentitySignal,
  buildPersonFact,
  FilePersonCandidateReviewStore,
  normalizeLegacyDeepFaceProfile,
  personFactCanBeReadByMemoryDistill,
} from "../src/identity/person/index.js";

const now = "2026-06-27T00:00:00.000Z";

describe("person identity contracts", () => {
  test("requires person facts to carry confidence plus inspectable evidence or source session", () => {
    expect(() =>
      buildPersonFact({
        id: "pfact_missing_evidence",
        personId: "person_sarah",
        text: "Sarah works at Acme",
        origin: "manual",
        source: "manual",
        confidence: 0.9,
      }),
    ).toThrow(/evidenceRefs or sourceSession/);

    expect(() =>
      buildPersonFact({
        id: "pfact_empty_evidence",
        personId: "person_sarah",
        text: "Sarah works at Acme",
        origin: "manual",
        source: "manual",
        evidenceRefs: [{}],
        confidence: 0.9,
      }),
    ).toThrow(/inspectable source pointer/);

    expect(() =>
      buildPersonFact({
        id: "pfact_empty_source_session_ref",
        personId: "person_sarah",
        text: "Sarah works at Acme",
        origin: "manual",
        source: "manual",
        evidenceRefs: [{ type: "manual", sourceSession: {} as never }],
        confidence: 0.9,
      }),
    ).toThrow(/sourceSession.sessionKey/);

    const fact = buildPersonFact({
      id: "pfact_intro",
      personId: "person_sarah",
      text: "Sarah works at Acme",
      origin: "manual",
      source: "manual",
      sourceSession: { sessionKey: "realtime:session-1" },
      confidence: 0.9,
      review: { state: "confirmed", reviewedAt: now },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    });

    expect(fact.confidence).toBe(0.9);
    expect(fact.sourceSession?.sessionKey).toBe("realtime:session-1");
    expect(personFactCanBeReadByMemoryDistill(fact)).toBe(true);
  });

  test("keeps unreviewed person facts out of memory distillation reads", () => {
    const fact = buildPersonFact({
      id: "pfact_legacy",
      personId: "person_sarah",
      text: "Sarah likes climbing",
      origin: "legacy_unverified",
      source: "legacy_deepface",
      evidenceRefs: [{ type: "tool_result", id: "legacy_deepface_profile:p1" }],
      confidence: 0.5,
      review: { state: "unreviewed" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    });

    expect(personFactCanBeReadByMemoryDistill(fact)).toBe(false);
  });

  test("normalizes named DeepFace profiles into unreviewed person records and legacy facts", () => {
    const normalized = normalizeLegacyDeepFaceProfile(
      {
        id: "p-sarah",
        name: "Sarah",
        embeddings: [[0.1, 0.2, 0.3]],
        facts: ["climber", "climber", "runs a coffee startup"],
        recaps: [{ summary: "Talked about seed round.", at: "2026-06-20T10:00:00.000Z" }],
        created_at: "2026-06-19T10:00:00.000Z",
        last_seen_at: "2026-06-21T10:00:00.000Z",
      },
      { now },
    );

    expect(normalized.profile?.id).toBe("p-sarah");
    expect(normalized.profile?.displayName).toBe("Sarah");
    expect(normalized.candidate).toBeUndefined();
    expect(normalized.facts.map((fact) => fact.text)).toEqual([
      "climber",
      "runs a coffee startup",
    ]);
    expect(normalized.facts.every((fact) => fact.origin === "legacy_unverified")).toBe(true);
    expect(normalized.facts.every((fact) => fact.review.state === "unreviewed")).toBe(true);
    expect(normalized.facts.every((fact) => !personFactCanBeReadByMemoryDistill(fact))).toBe(true);
    expect(normalized.recaps[0].origin).toBe("legacy_unverified");
    expect(normalized.faceSignals[0].subject).toEqual({ type: "person", personId: "p-sarah" });
    expect(JSON.stringify(normalized)).not.toContain("0.1");
  });

  test("normalizes Unknown DeepFace profiles into identity candidates, not person profiles", () => {
    const normalized = normalizeLegacyDeepFaceProfile(
      {
        id: "p-unknown",
        name: "Unknown",
        facts: ["should not become a person fact"],
        recaps: [{ summary: "should not become a recap" }],
      },
      { now },
    );

    expect(normalized.profile).toBeUndefined();
    expect(normalized.candidate?.candidateType).toBe("unknown_face");
    expect(normalized.candidate?.modalities).toEqual(["face"]);
    expect(normalized.facts).toEqual([]);
    expect(normalized.recaps).toEqual([]);
    expect(normalized.warnings).toContain(
      "Unknown legacy DeepFace profile had facts/recaps that were not promoted.",
    );
    expect(normalized.faceSignals[0].subject).toEqual({
      type: "person_candidate",
      candidateId: normalized.candidate?.id,
    });
    expect(normalized.faceSignals[0].allowedUses.profilePromotion).toBe(false);
  });

  test("lets reviewed face candidates promote profiles without granting memory rights", () => {
    const subject = { type: "person_candidate", candidateId: "cand_face_reviewed" } as const;
    const allowedUses = allowedUsesForIdentitySignal({
      subject,
      reviewState: "confirmed",
      confidence: 0.93,
      consent: {
        profilePromotionAllowed: true,
        memoryPromotionAllowed: true,
        contextExportAllowed: true,
      },
    });
    const signal = buildFaceIdentitySignal({
      id: "face_sig_reviewed_candidate",
      signalType: "face_candidate",
      subject,
      evidenceRefs: [{ type: "frame", frameId: "frame-1" }],
      confidence: 0.93,
      review: { state: "confirmed", reviewedAt: now },
      allowedUses,
      metadata: { candidateId: subject.candidateId, similarity: 0.93 },
    });

    expect(signal.allowedUses.profilePromotion).toBe(true);
    expect(signal.allowedUses.promoteMemory).toBe(false);
    expect(signal.allowedUses.exportContext).toBe(false);
    expect(() => assertIdentitySignalAllowedUsesSafe(signal)).not.toThrow();
  });

  test("persists candidate review records with atomic JSON store", () => {
    const dir = mkdtempSync(join(tmpdir(), "haoclaw-person-review-"));
    try {
      const normalized = normalizeLegacyDeepFaceProfile({ id: "p-unknown", name: "Unknown" }, { now });
      const candidate = normalized.candidate!;
      const filePath = join(dir, "person-candidates.json");
      const store = new FilePersonCandidateReviewStore(filePath);
      store.put(buildPersonCandidateReviewRecord({
        candidate,
        review: {
          state: "rejected",
          reviewedAt: now,
          reviewer: "owner",
          reason: "not someone to remember",
        },
        metadata: { source: "test" },
        now,
      }));

      const reloaded = new FilePersonCandidateReviewStore(filePath);
      const record = reloaded.get(candidate.id);
      expect(record?.candidateId).toBe(candidate.id);
      expect(record?.review.state).toBe("rejected");
      expect(record?.review.reason).toBe("not someone to remember");
      expect(record?.metadata.source).toBe("test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
