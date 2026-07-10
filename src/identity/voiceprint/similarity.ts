import {
  type VoiceprintDecision,
  type VoiceprintThresholds,
} from "./types.js";
import { resolveVoiceprintThresholds } from "./thresholds.js";

export const INVALID_VECTOR_SIMILARITY = -1;

export function isFiniteVector(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.every(Number.isFinite);
}

export function isUsableEmbeddingVector(vector: readonly number[]): boolean {
  return isFiniteVector(vector) && vectorNorm(vector) > 0;
}

export function vectorNorm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

export function safeCosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length || !isFiniteVector(a) || !isFiniteVector(b)) {
    return INVALID_VECTOR_SIMILARITY;
  }

  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (normA === 0 || normB === 0) {
    return INVALID_VECTOR_SIMILARITY;
  }

  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
  }

  const similarity = dot / (normA * normB);
  if (!Number.isFinite(similarity)) {
    return INVALID_VECTOR_SIMILARITY;
  }

  return Math.max(-1, Math.min(1, similarity));
}

export function safeCosineDistance(
  a: readonly number[],
  b: readonly number[],
): number {
  const similarity = safeCosineSimilarity(a, b);
  if (similarity === INVALID_VECTOR_SIMILARITY) {
    return 2;
  }
  return 1 - similarity;
}

/**
 * Score a sample against enrolled owner clips using the BEST-MATCHING enrolled
 * clip (max over per-clip cosine similarity) rather than a single mean-centroid.
 *
 * Rationale: an owner recorded in one condition (mic/room/day) still matches the
 * enrolled clip captured under a similar condition, even if the mean centroid of
 * all conditions sits "between" them and matches no single query well.
 *
 * Invalid/zero-norm enrolled vectors are skipped. Returns INVALID_VECTOR_SIMILARITY
 * when there is no usable enrolled vector or when the sample itself is unusable —
 * matching the not-a-match convention of safeCosineSimilarity.
 *
 * SECURITY NOTE: max over enrolled clips can raise an impostor score slightly, since
 * it picks the LEAST-far enrolled clip. A single low-quality/outlier enrolled clip is
 * therefore a liability: it can manufacture a spurious near-match. Enrollment quality
 * gating matters here. The planned refinements are top-k mean or AS-Norm score
 * normalization (see the plan's scoring-calibration section); neither is implemented
 * here — this helper's scope is only the max aggregation.
 */
export function ownerSimilarity(
  ownerEmbeddings: readonly (readonly number[])[],
  sample: readonly number[],
): number {
  if (!isUsableEmbeddingVector(sample)) {
    return INVALID_VECTOR_SIMILARITY;
  }

  let best = INVALID_VECTOR_SIMILARITY;
  let sawUsable = false;
  for (const enrolled of ownerEmbeddings) {
    if (!isUsableEmbeddingVector(enrolled)) {
      continue;
    }
    sawUsable = true;
    const similarity = safeCosineSimilarity(enrolled, sample);
    if (similarity > best) {
      best = similarity;
    }
  }

  return sawUsable ? best : INVALID_VECTOR_SIMILARITY;
}

export function meanVector(vectors: readonly (readonly number[])[]): number[] {
  const valid = vectors.filter(isFiniteVector);
  if (valid.length === 0) {
    throw new Error("Cannot compute a voiceprint centroid without valid vectors.");
  }

  const dim = valid[0]!.length;
  if (!valid.every((vector) => vector.length === dim)) {
    throw new Error("Cannot compute a voiceprint centroid from mixed dimensions.");
  }

  const out = Array.from({ length: dim }, () => 0);
  for (const vector of valid) {
    for (let i = 0; i < dim; i += 1) {
      out[i]! += vector[i]!;
    }
  }

  const centroid = out.map((value) => value / valid.length);
  if (vectorNorm(centroid) === 0) {
    throw new Error("Cannot compute a voiceprint centroid with zero norm.");
  }

  return centroid;
}

export function classifyOwnerSimilarity(
  similarity: number,
  thresholds: Partial<VoiceprintThresholds> = {},
): VoiceprintDecision {
  const resolved = resolveVoiceprintThresholds(thresholds);

  if (similarity >= resolved.ownerAccept) {
    return "owner_speaking";
  }

  if (similarity >= resolved.ownerPossible) {
    return "possible_owner";
  }

  return "unknown_speaker";
}
