import { assertIdentitySignalAllowedUsesSafe } from "./policy.js";

export const IDENTITY_CORE_SCHEMA_VERSION = 1 as const;

export type RecordId = string;
export type IsoTime = string;

export const RETENTION_CLASSES = [
  "ephemeral",
  "session",
  "rolling_7d",
  "rolling_30d",
  "durable",
  "delete_on_close",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const REVIEW_STATES = [
  "unreviewed",
  "confirmed",
  "rejected",
  "suppressed",
  "expired",
  "deleted",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const IDENTITY_SIGNAL_SENSITIVITIES = [
  "public",
  "private",
  "sensitive",
  "biometric",
] as const;
export type IdentitySignalSensitivity = (typeof IDENTITY_SIGNAL_SENSITIVITIES)[number];

export const IDENTITY_MODALITIES = [
  "face",
  "voice",
  "text",
  "device",
  "manual",
  "context",
  "multimodal",
  "unknown",
] as const;
export type IdentityModality = (typeof IDENTITY_MODALITIES)[number];

export const IDENTITY_SIGNAL_SOURCES = [
  "face",
  "voiceprint",
  "manual_introduction",
  "heard_name",
  "device_context",
  "contact_hint",
  "social_hint",
  "memory",
  "tool",
  "other",
] as const;
export type IdentitySignalSource = (typeof IDENTITY_SIGNAL_SOURCES)[number];

export const EVIDENCE_REF_TYPES = [
  "artifact",
  "transcript",
  "frame",
  "image",
  "audio",
  "manual",
  "tool_result",
  "memory",
  "session",
] as const;
export type EvidenceRefType = (typeof EVIDENCE_REF_TYPES)[number];

export const IDENTITY_ALLOWED_USE_KEYS = [
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
] as const;
export type IdentityAllowedUseKey = (typeof IDENTITY_ALLOWED_USE_KEYS)[number];
export type IdentityAllowedUses = Record<IdentityAllowedUseKey, boolean>;

export interface SourceSessionRef {
  sessionKey: string;
  sessionId?: string;
  channelId?: string;
  participantId?: string;
  startedAt?: IsoTime;
  endedAt?: IsoTime;
}

export interface EvidenceRef {
  type?: EvidenceRefType;
  id?: RecordId;
  artifactId?: RecordId;
  sessionKey?: string;
  transcriptItemId?: string;
  transcriptRange?: { startMs: number; endMs: number };
  textRange?: { start: number; end: number };
  frameId?: RecordId;
  imageRegion?: { x: number; y: number; width: number; height: number };
  excerptHash?: string;
  uri?: string;
  label?: string;
  sourceSession?: SourceSessionRef;
  metadata?: Record<string, unknown>;
}

export type IdentitySubject =
  | { type: "owner" }
  | { type: "person"; personId: RecordId }
  | { type: "person_candidate"; candidateId: RecordId }
  | { type: "unknown_cluster"; id: RecordId; modality?: IdentityModality }
  | { type: "unknown_person"; modality?: IdentityModality }
  | { type: "unknown_speaker" }
  | { type: "device_owner_context" };

export interface ReviewRecord {
  state: ReviewState;
  reviewedAt?: IsoTime;
  reviewer?: "owner" | "system" | "developer" | "import";
  reason?: string;
}

export interface IdentitySignalStorage {
  encrypted: boolean;
  localOnly: boolean;
  templateUri?: string;
  keyRef?: string;
  rawArtifactRetained?: boolean;
}

export interface IdentitySignalBase<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TConsent extends Record<string, unknown> = Record<string, unknown>,
> {
  schemaVersion: typeof IDENTITY_CORE_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  signalType: string;
  source: IdentitySignalSource;
  modality: IdentityModality;
  subject: IdentitySubject;
  evidenceRefs: EvidenceRef[];
  confidence: number;
  thresholdUsed?: number;
  sensitivity: IdentitySignalSensitivity;
  sourceSession?: SourceSessionRef;
  consent?: TConsent;
  storage?: IdentitySignalStorage;
  retention: RetentionClass;
  review: ReviewRecord;
  allowedUses: IdentityAllowedUses;
  expiresAt?: IsoTime;
  metadata: TMetadata;
}

export interface BuildIdentitySignalBaseInput<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TConsent extends Record<string, unknown> = Record<string, unknown>,
> {
  id: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  signalType: string;
  source: IdentitySignalSource;
  modality: IdentityModality;
  subject: IdentitySubject;
  evidenceRefs?: EvidenceRef[];
  confidence: number;
  thresholdUsed?: number;
  sensitivity: IdentitySignalSensitivity;
  sourceSession?: SourceSessionRef;
  consent?: TConsent;
  storage?: IdentitySignalStorage;
  retention?: RetentionClass;
  review?: ReviewRecord;
  allowedUses?: Partial<IdentityAllowedUses>;
  expiresAt?: IsoTime;
  metadata?: TMetadata;
}

export function makeIdentityAllowedUses(
  overrides: Partial<IdentityAllowedUses> = {},
): IdentityAllowedUses {
  return {
    diagnostics: false,
    tagSession: false,
    transcriptDisplay: false,
    eventGraph: false,
    promoteMemory: false,
    proposeRelationship: false,
    exportContext: false,
    triggerAction: false,
    templateLearning: false,
    profilePromotion: false,
    ...overrides,
  };
}

export function buildIdentitySignalBase<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TConsent extends Record<string, unknown> = Record<string, unknown>,
>(
  input: BuildIdentitySignalBaseInput<TMetadata, TConsent>,
): IdentitySignalBase<TMetadata, TConsent> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const signal: IdentitySignalBase<TMetadata, TConsent> = {
    schemaVersion: IDENTITY_CORE_SCHEMA_VERSION,
    id: input.id,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    signalType: input.signalType,
    source: input.source,
    modality: input.modality,
    subject: input.subject,
    evidenceRefs: input.evidenceRefs ?? [],
    confidence: input.confidence,
    thresholdUsed: input.thresholdUsed,
    sensitivity: input.sensitivity,
    sourceSession: input.sourceSession,
    consent: input.consent,
    storage: input.storage,
    retention: input.retention ?? "session",
    review: input.review ?? { state: "unreviewed" },
    allowedUses: makeIdentityAllowedUses(input.allowedUses),
    expiresAt: input.expiresAt,
    metadata: input.metadata ?? ({} as TMetadata),
  };
  assertIdentitySignalBase(signal);
  // Enforce the authorization invariant at construction, not just structurally.
  // Previously a caller could build a fully-valid signal with an unsafe
  // allowedUses combination (e.g. promoteMemory/templateLearning on an
  // unconfirmed subject) because nothing called this. Imported lazily to avoid a
  // load-time circular dependency with ./policy (both runtime values are only
  // ever invoked inside function bodies, so the ESM cycle is benign).
  assertIdentitySignalAllowedUsesSafe(signal);
  return signal;
}

export function assertIdentitySignalBase(value: unknown): asserts value is IdentitySignalBase {
  const signal = record(value, "IdentitySignalBase");
  if (signal.schemaVersion !== IDENTITY_CORE_SCHEMA_VERSION) {
    throw new Error("IdentitySignalBase requires schemaVersion 1.");
  }
  requireNonEmptyString(signal.id, "id");
  requireNonEmptyString(signal.createdAt, "createdAt");
  requireNonEmptyString(signal.updatedAt, "updatedAt");
  requireNonEmptyString(signal.signalType, "signalType");
  requireOneOf(signal.source, IDENTITY_SIGNAL_SOURCES, "source");
  requireOneOf(signal.modality, IDENTITY_MODALITIES, "modality");
  requireOneOf(signal.sensitivity, IDENTITY_SIGNAL_SENSITIVITIES, "sensitivity");
  requireOneOf(signal.retention, RETENTION_CLASSES, "retention");
  requireConfidence(signal.confidence, "confidence");
  if (signal.thresholdUsed !== undefined) {
    requireFiniteNumber(signal.thresholdUsed, "thresholdUsed");
  }

  const review = record(signal.review, "review");
  requireOneOf(review.state, REVIEW_STATES, "review.state");
  validateSubject(signal.subject);
  validateAllowedUses(signal.allowedUses);
  validateEvidenceRefs(signal.evidenceRefs);

  const sourceSession = signal.sourceSession;
  if (sourceSession !== undefined) {
    validateSourceSession(sourceSession, "sourceSession");
  }
  if ((signal.evidenceRefs as EvidenceRef[]).length === 0 && !sourceSession) {
    throw new Error("IdentitySignalBase requires evidenceRefs or sourceSession.");
  }
  record(signal.metadata, "metadata");
}

function validateSubject(value: unknown): void {
  const subject = record(value, "subject");
  switch (subject.type) {
    case "owner":
    case "unknown_speaker":
    case "device_owner_context":
      return;
    case "person":
      requireNonEmptyString(subject.personId, "subject.personId");
      return;
    case "person_candidate":
      requireNonEmptyString(subject.candidateId, "subject.candidateId");
      return;
    case "unknown_cluster":
      requireNonEmptyString(subject.id, "subject.id");
      if (subject.modality !== undefined) {
        requireOneOf(subject.modality, IDENTITY_MODALITIES, "subject.modality");
      }
      return;
    case "unknown_person":
      if (subject.modality !== undefined) {
        requireOneOf(subject.modality, IDENTITY_MODALITIES, "subject.modality");
      }
      return;
    default:
      throw new Error("IdentitySignalBase subject.type is invalid.");
  }
}

function validateAllowedUses(value: unknown): void {
  const allowedUses = record(value, "allowedUses");
  for (const key of IDENTITY_ALLOWED_USE_KEYS) {
    if (typeof allowedUses[key] !== "boolean") {
      throw new Error(`IdentitySignalBase allowedUses.${key} must be boolean.`);
    }
  }
}

function validateEvidenceRefs(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("IdentitySignalBase evidenceRefs must be an array.");
  }
  for (const [index, refValue] of value.entries()) {
    const ref = record(refValue, `evidenceRefs[${index}]`);
    if (ref.type !== undefined) {
      requireOneOf(ref.type, EVIDENCE_REF_TYPES, `evidenceRefs[${index}].type`);
    }
    if (ref.transcriptRange !== undefined) {
      const range = record(ref.transcriptRange, `evidenceRefs[${index}].transcriptRange`);
      requireFiniteNumber(range.startMs, `evidenceRefs[${index}].transcriptRange.startMs`);
      requireFiniteNumber(range.endMs, `evidenceRefs[${index}].transcriptRange.endMs`);
      if ((range.endMs as number) <= (range.startMs as number)) {
        throw new Error(`evidenceRefs[${index}].transcriptRange requires endMs > startMs.`);
      }
    }
    if (ref.textRange !== undefined) {
      const range = record(ref.textRange, `evidenceRefs[${index}].textRange`);
      requireFiniteNumber(range.start, `evidenceRefs[${index}].textRange.start`);
      requireFiniteNumber(range.end, `evidenceRefs[${index}].textRange.end`);
      if ((range.end as number) < (range.start as number)) {
        throw new Error(`evidenceRefs[${index}].textRange requires end >= start.`);
      }
    }
    if (ref.sourceSession !== undefined) {
      validateSourceSession(ref.sourceSession, `evidenceRefs[${index}].sourceSession`);
    }
    if (!hasInspectableEvidenceRef(ref)) {
      throw new Error(
        `IdentitySignalBase evidenceRefs[${index}] requires an inspectable source pointer.`,
      );
    }
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

function validateSourceSession(value: unknown, label: string): void {
  const sourceSession = record(value, label);
  requireNonEmptyString(sourceSession.sessionKey, `${label}.sessionKey`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`IdentitySignalBase ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`IdentitySignalBase requires non-empty ${label}.`);
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function requireFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`IdentitySignalBase ${label} must be finite.`);
  }
}

function requireConfidence(value: unknown, label: string): void {
  requireFiniteNumber(value, label);
  const n = value as number;
  if (n < 0 || n > 1) {
    throw new Error(`IdentitySignalBase ${label} must be between 0 and 1.`);
  }
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new Error(`IdentitySignalBase ${label} is invalid.`);
  }
}
