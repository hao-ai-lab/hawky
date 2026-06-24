import { describe, expect, test } from "bun:test";
import {
  classifyOwnerSimilarity,
  isUsableEmbeddingVector,
  meanVector,
  safeCosineDistance,
  safeCosineSimilarity,
} from "../src/identity/voiceprint/index.js";

describe("voiceprint similarity helpers", () => {
  test("computes cosine similarity", () => {
    expect(safeCosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(safeCosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(safeCosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test("treats invalid vectors as maximum non-match", () => {
    expect(safeCosineSimilarity([0, 0], [1, 0])).toBe(-1);
    expect(safeCosineSimilarity([1, 0], [1])).toBe(-1);
    expect(safeCosineSimilarity([Number.NaN], [1])).toBe(-1);
    expect(safeCosineDistance([0, 0], [1, 0])).toBe(2);
    expect(isUsableEmbeddingVector([0, 0])).toBe(false);
    expect(isUsableEmbeddingVector([1, 0])).toBe(true);
  });

  test("computes a centroid for same-dimensional vectors", () => {
    expect(meanVector([[1, 0], [0, 1]])).toEqual([0.5, 0.5]);
    expect(() => meanVector([[1, 0], [1]])).toThrow(/mixed dimensions/);
    expect(() => meanVector([[1, 0], [-1, 0]])).toThrow(/zero norm/);
  });

  test("classifies owner, possible owner, and unknown by thresholds", () => {
    expect(classifyOwnerSimilarity(0.9, { ownerAccept: 0.82, ownerPossible: 0.72 })).toBe("owner_speaking");
    expect(classifyOwnerSimilarity(0.75, { ownerAccept: 0.82, ownerPossible: 0.72 })).toBe("possible_owner");
    expect(classifyOwnerSimilarity(0.5, { ownerAccept: 0.82, ownerPossible: 0.72 })).toBe("unknown_speaker");
  });

  test("rejects unsafe threshold overrides", () => {
    expect(() =>
      classifyOwnerSimilarity(0, { ownerAccept: -1, ownerPossible: -1 }),
    ).toThrow(/ownerAccept/);
  });
});
