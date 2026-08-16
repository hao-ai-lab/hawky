import { describe, expect, test } from "bun:test";
import {
  INVALID_VECTOR_SIMILARITY,
  classifyOwnerSimilarity,
  isUsableEmbeddingVector,
  meanVector,
  ownerSimilarity,
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

  describe("ownerSimilarity (best-matching enrolled clip)", () => {
    test("single enrolled embedding matches safeCosineSimilarity (back-compat)", () => {
      const e = [0.6, 0.8];
      const q = [0.5, 0.5];
      // For one enrolled clip: max-over-clips == that one clip == old centroid score.
      expect(ownerSimilarity([e], q)).toBe(safeCosineSimilarity(e, q));
      expect(ownerSimilarity([[1, 0]], [1, 0])).toBe(safeCosineSimilarity([1, 0], [1, 0]));
    });

    test("multi-condition query near one clip beats the centroid and flips the decision", () => {
      // e1 and e2 are two enrollment "conditions" 90 degrees apart.
      const e1 = [1, 0];
      const e2 = [0, 1];
      // q sits 8 degrees off e1 -> very close to e1, but far from the centroid (45 deg).
      const q = [Math.cos((8 * Math.PI) / 180), Math.sin((8 * Math.PI) / 180)];

      const maxScore = ownerSimilarity([e1, e2], q);
      const centroidScore = safeCosineSimilarity(meanVector([e1, e2]), q);

      // Max over clips recovers the near match; the centroid dilutes it.
      expect(maxScore).toBeGreaterThan(centroidScore);
      expect(maxScore).toBeCloseTo(0.99027, 4);
      expect(centroidScore).toBeCloseTo(0.79864, 4);

      // The whole point: at a fixed 0.82 accept threshold this flips
      // possible_owner (centroid) -> owner_speaking (max).
      const thresholds = { ownerAccept: 0.82, ownerPossible: 0.72 };
      expect(classifyOwnerSimilarity(centroidScore, thresholds)).toBe("possible_owner");
      expect(classifyOwnerSimilarity(maxScore, thresholds)).toBe("owner_speaking");
    });

    test("an impostor far from every enrolled clip stays rejected", () => {
      // 3D: e1 on x, e2 on y, impostor on z -> orthogonal to both enrolled clips.
      const e1 = [1, 0, 0];
      const e2 = [0, 1, 0];
      const impostor = [0.3, 0.3, 1];

      const score = ownerSimilarity([e1, e2], impostor);
      // Max does not manufacture a match from nothing.
      expect(score).toBeCloseTo(0.27617, 4);
      expect(score).toBeLessThan(0.82);
      expect(classifyOwnerSimilarity(score, { ownerAccept: 0.82, ownerPossible: 0.72 })).toBe(
        "unknown_speaker",
      );
    });

    test("max aggregation exposes the documented single-outlier-clip liability", () => {
      // The SECURITY NOTE in similarity.ts warns that max-over-clips picks the
      // LEAST-far enrolled clip, so a single outlier/low-quality enrolled clip can
      // manufacture a spurious near-match for an impostor who happens to sit near
      // that outlier. This test pins that documented tradeoff so a future guard
      // (top-k / AS-Norm / quality gating) that changes it is a deliberate choice.
      const genuineOwner = [1, 0]; // the "real" enrollment condition
      const outlierClip = [0, 1]; // an accidental/bad enrollment clip, orthogonal
      const impostor = [Math.cos((85 * Math.PI) / 180), Math.sin((85 * Math.PI) / 180)];

      // The impostor is far from the genuine owner clip (near-orthogonal)...
      expect(safeCosineSimilarity(genuineOwner, impostor)).toBeCloseTo(0.08716, 4);
      // ...but max over clips latches onto the outlier and reports a near-match.
      const withOutlier = ownerSimilarity([genuineOwner, outlierClip], impostor);
      expect(withOutlier).toBeCloseTo(0.99619, 4);
      expect(withOutlier).toBeGreaterThan(safeCosineSimilarity(genuineOwner, impostor));
      // Without the outlier clip, the same impostor is correctly far from owner.
      expect(ownerSimilarity([genuineOwner], impostor)).toBeCloseTo(0.08716, 4);
    });

    test("skips degenerate enrolled vectors and handles invalid input", () => {
      // Empty enrollment -> invalid.
      expect(ownerSimilarity([], [1, 0])).toBe(INVALID_VECTOR_SIMILARITY);
      // Invalid sample -> invalid regardless of enrollment.
      expect(ownerSimilarity([[1, 0]], [0, 0])).toBe(INVALID_VECTOR_SIMILARITY);
      // Zero-norm and NaN enrolled vectors are skipped; the usable clip still scores.
      expect(ownerSimilarity([[0, 0], [1, 0]], [1, 0])).toBe(1);
      expect(ownerSimilarity([[Number.NaN, 1], [1, 0]], [1, 0])).toBe(1);
      // Every enrolled vector unusable -> invalid.
      expect(ownerSimilarity([[0, 0], [Number.NaN, 1]], [1, 0])).toBe(INVALID_VECTOR_SIMILARITY);
      // Dimension mismatch on the only enrolled clip -> that clip yields INVALID and
      // there is no other usable clip, so the aggregate is INVALID.
      expect(ownerSimilarity([[1, 0, 0]], [1, 0])).toBe(INVALID_VECTOR_SIMILARITY);
    });
  });
});
