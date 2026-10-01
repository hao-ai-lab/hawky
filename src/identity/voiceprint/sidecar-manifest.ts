import type {
  VoiceprintEmbeddingSource,
  VoiceprintManifest,
  VoiceprintModelInfo,
} from "./types.js";
import {
  buildEmbeddingBatchRequest,
  type VoiceprintEmbeddingBatchRequest,
  type VoiceprintEmbeddingResponse,
} from "./sidecar-protocol.js";
import { resolveFixturePath } from "./manifest.js";
import {
  runEmbeddingSidecar,
  type EmbeddingSidecarCommand,
} from "./sidecar-client.js";
import { sameVoiceprintModel } from "./model.js";

export type ManifestSidecarMode = "missing_embeddings" | "all_audio";

export interface ManifestEmbeddingRequestRef {
  requestId: string;
  sourceId: string;
  scope: "owner_enrollment" | "sample";
  index: number;
}

export interface ManifestEmbeddingRequestPlan {
  request: VoiceprintEmbeddingBatchRequest | null;
  refs: ManifestEmbeddingRequestRef[];
}

export interface ManifestSidecarMaterializationResult {
  manifest: VoiceprintManifest;
  requestCount: number;
  model?: VoiceprintModelInfo;
}

export function buildManifestEmbeddingRequestPlan(input: {
  manifest: VoiceprintManifest;
  baseDir: string;
  mode?: ManifestSidecarMode;
  targetSampleRate?: number;
}): ManifestEmbeddingRequestPlan {
  const mode = input.mode ?? "missing_embeddings";
  const refs: ManifestEmbeddingRequestRef[] = [];
  const requests = [];

  for (const [index, source] of input.manifest.owner.enrollment.entries()) {
    if (!shouldRequestEmbedding(source, mode)) {
      continue;
    }
    const requestId = scopedRequestId("owner_enrollment", index, source.id);
    refs.push({ requestId, sourceId: source.id, scope: "owner_enrollment", index });
    requests.push({
      id: requestId,
      audioPath: resolveFixturePath(input.baseDir, source.audioPath!),
      startMs: source.startMs,
      endMs: source.endMs,
      targetSampleRate: input.targetSampleRate,
      route: source.route,
    });
  }

  for (const [index, source] of input.manifest.samples.entries()) {
    if (!shouldRequestEmbedding(source, mode)) {
      continue;
    }
    const requestId = scopedRequestId("sample", index, source.id);
    refs.push({ requestId, sourceId: source.id, scope: "sample", index });
    requests.push({
      id: requestId,
      audioPath: resolveFixturePath(input.baseDir, source.audioPath!),
      startMs: source.startMs,
      endMs: source.endMs,
      targetSampleRate: input.targetSampleRate,
      route: source.route,
    });
  }

  return {
    request: requests.length > 0 ? buildEmbeddingBatchRequest(requests) : null,
    refs,
  };
}

export async function materializeManifestEmbeddingsWithSidecar(input: {
  manifest: VoiceprintManifest;
  baseDir: string;
  sidecar: EmbeddingSidecarCommand;
  mode?: ManifestSidecarMode;
  targetSampleRate?: number;
}): Promise<ManifestSidecarMaterializationResult> {
  const plan = buildManifestEmbeddingRequestPlan({
    manifest: input.manifest,
    baseDir: input.baseDir,
    mode: input.mode,
    targetSampleRate: input.targetSampleRate,
  });

  if (!plan.request) {
    return { manifest: input.manifest, requestCount: 0 };
  }

  const response = await runEmbeddingSidecar({
    sidecar: input.sidecar,
    request: plan.request,
  });
  const responseById = new Map(
    response.responses.map((item) => [item.id, item] as const),
  );
  const model = commonResponseModel(response.responses);
  ensureManifestModelCompatible(input.manifest.model, model);
  ensureNoImplicitMixedEmbeddingModels(input.manifest, plan.refs);

  const manifest = cloneManifest(input.manifest);
  for (const ref of plan.refs) {
    const embedding = responseById.get(ref.requestId);
    if (!embedding) {
      throw new Error(`Missing voiceprint sidecar embedding for ${ref.requestId}.`);
    }

    if (ref.scope === "owner_enrollment") {
      manifest.owner.enrollment[ref.index] = withEmbedding(
        manifest.owner.enrollment[ref.index]!,
        embedding,
      );
    } else {
      manifest.samples[ref.index] = {
        ...manifest.samples[ref.index]!,
        ...withEmbedding(manifest.samples[ref.index]!, embedding),
      };
    }
  }

  manifest.model = model;
  return {
    manifest,
    requestCount: plan.refs.length,
    model,
  };
}

function shouldRequestEmbedding(
  source: VoiceprintEmbeddingSource,
  mode: ManifestSidecarMode,
): boolean {
  if (!source.audioPath) {
    return false;
  }
  if (mode === "all_audio") {
    return true;
  }
  return !Array.isArray(source.embedding) && !source.embeddingPath;
}

function scopedRequestId(
  scope: ManifestEmbeddingRequestRef["scope"],
  index: number,
  sourceId: string,
): string {
  return `${scope}:${index}:${sourceId}`;
}

function cloneManifest(manifest: VoiceprintManifest): VoiceprintManifest {
  return {
    ...manifest,
    model: manifest.model ? { ...manifest.model } : undefined,
    thresholds: manifest.thresholds ? { ...manifest.thresholds } : undefined,
    owner: {
      ...manifest.owner,
      enrollment: manifest.owner.enrollment.map((source) => ({ ...source })),
    },
    samples: manifest.samples.map((sample) => ({ ...sample })),
  };
}

function withEmbedding<T extends VoiceprintEmbeddingSource>(
  source: T,
  response: VoiceprintEmbeddingResponse,
): T {
  return {
    ...source,
    embedding: [...response.embedding],
    notes: source.notes,
  };
}

function commonResponseModel(responses: VoiceprintEmbeddingResponse[]): VoiceprintModelInfo {
  const [first] = responses;
  if (!first) {
    throw new Error("Voiceprint sidecar produced no embedding responses.");
  }
  for (const response of responses.slice(1)) {
    if (!sameVoiceprintModel(first.model, response.model)) {
      throw new Error("Voiceprint sidecar returned mixed embedding models.");
    }
  }
  return { ...first.model };
}

function ensureManifestModelCompatible(
  manifestModel: VoiceprintModelInfo | undefined,
  sidecarModel: VoiceprintModelInfo,
): void {
  if (!manifestModel) {
    return;
  }
  if (!sameVoiceprintModel(manifestModel, sidecarModel)) {
    throw new Error(
      `Voiceprint manifest model ${manifestModel.provider}/${manifestModel.modelId} does not match sidecar model ${sidecarModel.provider}/${sidecarModel.modelId}.`,
    );
  }
}

function ensureNoImplicitMixedEmbeddingModels(
  manifest: VoiceprintManifest,
  refs: readonly ManifestEmbeddingRequestRef[],
): void {
  if (manifest.model) {
    return;
  }

  const materialized = new Set(refs.map((ref) => `${ref.scope}:${ref.index}`));
  const hasExistingEmbeddings = [
    ...manifest.owner.enrollment.map((source, index) => ({
      source,
      key: `owner_enrollment:${index}`,
    })),
    ...manifest.samples.map((source, index) => ({
      source,
      key: `sample:${index}`,
    })),
  ].some(({ source, key }) => {
    if (materialized.has(key)) {
      return false;
    }
    return Array.isArray(source.embedding) || Boolean(source.embeddingPath);
  });

  if (hasExistingEmbeddings) {
    throw new Error(
      "Voiceprint manifest mixes existing embeddings with sidecar embeddings without declaring a manifest model.",
    );
  }
}
