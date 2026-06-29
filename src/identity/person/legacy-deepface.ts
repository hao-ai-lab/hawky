import { createHash } from "node:crypto";
import { allowedUsesForIdentitySignal } from "../core/index.js";
import type { FaceIndexProfile } from "../face/index.js";
import {
  buildFaceIdentitySignal,
  buildIdentityCandidate,
  buildPersonFact,
  buildPersonProfile,
  buildPersonRecap,
  makePersonRecordAllowedUses,
  type FaceIdentitySignal,
  type IdentityCandidate,
  type LegacyPersonRef,
  type PersonFact,
  type PersonProfile,
  type PersonRecap,
} from "./contracts.js";
import type { EvidenceRef, IsoTime, RecordId } from "../core/index.js";

export interface LegacyDeepFaceProfile extends FaceIndexProfile {
  facts?: unknown;
  recaps?: unknown;
}

export interface NormalizedLegacyDeepFaceProfile {
  legacyProfileId: RecordId;
  profile?: PersonProfile;
  candidate?: IdentityCandidate;
  facts: PersonFact[];
  recaps: PersonRecap[];
  faceSignals: FaceIdentitySignal[];
  warnings: string[];
}

export function normalizeLegacyDeepFaceProfile(
  raw: LegacyDeepFaceProfile,
  options: {
    now?: IsoTime;
    defaultConfidence?: number;
  } = {},
): NormalizedLegacyDeepFaceProfile {
  const now = options.now ?? new Date().toISOString();
  const confidence = options.defaultConfidence ?? 0.5;
  const legacyProfileId = legacyIdFrom(raw);
  const evidenceRefs = legacyEvidenceRefs(legacyProfileId);
  const legacyRefs = legacyRefsFor(legacyProfileId);
  const warnings: string[] = [];
  const displayName = legacyName(raw.name);
  const isUnknown = isUnknownName(displayName);

  const faceSignalBase = {
    evidenceRefs,
    createdAt: now,
    updatedAt: now,
    confidence,
    retention: "rolling_30d" as const,
    review: { state: "unreviewed" as const },
    metadata: {
      source: "face" as const,
      service: "deepface" as const,
      deepfaceProfileId: legacyProfileId,
      legacy: true,
    },
  };

  if (isUnknown) {
    const candidateId = `cand_face_${stableHash(["legacy_deepface", legacyProfileId])}`;
    const candidate = buildIdentityCandidate({
      id: candidateId,
      createdAt: now,
      updatedAt: now,
      candidateType: "unknown_face",
      modalities: ["face"],
      source: "legacy_deepface",
      evidenceRefs,
      confidence,
      review: { state: "unreviewed" },
      allowedUses: allowedUsesForIdentitySignal({
        subject: { type: "person_candidate", candidateId },
        reviewState: "unreviewed",
        confidence,
      }),
      legacyRefs,
      metadata: { deepfaceProfileId: legacyProfileId },
    });

    const facts = legacyFacts(raw.facts);
    const recaps = legacyRecaps(raw.recaps);
    if (facts.length > 0 || recaps.length > 0) {
      warnings.push("Unknown legacy DeepFace profile had facts/recaps that were not promoted.");
    }

    return {
      legacyProfileId,
      candidate,
      facts: [],
      recaps: [],
      faceSignals: [
        buildFaceIdentitySignal({
          id: `face_sig_${stableHash(["legacy_face_candidate", legacyProfileId])}`,
          signalType: "legacy_face_profile",
          subject: { type: "person_candidate", candidateId },
          allowedUses: candidate.allowedUses,
          ...faceSignalBase,
          metadata: {
            ...faceSignalBase.metadata,
            candidateId,
          },
        }),
      ],
      warnings,
    };
  }

  const profile = buildPersonProfile({
    id: legacyProfileId,
    createdAt: stringOrUndefined(raw.created_at) ?? now,
    updatedAt: stringOrUndefined(raw.last_seen_at) ?? now,
    displayName,
    source: "legacy_deepface",
    evidenceRefs,
    confidence,
    review: { state: "unreviewed" },
    allowedUses: { profileDisplay: true },
    legacyRefs,
    metadata: {
      deepfaceProfileId: legacyProfileId,
      hasThumbnail: typeof raw.thumbnail === "string" && raw.thumbnail.length > 0,
    },
  });

  const facts = uniqueStrings(legacyFacts(raw.facts)).map((text) =>
    buildPersonFact({
      id: `pfact_${stableHash(["legacy_deepface", legacyProfileId, text])}`,
      createdAt: now,
      updatedAt: now,
      personId: profile.id,
      text,
      origin: "legacy_unverified",
      source: "legacy_deepface",
      evidenceRefs,
      confidence,
      review: { state: "unreviewed" },
      allowedUses: makePersonRecordAllowedUses({ profileDisplay: true }),
      legacyRefs,
      metadata: { deepfaceProfileId: legacyProfileId },
    }),
  );

  const recaps = legacyRecaps(raw.recaps).map((recap) =>
    buildPersonRecap({
      id: `precap_${stableHash(["legacy_deepface", legacyProfileId, recap.summary, recap.at ?? ""])}`,
      createdAt: now,
      updatedAt: now,
      personId: profile.id,
      summary: recap.summary,
      at: recap.at,
      origin: "legacy_unverified",
      source: "legacy_deepface",
      evidenceRefs,
      confidence,
      review: { state: "unreviewed" },
      allowedUses: makePersonRecordAllowedUses({ profileDisplay: true }),
      legacyRefs,
      metadata: { deepfaceProfileId: legacyProfileId },
    }),
  );

  return {
    legacyProfileId,
    profile,
    facts,
    recaps,
    faceSignals: [
      buildFaceIdentitySignal({
        id: `face_sig_${stableHash(["legacy_face_profile", legacyProfileId])}`,
        signalType: "legacy_face_profile",
        subject: { type: "person", personId: profile.id },
        allowedUses: allowedUsesForIdentitySignal({
          subject: { type: "person", personId: profile.id },
          reviewState: "unreviewed",
          confidence,
        }),
        ...faceSignalBase,
        metadata: {
          ...faceSignalBase.metadata,
          personId: profile.id,
        },
      }),
    ],
    warnings,
  };
}

function legacyEvidenceRefs(legacyProfileId: RecordId): EvidenceRef[] {
  return [
    {
      type: "tool_result",
      id: `legacy_deepface_profile:${legacyProfileId}`,
      uri: `deepface://profiles/${encodeURIComponent(legacyProfileId)}`,
      label: "Legacy DeepFace profile",
    },
  ];
}

function legacyRefsFor(legacyProfileId: RecordId): LegacyPersonRef[] {
  return [
    {
      system: "deepface",
      profileId: legacyProfileId,
      uri: `deepface://profiles/${encodeURIComponent(legacyProfileId)}`,
    },
  ];
}

function legacyIdFrom(raw: LegacyDeepFaceProfile): RecordId {
  const id = stringOrUndefined(raw.id);
  if (id) return id;
  return `legacy_deepface_${stableHash(safeLegacyHashPayload(raw))}`;
}

function safeLegacyHashPayload(raw: LegacyDeepFaceProfile): Record<string, unknown> {
  const { embeddings: _embeddings, embedding: _embedding, thumbnail: _thumbnail, ...rest } = raw;
  return rest;
}

function legacyName(value: unknown): string {
  const name = stringOrUndefined(value);
  return name && name.trim().length > 0 ? name.trim() : "Unknown";
}

function isUnknownName(name: string): boolean {
  return name.trim().toLowerCase() === "unknown";
}

function legacyFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0)
    .map((fact) => fact.trim());
}

function legacyRecaps(value: unknown): Array<{ summary: string; at?: IsoTime }> {
  if (!Array.isArray(value)) return [];
  const recaps: Array<{ summary: string; at?: IsoTime }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const summary = stringOrUndefined(record.summary);
    if (!summary) continue;
    const at = stringOrUndefined(record.at);
    recaps.push(at ? { summary, at } : { summary });
  }
  return recaps;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}