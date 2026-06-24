import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  VoiceprintEmbeddingSource,
  VoiceprintLoadedEmbedding,
  VoiceprintManifest,
  VoiceprintModelInfo,
} from "./types.js";
import { loadSignalBaselineEmbedding, SIGNAL_BASELINE_MODEL } from "./audio-features.js";

export async function loadVoiceprintManifest(path: string): Promise<{
  manifest: VoiceprintManifest;
  baseDir: string;
}> {
  const text = await readFile(path, "utf8");
  return {
    manifest: JSON.parse(text) as VoiceprintManifest,
    baseDir: dirname(resolve(path)),
  };
}

export async function loadVoiceprintEmbedding(
  source: VoiceprintEmbeddingSource,
  baseDir: string,
  model: VoiceprintModelInfo,
): Promise<VoiceprintLoadedEmbedding> {
  if (Array.isArray(source.embedding)) {
    return {
      sourceId: source.id,
      vector: source.embedding,
      provider: model.provider,
      modelId: model.modelId,
      source: "inline_embedding",
      dim: source.embedding.length,
    };
  }

  if (source.embeddingPath) {
    const embeddingPath = resolveFixturePath(baseDir, source.embeddingPath);
    const parsed = JSON.parse(await readFile(embeddingPath, "utf8")) as unknown;
    const vector = parseEmbeddingJson(parsed, embeddingPath);
    return {
      sourceId: source.id,
      vector,
      provider: model.provider,
      modelId: model.modelId,
      source: "embedding_path",
      dim: vector.length,
    };
  }

  if (source.audioPath) {
    requireExplicitSignalBaselineModel(source, model);
    return loadSignalBaselineEmbedding(
      source.id,
      resolveFixturePath(baseDir, source.audioPath),
      source.startMs,
      source.endMs,
    );
  }

  throw new Error(
    `Voiceprint fixture "${source.id}" needs embedding, embeddingPath, or audioPath.`,
  );
}

function requireExplicitSignalBaselineModel(
  source: VoiceprintEmbeddingSource,
  model: VoiceprintModelInfo,
): void {
  if (
    model.provider === SIGNAL_BASELINE_MODEL.provider &&
    model.modelId === SIGNAL_BASELINE_MODEL.modelId
  ) {
    return;
  }

  throw new Error(
    `Voiceprint fixture "${source.id}" uses audioPath, which requires explicit model ${SIGNAL_BASELINE_MODEL.provider}/${SIGNAL_BASELINE_MODEL.modelId}. Use sidecar materialization for production embeddings.`,
  );
}

export function resolveFixturePath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function parseEmbeddingJson(parsed: unknown, path: string): number[] {
  if (Array.isArray(parsed) && parsed.every((value) => typeof value === "number")) {
    return parsed;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "embedding" in parsed &&
    Array.isArray((parsed as { embedding: unknown }).embedding) &&
    (parsed as { embedding: unknown[] }).embedding.every((value) => typeof value === "number")
  ) {
    return (parsed as { embedding: number[] }).embedding;
  }

  throw new Error(`Embedding JSON must be a number array or { "embedding": number[] }: ${path}`);
}
