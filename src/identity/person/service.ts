import { allowedUsesForIdentitySignal } from "../core/index.js";
import {
  buildFaceIdentitySignal,
  buildIdentityCandidate,
  type IdentityCandidate,
  type LegacyPersonRef,
} from "./contracts.js";
import {
  buildPersonCandidateReviewRecord,
  type PersonCandidateReviewRecord,
  type PersonCandidateReviewStore,
} from "./candidate-review-store.js";
import {
  deepFaceProfileToPersonToolPerson,
  deepFaceProfilesToPersonToolPeople,
} from "./deepface-tool-adapter.js";
import {
  normalizeLegacyDeepFaceProfile,
  type LegacyDeepFaceProfile,
} from "./legacy-deepface.js";
import type {
  PersonCandidateReviewResult,
  PersonIdentifyResult,
  PersonListResult,
  PersonRecallResult,
  PersonToolPerson,
  PersonUpdateProfileResult,
} from "./tool-contract.js";
import type { ReviewRecord, SourceSessionRef } from "../core/index.js";

export type PersonServiceErrorCode =
  | "INVALID_REQUEST"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED";

export class PersonServiceError extends Error {
  constructor(
    readonly code: PersonServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersonServiceError";
  }
}

export type LegacyFailure = { ok: false; error: string; code?: PersonServiceErrorCode };

export type LegacyIdentifyResult =
  | { ok: true; found: false }
  | { ok: true; found: true; person: LegacyDeepFaceProfile; similarity?: number }
  | LegacyFailure;

export type LegacyPeopleResult =
  | { ok: true; people: unknown[] }
  | LegacyFailure;

export type LegacyWriteResult =
  | { ok: true; person: LegacyDeepFaceProfile }
  | LegacyFailure;

export interface LegacyPersonRepository {
  identify(imageBase64: string): Promise<LegacyIdentifyResult>;
  listPeople(): Promise<LegacyPeopleResult>;
  enroll(input: {
    imageBase64: string;
    name: string;
    personId?: string | null;
  }): Promise<LegacyWriteResult>;
  update(input: {
    personId: string;
    name?: string | null;
    facts?: string[] | null;
    recap?: string | null;
  }): Promise<LegacyWriteResult>;
}

export interface PersonServiceOptions {
  now?: () => string;
}

export class PersonService {
  private readonly now: () => string;

  constructor(
    private readonly legacy: LegacyPersonRepository,
    private readonly candidateReviews: PersonCandidateReviewStore,
    options: PersonServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async identifyCurrentFrame(input: {
    imageBase64: string;
    sessionKey?: string;
    includeStructured?: boolean;
  }): Promise<PersonIdentifyResult> {
    const result = await this.legacy.identify(input.imageBase64);
    if (!result.ok) {
      throw new PersonServiceError(result.code ?? "UNAVAILABLE", result.error);
    }
    if (!result.found) {
      return {
        ok: true,
        found: false,
        reason: "no_match",
        message: "No one on camera matches a person you've met.",
      };
    }

    const confidence = numberOr(result.similarity, 0.5);
    const person = deepFaceProfileToPersonToolPerson(result.person, {
      includeStructured: input.includeStructured,
    });
    if (!person) {
      const normalized = normalizeLegacyDeepFaceProfile(result.person, {
        defaultConfidence: confidence,
      });
      if (normalized.candidate) {
        const candidate = this.reviewedCandidateOrUndefined(normalized.candidate);
        if (!candidate) {
          return {
            ok: true,
            found: false,
            candidate_id: normalized.candidate.id,
            reason: "candidate_rejected",
            suppressed: true,
            no_enroll: true,
            message: "This face matches an identity candidate that was rejected or suppressed.",
          };
        }
        return {
          ok: true,
          found: false,
          candidate,
          candidate_id: candidate.id,
          reason: "candidate_like_legacy_unknown",
          message: "This face matches an unconfirmed identity candidate, not a named person yet.",
        };
      }
      return {
        ok: true,
        found: false,
        reason: "candidate_like_legacy_unknown",
        message: "The matching legacy profile is unknown and needs review before it becomes a person.",
      };
    }

    return {
      ok: true,
      found: true,
      person,
      identity_signal: this.buildIdentifySignal(person, confidence, input.sessionKey),
    };
  }

  async listPeople(input: {
    includeStructured?: boolean;
    includeCandidates?: boolean;
  } = {}): Promise<PersonListResult> {
    const result = await this.legacy.listPeople();
    if (!result.ok) {
      return {
        ok: true,
        available: false,
        people: [],
        note: "Face database service is not running.",
      };
    }
    return {
      ok: true,
      available: true,
      people: deepFaceProfilesToPersonToolPeople(result.people, {
        includeStructured: input.includeStructured,
      }),
      ...(input.includeCandidates ? { candidates: this.identityCandidatesFromLegacyPeople(result.people) } : {}),
    };
  }

  async recallPerson(input: {
    name: string;
    includeStructured?: boolean;
  }): Promise<PersonRecallResult> {
    const listed = await this.listPeople({ includeStructured: input.includeStructured });
    if (!listed.available) {
      return { ok: true, found: false };
    }
    const query = input.name.toLowerCase();
    const exact = listed.people.find((person) => person.name.toLowerCase() === query);
    const partial = exact ?? listed.people.find((person) => person.name.toLowerCase().includes(query));
    return partial ? { ok: true, found: true, person: partial } : { ok: true, found: false };
  }

  async updateProfile(input: {
    id?: string;
    name?: string;
    imageBase64?: string;
    facts?: string[];
    recap?: string;
    includeStructured?: boolean;
  }): Promise<PersonUpdateProfileResult> {
    const facts = input.facts ?? [];
    if (!input.name && facts.length === 0 && !input.recap) {
      throw new PersonServiceError("INVALID_REQUEST", "name, facts, or recap is required.");
    }

    let personId = input.id;
    if (personId) {
      personId = await this.profileIdForDirectUpdate(personId);
    } else {
      if (!input.name || !input.imageBase64) {
        throw new PersonServiceError("INVALID_REQUEST", "id is required unless name and image_base64 are provided.");
      }
      personId = await this.profileIdForFrameUpdate(input.imageBase64, input.includeStructured);
      if (!personId) {
        const enrolled = await this.legacy.enroll({
          imageBase64: input.imageBase64,
          name: input.name,
          personId: null,
        });
        if (!enrolled.ok) {
          throw new PersonServiceError(enrolled.code ?? "UNAVAILABLE", enrolled.error);
        }
        const enrolledId = stringOrUndefined(enrolled.person.id);
        if (!enrolledId) {
          throw new PersonServiceError("INVALID_RESPONSE", "DeepFace enroll response omitted person id.");
        }
        personId = enrolledId;
        if (facts.length === 0 && !input.recap) {
          return {
            ok: true,
            person: this.personOrThrow(enrolled.person, input.includeStructured, "Enrolled profile did not become a named person."),
          };
        }
      }
    }

    const result = await this.legacy.update({
      personId,
      name: input.name ?? null,
      facts: facts.length > 0 ? facts : null,
      recap: input.recap ?? null,
    });
    if (!result.ok) {
      throw new PersonServiceError(result.code ?? "UNAVAILABLE", result.error);
    }
    return {
      ok: true,
      person: this.personOrThrow(result.person, input.includeStructured, "Updated legacy profile is still an unknown candidate."),
    };
  }

  async confirmCandidate(input: {
    candidateId: string;
    name?: string;
    personId?: string;
    reason?: string;
    sessionKey?: string;
    includeStructured?: boolean;
  }): Promise<PersonCandidateReviewResult> {
    if (!input.name) {
      throw new PersonServiceError("INVALID_REQUEST", "name is required to confirm a candidate.");
    }

    const found = await this.findCandidate(input.candidateId);
    const existing = this.candidateReviews.get(input.candidateId);
    if (isTerminalReview(existing?.review.state)) {
      throw new PersonServiceError("INVALID_REQUEST", "Candidate was already rejected or suppressed.");
    }

    const legacyProfileId = legacyProfileIdFromCandidate(found.candidate);
    if (!legacyProfileId) {
      throw new PersonServiceError("INVALID_RESPONSE", "Candidate does not reference a legacy DeepFace profile.");
    }
    if (input.personId && input.personId !== legacyProfileId) {
      throw new PersonServiceError(
        "NOT_IMPLEMENTED",
        "Merging a candidate into a different existing person profile is not available yet.",
      );
    }

    const updated = await this.legacy.update({
      personId: legacyProfileId,
      name: input.name,
      facts: null,
      recap: null,
    });
    if (!updated.ok) {
      throw new PersonServiceError(updated.code ?? "UNAVAILABLE", updated.error);
    }
    const person = this.personOrThrow(
      updated.person,
      input.includeStructured,
      "Confirmed candidate did not become a named person.",
    );
    const review: ReviewRecord = {
      state: "confirmed",
      reviewedAt: this.now(),
      reviewer: "owner",
      reason: input.reason,
    };
    const candidate = this.reviewedCandidate(found.candidate, review, {
      promotedPersonId: person.id,
      confirmedName: input.name,
    });
    this.persistCandidateReview({
      candidate,
      review,
      existing,
      promotedPersonId: person.id,
      sessionKey: input.sessionKey,
      metadata: { legacyProfileId, confirmedName: input.name },
    });
    return { ok: true, candidate, person };
  }

  async rejectCandidate(input: {
    candidateId: string;
    reason?: string;
    sessionKey?: string;
  }): Promise<PersonCandidateReviewResult> {
    const found = await this.findCandidate(input.candidateId);
    const existing = this.candidateReviews.get(input.candidateId);
    if (existing?.review.state === "confirmed") {
      throw new PersonServiceError("INVALID_REQUEST", "Candidate is already confirmed.");
    }

    const review: ReviewRecord = {
      state: "rejected",
      reviewedAt: this.now(),
      reviewer: "owner",
      reason: input.reason,
    };
    const candidate = this.reviewedCandidate(found.candidate, review, {
      rejectionReason: input.reason,
    });
    this.persistCandidateReview({
      candidate,
      review,
      existing,
      sessionKey: input.sessionKey,
      metadata: {
        legacyProfileId: legacyProfileIdFromCandidate(found.candidate),
        rejectionReason: input.reason,
      },
    });
    return { ok: true, candidate };
  }

  private async profileIdForDirectUpdate(personId: string): Promise<string> {
    const byCandidateId = this.candidateReviews.get(personId);
    if (byCandidateId) {
      throw new PersonServiceError(
        "INVALID_REQUEST",
        "candidate_id cannot be used with update_person_profile; use confirm_identity_candidate after the user verifies the name.",
      );
    }

    const result = await this.legacy.listPeople();
    if (!result.ok) {
      throw new PersonServiceError(result.code ?? "UNAVAILABLE", result.error);
    }

    for (const raw of result.people) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const normalized = normalizeLegacyDeepFaceProfile(raw as LegacyDeepFaceProfile);
      if (normalized.legacyProfileId !== personId && normalized.candidate?.id !== personId) continue;
      if (normalized.candidate) {
        return this.profileIdForCandidateUpdate(normalized.candidate, "direct_profile_update");
      }
      return personId;
    }

    return personId;
  }

  private async profileIdForFrameUpdate(
    imageBase64: string,
    includeStructured: boolean | undefined,
  ): Promise<string | undefined> {
    const identified = await this.legacy.identify(imageBase64);
    if (!identified.ok) {
      throw new PersonServiceError(identified.code ?? "UNAVAILABLE", identified.error);
    }
    if (!identified.found) {
      return undefined;
    }

    const person = deepFaceProfileToPersonToolPerson(identified.person, { includeStructured });
    if (person) {
      return person.id;
    }

    const normalized = normalizeLegacyDeepFaceProfile(identified.person, {
      defaultConfidence: numberOr(identified.similarity, 0.5),
    });
    const candidate = normalized.candidate;
    if (!candidate) {
      throw new PersonServiceError(
        "INVALID_REQUEST",
        "This frame matches a legacy Unknown profile; confirm the identity candidate before updating it.",
      );
    }

    return this.profileIdForCandidateUpdate(candidate, "frame_profile_update");
  }

  private profileIdForCandidateUpdate(candidate: IdentityCandidate, source: "direct_profile_update" | "frame_profile_update"): string {
    const existing = this.candidateReviews.get(candidate.id);
    if (existing?.review.state === "confirmed") {
      const reviewedProfileId = existing.promotedPersonId
        ?? legacyProfileIdFromCandidate(existing.candidate)
        ?? legacyProfileIdFromCandidate(candidate);
      if (reviewedProfileId) return reviewedProfileId;
      throw new PersonServiceError("INVALID_RESPONSE", "Confirmed candidate does not reference a person profile.");
    }
    if (isTerminalReview(existing?.review.state)) {
      throw new PersonServiceError(
        "INVALID_REQUEST",
        source === "frame_profile_update"
          ? "This frame matches a rejected or suppressed identity candidate and cannot be enrolled or renamed."
          : "This profile id belongs to a rejected or suppressed identity candidate and cannot be updated or renamed.",
      );
    }
    throw new PersonServiceError(
      "INVALID_REQUEST",
      source === "frame_profile_update"
        ? `This frame matches an unconfirmed identity candidate (${candidate.id}); use confirm_identity_candidate after the user verifies the name.`
        : `This profile id belongs to an unconfirmed identity candidate (${candidate.id}); use confirm_identity_candidate after the user verifies the name.`,
    );
  }

  private async findCandidate(candidateId: string): Promise<{ candidate: IdentityCandidate }> {
    const existing = this.candidateReviews.get(candidateId);
    if (existing) {
      return { candidate: existing.candidate };
    }

    const result = await this.legacy.listPeople();
    if (!result.ok) {
      throw new PersonServiceError(result.code ?? "UNAVAILABLE", result.error);
    }
    const candidate = this.identityCandidatesFromLegacyPeople(result.people)
      .find((item) => item.id === candidateId);
    if (!candidate) {
      throw new PersonServiceError("NOT_FOUND", "Identity candidate was not found.");
    }
    return { candidate };
  }

  private identityCandidatesFromLegacyPeople(rawProfiles: unknown[]): IdentityCandidate[] {
    return rawProfiles.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const normalized = normalizeLegacyDeepFaceProfile(raw as LegacyDeepFaceProfile);
      if (!normalized.candidate) return [];
      const candidate = this.reviewedCandidateOrUndefined(normalized.candidate);
      return candidate ? [candidate] : [];
    });
  }

  private reviewedCandidateOrUndefined(candidate: IdentityCandidate): IdentityCandidate | undefined {
    const record = this.candidateReviews.get(candidate.id);
    if (!record) return candidate;
    if (isTerminalReview(record.review.state)) return undefined;
    return record.candidate;
  }

  private reviewedCandidate(
    candidate: IdentityCandidate,
    review: ReviewRecord,
    metadata: Record<string, unknown> = {},
  ): IdentityCandidate {
    return buildIdentityCandidate({
      id: candidate.id,
      createdAt: candidate.createdAt,
      updatedAt: review.reviewedAt ?? this.now(),
      candidateType: candidate.candidateType,
      modalities: candidate.modalities,
      label: candidate.label,
      source: candidate.source,
      evidenceRefs: candidate.evidenceRefs,
      sourceSession: candidate.sourceSession,
      confidence: candidate.confidence,
      review,
      allowedUses: allowedUsesForIdentitySignal({
        subject: { type: "person_candidate", candidateId: candidate.id },
        reviewState: review.state,
        confidence: candidate.confidence,
        consent: { profilePromotionAllowed: review.state === "confirmed" },
      }),
      legacyRefs: candidate.legacyRefs,
      metadata: { ...candidate.metadata, ...metadata },
    });
  }

  private persistCandidateReview(input: {
    candidate: IdentityCandidate;
    review: ReviewRecord;
    existing?: PersonCandidateReviewRecord;
    promotedPersonId?: string;
    sessionKey?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.candidateReviews.put(buildPersonCandidateReviewRecord({
      candidate: input.candidate,
      review: input.review,
      existing: input.existing,
      promotedPersonId: input.promotedPersonId,
      sourceSession: sourceSession(input.sessionKey),
      metadata: input.metadata,
      now: input.review.reviewedAt ?? this.now(),
    }));
  }

  private personOrThrow(raw: LegacyDeepFaceProfile, includeStructured: boolean | undefined, message: string): PersonToolPerson {
    const person = deepFaceProfileToPersonToolPerson(raw, { includeStructured });
    if (!person) {
      throw new PersonServiceError("INVALID_RESPONSE", message);
    }
    return person;
  }

  private buildIdentifySignal(person: PersonToolPerson, confidence: number, sessionKey?: string) {
    const subject = { type: "person" as const, personId: person.id };
    return buildFaceIdentitySignal({
      id: `face_sig_identify_${person.id}_${Date.now()}`,
      signalType: "face_match",
      subject,
      sourceSession: sourceSession(sessionKey),
      evidenceRefs: sessionKey ? undefined : [{ type: "tool_result" as const, id: `deepface_identify:${person.id}` }],
      confidence,
      review: { state: "unreviewed" as const },
      allowedUses: allowedUsesForIdentitySignal({
        subject,
        reviewState: "unreviewed",
        confidence,
      }),
      metadata: {
        personId: person.id,
        deepfaceProfileId: person.id,
        service: "deepface",
      },
    });
  }
}

function sourceSession(sessionKey: string | undefined): SourceSessionRef | undefined {
  return sessionKey ? { sessionKey } : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function legacyProfileIdFromCandidate(candidate: IdentityCandidate): string | undefined {
  const metadataId = stringOrUndefined(candidate.metadata.deepfaceProfileId);
  if (metadataId) return metadataId;
  const ref = candidate.legacyRefs.find((item): item is LegacyPersonRef & { profileId: string } =>
    item.system === "deepface" && typeof item.profileId === "string" && item.profileId.trim().length > 0
  );
  return ref?.profileId;
}

function isTerminalReview(state: string | undefined): boolean {
  return state === "rejected" || state === "suppressed" || state === "deleted";
}
