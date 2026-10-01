import type { VoiceprintModelInfo } from "./types.js";
import { isUsableEmbeddingVector } from "./similarity.js";
import { UnusableVoiceprintEmbeddingError } from "./embedding-errors.js";

export interface VoiceprintEmbeddingRequest {
  id: string;
  audioPath: string;
  startMs?: number;
  endMs?: number;
  targetSampleRate?: number;
  route?: string;
}

export interface VoiceprintEmbeddingResponse {
  id: string;
  embedding: number[];
  model: VoiceprintModelInfo;
  audio?: {
    durationMs?: number;
    speechMs?: number;
    sampleRate?: number;
    channels?: number;
  };
  quality?: {
    rms?: number;
    clipping?: boolean;
    tooShort?: boolean;
    warnings?: string[];
  };
}

export interface VoiceprintEmbeddingBatchRequest {
  version: 1;
  requests: VoiceprintEmbeddingRequest[];
}

export interface VoiceprintEmbeddingBatchResponse {
  version: 1;
  responses: VoiceprintEmbeddingResponse[];
}

export function buildEmbeddingRequest(input: VoiceprintEmbeddingRequest): VoiceprintEmbeddingRequest {
  validateEmbeddingRequest(input);
  return { ...input };
}

export function buildEmbeddingBatchRequest(
  requests: VoiceprintEmbeddingRequest[],
): VoiceprintEmbeddingBatchRequest {
  validateEmbeddingBatchRequest({ version: 1, requests });
  return {
    version: 1,
    requests: requests.map((request) => ({ ...request })),
  };
}

export function validateEmbeddingBatchRequest(batch: VoiceprintEmbeddingBatchRequest): void {
  if (batch.version !== 1) {
    throw new Error(`Unsupported voiceprint embedding request version: ${String(batch.version)}.`);
  }
  if (!Array.isArray(batch.requests)) {
    throw new Error("Voiceprint embedding batch request requires requests array.");
  }
  const requests = batch.requests;
  if (requests.length === 0) {
    throw new Error("Voiceprint embedding batch requires at least one request.");
  }
  const seen = new Set<string>();
  for (const request of requests) {
    validateEmbeddingRequest(request);
    if (seen.has(request.id)) {
      throw new Error(`Duplicate voiceprint embedding request id: ${request.id}.`);
    }
    seen.add(request.id);
  }
}

export function validateEmbeddingRequest(request: VoiceprintEmbeddingRequest): void {
  if (typeof request.id !== "string" || !request.id.trim()) {
    throw new Error("Voiceprint embedding request requires id.");
  }
  if (typeof request.audioPath !== "string" || !request.audioPath.trim()) {
    throw new Error("Voiceprint embedding request requires audioPath.");
  }
  if (request.startMs !== undefined && (!Number.isFinite(request.startMs) || request.startMs < 0)) {
    throw new Error("Voiceprint embedding request startMs must be a non-negative number.");
  }
  if (request.endMs !== undefined && (!Number.isFinite(request.endMs) || request.endMs < 0)) {
    throw new Error("Voiceprint embedding request endMs must be a non-negative number.");
  }
  if (
    request.startMs !== undefined &&
    request.endMs !== undefined &&
    request.endMs <= request.startMs
  ) {
    throw new Error("Voiceprint embedding request endMs must be greater than startMs.");
  }
  if (
    request.targetSampleRate !== undefined &&
    (!Number.isFinite(request.targetSampleRate) || request.targetSampleRate <= 0)
  ) {
    throw new Error("Voiceprint embedding request targetSampleRate must be positive.");
  }
}

export function validateEmbeddingResponse(
  response: VoiceprintEmbeddingResponse,
  options: { skipEmbeddingUsability?: boolean } = {},
): void {
  if (!response.id.trim()) {
    throw new Error("Voiceprint embedding response requires id.");
  }
  if (!response.model?.provider || !response.model.modelId) {
    throw new Error("Voiceprint embedding response requires model provider and modelId.");
  }
  // `skipEmbeddingUsability` defers the embedding-VECTOR usability check
  // (empty / NaN / infinite / zero-norm) to a per-turn scoring boundary so a
  // single garbage embedding can be isolated to ONE turn (fail-closed skip)
  // rather than failing the whole batch. Structural checks (id, model, speechMs)
  // still hard-fail because they break the id-based join / batch integrity. The
  // transport parser (parseEmbeddingBatchResponseJson) keeps the strict default.
  if (!options.skipEmbeddingUsability && !isUsableEmbeddingVector(response.embedding)) {
    // TYPED per-turn data fault (message text unchanged): the batch scorer detects
    // this by `instanceof UnusableVoiceprintEmbeddingError` — not by substring — so
    // a reword can never silently flip skip-vs-fail. On the strict transport-parser
    // path it simply propagates as an Error subclass and still hard-fails the batch.
    throw new UnusableVoiceprintEmbeddingError(
      "Voiceprint embedding response requires a finite non-empty embedding.",
    );
  }
  if (
    response.audio?.speechMs !== undefined &&
    (!Number.isFinite(response.audio.speechMs) || response.audio.speechMs < 0)
  ) {
    throw new Error("Voiceprint embedding response speechMs must be a non-negative number.");
  }
}

export function validateEmbeddingBatchResponse(
  batch: VoiceprintEmbeddingBatchResponse,
  requestIds?: readonly string[],
  options: { skipEmbeddingUsability?: boolean } = {},
): void {
  if (batch.version !== 1) {
    throw new Error(`Unsupported voiceprint embedding response version: ${String(batch.version)}.`);
  }
  if (!Array.isArray(batch.responses)) {
    throw new Error("Voiceprint embedding batch response requires responses array.");
  }
  const seen = new Set<string>();
  for (const response of batch.responses) {
    validateEmbeddingResponse(response, options);
    if (seen.has(response.id)) {
      throw new Error(`Duplicate voiceprint embedding response id: ${response.id}.`);
    }
    seen.add(response.id);
  }

  if (requestIds) {
    const requested = new Set<string>();
    for (const requestId of requestIds) {
      if (requested.has(requestId)) {
        throw new Error(`Duplicate voiceprint embedding request id: ${requestId}.`);
      }
      requested.add(requestId);
      if (!seen.has(requestId)) {
        throw new Error(`Missing voiceprint embedding response id: ${requestId}.`);
      }
    }
    for (const responseId of seen) {
      if (!requested.has(responseId)) {
        throw new Error(`Unexpected voiceprint embedding response id: ${responseId}.`);
      }
    }
  }
}

export function parseEmbeddingBatchResponseJson(
  text: string,
  requestIds?: readonly string[],
): VoiceprintEmbeddingBatchResponse {
  const parsed = JSON.parse(text) as VoiceprintEmbeddingBatchResponse;
  validateEmbeddingBatchResponse(parsed, requestIds);
  return parsed;
}
