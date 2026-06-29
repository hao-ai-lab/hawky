import {
  PERSON_RECORD_SCHEMA_VERSION,
  type LegacyPersonRef,
} from "./contracts.js";
import type {
  EvidenceRef,
  IsoTime,
  RecordId,
  ReviewRecord,
  SourceSessionRef,
} from "../core/index.js";

export const PERSON_TOMBSTONE_SUBJECT_TYPES = [
  "person_profile",
  "identity_candidate",
  "legacy_profile",
] as const;
export type PersonTombstoneSubjectType = (typeof PERSON_TOMBSTONE_SUBJECT_TYPES)[number];

export interface PersonTombstone {
  schemaVersion: typeof PERSON_RECORD_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  subjectId: RecordId;
  subjectType: PersonTombstoneSubjectType;
  review: ReviewRecord;
  evidenceRefs: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  legacyRefs: LegacyPersonRef[];
  metadata: Record<string, unknown>;
}

export function buildPersonTombstone(input: {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  subjectId: RecordId;
  subjectType: PersonTombstoneSubjectType;
  review: ReviewRecord;
  evidenceRefs?: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  legacyRefs?: LegacyPersonRef[];
  metadata?: Record<string, unknown>;
}): PersonTombstone {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const tombstone: PersonTombstone = {
    schemaVersion: PERSON_RECORD_SCHEMA_VERSION,
    id: input.id,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    review: input.review,
    evidenceRefs: input.evidenceRefs ?? [],
    sourceSession: input.sourceSession,
    legacyRefs: input.legacyRefs ?? [],
    metadata: input.metadata ?? {},
  };
  assertPersonTombstone(tombstone);
  return tombstone;
}

export function assertPersonTombstone(value: unknown): asserts value is PersonTombstone {
  const tombstone = record(value, "PersonTombstone");
  if (tombstone.schemaVersion !== PERSON_RECORD_SCHEMA_VERSION) {
    throw new Error("PersonTombstone schemaVersion must be 1.");
  }
  requireNonEmptyString(tombstone.id, "id");
  requireNonEmptyString(tombstone.createdAt, "createdAt");
  requireNonEmptyString(tombstone.updatedAt, "updatedAt");
  requireNonEmptyString(tombstone.subjectId, "subjectId");
  requireOneOf(tombstone.subjectType, PERSON_TOMBSTONE_SUBJECT_TYPES, "subjectType");
  validateReview(tombstone.review);
  if (!["rejected", "suppressed", "deleted"].includes(tombstone.review.state)) {
    throw new Error("PersonTombstone review.state must be rejected, suppressed, or deleted.");
  }
  if (!Array.isArray(tombstone.evidenceRefs)) {
    throw new Error("PersonTombstone evidenceRefs must be an array.");
  }
  if (tombstone.sourceSession !== undefined) {
    const session = record(tombstone.sourceSession, "sourceSession");
    requireNonEmptyString(session.sessionKey, "sourceSession.sessionKey");
  }
  if (!Array.isArray(tombstone.legacyRefs)) {
    throw new Error("PersonTombstone legacyRefs must be an array.");
  }
  for (const [index, ref] of tombstone.legacyRefs.entries()) {
    const legacyRef = record(ref, `legacyRefs[${index}]`);
    requireOneOf(legacyRef.system, ["deepface", "other"] as const, `legacyRefs[${index}].system`);
  }
  record(tombstone.metadata, "metadata");
}

function validateReview(value: unknown): asserts value is ReviewRecord {
  const review = record(value, "review");
  requireNonEmptyString(review.state, "review.state");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function requireOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
}
