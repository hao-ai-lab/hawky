import { allowedUsesForIdentitySignal } from "../core/index.js";
import {
  buildFaceIdentitySignal,
  buildIdentityCandidate,
  buildPersonFact,
  buildPersonProfile,
  buildPersonRecap,
  makePersonRecordAllowedUses,
  type IdentityCandidate,
  type LegacyPersonRef,
  type PersonFact,
  type PersonProfile,
  type PersonRecap,
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
import { importLegacyDeepFaceProfiles } from "./migration.js";
import { stableHash } from "./stable-hash.js";
import type { PersonStore } from "./store.js";
import { buildPersonTombstone } from "./tombstone.js";
import type {
  PersonCandidateReviewResult,
  PersonClearResult,
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

export type LegacyClearResult =
  | { ok: true; removed?: number }
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
  }): Promise<LegacyWriteResult>;
  clearPeople?(): Promise<LegacyClearResult>;
}

export interface PersonServiceOptions {
  now?: () => string;
  personStore?: PersonStore;
}

export class PersonService {
  private readonly now: () => string;
  private readonly personStore?: PersonStore;

  constructor(
    private readonly legacy: LegacyPersonRepository,
    private readonly candidateReviews: PersonCandidateReviewStore,
    options: PersonServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.personStore = options.personStore;
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
    if (this.personStore) {
      importLegacyDeepFaceProfiles(this.personStore, [result.person], {
        defaultConfidence: confidence,
      });
    }
    const person = deepFaceProfileToPersonToolPerson(result.person, {
      includeStructured: input.includeStructured,
    });
    if (!person) {
      const normalized = normalizeLegacyDeepFaceProfile(result.person, {
        defaultConfidence: confidence,
      });
      if (normalized.candidate) {
        const confirmedPerson = this.personForConfirmedCandidate(
          normalized.candidate,
          input.includeStructured,
        );
        if (confirmedPerson) {
          return {
            ok: true,
            found: true,
            person: confirmedPerson,
            identity_signal: this.buildIdentifySignal(confirmedPerson, confidence, input.sessionKey),
          };
        }
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

    const storedPerson = this.personStore?.getProfile(person.id);
    if (this.personStore?.getTombstone(person.id)) {
      return {
        ok: true,
        found: false,
        reason: "person_suppressed",
        suppressed: true,
        no_enroll: true,
        message: "This face matches a suppressed or deleted person profile.",
      };
    }

    const responsePerson = storedPerson
      ? this.personToolPersonFromStore(storedPerson, input.includeStructured)
      : person;
    return {
      ok: true,
      found: true,
      person: responsePerson,
      identity_signal: this.buildIdentifySignal(responsePerson, confidence, input.sessionKey),
    };
  }

  async listPeople(input: {
    includeStructured?: boolean;
    includeCandidates?: boolean;
  } = {}): Promise<PersonListResult> {
    const result = await this.legacy.listPeople();
    if (this.personStore) {
      if (result.ok) {
        importLegacyDeepFaceProfiles(this.personStore, result.people, {
          now: this.now(),
        });
        return {
          ok: true,
          available: true,
          people: this.peopleFromStore(input.includeStructured, legacyThumbnailsById(result.people)),
          ...(input.includeCandidates ? { candidates: this.identityCandidatesFromStore() } : {}),
        };
      }
      const people = this.peopleFromStore(input.includeStructured);
      const candidates = input.includeCandidates ? this.identityCandidatesFromStore() : undefined;
      if (people.length > 0 || (candidates && candidates.length > 0)) {
        return {
          ok: true,
          available: true,
          people,
          ...(candidates ? { candidates } : {}),
          note: "Face database service is not running; returning local person store.",
        };
      }
    }
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
    sessionKey?: string;
    includeStructured?: boolean;
  }): Promise<PersonUpdateProfileResult> {
    const facts = input.facts ?? [];
    if (!input.name && facts.length === 0 && !input.recap) {
      throw new PersonServiceError("INVALID_REQUEST", "name, facts, or recap is required.");
    }
    if (this.personStore) {
      return this.updateProfileWithStore({
        ...input,
        facts,
      });
    }
    if (facts.length > 0 || input.recap) {
      throw new PersonServiceError(
        "NOT_IMPLEMENTED",
        "A person store is required to write person facts or recaps; face compatibility storage only supports legacy labels.",
      );
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
    if (this.personStore) {
      return this.confirmCandidateWithStore(input);
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
    if (this.personStore) {
      return this.rejectCandidateWithStore(input);
    }

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

  async clearPeople(): Promise<PersonClearResult> {
    let legacy: PersonClearResult["legacy"] | undefined;
    if (this.legacy.clearPeople) {
      const result = await this.legacy.clearPeople().catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (!result.ok) {
        const code = "code" in result && result.code ? result.code : "UNAVAILABLE";
        throw new PersonServiceError(code, `Legacy face index clear failed: ${result.error}`);
      }
      legacy = { ok: true, removed: numberOr(result.removed, 0) };
    }

    const local = this.personStore?.clear() ?? {
      profiles: 0,
      facts: 0,
      recaps: 0,
      candidates: 0,
      tombstones: 0,
    };
    const candidateReviews = this.candidateReviews.clear();

    return {
      ok: true,
      cleared: {
        profiles: local.profiles,
        facts: local.facts,
        recaps: local.recaps,
        candidates: local.candidates,
        tombstones: local.tombstones,
        candidate_reviews: candidateReviews,
        ...(legacy?.ok ? { legacy_face_profiles: legacy.removed } : {}),
      },
      ...(legacy ? { legacy } : {}),
    };
  }

  private async profileIdForDirectUpdate(personId: string): Promise<string> {
    const byCandidateId = this.candidateReviews.get(personId);
    if (byCandidateId) {
      throw new PersonServiceError(
        "INVALID_REQUEST",
        "candidate_id cannot be used with update_person_profile; use confirm_identity_candidate after the user verifies the name.",
      );
    }
    if (this.personStore) {
      this.assertNoTombstone(personId, "This person or candidate was rejected, suppressed, or deleted and cannot be updated.");
      const directCandidate = this.personStore.getCandidate(personId);
      if (directCandidate) {
        return this.profileIdForCandidateUpdate(directCandidate, "direct_profile_update");
      }
      if (this.personStore.getProfile(personId)) {
        return personId;
      }
    }

    const result = await this.legacy.listPeople();
    if (!result.ok) {
      if (this.personStore) {
        throw new PersonServiceError("NOT_FOUND", "Person profile was not found in the local person store.");
      }
      throw new PersonServiceError(result.code ?? "UNAVAILABLE", result.error);
    }
    if (this.personStore) {
      importLegacyDeepFaceProfiles(this.personStore, result.people, { now: this.now() });
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

    if (this.personStore) {
      throw new PersonServiceError("NOT_FOUND", "Person profile was not found in the local person store.");
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
    if (this.personStore) {
      importLegacyDeepFaceProfiles(this.personStore, [identified.person], {
        defaultConfidence: numberOr(identified.similarity, 0.5),
      });
    }

    const person = deepFaceProfileToPersonToolPerson(identified.person, { includeStructured });
    if (person) {
      this.assertNoTombstone(person.id, "This frame matches a rejected, suppressed, or deleted person profile and cannot be updated.");
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
    this.assertNoTombstone(
      candidate.id,
      source === "frame_profile_update"
        ? "This frame matches a rejected or suppressed identity candidate and cannot be enrolled or renamed."
        : "This profile id belongs to a rejected or suppressed identity candidate and cannot be updated or renamed.",
    );
    const legacyProfileId = legacyProfileIdFromCandidate(candidate);
    if (legacyProfileId) {
      this.assertNoTombstone(
        legacyProfileId,
        source === "frame_profile_update"
          ? "This frame matches a rejected or suppressed identity candidate and cannot be enrolled or renamed."
          : "This profile id belongs to a rejected or suppressed identity candidate and cannot be updated or renamed.",
      );
    }
    const existing = this.candidateReviews.get(candidate.id);
    if (existing?.review.state === "confirmed") {
      const reviewedProfileId = existing.promotedPersonId
        ?? legacyProfileIdFromCandidate(existing.candidate)
        ?? legacyProfileId;
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
    const stored = this.personStore?.getCandidate(candidateId);
    if (stored) {
      return { candidate: stored };
    }

    const result = await this.legacy.listPeople();
    if (!result.ok) {
      throw new PersonServiceError(result.code ?? "UNAVAILABLE", result.error);
    }
    if (this.personStore) {
      importLegacyDeepFaceProfiles(this.personStore, result.people, { now: this.now() });
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

  private identityCandidatesFromStore(): IdentityCandidate[] {
    if (!this.personStore) return [];
    return this.personStore.listCandidates().flatMap((candidate) => {
      const reviewed = this.reviewedCandidateOrUndefined(candidate);
      return reviewed ? [reviewed] : [];
    });
  }

  private reviewedCandidateOrUndefined(candidate: IdentityCandidate): IdentityCandidate | undefined {
    if (this.personStore?.getTombstone(candidate.id)) return undefined;
    const legacyProfileId = legacyProfileIdFromCandidate(candidate);
    if (legacyProfileId && this.personStore?.getTombstone(legacyProfileId)) return undefined;
    const record = this.candidateReviews.get(candidate.id);
    if (!record) return candidate;
    if (record.review.state === "confirmed") return undefined;
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

  private async updateProfileWithStore(input: {
    id?: string;
    name?: string;
    imageBase64?: string;
    facts: string[];
    recap?: string;
    sessionKey?: string;
    includeStructured?: boolean;
  }): Promise<PersonUpdateProfileResult> {
    const store = this.personStoreOrThrow();
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
        importLegacyDeepFaceProfiles(store, [enrolled.person], { now: this.now() });
        const enrolledId = stringOrUndefined(enrolled.person.id);
        if (!enrolledId) {
          throw new PersonServiceError("INVALID_RESPONSE", "DeepFace enroll response omitted person id.");
        }
        personId = enrolledId;
        if (!store.getProfile(personId)) {
          store.putProfile(this.buildToolProfile({
            id: personId,
            name: input.name,
            sessionKey: input.sessionKey,
            legacyProfileId: personId,
          }));
        }
        if (input.facts.length === 0 && !input.recap) {
          return {
            ok: true,
            person: this.personToolPersonFromStore(
              this.profileOrThrow(personId),
              input.includeStructured,
            ),
          };
        }
      }
    }

    const profile = store.getProfile(personId);
    if (!profile) {
      throw new PersonServiceError("NOT_FOUND", "Person profile was not found in the local person store.");
    }
    const updatedProfile = this.updatedProfile(profile, input.name, input.sessionKey);
    store.putProfile(updatedProfile);
    for (const factText of uniqueNonEmptyStrings(input.facts)) {
      this.putToolFact(updatedProfile.id, factText, input.sessionKey);
    }
    if (input.recap) {
      this.putToolRecap(updatedProfile.id, input.recap, input.sessionKey);
    }
    await this.bestEffortLegacyUpdate(updatedProfile, {
      name: input.name ?? null,
    });
    return {
      ok: true,
      person: this.personToolPersonFromStore(updatedProfile, input.includeStructured),
    };
  }

  private async confirmCandidateWithStore(input: {
    candidateId: string;
    name?: string;
    personId?: string;
    reason?: string;
    sessionKey?: string;
    includeStructured?: boolean;
  }): Promise<PersonCandidateReviewResult> {
    const store = this.personStoreOrThrow();
    const found = await this.findCandidate(input.candidateId);
    const existing = this.candidateReviews.get(input.candidateId);
    if (isTerminalReview(existing?.review.state)) {
      throw new PersonServiceError("INVALID_REQUEST", "Candidate was already rejected or suppressed.");
    }
    this.assertNoTombstone(found.candidate.id, "Candidate was rejected or suppressed.");

    const legacyProfileId = legacyProfileIdFromCandidate(found.candidate);
    if (legacyProfileId) {
      this.assertNoTombstone(legacyProfileId, "Candidate legacy profile was rejected or suppressed.");
    }
    if (input.personId && legacyProfileId && input.personId !== legacyProfileId) {
      throw new PersonServiceError(
        "NOT_IMPLEMENTED",
        "Merging a candidate into a different existing person profile is not available yet.",
      );
    }

    const personId = input.personId ?? legacyProfileId ?? `person_${stableHash(["candidate", found.candidate.id, input.name])}`;
    const profile = buildPersonProfile({
      id: personId,
      displayName: input.name!,
      source: "tool",
      evidenceRefs: found.candidate.evidenceRefs,
      sourceSession: sourceSession(input.sessionKey),
      confidence: found.candidate.confidence,
      review: {
        state: "confirmed",
        reviewedAt: this.now(),
        reviewer: "owner",
        reason: input.reason,
      },
      allowedUses: { profileDisplay: true },
      legacyRefs: found.candidate.legacyRefs,
      metadata: {
        confirmedFromCandidateId: found.candidate.id,
        legacyProfileId,
      },
    });
    store.putProfile(profile);

    if (legacyProfileId) {
      await this.bestEffortLegacyUpdate(profile, {
        name: input.name ?? null,
      });
    }

    const review: ReviewRecord = {
      state: "confirmed",
      reviewedAt: this.now(),
      reviewer: "owner",
      reason: input.reason,
    };
    const candidate = this.reviewedCandidate(found.candidate, review, {
      promotedPersonId: personId,
      confirmedName: input.name,
    });
    store.putCandidate(candidate);
    this.persistCandidateReview({
      candidate,
      review,
      existing,
      promotedPersonId: personId,
      sessionKey: input.sessionKey,
      metadata: { legacyProfileId, confirmedName: input.name },
    });
    return {
      ok: true,
      candidate,
      person: this.personToolPersonFromStore(profile, input.includeStructured),
    };
  }

  private async rejectCandidateWithStore(input: {
    candidateId: string;
    reason?: string;
    sessionKey?: string;
  }): Promise<PersonCandidateReviewResult> {
    const store = this.personStoreOrThrow();
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
    store.putCandidate(candidate);
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
    this.putCandidateTombstones(candidate, review, input.sessionKey);
    return { ok: true, candidate };
  }

  private peopleFromStore(
    includeStructured: boolean | undefined,
    thumbnailsById: Map<string, string> = new Map(),
  ): PersonToolPerson[] {
    const store = this.personStoreOrThrow();
    return store.listProfiles()
      .filter((profile) =>
        profile.state === "active"
        && profile.allowedUses.profileDisplay
        && !isTerminalReview(profile.review.state)
        && !store.getTombstone(profile.id)
      )
      .map((profile) => this.personToolPersonFromStore(profile, includeStructured, thumbnailsById.get(profile.id)));
  }

  private personToolPersonFromStore(
    profile: PersonProfile,
    includeStructured: boolean | undefined,
    thumbnail?: string,
  ): PersonToolPerson {
    const store = this.personStoreOrThrow();
    const facts = store.listFacts(profile.id)
      .filter((fact) => fact.allowedUses.profileDisplay && !isTerminalReview(fact.review.state))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const recaps = store.listRecaps(profile.id)
      .filter((recap) => recap.allowedUses.profileDisplay && !isTerminalReview(recap.review.state))
      .sort((left, right) => (left.at ?? left.createdAt).localeCompare(right.at ?? right.createdAt));
    const recapSummaries = recaps.map((recap) => (
      recap.at ? { summary: recap.summary, at: recap.at } : { summary: recap.summary }
    ));
    const structured = includeStructured === false
      ? undefined
      : {
          profile,
          facts,
          recaps,
          faceSignals: [],
          warnings: [],
        };

    return {
      id: profile.id,
      name: profile.displayName,
      facts: uniqueNonEmptyStrings(facts.map((fact) => fact.text)),
      recaps: recapSummaries,
      lastRecap: recapSummaries.length > 0 ? recapSummaries[recapSummaries.length - 1]?.summary : undefined,
      created_at: profile.createdAt,
      last_seen_at: profile.updatedAt,
      thumbnail,
      structured,
    };
  }

  private personForConfirmedCandidate(
    candidate: IdentityCandidate,
    includeStructured: boolean | undefined,
  ): PersonToolPerson | undefined {
    if (!this.personStore) return undefined;
    if (this.personStore.getTombstone(candidate.id)) return undefined;
    const record = this.candidateReviews.get(candidate.id);
    const confirmedCandidate = record?.review.state === "confirmed"
      ? record.candidate
      : candidate.review.state === "confirmed"
        ? candidate
        : undefined;
    if (!confirmedCandidate) return undefined;

    const personId = record?.promotedPersonId
      ?? stringOrUndefined(confirmedCandidate.metadata.promotedPersonId)
      ?? legacyProfileIdFromCandidate(confirmedCandidate);
    if (!personId || this.personStore.getTombstone(personId)) return undefined;
    const profile = this.personStore.getProfile(personId);
    if (!profile) return undefined;
    return this.personToolPersonFromStore(profile, includeStructured);
  }

  private buildToolProfile(input: {
    id: string;
    name: string;
    sessionKey?: string;
    legacyProfileId?: string;
  }): PersonProfile {
    const now = this.now();
    const session = sourceSession(input.sessionKey);
    return buildPersonProfile({
      id: input.id,
      createdAt: now,
      updatedAt: now,
      displayName: input.name,
      source: "tool",
      evidenceRefs: session ? [] : [{ type: "tool_result", id: `person.update_profile:${input.id}` }],
      sourceSession: session,
      confidence: 0.85,
      review: { state: "confirmed", reviewedAt: now, reviewer: "owner" },
      allowedUses: { profileDisplay: true },
      legacyRefs: input.legacyProfileId
        ? [{ system: "deepface", profileId: input.legacyProfileId, uri: `deepface://profiles/${encodeURIComponent(input.legacyProfileId)}` }]
        : [],
      metadata: {
        legacyProfileId: input.legacyProfileId,
      },
    });
  }

  private updatedProfile(profile: PersonProfile, name: string | undefined, sessionKey: string | undefined): PersonProfile {
    const now = this.now();
    const session = sourceSession(sessionKey);
    return buildPersonProfile({
      id: profile.id,
      createdAt: profile.createdAt,
      updatedAt: now,
      displayName: name ?? profile.displayName,
      aliases: profile.aliases,
      state: profile.state,
      source: profile.source,
      evidenceRefs: profile.evidenceRefs.length > 0
        ? profile.evidenceRefs
        : session ? [] : [{ type: "tool_result", id: `person.update_profile:${profile.id}` }],
      sourceSession: profile.sourceSession ?? session,
      confidence: profile.confidence,
      review: profile.review,
      allowedUses: profile.allowedUses,
      legacyRefs: profile.legacyRefs,
      metadata: {
        ...profile.metadata,
        ...(name ? { lastRenamedAt: now } : {}),
      },
    });
  }

  private putToolFact(personId: string, text: string, sessionKey: string | undefined): PersonFact {
    const store = this.personStoreOrThrow();
    const now = this.now();
    const normalized = text.trim();
    const existing = store.listFacts(personId)
      .find((fact) => fact.text.trim().toLowerCase() === normalized.toLowerCase() && !isTerminalReview(fact.review.state));
    if (existing) return existing;
    const session = sourceSession(sessionKey);
    const fact = buildPersonFact({
      id: `pfact_${stableHash(["person_update", personId, normalized.toLowerCase()])}`,
      createdAt: now,
      updatedAt: now,
      personId,
      text: normalized,
      origin: "manual",
      source: "tool",
      evidenceRefs: session ? [] : [{ type: "tool_result", id: `person.update_profile:${personId}` }],
      sourceSession: session,
      confidence: 0.85,
      review: { state: "unreviewed" },
      allowedUses: makePersonRecordAllowedUses({ profileDisplay: true }),
      metadata: { createdByTool: "update_person_profile" },
    });
    store.putFact(fact);
    return fact;
  }

  private putToolRecap(personId: string, summary: string, sessionKey: string | undefined): PersonRecap {
    const store = this.personStoreOrThrow();
    const now = this.now();
    const session = sourceSession(sessionKey);
    const recap = buildPersonRecap({
      id: `precap_${stableHash(["person_update", personId, summary.trim(), now])}`,
      createdAt: now,
      updatedAt: now,
      personId,
      summary: summary.trim(),
      at: now,
      origin: "manual",
      source: "tool",
      evidenceRefs: session ? [] : [{ type: "tool_result", id: `person.update_profile:${personId}` }],
      sourceSession: session,
      confidence: 0.85,
      review: { state: "unreviewed" },
      allowedUses: makePersonRecordAllowedUses({ profileDisplay: true }),
      metadata: { createdByTool: "update_person_profile" },
    });
    store.putRecap(recap);
    return recap;
  }

  private putCandidateTombstones(
    candidate: IdentityCandidate,
    review: ReviewRecord,
    sessionKey: string | undefined,
  ): void {
    const store = this.personStoreOrThrow();
    const session = sourceSession(sessionKey);
    store.putTombstone(buildPersonTombstone({
      id: `ptomb_${stableHash(["candidate", candidate.id, review.state])}`,
      subjectId: candidate.id,
      subjectType: "identity_candidate",
      review,
      evidenceRefs: candidate.evidenceRefs,
      sourceSession: session,
      legacyRefs: candidate.legacyRefs,
      metadata: { candidateType: candidate.candidateType },
    }));
    const legacyProfileId = legacyProfileIdFromCandidate(candidate);
    if (legacyProfileId) {
      store.putTombstone(buildPersonTombstone({
        id: `ptomb_${stableHash(["legacy_profile", legacyProfileId, review.state])}`,
        subjectId: legacyProfileId,
        subjectType: "legacy_profile",
        review,
        evidenceRefs: candidate.evidenceRefs,
        sourceSession: session,
        legacyRefs: candidate.legacyRefs,
        metadata: { candidateId: candidate.id },
      }));
    }
  }

  private async bestEffortLegacyUpdate(
    profile: PersonProfile,
    input: {
      name?: string | null;
    },
  ): Promise<void> {
    const legacyProfileId = legacyProfileIdFromProfile(profile);
    if (!legacyProfileId) return;
    if (!input.name || input.name.trim().length === 0) return;
    await this.legacy.update({
      personId: legacyProfileId,
      name: input.name,
    }).catch(() => undefined);
  }

  private profileOrThrow(personId: string): PersonProfile {
    const profile = this.personStoreOrThrow().getProfile(personId);
    if (!profile) {
      throw new PersonServiceError("NOT_FOUND", "Person profile was not found in the local person store.");
    }
    return profile;
  }

  private assertNoTombstone(subjectId: string, message: string): void {
    if (!this.personStore?.getTombstone(subjectId)) return;
    throw new PersonServiceError("INVALID_REQUEST", message);
  }

  private personStoreOrThrow(): PersonStore {
    if (!this.personStore) {
      throw new PersonServiceError("NOT_IMPLEMENTED", "Person store is not configured.");
    }
    return this.personStore;
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

function legacyProfileIdFromProfile(profile: PersonProfile): string | undefined {
  const metadataId = stringOrUndefined(profile.metadata.deepfaceProfileId);
  if (metadataId) return metadataId;
  const ref = profile.legacyRefs.find((item): item is LegacyPersonRef & { profileId: string } =>
    item.system === "deepface" && typeof item.profileId === "string" && item.profileId.trim().length > 0
  );
  return ref?.profileId;
}

function legacyThumbnailsById(rawProfiles: unknown[]): Map<string, string> {
  const thumbnails = new Map<string, string>();
  for (const raw of rawProfiles) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = stringOrUndefined(record.id);
    const thumbnail = typeof record.thumbnail === "string" && record.thumbnail.length > 0 && record.thumbnail.length < 400_000
      ? record.thumbnail
      : undefined;
    if (id && thumbnail) thumbnails.set(id, thumbnail);
  }
  return thumbnails;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function isTerminalReview(state: string | undefined): boolean {
  return state === "rejected" || state === "suppressed" || state === "deleted";
}
