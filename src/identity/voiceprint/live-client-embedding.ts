import {
  scoreLiveVoiceprintScoringJobResponse,
  type LiveVoiceprintScoringJobResult,
} from "./live-sidecar-jobs.js";
import type { LiveVoiceprintQueuedTurn } from "./live-queue.js";
import { formatVoiceprintModel, sameVoiceprintModel } from "./model.js";
import { isUsableEmbeddingVector } from "./similarity.js";
import type { VoiceprintEmbeddingResponse } from "./sidecar-protocol.js";
import { voiceprintConsentAllowsProcessing } from "./policy.js";
import type { VoiceprintConsentSnapshot } from "./policy.js";
import type { VoiceprintModelInfo, VoiceprintThresholds } from "./types.js";
import type { IsoTime } from "./contracts.js";

/**
 * TRUST BOUNDARY NOTE.
 *
 * A client-supplied voiceprint embedding is scored DIRECTLY against the owner
 * template, WITHOUT the server ever seeing the biometric audio or re-deriving
 * the vector via the sidecar. This deliberately moves the trust boundary: the
 * server can no longer verify that the audio actually produced this vector, so
 * it is trusting the authenticated device to have computed it honestly with the
 * declared model. This path is therefore gated behind an explicit opt-in
 * (`acceptClientEmbeddings`, default false) at the caller; callers MUST NOT
 * route a client embedding here unless that flag is on. The value here is
 * privacy: on-device iOS can send an embedding instead of shipping raw
 * biometric audio to the server.
 *
 * REPLAY vs CAPTURE-BINDING. Model+dimension+consent validation here does NOT
 * make a client vector fresh: a captured owner vector could be resubmitted. The
 * single-use liveness nonce (see liveness-nonce.ts, enforced in
 * voiceprint-methods.ts) closes NAIVE REPLAY, and is a separate, additive layer
 * on top of the validation below. Neither this validation nor the nonce binds
 * the vector to a live on-device capture — that is device attestation +
 * capture-binding, an explicit follow-up (see the A8 HONESTY note in
 * liveness-nonce.ts) that MUST land before `acceptClientEmbeddings` ships in
 * production.
 */

export interface ClientEmbeddingScoreContext {
  ownerEmbeddings: number[][];
  sampleEmbedding: number[];
  sampleEmbeddingModel?: VoiceprintModelInfo;
  /** The owner template / expected model the client embedding must match. */
  expectedModel?: VoiceprintModelInfo;
  thresholds?: Partial<VoiceprintThresholds>;
  consent?: Partial<VoiceprintConsentSnapshot>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  createdAt?: IsoTime;
}

export type ClientEmbeddingRejectionReason =
  | "client_embedding_empty"
  | "client_embedding_not_finite"
  | "client_embedding_zero_norm"
  | "client_embedding_dimension_mismatch"
  | "client_embedding_model_missing"
  | "client_embedding_model_mismatch"
  | "client_embedding_expected_model_unavailable"
  | "client_embedding_consent_denied"
  | "client_embedding_owner_template_missing";

export interface ClientEmbeddingRejection {
  ok: false;
  reason: ClientEmbeddingRejectionReason;
  message: string;
}

export type ClientEmbeddingScoreOutcome =
  | { ok: true; result: LiveVoiceprintScoringJobResult }
  | ClientEmbeddingRejection;

/**
 * Score a queued turn against a CLIENT-SUPPLIED embedding, bypassing the
 * sidecar entirely. On success it returns the exact same
 * {@link LiveVoiceprintScoringJobResult} shape a sidecar-scored turn produces,
 * so downstream patch/state building is byte-for-byte identical.
 *
 * Untrusted input: the client embedding is strictly validated (non-empty,
 * finite, non-zero-norm, dimension == ownerEmbeddings[0].length) and its model
 * MUST match the owner template / expected model. Any failure returns a
 * rejection — never a spurious accept.
 */
export function scoreClientEmbeddingForQueuedTurn(input: {
  queued: LiveVoiceprintQueuedTurn;
  context: ClientEmbeddingScoreContext;
}): ClientEmbeddingScoreOutcome {
  const { context } = input;
  const validation = validateClientEmbedding(context);
  if (!validation.ok) {
    return validation;
  }

  const response: VoiceprintEmbeddingResponse = {
    id: input.queued.job.embeddingRequest.id,
    embedding: context.sampleEmbedding,
    model: validation.model,
  };

  const result = scoreLiveVoiceprintScoringJobResponse({
    job: input.queued.job,
    response,
    ownerEmbeddings: context.ownerEmbeddings,
    thresholds: context.thresholds,
    consent: context.consent,
    templateLearningReviewed: context.templateLearningReviewed,
    eventId: context.eventId,
    createdAt: context.createdAt,
    // scoreLiveVoiceprintScoringJobResponse re-checks the response model against
    // expectedModel; we pass the same expected model to keep that guard active.
    expectedModel: context.expectedModel,
  });

  return { ok: true, result };
}

interface ClientEmbeddingValidationOk {
  ok: true;
  model: VoiceprintModelInfo;
}

function validateClientEmbedding(
  context: ClientEmbeddingScoreContext,
): ClientEmbeddingValidationOk | ClientEmbeddingRejection {
  // Defense-in-depth: scoring a client vector is biometric processing. The
  // gateway already gates on consent before routing here, but this reusable
  // boundary must not assume that — a future/alternate caller must not be able
  // to score a client embedding without processing consent.
  if (!voiceprintConsentAllowsProcessing(context.consent)) {
    return reject(
      "client_embedding_consent_denied",
      "Voiceprint client embedding cannot be scored without capture + biometric processing consent.",
    );
  }

  const owner = context.ownerEmbeddings;
  if (!Array.isArray(owner) || owner.length === 0 || !Array.isArray(owner[0]) || owner[0].length === 0) {
    return reject(
      "client_embedding_owner_template_missing",
      "Voiceprint client embedding requires a usable owner template.",
    );
  }

  const sample = context.sampleEmbedding;
  if (!Array.isArray(sample) || sample.length === 0) {
    return reject("client_embedding_empty", "Voiceprint client embedding must be a non-empty vector.");
  }
  if (!sample.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return reject(
      "client_embedding_not_finite",
      "Voiceprint client embedding must contain only finite numbers.",
    );
  }
  if (!isUsableEmbeddingVector(sample)) {
    return reject(
      "client_embedding_zero_norm",
      "Voiceprint client embedding must have a non-zero norm.",
    );
  }

  const expectedDim = owner[0].length;
  if (sample.length !== expectedDim) {
    return reject(
      "client_embedding_dimension_mismatch",
      `Voiceprint client embedding has dimension ${sample.length}; expected ${expectedDim} to match the owner template.`,
    );
  }

  // Model match is critical: a client embedding is only comparable to the owner
  // template if it was computed by the SAME model+version.
  const model = context.sampleEmbeddingModel;
  if (!model) {
    return reject(
      "client_embedding_model_missing",
      "Voiceprint client embedding requires sampleEmbeddingModel to prove it matches the owner template model.",
    );
  }
  // A client embedding is ONLY comparable to the owner template if it was
  // produced by the same model+version. The expected model is therefore
  // REQUIRED here (never an optional "skip the check"): if we cannot prove
  // which model the owner template was built with, we cannot safely score a
  // client vector against it, so reject rather than accept an unverifiable
  // vector. Callers derive the expected model from config OR the owner template.
  const expected = context.expectedModel;
  if (!expected) {
    return reject(
      "client_embedding_expected_model_unavailable",
      "Voiceprint client embedding cannot be scored: no expected owner-template model is available to enforce a model match.",
    );
  }
  if (!sameVoiceprintModel(model, expected)) {
    return reject(
      "client_embedding_model_mismatch",
      `Voiceprint client embedding model ${formatVoiceprintModel(model)} does not match the owner template model ${formatVoiceprintModel(expected)}.`,
    );
  }

  return { ok: true, model };
}

function reject(
  reason: ClientEmbeddingRejectionReason,
  message: string,
): ClientEmbeddingRejection {
  return { ok: false, reason, message };
}
