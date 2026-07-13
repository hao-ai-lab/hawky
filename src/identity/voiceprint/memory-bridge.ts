// A9 — Reviewed voiceprint -> memory-candidate BRIDGE (server-side / TS).
//
// THE GAP THIS CLOSES: the voiceprint pipeline (score_turns) builds
// `VoiceprintTurnRecords` into its OWN storage, but nothing feeds a REVIEWED owner
// tag into the person-capsule / memory-candidate / distillation path. This module is
// the missing, PURE bridge: it maps one `VoiceprintTurnRecords` (plus the consent +
// thresholds already resolved onto those records) into a single `MemoryCandidate`
// CONTRIBUTION DECISION, reusing the EXISTING candidate contract (`../memory/candidate`)
// and the EXISTING policy (`./policy`). It reimplements NEITHER.
//
// FAIL-CLOSED IS THE WHOLE POINT. The mapping guarantees:
//   - possible_owner / unknown_cluster / unknown_speaker, or ANY
//     unreviewed/rejected/suppressed/deleted signal -> a QUARANTINED candidate
//     (quarantineReason "unreviewed_identity_signal") with allowedUses.durableMemory
//     === false. NEVER durable.
//   - ONLY a STRONG (score >= ownerAccept), CONSENTED (memoryPromotionAllowed),
//     `owner_speaking` tag whose identitySignal.review.state === "confirmed" AND whose
//     annotation allowedUses PERMIT memoryPromotion (gated strictly through
//     `voiceprintResultCanInfluenceMemory`) MAY yield a promotable candidate.
//   - Missing/partial policy, missing consent, non-finite score, model mismatch, or ANY
//     thrown error inside the mapping -> a quarantined candidate. Never a throw that
//     could crash a caller; never durableMemory === true on any failure path.
//   - The candidate.review.state MIRRORS the source signal review state (never upgrades).
//
// NO SECRETS. The produced candidate must NEVER carry an embedding vector, raw audio,
// an encryption key, or a raw audioPath. `assertVoiceprintMemoryCandidateHasNoSecrets`
// is an ALLOW-LIST guard (mirror of `assertVoiceprintScoreTelemetryHasNoSecrets` and the
// A4 audit guard) that runs on EVERY produced candidate: only a fixed set of metadata
// keys is permitted, so smuggling a vector-shaped/audio/key field is a HARD ERROR. We
// carry only opaque ids, the decision/result, scalar confidence/score, model tags, and
// the sessionKey/transcript joins already present on the records.

import type { MemoryCandidate, MemoryCandidateAllowedUses } from "../../memory/candidate.js";
import { buildMemoryCandidate } from "../../memory/candidate.js";
import type { EvidenceRef, IsoTime, ReviewState, SourceSessionRef } from "../core/index.js";
import type { VoiceprintTurnRecords } from "./contracts.js";
import {
  DEFAULT_VOICEPRINT_THRESHOLDS,
  type VoiceprintThresholds,
} from "./types.js";
import {
  resolveVoiceprintConsent,
  voiceprintResultCanInfluenceMemory,
  type VoiceprintAnnotationAllowedUses,
  type VoiceprintConsentSnapshot,
} from "./policy.js";

/**
 * The allow-listed, NON-SECRET metadata a bridged candidate may carry. Only these
 * keys survive the no-secrets guard: opaque ids, the decision/result, scalar
 * confidence/score, model tags, and the transcript joins already present on the
 * records. NEVER an embedding, audio, key, or raw audioPath.
 */
export interface VoiceprintMemoryCandidateMetadata {
  bridge: "voiceprint_memory_bridge";
  /** The scoring result the source annotation carried. */
  result: string;
  /** The source identity-signal review state, mirrored onto the candidate. */
  reviewState: ReviewState;
  /** Opaque record ids (never biometric). */
  identitySignalId: string;
  speakerTurnTagId: string;
  /** Transcript joins already present on the records. */
  sessionKey: string;
  transcriptItemId: string;
  /** Scalar confidence/score + the threshold it was taken against (never a vector). */
  confidence?: number;
  score?: number;
  thresholdUsed?: number;
  ownerAccept?: number;
  /** Non-secret model provenance tags. */
  modelProvider?: string;
  modelId?: string;
  modelVersion?: string;
  /** Why the candidate was quarantined (mirrors MemoryCandidate.quarantineReason). */
  quarantineReason?: MemoryCandidate["quarantineReason"];
  /** Whether the strict fail-closed gate permitted durable promotion. */
  memoryPromotionGate: boolean;
}

export interface VoiceprintMemoryBridgeOptions {
  /** Override the bridge clock (tests). */
  createdAt?: IsoTime;
  /**
   * The thresholds the score was taken against. When omitted the value is read from
   * the record's `thresholdUsed`, falling back to DEFAULT_VOICEPRINT_THRESHOLDS.
   */
  thresholds?: Partial<VoiceprintThresholds>;
  /**
   * The RESOLVED consent for the subject. When omitted, consent is treated as absent
   * (the default DEFAULT_VOICEPRINT_CONSENT: everything withheld) — which fails closed.
   */
  consent?: Partial<VoiceprintConsentSnapshot>;
}

/**
 * The bridge decision: the produced candidate plus whether the strict fail-closed gate
 * permitted durable promotion, and (on the failure path) why it degraded.
 */
export interface VoiceprintMemoryBridgeResult {
  candidate: MemoryCandidate;
  /** True ONLY when the strict owner+consent+confirmed+reviewed gate passed. */
  promotable: boolean;
  /** Set when the candidate is quarantined; names the degrade cause. */
  degradeReason?: string;
}

const QUARANTINE_REASON = "unreviewed_identity_signal" as const;

/**
 * Map one `VoiceprintTurnRecords` into a single `MemoryCandidate` contribution
 * decision. FAIL-CLOSED: this NEVER throws and NEVER returns a durable candidate
 * unless the strict gate passes. Any internal error degrades to a quarantined
 * candidate.
 */
export function voiceprintTurnRecordsToMemoryCandidate(
  records: VoiceprintTurnRecords,
  options: VoiceprintMemoryBridgeOptions = {},
): VoiceprintMemoryBridgeResult {
  const createdAt = options.createdAt ?? new Date().toISOString();
  try {
    return mapVoiceprintTurnRecordsToMemoryCandidate(records, options, createdAt);
  } catch (error) {
    // ANY thrown error inside the mapping (malformed record, policy fault, guard
    // rejection) degrades to a quarantined, non-durable candidate. Never a crash.
    return {
      candidate: buildQuarantinedFallbackCandidate(records, createdAt, error),
      promotable: false,
      degradeReason: `bridge_error:${errorMessage(error)}`,
    };
  }
}

function mapVoiceprintTurnRecordsToMemoryCandidate(
  records: VoiceprintTurnRecords,
  options: VoiceprintMemoryBridgeOptions,
  createdAt: IsoTime,
): VoiceprintMemoryBridgeResult {
  const { identitySignal, speakerTurnTag, transcriptSpeakerAnnotation } = records;
  if (!identitySignal || !speakerTurnTag || !transcriptSpeakerAnnotation) {
    throw new Error("Voiceprint memory bridge requires identitySignal + speakerTurnTag + annotation.");
  }

  const reviewState = identitySignal.review?.state;
  if (typeof reviewState !== "string") {
    throw new Error("Voiceprint memory bridge requires an identity signal review state.");
  }

  const result = transcriptSpeakerAnnotation.result;
  const allowedUses = transcriptSpeakerAnnotation.allowedUses;

  // Resolve consent + thresholds. A withheld/absent consent, missing/partial policy,
  // or non-finite score all fall through to the quarantine path below (they cannot
  // pass the strict gate) — never a throw.
  const consent = resolveVoiceprintConsent(options.consent ?? identitySignal.consent);
  const thresholds = resolveThresholds(options.thresholds, speakerTurnTag.thresholdUsed);
  const score = resolveScore(identitySignal, speakerTurnTag);

  // THE STRICT FAIL-CLOSED GATE. Durable promotion requires ALL of:
  //   1. result === "owner_speaking" (never possible_owner / cluster / unknown)
  //   2. identity signal review state === "confirmed"
  //   3. resolved consent allows memory promotion (capture+biometric already implied
  //      by the annotation policy having been computed with consent)
  //   4. a FINITE score >= ownerAccept
  //   5. the annotation's allowedUses PERMIT memory influence — gated STRICTLY through
  //      the existing `voiceprintResultCanInfluenceMemory` (no looser gate invented).
  const promotable =
    result === "owner_speaking" &&
    reviewState === "confirmed" &&
    consent.captureAllowed &&
    consent.biometricAllowed &&
    consent.memoryPromotionAllowed === true &&
    Number.isFinite(score) &&
    (score as number) >= thresholds.ownerAccept &&
    isAnnotationAllowedUses(allowedUses) &&
    allowedUses.memoryPromotion === true &&
    voiceprintResultCanInfluenceMemory(allowedUses);

  const metadata = buildBridgeMetadata({
    records,
    reviewState,
    result,
    score,
    thresholds,
    consent,
    promotable,
  });

  const evidenceRefs = candidateEvidenceRefs(records);
  const sourceSession: SourceSessionRef = { sessionKey: speakerTurnTag.sessionKey };
  const confidence = clampConfidence(identitySignal.confidence);

  if (promotable) {
    // Promotable path: a strong, consented, confirmed, reviewed OWNER turn. Even here
    // the candidate stays UNREVIEWED-mirroring: review.state is the signal state
    // ("confirmed"), and durableMemory is allowed. We never upgrade the review state.
    const candidate = buildMemoryCandidate({
      createdAt,
      updatedAt: createdAt,
      text: promotableCandidateText(records),
      source: "memory_distill",
      sourceSession,
      evidenceRefs,
      subjects: [{ type: "owner" }],
      confidence,
      sensitivity: "sensitive",
      retention: "durable",
      review: mirroredReview(reviewState, identitySignal.review?.reviewedAt),
      allowedUses: promotableAllowedUses(),
      metadata: metadata as unknown as Record<string, unknown>,
    });
    assertVoiceprintMemoryCandidateHasNoSecrets(candidate);
    return { candidate, promotable: true };
  }

  // QUARANTINE PATH (the default). Everything that is not a strong+consented+confirmed
  // owner turn contributes a quarantined, NON-DURABLE candidate whose review state
  // mirrors the source signal (never upgraded).
  const candidate = buildMemoryCandidate({
    createdAt,
    updatedAt: createdAt,
    text: quarantinedCandidateText(records),
    source: "memory_distill",
    sourceSession,
    evidenceRefs,
    subjects: [subjectForResult(records)],
    confidence,
    sensitivity: "sensitive",
    retention: "session",
    review: mirroredReview(reviewState, identitySignal.review?.reviewedAt),
    quarantineReason: QUARANTINE_REASON,
    allowedUses: quarantinedAllowedUses(),
    metadata: metadata as unknown as Record<string, unknown>,
  });
  assertVoiceprintMemoryCandidateHasNoSecrets(candidate);
  return {
    candidate,
    promotable: false,
    degradeReason: `not_promotable:${result}:${reviewState}`,
  };
}

/**
 * The no-secrets ALLOW-LIST guard for a bridged candidate's metadata. Mirrors
 * `assertVoiceprintScoreTelemetryHasNoSecrets`: only known-safe keys are permitted, so
 * a vector-shaped / audio / key / raw-audioPath field is a HARD ERROR. Scalars must be
 * finite numbers (rejecting a smuggled array-as-score), and provenance/id fields must be
 * strings. Called on every produced candidate.
 */
export function assertVoiceprintMemoryCandidateHasNoSecrets(
  candidate: MemoryCandidate,
): MemoryCandidate {
  const metadata = candidate.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Voiceprint memory candidate metadata must be an object.");
  }
  const allowedKeys = new Set<string>([
    "bridge",
    "result",
    "reviewState",
    "identitySignalId",
    "speakerTurnTagId",
    "sessionKey",
    "transcriptItemId",
    "confidence",
    "score",
    "thresholdUsed",
    "ownerAccept",
    "modelProvider",
    "modelId",
    "modelVersion",
    "quarantineReason",
    "memoryPromotionGate",
  ]);
  for (const key of Object.keys(metadata)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Voiceprint memory candidate metadata has a disallowed field "${key}" (candidate carries scalars+ids+tags only; no embeddings/audio/keys/audioPath).`,
      );
    }
  }
  // Scalars must be finite numbers — never an array (a vector) or a blob. This closes
  // the "smuggle a vector as score" path even beyond the allow-list.
  for (const field of ["confidence", "score", "thresholdUsed", "ownerAccept"] as const) {
    const value = (metadata as Record<string, unknown>)[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(
        `Voiceprint memory candidate metadata.${field} must be a finite number (no vectors in candidates).`,
      );
    }
  }
  // Id / provenance fields must be strings, never smuggled blobs/arrays.
  for (const field of [
    "bridge",
    "result",
    "reviewState",
    "identitySignalId",
    "speakerTurnTagId",
    "sessionKey",
    "transcriptItemId",
    "modelProvider",
    "modelId",
    "modelVersion",
    "quarantineReason",
  ] as const) {
    const value = (metadata as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Voiceprint memory candidate metadata.${field} must be a string.`);
    }
  }
  if (typeof (metadata as Record<string, unknown>).memoryPromotionGate !== "boolean") {
    throw new Error("Voiceprint memory candidate metadata.memoryPromotionGate must be a boolean.");
  }
  return candidate;
}

function buildBridgeMetadata(input: {
  records: VoiceprintTurnRecords;
  reviewState: ReviewState;
  result: string;
  score: number | undefined;
  thresholds: VoiceprintThresholds;
  consent: VoiceprintConsentSnapshot;
  promotable: boolean;
}): VoiceprintMemoryCandidateMetadata {
  const { identitySignal, speakerTurnTag } = input.records;
  const model = identitySignal.metadata?.model;
  const metadata: VoiceprintMemoryCandidateMetadata = {
    bridge: "voiceprint_memory_bridge",
    result: input.result,
    reviewState: input.reviewState,
    identitySignalId: identitySignal.id,
    speakerTurnTagId: speakerTurnTag.id,
    sessionKey: speakerTurnTag.sessionKey,
    transcriptItemId: speakerTurnTag.transcriptItemId,
    ownerAccept: input.thresholds.ownerAccept,
    memoryPromotionGate: input.promotable,
    quarantineReason: input.promotable ? undefined : QUARANTINE_REASON,
  };
  if (Number.isFinite(identitySignal.confidence)) {
    metadata.confidence = identitySignal.confidence;
  }
  if (Number.isFinite(input.score)) {
    metadata.score = input.score as number;
  }
  if (Number.isFinite(speakerTurnTag.thresholdUsed)) {
    metadata.thresholdUsed = speakerTurnTag.thresholdUsed;
  }
  if (model && typeof model.provider === "string") {
    metadata.modelProvider = model.provider;
  }
  if (model && typeof model.modelId === "string") {
    metadata.modelId = model.modelId;
  }
  if (model && typeof model.version === "string") {
    metadata.modelVersion = model.version;
  }
  return metadata;
}

function buildQuarantinedFallbackCandidate(
  records: VoiceprintTurnRecords,
  createdAt: IsoTime,
  error: unknown,
): MemoryCandidate {
  // The degrade path when mapping threw. Build the smallest valid, quarantined,
  // non-durable candidate we can from whatever joins survive, WITHOUT re-running the
  // faulting mapping. Every field is defensive.
  // Every field read is throw-safe: the mapping may have failed because an accessor
  // on the records throws, so `safeGet` swallows any getter fault too.
  const sessionKey = safeString(safeGet(() => records?.speakerTurnTag?.sessionKey)) ?? "unknown";
  const transcriptItemId =
    safeString(safeGet(() => records?.speakerTurnTag?.transcriptItemId)) ?? "unknown";
  const reviewState = safeReviewState(safeGet(() => records?.identitySignal?.review?.state));
  const metadata: VoiceprintMemoryCandidateMetadata = {
    bridge: "voiceprint_memory_bridge",
    result: safeString(safeGet(() => records?.transcriptSpeakerAnnotation?.result)) ?? "unknown",
    reviewState,
    identitySignalId: safeString(safeGet(() => records?.identitySignal?.id)) ?? "unknown",
    speakerTurnTagId: safeString(safeGet(() => records?.speakerTurnTag?.id)) ?? "unknown",
    sessionKey,
    transcriptItemId,
    quarantineReason: QUARANTINE_REASON,
    memoryPromotionGate: false,
  };
  const candidate = buildMemoryCandidate({
    createdAt,
    updatedAt: createdAt,
    text: `Quarantined voiceprint identity signal (bridge degraded): ${errorMessage(error)}`,
    source: "memory_distill",
    sourceSession: { sessionKey },
    evidenceRefs: [{ sessionKey, transcriptItemId }],
    subjects: [{ type: "unknown" }],
    confidence: 0,
    sensitivity: "sensitive",
    retention: "session",
    review: { state: reviewState },
    quarantineReason: QUARANTINE_REASON,
    allowedUses: quarantinedAllowedUses(),
    metadata: metadata as unknown as Record<string, unknown>,
  });
  return assertVoiceprintMemoryCandidateHasNoSecrets(candidate);
}

function promotableAllowedUses(): Partial<MemoryCandidateAllowedUses> {
  return {
    reviewDisplay: true,
    memorySearch: true,
    contextExport: false,
    durableMemory: true,
  };
}

function quarantinedAllowedUses(): Partial<MemoryCandidateAllowedUses> {
  // FAIL-CLOSED: durableMemory is ALWAYS false on the quarantine path.
  return {
    reviewDisplay: true,
    memorySearch: false,
    contextExport: false,
    durableMemory: false,
  };
}

function mirroredReview(state: ReviewState, reviewedAt?: IsoTime) {
  // Mirror the source signal review state onto the candidate; NEVER upgrade it.
  return reviewedAt !== undefined ? { state, reviewedAt } : { state };
}

function subjectForResult(records: VoiceprintTurnRecords): MemoryCandidate["subjects"][number] {
  const subject = records.identitySignal.subject;
  if (subject?.type === "owner") {
    // An owner-typed signal that did not clear the strict gate (unreviewed / weak /
    // consent withheld) is still quarantined — labeled owner for review context only.
    return { type: "owner" };
  }
  return { type: "unknown" };
}

function candidateEvidenceRefs(records: VoiceprintTurnRecords): EvidenceRef[] {
  // Carry only the inspectable transcript joins already present on the records —
  // never audio/embedding pointers. Map to the identity/core EvidenceRef shape.
  const refs: EvidenceRef[] = [];
  for (const ref of records.transcriptSpeakerAnnotation.evidenceRefs ?? records.evidenceRefs ?? []) {
    refs.push({
      artifactId: ref.artifactId,
      transcriptItemId: ref.transcriptItemId,
      transcriptRange: ref.transcriptRange,
      excerptHash: ref.excerptHash,
    });
  }
  if (refs.length === 0) {
    refs.push({
      sessionKey: records.speakerTurnTag.sessionKey,
      transcriptItemId: records.speakerTurnTag.transcriptItemId,
    });
  }
  return refs;
}

function promotableCandidateText(records: VoiceprintTurnRecords): string {
  return `Owner voiceprint confirmed on transcript turn ${records.speakerTurnTag.transcriptItemId} (session ${records.speakerTurnTag.sessionKey}).`;
}

function quarantinedCandidateText(records: VoiceprintTurnRecords): string {
  return `Quarantined voiceprint identity signal (${records.transcriptSpeakerAnnotation.result}, review=${records.identitySignal.review.state}) on transcript turn ${records.speakerTurnTag.transcriptItemId}.`;
}

function resolveThresholds(
  override: Partial<VoiceprintThresholds> | undefined,
  thresholdUsed: number | undefined,
): VoiceprintThresholds {
  const ownerAccept =
    override?.ownerAccept ??
    (Number.isFinite(thresholdUsed) ? (thresholdUsed as number) : DEFAULT_VOICEPRINT_THRESHOLDS.ownerAccept);
  const ownerPossible = override?.ownerPossible ?? DEFAULT_VOICEPRINT_THRESHOLDS.ownerPossible;
  return { ownerAccept, ownerPossible };
}

function resolveScore(
  identitySignal: VoiceprintTurnRecords["identitySignal"],
  speakerTurnTag: VoiceprintTurnRecords["speakerTurnTag"],
): number | undefined {
  const metaScore = identitySignal.metadata?.score;
  if (typeof metaScore === "number" && Number.isFinite(metaScore)) {
    return metaScore;
  }
  // Fall back to the tag confidence as the classified scalar (mirrors how
  // allowedUsesForVoiceprintResult treats score === confidence when score is absent).
  const confidence = speakerTurnTag.confidence;
  return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : undefined;
}

function isAnnotationAllowedUses(value: unknown): value is VoiceprintAnnotationAllowedUses {
  if (!value || typeof value !== "object") return false;
  const uses = value as Record<string, unknown>;
  return (
    typeof uses.memoryPromotion === "boolean" &&
    typeof uses.actionProposal === "boolean" &&
    typeof uses.transcriptDisplay === "boolean"
  );
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeGet<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeReviewState(value: unknown): ReviewState {
  const states: ReviewState[] = ["unreviewed", "confirmed", "rejected", "suppressed", "expired", "deleted"];
  return typeof value === "string" && states.includes(value as ReviewState)
    ? (value as ReviewState)
    : "unreviewed";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
