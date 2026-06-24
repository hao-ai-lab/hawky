import {
  makeVoiceprintRecordId,
  type IsoTime,
  type RecordId,
  type RetentionClass,
  type SpeechTurn,
} from "./contracts.js";
import { voiceprintModelIdentityParts } from "./model.js";
import type { VoiceprintAudioQualityStatus } from "./quality.js";
import {
  isUsableEmbeddingVector,
  meanVector,
} from "./similarity.js";
import { resolveVoiceprintThresholds } from "./thresholds.js";
import type {
  VoiceprintModelInfo,
  VoiceprintThresholds,
} from "./types.js";

export type VoiceprintTemplateSubject =
  | { type: "owner" }
  | { type: "unknown_cluster"; id: RecordId };

export type VoiceprintEnrollmentQuality = "good" | "marginal";

export interface VoiceprintEnrollmentSource {
  artifactId: RecordId;
  embedding: number[];
  speechMs?: number;
  startMs?: number;
  endMs?: number;
  route?: SpeechTurn["route"];
  qualityStatus?: VoiceprintAudioQualityStatus;
}

export interface VoiceprintTemplateStorageRef {
  templateUri: string;
  encrypted: true;
  localOnly: true;
  keyRef: string;
}

export interface VoiceprintTemplate {
  version: 1;
  id: RecordId;
  subject: VoiceprintTemplateSubject;
  model: VoiceprintModelInfo;
  embeddingDim: number;
  enrollment: {
    createdAt: IsoTime;
    sourceArtifactIds: RecordId[];
    speechMs: number;
    quality: VoiceprintEnrollmentQuality;
    sourceCount: number;
    route?: SpeechTurn["route"];
  };
  storage: VoiceprintTemplateStorageRef;
  thresholds: VoiceprintThresholds;
  retention: RetentionClass;
  deletedAt?: IsoTime;
}

export interface VoiceprintTemplateArtifact {
  version: 1;
  template: VoiceprintTemplate;
  centroid: number[];
  sourceEmbeddingCount: number;
}

export interface VoiceprintEnrollmentAssessment {
  status: "accepted" | "rejected";
  reasons: string[];
  speechMs: number;
  sourceCount: number;
  quality: VoiceprintEnrollmentQuality | "rejected";
  embeddingDim?: number;
  centroid?: number[];
}

export const DEFAULT_OWNER_VOICEPRINT_ENROLLMENT_MIN_SPEECH_MS = 30_000;

export function assessVoiceprintEnrollment(input: {
  sources: readonly VoiceprintEnrollmentSource[];
  minSpeechMs?: number;
}): VoiceprintEnrollmentAssessment {
  const minSpeechMs =
    input.minSpeechMs ?? DEFAULT_OWNER_VOICEPRINT_ENROLLMENT_MIN_SPEECH_MS;
  validateNonNegativeFiniteNumber(minSpeechMs, "minSpeechMs");
  validateEnrollmentSources(input.sources);

  const speechMs = input.sources.reduce(
    (sum, source) => sum + speechMsForSource(source),
    0,
  );
  const embeddings = input.sources.map((source) => source.embedding);
  const centroid = meanVector(embeddings);
  const reasons: string[] = [];

  if (speechMs < minSpeechMs) {
    reasons.push("not_enough_speech");
  }
  if (input.sources.some((source) => source.qualityStatus === "rejected")) {
    reasons.push("quality_rejected");
  }

  const rejected = reasons.length > 0;
  const quality = rejected
    ? "rejected"
    : input.sources.some((source) => source.qualityStatus === "marginal")
      ? "marginal"
      : "good";

  return {
    status: rejected ? "rejected" : "accepted",
    reasons,
    speechMs,
    sourceCount: input.sources.length,
    quality,
    embeddingDim: centroid.length,
    centroid: rejected ? undefined : centroid,
  };
}

export function buildVoiceprintTemplateArtifact(input: {
  subject?: VoiceprintTemplateSubject;
  model: VoiceprintModelInfo;
  sources: readonly VoiceprintEnrollmentSource[];
  storage: VoiceprintTemplateStorageRef;
  thresholds?: Partial<VoiceprintThresholds>;
  retention?: RetentionClass;
  createdAt?: IsoTime;
  minSpeechMs?: number;
}): VoiceprintTemplateArtifact {
  validateModel(input.model);
  validateTemplateStorage(input.storage);
  const thresholds = resolveVoiceprintThresholds(input.thresholds);
  const assessment = assessVoiceprintEnrollment({
    sources: input.sources,
    minSpeechMs: input.minSpeechMs,
  });
  if (
    assessment.status !== "accepted" ||
    !assessment.centroid ||
    !assessment.embeddingDim ||
    assessment.quality === "rejected"
  ) {
    throw new Error(
      `Cannot build voiceprint template from rejected enrollment: ${assessment.reasons.join(", ") || "unknown"}.`,
    );
  }

  const subject = input.subject ?? { type: "owner" };
  validateTemplateSubject(subject);
  const createdAt = input.createdAt ?? new Date().toISOString();
  validateIsoLikeTime(createdAt, "createdAt");
  const sourceArtifactIds = input.sources.map((source) => source.artifactId.trim());
  const route = singleEnrollmentRoute(input.sources);
  const id = makeVoiceprintRecordId("vptemplate", [
    subject,
    voiceprintModelIdentityParts(input.model),
    assessment.embeddingDim,
    sourceArtifactIds,
    assessment.centroid,
    thresholds,
    createdAt,
  ]);

  return {
    version: 1,
    template: {
      version: 1,
      id,
      subject,
      model: input.model,
      embeddingDim: assessment.embeddingDim,
      enrollment: {
        createdAt,
        sourceArtifactIds,
        speechMs: assessment.speechMs,
        quality: assessment.quality,
        sourceCount: assessment.sourceCount,
        route,
      },
      storage: input.storage,
      thresholds,
      retention: input.retention ?? "durable",
    },
    centroid: assessment.centroid,
    sourceEmbeddingCount: assessment.sourceCount,
  };
}

export function ownerEmbeddingsFromVoiceprintTemplateArtifact(
  artifact: VoiceprintTemplateArtifact,
): number[][] {
  validateVoiceprintTemplateArtifact(artifact);
  if (artifact.template.subject.type !== "owner") {
    throw new Error("Voiceprint owner embeddings require an owner template.");
  }
  assertVoiceprintTemplateActive(artifact.template);
  return [artifact.centroid.slice()];
}

export function tombstoneVoiceprintTemplate(
  template: VoiceprintTemplate,
  deletedAt: IsoTime = new Date().toISOString(),
): VoiceprintTemplate {
  validateVoiceprintTemplate(template);
  validateIsoLikeTime(deletedAt, "deletedAt");
  return {
    ...template,
    deletedAt,
  };
}

export function assertVoiceprintTemplateActive(template: VoiceprintTemplate): void {
  validateVoiceprintTemplate(template);
  if (template.deletedAt) {
    throw new Error("Voiceprint template has been deleted.");
  }
}

export function validateVoiceprintTemplateArtifact(
  artifact: VoiceprintTemplateArtifact,
): void {
  if (artifact.version !== 1) {
    throw new Error("Voiceprint template artifact version must be 1.");
  }
  validateVoiceprintTemplate(artifact.template);
  if (!isUsableEmbeddingVector(artifact.centroid)) {
    throw new Error("Voiceprint template artifact requires a usable centroid.");
  }
  if (artifact.centroid.length !== artifact.template.embeddingDim) {
    throw new Error("Voiceprint template centroid dimension does not match template metadata.");
  }
  if (artifact.sourceEmbeddingCount !== artifact.template.enrollment.sourceCount) {
    throw new Error("Voiceprint template source count does not match artifact metadata.");
  }
}

export function validateVoiceprintTemplate(template: VoiceprintTemplate): void {
  if (template.version !== 1) {
    throw new Error("Voiceprint template version must be 1.");
  }
  if (!template.id.trim()) {
    throw new Error("Voiceprint template requires id.");
  }
  validateTemplateSubject(template.subject);
  validateModel(template.model);
  validatePositiveInteger(template.embeddingDim, "embeddingDim");
  validateIsoLikeTime(template.enrollment.createdAt, "enrollment.createdAt");
  if (template.enrollment.sourceCount <= 0) {
    throw new Error("Voiceprint template requires at least one enrollment source.");
  }
  validateNonNegativeFiniteNumber(template.enrollment.speechMs, "enrollment.speechMs");
  if (!["good", "marginal"].includes(template.enrollment.quality)) {
    throw new Error("Voiceprint template enrollment quality must be good or marginal.");
  }
  validateTemplateStorage(template.storage);
  resolveVoiceprintThresholds(template.thresholds);
  if (template.deletedAt) {
    validateIsoLikeTime(template.deletedAt, "deletedAt");
  }
}

function validateEnrollmentSources(sources: readonly VoiceprintEnrollmentSource[]): void {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("Voiceprint enrollment requires at least one source.");
  }
  const seenArtifactIds = new Set<string>();
  let dim: number | undefined;
  for (const [index, source] of sources.entries()) {
    const artifactId = source.artifactId?.trim();
    if (!artifactId) {
      throw new Error(`Voiceprint enrollment source at index ${index} requires artifactId.`);
    }
    if (seenArtifactIds.has(artifactId)) {
      throw new Error(`Duplicate voiceprint enrollment artifact id: ${artifactId}.`);
    }
    seenArtifactIds.add(artifactId);
    if (!isUsableEmbeddingVector(source.embedding)) {
      throw new Error(`Voiceprint enrollment source "${artifactId}" has an unusable embedding.`);
    }
    dim ??= source.embedding.length;
    if (source.embedding.length !== dim) {
      throw new Error("Voiceprint enrollment embeddings must have consistent dimensions.");
    }
    speechMsForSource(source);
  }
}

function speechMsForSource(source: VoiceprintEnrollmentSource): number {
  if (source.speechMs !== undefined) {
    validateNonNegativeFiniteNumber(source.speechMs, `speechMs for ${source.artifactId}`);
    return source.speechMs;
  }
  if (source.startMs !== undefined || source.endMs !== undefined) {
    validateNonNegativeFiniteNumber(source.startMs, `startMs for ${source.artifactId}`);
    validateNonNegativeFiniteNumber(source.endMs, `endMs for ${source.artifactId}`);
    if (source.endMs! <= source.startMs!) {
      throw new Error(`Voiceprint enrollment source "${source.artifactId}" requires endMs > startMs.`);
    }
    return source.endMs! - source.startMs!;
  }
  throw new Error(`Voiceprint enrollment source "${source.artifactId}" requires speechMs or startMs/endMs.`);
}

function singleEnrollmentRoute(
  sources: readonly VoiceprintEnrollmentSource[],
): SpeechTurn["route"] | undefined {
  const routes = new Set(
    sources
      .map((source) => source.route?.trim())
      .filter((route): route is string => Boolean(route)),
  );
  return routes.size === 1 ? [...routes][0] : undefined;
}

function validateTemplateSubject(subject: VoiceprintTemplateSubject): void {
  if (subject.type === "owner") {
    return;
  }
  if (subject.type === "unknown_cluster" && subject.id.trim()) {
    return;
  }
  throw new Error("Voiceprint template subject is invalid.");
}

function validateModel(model: VoiceprintModelInfo): void {
  if (!model.provider || !model.modelId?.trim()) {
    throw new Error("Voiceprint template requires model provider and modelId.");
  }
}

function validateTemplateStorage(storage: VoiceprintTemplateStorageRef): void {
  if (!storage.templateUri.trim()) {
    throw new Error("Voiceprint template storage requires templateUri.");
  }
  if (!storage.keyRef.trim()) {
    throw new Error("Voiceprint template storage requires keyRef.");
  }
  if (storage.encrypted !== true || storage.localOnly !== true) {
    throw new Error("Voiceprint template storage must be encrypted and local-only.");
  }
}

function validateIsoLikeTime(value: string, field: string): void {
  if (!value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`Voiceprint template ${field} must be an ISO timestamp.`);
  }
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Voiceprint template ${field} must be a positive integer.`);
  }
}

function validateNonNegativeFiniteNumber(
  value: number | undefined,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Voiceprint template ${field} must be a non-negative finite number.`);
  }
}
