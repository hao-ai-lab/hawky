// JSON Schema descriptors for the identity-core contracts. NOTE: these are
// descriptive only — the authoritative RUNTIME guard is the imperative
// assertIdentitySignalBase() in contracts.ts (which also enforces cross-field
// rules JSON Schema can't express, e.g. endMs > startMs and "has an inspectable
// evidence pointer"). Nothing currently validates objects against these schemas;
// they exist for export/tooling. Before wiring a real validator, add fixtures
// that prove these schemas agree with assertIdentitySignalBase, or drop them.
import {
  EVIDENCE_REF_TYPES,
  IDENTITY_ALLOWED_USE_KEYS,
  IDENTITY_CORE_SCHEMA_VERSION,
  IDENTITY_MODALITIES,
  IDENTITY_SIGNAL_SENSITIVITIES,
  IDENTITY_SIGNAL_SOURCES,
  RETENTION_CLASSES,
  REVIEW_STATES,
} from "./contracts.js";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: readonly unknown[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  const?: unknown;
}

const stringSchema: JsonSchema = { type: "string" };
const numberSchema: JsonSchema = { type: "number" };

export const identityAllowedUsesSchema: JsonSchema = {
  type: "object",
  required: [...IDENTITY_ALLOWED_USE_KEYS],
  additionalProperties: false,
  properties: Object.fromEntries(
    IDENTITY_ALLOWED_USE_KEYS.map((key) => [key, { type: "boolean" } satisfies JsonSchema]),
  ),
};

export const sourceSessionRefSchema: JsonSchema = {
  type: "object",
  required: ["sessionKey"],
  additionalProperties: false,
  properties: {
    sessionKey: stringSchema,
    sessionId: stringSchema,
    channelId: stringSchema,
    participantId: stringSchema,
    startedAt: stringSchema,
    endedAt: stringSchema,
  },
};

export const evidenceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string", enum: EVIDENCE_REF_TYPES },
    id: stringSchema,
    artifactId: stringSchema,
    sessionKey: stringSchema,
    transcriptItemId: stringSchema,
    transcriptRange: {
      type: "object",
      required: ["startMs", "endMs"],
      additionalProperties: false,
      properties: { startMs: numberSchema, endMs: numberSchema },
    },
    textRange: {
      type: "object",
      required: ["start", "end"],
      additionalProperties: false,
      properties: { start: numberSchema, end: numberSchema },
    },
    frameId: stringSchema,
    imageRegion: {
      type: "object",
      required: ["x", "y", "width", "height"],
      additionalProperties: false,
      properties: {
        x: numberSchema,
        y: numberSchema,
        width: numberSchema,
        height: numberSchema,
      },
    },
    excerptHash: stringSchema,
    uri: stringSchema,
    label: stringSchema,
    sourceSession: sourceSessionRefSchema,
    metadata: { type: "object", additionalProperties: true },
  },
};

export const identitySubjectSchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: { type: { const: "owner" } },
    },
    {
      type: "object",
      required: ["type", "personId"],
      additionalProperties: false,
      properties: { type: { const: "person" }, personId: stringSchema },
    },
    {
      type: "object",
      required: ["type", "candidateId"],
      additionalProperties: false,
      properties: { type: { const: "person_candidate" }, candidateId: stringSchema },
    },
    {
      type: "object",
      required: ["type", "id"],
      additionalProperties: false,
      properties: {
        type: { const: "unknown_cluster" },
        id: stringSchema,
        modality: { type: "string", enum: IDENTITY_MODALITIES },
      },
    },
    {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { const: "unknown_person" },
        modality: { type: "string", enum: IDENTITY_MODALITIES },
      },
    },
    {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: { type: { const: "unknown_speaker" } },
    },
    {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: { type: { const: "device_owner_context" } },
    },
  ],
};

export const reviewRecordSchema: JsonSchema = {
  type: "object",
  required: ["state"],
  additionalProperties: false,
  properties: {
    state: { type: "string", enum: REVIEW_STATES },
    reviewedAt: stringSchema,
    reviewer: { type: "string", enum: ["owner", "system", "developer", "import"] },
    reason: stringSchema,
  },
};

export const identitySignalStorageSchema: JsonSchema = {
  type: "object",
  required: ["encrypted", "localOnly"],
  additionalProperties: false,
  properties: {
    encrypted: { type: "boolean" },
    localOnly: { type: "boolean" },
    templateUri: stringSchema,
    keyRef: stringSchema,
    rawArtifactRetained: { type: "boolean" },
  },
};

export const identitySignalBaseSchema: JsonSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "id",
    "createdAt",
    "updatedAt",
    "signalType",
    "source",
    "modality",
    "subject",
    "evidenceRefs",
    "confidence",
    "sensitivity",
    "retention",
    "review",
    "allowedUses",
    "metadata",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: IDENTITY_CORE_SCHEMA_VERSION },
    id: stringSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    signalType: stringSchema,
    source: { type: "string", enum: IDENTITY_SIGNAL_SOURCES },
    modality: { type: "string", enum: IDENTITY_MODALITIES },
    subject: identitySubjectSchema,
    evidenceRefs: { type: "array", items: evidenceRefSchema },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    thresholdUsed: { type: "number" },
    sensitivity: { type: "string", enum: IDENTITY_SIGNAL_SENSITIVITIES },
    sourceSession: sourceSessionRefSchema,
    consent: { type: "object", additionalProperties: true },
    storage: identitySignalStorageSchema,
    retention: { type: "string", enum: RETENTION_CLASSES },
    review: reviewRecordSchema,
    allowedUses: identityAllowedUsesSchema,
    expiresAt: stringSchema,
    metadata: { type: "object", additionalProperties: true },
  },
};
