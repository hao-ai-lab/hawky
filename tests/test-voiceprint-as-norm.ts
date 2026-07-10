import { describe, expect, test } from "bun:test";
import {
  AsNormError,
  asNormScore,
  classifyOwnerSimilarity,
  DEFAULT_AS_NORM_TOP_N,
  scoreVoiceprintTurnFromEmbedding,
  scoreVoiceprintTurnWithEvidence,
  validateVoiceprintCohort,
  type VoiceprintCohort,
  type VoiceprintModelInfo,
} from "../src/identity/voiceprint/index.js";

const model: VoiceprintModelInfo = {
  provider: "external-json",
  modelId: "test-embedding-model",
};

const otherModel: VoiceprintModelInfo = {
  provider: "external-json",
  modelId: "test-embedding-model",
  version: "v2",
};

const turn = {
  sessionKey: "live:test",
  transcriptItemId: "rt_asnorm",
  role: "user" as const,
  text: "please remind me later",
  startMs: 1000,
  endMs: 2600,
  audioArtifactId: "audio_asnorm",
};

const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

function vecAtAngle(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

describe("asNormScore pure math", () => {
  test("matches a hand-computed value on a known synthetic cohort", () => {
    // test == owner == [1,0], raw cosine = 1.0. Cohort cosines to [1,0] are
    // {0, 0.6, -1, 0.8}; topN=4 => mean 0.1, population std 0.7.
    // Because test and owner are identical, se == so, so:
    //   normalized = (1 - 0.1) / 0.7 = 0.9 / 0.7 = 1.2857142857...
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [
        [0, 1],
        [0.6, 0.8],
        [-1, 0],
        [0.8, 0.6],
      ],
    };
    const normalized = asNormScore({
      rawScore: 1,
      testEmbedding: [1, 0],
      ownerEmbeddings: [[1, 0]],
      cohort,
      topN: 4,
    });
    expect(normalized).toBeCloseTo(0.9 / 0.7, 10);
    expect(normalized).toBeCloseTo(1.2857142857, 8);
  });

  test("defaults topN to min(300, cohort length)", () => {
    // A cohort smaller than 300 uses all of it; the result must equal an explicit
    // topN == cohort length.
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [
        [0, 1],
        [0.6, 0.8],
        [0.8, 0.6],
      ],
    };
    const withDefault = asNormScore({
      rawScore: 0.9,
      testEmbedding: [1, 0],
      ownerEmbeddings: [[1, 0]],
      cohort,
    });
    const explicit = asNormScore({
      rawScore: 0.9,
      testEmbedding: [1, 0],
      ownerEmbeddings: [[1, 0]],
      cohort,
      topN: cohort.embeddings.length,
    });
    expect(withDefault).toBeCloseTo(explicit, 12);
    expect(DEFAULT_AS_NORM_TOP_N).toBe(300);
  });

  test("falls back to the raw score when a cohort std is degenerate (zero)", () => {
    // A cohort of identical vectors has zero variance => zero std on both sides.
    // The guard returns the raw score rather than dividing by zero / NaN.
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [
        [0, 1],
        [0, 1],
        [0, 1],
      ],
    };
    const normalized = asNormScore({
      rawScore: 0.83,
      testEmbedding: [1, 0],
      ownerEmbeddings: [[1, 0]],
      cohort,
    });
    expect(normalized).toBe(0.83);
  });

  test("rejects a non-positive or non-integer topN instead of silently no-oping", () => {
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [[0, 1], [0.6, 0.8], [0.8, 0.6]],
    };
    const base = {
      rawScore: 0.9,
      testEmbedding: [1, 0],
      ownerEmbeddings: [[1, 0]],
      cohort,
    };
    for (const bad of [0, -1, 1.5]) {
      expect(() => asNormScore({ ...base, topN: bad })).toThrow(AsNormError);
      try {
        asNormScore({ ...base, topN: bad });
      } catch (error) {
        expect((error as AsNormError).reason).toBe("top_n_invalid");
      }
    }
  });

  test("owner side uses the argmax enrolled clip (the clip that produced the raw score)", () => {
    // Two enrolled owner clips: clip A == test ([1,0]) is the argmax; clip B is
    // far away. Textbook symmetric AS-Norm derives so from clip A only. The
    // result must equal a single-clip [A] computation, NOT an average over A+B.
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [[0, 1], [0.6, 0.8], [-1, 0], [0.8, 0.6]],
    };
    const clipA = [1, 0];
    const clipB = vecAtAngle(80);
    const withBoth = asNormScore({
      rawScore: 1,
      testEmbedding: [1, 0],
      ownerEmbeddings: [clipA, clipB],
      cohort,
      topN: 4,
    });
    const singleArgmax = asNormScore({
      rawScore: 1,
      testEmbedding: [1, 0],
      ownerEmbeddings: [clipA],
      cohort,
      topN: 4,
    });
    expect(withBoth).toBeCloseTo(singleArgmax, 12);
    // And with test == argmax clip A, se == so, matching the hand-computed value.
    expect(withBoth).toBeCloseTo(1.2857142857, 8);
  });

  test("propagates a NaN raw score without touching the cohort", () => {
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [[0, 1], [0.6, 0.8]],
    };
    const normalized = asNormScore({
      rawScore: Number.NaN,
      testEmbedding: [1, 0],
      ownerEmbeddings: [[1, 0]],
      cohort,
    });
    expect(Number.isNaN(normalized)).toBe(true);
  });
});

describe("validateVoiceprintCohort", () => {
  test("accepts a finite, right-dimension, model-matched cohort", () => {
    const cohort: VoiceprintCohort = {
      model,
      embeddings: [[0, 1], [0.6, 0.8]],
    };
    expect(() => validateVoiceprintCohort(cohort, model, 2)).not.toThrow();
  });

  test("rejects an empty cohort", () => {
    const cohort: VoiceprintCohort = { model, embeddings: [] };
    expect(() => validateVoiceprintCohort(cohort, model, 2)).toThrow(AsNormError);
    try {
      validateVoiceprintCohort(cohort, model, 2);
    } catch (error) {
      expect((error as AsNormError).reason).toBe("cohort_empty");
    }
  });

  test("rejects a non-finite / zero-norm cohort vector", () => {
    const nan: VoiceprintCohort = { model, embeddings: [[Number.NaN, 1]] };
    expect(() => validateVoiceprintCohort(nan, model, 2)).toThrow(/finite/);
    const zero: VoiceprintCohort = { model, embeddings: [[0, 0]] };
    expect(() => validateVoiceprintCohort(zero, model, 2)).toThrow(/non-zero-norm/);
  });

  test("rejects a dimension mismatch vs the owner template", () => {
    const cohort: VoiceprintCohort = { model, embeddings: [[1, 0, 0]] };
    try {
      validateVoiceprintCohort(cohort, model, 2);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as AsNormError).reason).toBe("cohort_dimension_mismatch");
    }
  });

  test("rejects a cohort whose model does not match the owner template model", () => {
    const cohort: VoiceprintCohort = { model, embeddings: [[0, 1]] };
    try {
      validateVoiceprintCohort(cohort, otherModel, 2);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as AsNormError).reason).toBe("cohort_model_mismatch");
    }
  });
});

describe("AS-Norm turn-scoring wiring (opt-in)", () => {
  const owner = [vecAtAngle(0)];
  const genuineCrossCondition = vecAtAngle(53); // raw cosine ~0.60 (under 0.72)
  const impostor = vecAtAngle(72); // raw cosine ~0.31

  // Cohort tightly clustered near orthogonal to the owner: low, low-variance
  // cosines to the owner, so the genuine sample's raw cosine sits far above the
  // cohort while the impostor sits within it. Constructed so raw cosine
  // MISCLASSIFIES the genuine sample but AS-Norm separates it.
  const cohort: VoiceprintCohort = {
    model,
    embeddings: [85, 87, 89, 91, 93, 95].map(vecAtAngle),
  };

  const rawThresholds = { ownerAccept: 0.82, ownerPossible: 0.72 };
  const normalizedThresholds = { ownerAccept: 1.5, ownerPossible: 1.0 };

  test("raw cosine (AS-Norm OFF) rejects the borderline genuine cross-condition turn", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: owner,
      sampleEmbedding: genuineCrossCondition,
      model,
      thresholds: rawThresholds,
      consent: processingConsent,
    });
    expect(result.similarity).toBeCloseTo(0.6018, 3);
    expect(result.decision).toBe("unknown_speaker");
  });

  test("AS-Norm ON makes the genuine cross-condition turn classify as owner", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: owner,
      sampleEmbedding: genuineCrossCondition,
      model,
      thresholds: rawThresholds,
      consent: processingConsent,
      asNorm: { cohort, thresholds: normalizedThresholds },
    });
    // The classified score is now the z-score-like normalized value, not cosine.
    expect(result.similarity).toBeGreaterThan(normalizedThresholds.ownerAccept);
    expect(result.decision).toBe("owner_speaking");
  });

  test("AS-Norm ON keeps the impostor rejected", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: owner,
      sampleEmbedding: impostor,
      model,
      thresholds: rawThresholds,
      consent: processingConsent,
      asNorm: { cohort, thresholds: normalizedThresholds },
    });
    expect(result.similarity).toBeLessThan(normalizedThresholds.ownerPossible);
    expect(result.decision).toBe("unknown_speaker");
  });

  test("AS-Norm throws when the cohort model does not match the scored model", () => {
    const mismatchedCohort: VoiceprintCohort = {
      model: otherModel,
      embeddings: cohort.embeddings,
    };
    expect(() =>
      scoreVoiceprintTurnFromEmbedding({
        turn,
        ownerEmbeddings: owner,
        sampleEmbedding: genuineCrossCondition,
        model,
        thresholds: rawThresholds,
        consent: processingConsent,
        asNorm: { cohort: mismatchedCohort, thresholds: normalizedThresholds },
      }),
    ).toThrow(/cohort model does not match/);
  });

  test("result exposes the raw cosine alongside the normalized similarity", () => {
    const result = scoreVoiceprintTurnFromEmbedding({
      turn,
      ownerEmbeddings: owner,
      sampleEmbedding: genuineCrossCondition,
      model,
      thresholds: rawThresholds,
      consent: processingConsent,
      asNorm: { cohort, thresholds: normalizedThresholds },
    });
    // similarity is the z-score-like normalized value; rawSimilarity stays the
    // cosine in [-1, 1] so cosine-scale consumers are not polluted.
    expect(result.rawSimilarity).toBeCloseTo(0.6018, 3);
    expect(result.similarity).toBeGreaterThan(normalizedThresholds.ownerAccept);
    expect(result.rawSimilarity).not.toBeCloseTo(result.similarity, 2);
  });

  test("evidence folds the raw cosine, not the z-score, so confidence stays cosine-scaled", () => {
    // On the AS-Norm path the normalized similarity routinely exceeds 1, which
    // the evidence reducer would clamp (it maps a cosine in [-1,1] to [0,1]).
    // scoreVoiceprintTurnWithEvidence must fold the raw cosine instead.
    const { evidence, similarity, rawSimilarity } = scoreVoiceprintTurnWithEvidence({
      turn,
      ownerEmbeddings: owner,
      sampleEmbedding: genuineCrossCondition,
      model,
      thresholds: rawThresholds,
      consent: processingConsent,
      asNorm: { cohort, thresholds: normalizedThresholds },
    });
    expect(similarity).toBeGreaterThan(1);
    const folded = evidence.recent.at(-1);
    expect(folded?.score).toBeCloseTo(rawSimilarity, 12);
    expect(folded?.score).not.toBe(similarity);
    // The decision still comes from the normalized score vs normalized thresholds.
    expect(folded?.decision).toBe("owner_speaking");
  });

  test("OFF (default) path is byte-for-byte identical to pre-A3 scoring", () => {
    // Same inputs, with and without the `asNorm` field OMITTED entirely. The
    // omitted-field call must produce the exact same decision, similarity,
    // confidence, and thresholdUsed as a plain call — the off-by-default invariant.
    const base = {
      turn,
      ownerEmbeddings: [[1, 0], [0.98, 0.02]],
      sampleEmbedding: [0.99, 0.01],
      model,
      thresholds: rawThresholds,
      consent: { ...processingConsent, memoryPromotionAllowed: true },
      eventId: "event_off",
      createdAt: "2026-06-23T00:00:00.000Z",
    };
    const plain = scoreVoiceprintTurnFromEmbedding(base);
    const withUndefinedAsNorm = scoreVoiceprintTurnFromEmbedding({
      ...base,
      asNorm: undefined,
    });
    expect(withUndefinedAsNorm.decision).toBe(plain.decision);
    expect(withUndefinedAsNorm.similarity).toBe(plain.similarity);
    expect(withUndefinedAsNorm.confidence).toBe(plain.confidence);
    expect(withUndefinedAsNorm.thresholdUsed).toBe(plain.thresholdUsed);
    expect(withUndefinedAsNorm.records).toEqual(plain.records);
    // And the raw cosine path stays a cosine, classified at the raw threshold.
    expect(plain.decision).toBe("owner_speaking");
    expect(plain.similarity).toBeGreaterThan(0.99);
    expect(classifyOwnerSimilarity(plain.similarity, rawThresholds)).toBe("owner_speaking");
  });
});
