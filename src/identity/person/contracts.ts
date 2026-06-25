import {
  assertIdentitySignalBase,
  buildIdentitySignalBase,
  makeIdentityAllowedUses,
  type EvidenceRef,
  type IdentityAllowedUses,
  type IdentitySignalBase,
  type IdentitySubject,
  type IsoTime,
  type RecordId,
  type RetentionClass,
  type ReviewRecord,
  type SourceSessionRef,
} from "../core/index.js";

export const PERSON_RECORD_SCHEMA_VERSION = 1 as const;

export const PERSON_RECORD_SOURCES = [
  "manual",
  "memory_distill",
  "face_service",
  "voiceprint",
  "legacy_deepface",
  "import",
  "tool",
  "other",
] as const;
export type PersonRecordSource = (typeof PERSON_RECORD_SOURCES)[number];

export const PERSON_FACT_ORIGINS = [
  "manual",
  "memory_distill",
  "identity_signal",
  "legacy_unverified",
  "import",
] as const;
export type PersonFactOrigin = (typeof PERSON_FACT_ORIGINS)[number];

export const PERSON_PROFILE_STATES = [
  "active",
  "merged",
  "deleted",
] as const;
export type PersonProfileState = (typeof PERSON_PROFILE_STATES)[number];

export const IDENTITY_CANDIDATE_TYPES = [
  "unknown_face",
  "unknown_voice",
  "manual_candidate",
  "merged_identity",
] as const;
export type IdentityCandidateType = (typeof IDENTITY_CANDIDATE_TYPES)[number];

export const FACE_IDENTITY_SIGNAL_TYPES = [
  "face_match",
  "face_enrollment",
  "face_candidate",
  "legacy_face_profile",
] as const;
export type FaceIdentitySignalType = (typeof FACE_IDENTITY_SIGNAL_TYPES)[number];

export interface PersonRecordAllowedUses {
  profileDisplay: boolean;
  memoryDistillRead: boolean;
  contextExport: boolean;
}

export interface LegacyPersonRef {
  system: "deepface" | "other";
  profileId?: RecordId;
  uri?: string;
}

export interface PersonProfile {
  schemaVersion: typeof PERSON_RECORD_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  displayName: string;
  aliases: string[];
  state: PersonProfileState;
  source: PersonRecordSource;
  evidenceRefs: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  confidence: number;
  review: ReviewRecord;
  allowedUses: PersonRecordAllowedUses;
  legacyRefs: LegacyPersonRef[];
  metadata: Record<string, unknown>;
}

export interface PersonFact {
  schemaVersion: typeof PERSON_RECORD_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  personId: RecordId;
  text: string;
  origin: PersonFactOrigin;
  source: PersonRecordSource;
  evidenceRefs: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  sourceSignalIds: RecordId[];
  confidence: number;
  sensitivity: "public" | "private" | "sensitive";
  retention: RetentionClass;
  review: ReviewRecord;
  allowedUses: PersonRecordAllowedUses;
  legacyRefs: LegacyPersonRef[];
  metadata: Record<string, unknown>;
}

export interface PersonRecap {
  schemaVersion: typeof PERSON_RECORD_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  personId: RecordId;
  summary: string;
  at?: IsoTime;
  origin: PersonFactOrigin;
  source: PersonRecordSource;
  evidenceRefs: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  sourceSignalIds: RecordId[];
  confidence: number;
  retention: RetentionClass;
  review: ReviewRecord;
  allowedUses: PersonRecordAllowedUses;
  legacyRefs: LegacyPersonRef[];
  metadata: Record<string, unknown>;
}

export interface IdentityCandidate {
  schemaVersion: typeof PERSON_RECORD_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  candidateType: IdentityCandidateType;
  modalities: Array<"face" | "voice" | "manual" | "multimodal">;
  label?: string;
  source: PersonRecordSource;
  evidenceRefs: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  confidence: number;
  review: ReviewRecord;
  allowedUses: IdentityAllowedUses;
  legacyRefs: LegacyPersonRef[];
  metadata: Record<string, unknown>;
}

export interface FaceIdentitySignalMetadata extends Record<string, unknown> {
  source: "face";
  service?: "deepface" | "other";
  model?: string;
  deepfaceProfileId?: RecordId;
  candidateId?: RecordId;
  personId?: RecordId;
  similarity?: number;
  imageRegion?: EvidenceRef["imageRegion"];
  legacy?: boolean;
}

export interface FaceIdentityConsent extends Record<string, unknown> {
  captureAllowed?: boolean;
  identityProcessingAllowed?: boolean;
  profilePromotionAllowed?: boolean;
}

export type FaceIdentitySignal = IdentitySignalBase<
  FaceIdentitySignalMetadata,
  FaceIdentityConsent
> & {
  signalType: FaceIdentitySignalType;
  source: "face";
  modality: "face";
  sensitivity: "biometric";
};

export function makePersonRecordAllowedUses(
  overrides: Partial<PersonRecordAllowedUses> = {},
): PersonRecordAllowedUses {
  return {
    profileDisplay: false,
    memoryDistillRead: false,
    contextExport: false,
    ...overrides,
  };
}

export function buildPersonProfile(input: {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  displayName: string;
  aliases?: string[];
  state?: PersonProfileState;
  source: PersonRecordSource;
  evidenceRefs?: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  confidence: number;
  review?: ReviewRecord;
  allowedUses?: Partial<PersonRecordAllowedUses>;
  legacyRefs?: LegacyPersonRef[];
  metadata?: Record<string, unknown>;
}): PersonProfile {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const profile: PersonProfile = {
    schemaVersion: PERSON_RECORD_SCHEMA_VERSION,
    id: input.id,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    displayName: input.displayName,
    aliases: input.aliases ?? [],
    state: input.state ?? "active",
    source: input.source,
    evidenceRefs: input.evidenceRefs ?? [],
    sourceSession: input.sourceSession,
    confidence: input.confidence,
    review: input.review ?? { state: "unreviewed" },
    allowedUses: makePersonRecordAllowedUses(input.allowedUses),
    legacyRefs: input.legacyRefs ?? [],
    metadata: input.metadata ?? {},
  };
  assertPersonProfile(profile);
  return profile;
}

export function buildPersonFact(input: {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  personId: RecordId;
  text: string;
  origin: PersonFactOrigin;
  source: PersonRecordSource;
  evidenceRefs?: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  sourceSignalIds?: RecordId[];
  confidence: number;
  sensitivity?: PersonFact["sensitivity"];
  retention?: RetentionClass;
  review?: ReviewRecord;
  allowedUses?: Partial<PersonRecordAllowedUses>;
  legacyRefs?: LegacyPersonRef[];
  metadata?: Record<string, unknown>;
}): PersonFact {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const fact: PersonFact = {
    schemaVersion: PERSON_RECORD_SCHEMA_VERSION,
    id: input.id,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    personId: input.personId,
    text: input.text,
    origin: input.origin,
    source: input.source,
    evidenceRefs: input.evidenceRefs ?? [],
    sourceSession: input.sourceSession,
    sourceSignalIds: input.sourceSignalIds ?? [],
    confidence: input.confidence,
    sensitivity: input.sensitivity ?? "private",
    retention: input.retention ?? "durable",
    review: input.review ?? { state: "unreviewed" },
    allowedUses: makePersonRecordAllowedUses(input.allowedUses),
    legacyRefs: input.legacyRefs ?? [],
    metadata: input.metadata ?? {},
  };
  assertPersonFact(fact);
  return fact;
}

export function buildPersonRecap(input: {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  personId: RecordId;
  summary: string;
  at?: IsoTime;
  origin: PersonFactOrigin;
  source: PersonRecordSource;
  evidenceRefs?: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  sourceSignalIds?: RecordId[];
  confidence: number;
  retention?: RetentionClass;
  review?: ReviewRecord;
  allowedUses?: Partial<PersonRecordAllowedUses>;
  legacyRefs?: LegacyPersonRef[];
  metadata?: Record<string, unknown>;
}): PersonRecap {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const recap: PersonRecap = {
    schemaVersion: PERSON_RECORD_SCHEMA_VERSION,
    id: input.id,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    personId: input.personId,
    summary: input.summary,
    at: input.at,
    origin: input.origin,
    source: input.source,
    evidenceRefs: input.evidenceRefs ?? [],
    sourceSession: input.sourceSession,
    sourceSignalIds: input.sourceSignalIds ?? [],
    confidence: input.confidence,
    retention: input.retention ?? "durable",
    review: input.review ?? { state: "unreviewed" },
    allowedUses: makePersonRecordAllowedUses(input.allowedUses),
    legacyRefs: input.legacyRefs ?? [],
    metadata: input.metadata ?? {},
  };
  assertPersonRecap(recap);
  return recap;
}

export function buildIdentityCandidate(input: {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  candidateType: IdentityCandidateType;
  modalities: IdentityCandidate["modalities"];
  label?: string;
  source: PersonRecordSource;
  evidenceRefs?: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  confidence: number;
  review?: ReviewRecord;
  allowedUses?: Partial<IdentityAllowedUses>;
  legacyRefs?: LegacyPersonRef[];
  metadata?: Record<string, unknown>;
}): IdentityCandidate {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const candidate: IdentityCandidate = {
    schemaVersion: PERSON_RECORD_SCHEMA_VERSION,
    id: input.id,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    candidateType: input.candidateType,
    modalities: input.modalities,
    label: input.label,
    source: input.source,
    evidenceRefs: input.evidenceRefs ?? [],
    sourceSession: input.sourceSession,
    confidence: input.confidence,
    review: input.review ?? { state: "unreviewed" },
    allowedUses: makeIdentityAllowedUses(input.allowedUses),
    legacyRefs: input.legacyRefs ?? [],
    metadata: input.metadata ?? {},
  };
  assertIdentityCandidate(candidate);
  return candidate;
}

export function buildFaceIdentitySignal(input: {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  signalType: FaceIdentitySignalType;
  subject: IdentitySubject;
  evidenceRefs?: EvidenceRef[];
  sourceSession?: SourceSessionRef;
  confidence: number;
  thresholdUsed?: number;
  retention?: RetentionClass;
  review?: ReviewRecord;
  allowedUses?: Partial<IdentityAllowedUses>;
  consent?: FaceIdentityConsent;
  expiresAt?: IsoTime;
  metadata?: Partial<FaceIdentitySignalMetadata>;
}): FaceIdentitySignal {
  const signal = buildIdentitySignalBase<FaceIdentitySignalMetadata, FaceIdentityConsent>({
    id: input.id,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    signalType: input.signalType,
    source: "face",
    modality: "face",
    subject: input.subject,
    evidenceRefs: input.evidenceRefs,
    sourceSession: input.sourceSession,
    confidence: input.confidence,
    thresholdUsed: input.thresholdUsed,
    sensitivity: "biometric",
    retention: input.retention ?? "session",
    review: input.review,
    allowedUses: input.allowedUses,
    consent: input.consent,
    expiresAt: input.expiresAt,
    metadata: { ...input.metadata, source: "face" },
  }) as FaceIdentitySignal;

  assertFaceIdentitySignal(signal);
  return signal;
}

export function personFactCanBeReadByMemoryDistill(fact: PersonFact): boolean {
  return fact.review.state === "confirmed" && fact.allowedUses.memoryDistillRead;
}

export function personRecapCanBeReadByMemoryDistill(recap: PersonRecap): boolean {
  return recap.review.state === "confirmed" && recap.allowedUses.memoryDistillRead;
}

export function assertPersonProfile(value: unknown): asserts value is PersonProfile {
  const profile = record(value, "PersonProfile");
  requireSchemaVersion(profile);
  requireNonEmptyString(profile.id, "id");
  requireNonEmptyString(profile.createdAt, "createdAt");
  requireNonEmptyString(profile.updatedAt, "updatedAt");
  requireNonEmptyString(profile.displayName, "displayName");
  requireOneOf(profile.state, PERSON_PROFILE_STATES, "state");
  requireOneOf(profile.source, PERSON_RECORD_SOURCES, "source");
  validateStringArray(profile.aliases, "aliases");
  requireConfidence(profile.confidence, "confidence");
  validateReview(profile.review, "review");
  validateEvidenceOrSession(profile.evidenceRefs, profile.sourceSession, "PersonProfile");
  validatePersonRecordAllowedUses(profile.allowedUses);
  validateLegacyRefs(profile.legacyRefs);
  record(profile.metadata, "metadata");
}

export function assertPersonFact(value: unknown): asserts value is PersonFact {
  const fact = record(value, "PersonFact");
  requireSchemaVersion(fact);
  requireNonEmptyString(fact.id, "id");
  requireNonEmptyString(fact.createdAt, "createdAt");
  requireNonEmptyString(fact.updatedAt, "updatedAt");
  requireNonEmptyString(fact.personId, "personId");
  requireNonEmptyString(fact.text, "text");
  requireOneOf(fact.origin, PERSON_FACT_ORIGINS, "origin");
  requireOneOf(fact.source, PERSON_RECORD_SOURCES, "source");
  requireOneOf(fact.sensitivity, ["public", "private", "sensitive"] as const, "sensitivity");
  validateStringArray(fact.sourceSignalIds, "sourceSignalIds");
  requireConfidence(fact.confidence, "confidence");
  validateReview(fact.review, "review");
  validateEvidenceOrSession(fact.evidenceRefs, fact.sourceSession, "PersonFact");
  validatePersonRecordAllowedUses(fact.allowedUses);
  validateLegacyRefs(fact.legacyRefs);
  record(fact.metadata, "metadata");
}

export function assertPersonRecap(value: unknown): asserts value is PersonRecap {
  const recap = record(value, "PersonRecap");
  requireSchemaVersion(recap);
  requireNonEmptyString(recap.id, "id");
  requireNonEmptyString(recap.createdAt, "createdAt");
  requireNonEmptyString(recap.updatedAt, "updatedAt");
  requireNonEmptyString(recap.personId, "personId");
  requireNonEmptyString(recap.summary, "summary");
  requireOneOf(recap.origin, PERSON_FACT_ORIGINS, "origin");
  requireOneOf(recap.source, PERSON_RECORD_SOURCES, "source");
  validateStringArray(recap.sourceSignalIds, "sourceSignalIds");
  requireConfidence(recap.confidence, "confidence");
  validateReview(recap.review, "review");
  validateEvidenceOrSession(recap.evidenceRefs, recap.sourceSession, "PersonRecap");
  validatePersonRecordAllowedUses(recap.allowedUses);
  validateLegacyRefs(recap.legacyRefs);
  record(recap.metadata, "metadata");
}

export function assertIdentityCandidate(value: unknown): asserts value is IdentityCandidate {
  const candidate = record(value, "IdentityCandidate");
  requireSchemaVersion(candidate);
  requireNonEmptyString(candidate.id, "id");
  requireNonEmptyString(candidate.createdAt, "createdAt");
  requireNonEmptyString(candidate.updatedAt, "updatedAt");
  requireOneOf(candidate.candidateType, IDENTITY_CANDIDATE_TYPES, "candidateType");
  if (!Array.isArray(candidate.modalities) || candidate.modalities.length === 0) {
    throw new Error("IdentityCandidate requires at least one modality.");
  }
  for (const [index, modality] of candidate.modalities.entries()) {
    requireOneOf(modality, ["face", "voice", "manual", "multimodal"] as const, `modalities[${index}]`);
  }
  requireOneOf(candidate.source, PERSON_RECORD_SOURCES, "source");
  requireConfidence(candidate.confidence, "confidence");
  validateReview(candidate.review, "review");
  validateEvidenceOrSession(candidate.evidenceRefs, candidate.sourceSession, "IdentityCandidate");
  validateIdentityAllowedUses(candidate.allowedUses);
  validateLegacyRefs(candidate.legacyRefs);
  record(candidate.metadata, "metadata");
}

export function assertFaceIdentitySignal(value: unknown): asserts value is FaceIdentitySignal {
  assertIdentitySignalBase(value);
  const signal = value as FaceIdentitySignal;
  requireOneOf(signal.signalType, FACE_IDENTITY_SIGNAL_TYPES, "signalType");
  if (signal.source !== "face" || signal.modality !== "face" || signal.sensitivity !== "biometric") {
    throw new Error("FaceIdentitySignal must be a biometric face identity signal.");
  }
}

function validatePersonRecordAllowedUses(value: unknown): void {
  const allowedUses = record(value, "allowedUses");
  for (const key of ["profileDisplay", "memoryDistillRead", "contextExport"] as const) {
    if (typeof allowedUses[key] !== "boolean") {
      throw new Error(`PersonRecord allowedUses.${key} must be boolean.`);
    }
  }
}

function validateIdentityAllowedUses(value: unknown): void {
  const allowedUses = record(value, "allowedUses");
  for (const key of [
    "diagnostics",
    "tagSession",
    "transcriptDisplay",
    "eventGraph",
    "promoteMemory",
    "proposeRelationship",
    "exportContext",
    "triggerAction",
    "templateLearning",
    "profilePromotion",
  ] as const) {
    if (typeof allowedUses[key] !== "boolean") {
      throw new Error(`IdentityCandidate allowedUses.${key} must be boolean.`);
    }
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`Person record ${label} must be an array.`);
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new Error(`Person record ${label}[${index}] must be a string.`);
    }
  }
}

function validateEvidenceOrSession(
  evidenceRefs: unknown,
  sourceSession: unknown,
  label: string,
): void {
  if (!Array.isArray(evidenceRefs)) {
    throw new Error(`${label} evidenceRefs must be an array.`);
  }
  for (const [index, refValue] of evidenceRefs.entries()) {
    const ref = record(refValue, `${label}.evidenceRefs[${index}]`);
    if (ref.sourceSession !== undefined) {
      const session = record(ref.sourceSession, `${label}.evidenceRefs[${index}].sourceSession`);
      requireNonEmptyString(
        session.sessionKey,
        `${label}.evidenceRefs[${index}].sourceSession.sessionKey`,
      );
    }
    if (!hasInspectableEvidenceRef(ref)) {
      throw new Error(`${label}.evidenceRefs[${index}] requires an inspectable source pointer.`);
    }
  }
  if (evidenceRefs.length === 0 && sourceSession === undefined) {
    throw new Error(`${label} requires evidenceRefs or sourceSession.`);
  }
  if (sourceSession !== undefined) {
    const session = record(sourceSession, `${label}.sourceSession`);
    requireNonEmptyString(session.sessionKey, "sourceSession.sessionKey");
  }
}

function validateReview(value: unknown, label: string): void {
  const review = record(value, label);
  requireOneOf(
    review.state,
    ["unreviewed", "confirmed", "rejected", "suppressed", "expired", "deleted"] as const,
    `${label}.state`,
  );
}

function validateLegacyRefs(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("legacyRefs must be an array.");
  }
  for (const [index, refValue] of value.entries()) {
    const ref = record(refValue, `legacyRefs[${index}]`);
    requireOneOf(ref.system, ["deepface", "other"] as const, `legacyRefs[${index}].system`);
  }
}

function requireSchemaVersion(value: Record<string, unknown>): void {
  if (value.schemaVersion !== PERSON_RECORD_SCHEMA_VERSION) {
    throw new Error("Person record requires schemaVersion 1.");
  }
}

function hasInspectableEvidenceRef(ref: Record<string, unknown>): boolean {
  return (
    hasNonEmptyString(ref.id) ||
    hasNonEmptyString(ref.artifactId) ||
    hasNonEmptyString(ref.sessionKey) ||
    hasNonEmptyString(ref.transcriptItemId) ||
    hasNonEmptyString(ref.frameId) ||
    hasNonEmptyString(ref.uri) ||
    ref.sourceSession !== undefined
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Person record requires non-empty ${label}.`);
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function requireConfidence(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Person record ${label} must be between 0 and 1.`);
  }
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new Error(`Person record ${label} is invalid.`);
  }
}
