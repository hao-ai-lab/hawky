// A5 — Voiceprint model lifecycle safety helpers (pure, server-side).
//
// This module holds the small, dependency-light building blocks for the three
// A5 concerns, kept out of the gateway wiring so they are unit-testable in
// isolation:
//
//   1. REFERENCE-BACKEND DETECTION. The bundled Python "reference" backend
//      (services/voiceprint/embed.py, VOICEPRINT_BACKEND=reference) is
//      deterministic but NON-DISCRIMINATIVE — it does NOT tell speakers apart.
//      Its embeddings are tagged provider="reference" / modelId="reference-fbank-v0".
//      A production posture MUST NEVER score real turns with it. These predicates
//      let the gateway hard-reject any reference-tagged model / sidecar env.
//
//   2. MODEL INTEGRITY PIN. When an operator pins the production model file hash,
//      we verify the on-disk model's SHA-256 matches before first use and REFUSE
//      on mismatch, so a swapped/corrupt model cannot silently score.
//
//   3. MODEL-VERSION MISMATCH. Cosine between two embeddings is only meaningful
//      when both were produced by the SAME model+version. When the live scoring
//      model differs from the STORED owner-template model, the template is
//      incomparable; `classifyVoiceprintModelMismatch` names that so callers can
//      re-embed or fail with a clear needs_reenrollment instead of a bad score.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sameVoiceprintModel } from "./model.js";
import type { VoiceprintModelInfo } from "./types.js";

/**
 * The model tag emitted by the NON-DISCRIMINATIVE reference backend
 * (see services/voiceprint/embed.py ReferenceBackend). Anything tagged with this
 * provider/modelId is test-only and must never score real users in production.
 */
export const REFERENCE_VOICEPRINT_PROVIDER = "reference" as const;
export const REFERENCE_VOICEPRINT_MODEL_ID = "reference-fbank-v0" as const;

/**
 * True when a model tag is (or claims to be) the non-discriminative reference
 * backend. We match on provider "reference" OR the reference modelId so a mislabeled
 * tag (right modelId, wrong provider or vice-versa) is still caught — the goal is to
 * never let the reference embedding score a real user under the production guard.
 */
export function isReferenceVoiceprintModel(
  model: VoiceprintModelInfo | undefined,
): boolean {
  if (!model) {
    return false;
  }
  return (
    model.provider === REFERENCE_VOICEPRINT_PROVIDER ||
    model.modelId === REFERENCE_VOICEPRINT_MODEL_ID
  );
}

/**
 * True when a sidecar environment selects the reference backend
 * (VOICEPRINT_BACKEND=reference, the backend's own default when unset). Under the
 * production guard, a sidecar that would run the reference backend is rejected at
 * config-resolve time. `undefined`/absent VOICEPRINT_BACKEND resolves to the
 * reference default, so it is treated as reference here.
 */
export function sidecarEnvSelectsReferenceBackend(
  env: Readonly<Record<string, string>> | undefined,
): boolean {
  const raw = env?.VOICEPRINT_BACKEND;
  const backend = (raw ?? "reference").trim().toLowerCase();
  return backend === "reference";
}

export type VoiceprintModelMismatch =
  | { kind: "match" }
  | {
      kind: "mismatch";
      scoringModel: VoiceprintModelInfo;
      templateModel: VoiceprintModelInfo;
    };

/**
 * Classify the relationship between the model the live scorer would use and the
 * model the STORED owner template was enrolled with. When they differ, cosine is
 * meaningless and the template is incomparable — the caller must re-embed or fail
 * with needs_reenrollment rather than emitting a silent (bad) score.
 */
export function classifyVoiceprintModelMismatch(
  scoringModel: VoiceprintModelInfo | undefined,
  templateModel: VoiceprintModelInfo,
): VoiceprintModelMismatch {
  if (!scoringModel || sameVoiceprintModel(scoringModel, templateModel)) {
    return { kind: "match" };
  }
  return { kind: "mismatch", scoringModel, templateModel };
}

export interface VoiceprintModelIntegrityPin {
  /** Resolved absolute path to the production model file. */
  modelPath: string;
  /** Lowercase hex SHA-256 the model file must hash to. */
  sha256: string;
}

/**
 * Compute the SHA-256 (lowercase hex) of a file's bytes. Reads the whole file;
 * model files are small enough (tens of MB) that a streaming hash is unnecessary.
 */
export function sha256OfFile(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify a pinned model file's SHA-256. Throws a clear error when the file is
 * unreadable or its hash does not match the pin, so an operator must provision a
 * known-good model before scoring. Returns nothing on success.
 */
export function assertVoiceprintModelIntegrity(pin: VoiceprintModelIntegrityPin): void {
  const expected = pin.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(
      "voiceprint.live_scoring.model_sha256 must be a 64-character hex SHA-256 digest.",
    );
  }
  let actual: string;
  try {
    actual = sha256OfFile(pin.modelPath);
  } catch (error) {
    throw new Error(
      `Voiceprint model integrity pin could not read the model file at ${pin.modelPath}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `Voiceprint model integrity check FAILED for ${pin.modelPath}: expected sha256 ${expected} but the file hashes to ${actual}. Provision the known-good model or update model_sha256.`,
    );
  }
}
