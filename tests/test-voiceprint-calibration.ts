import { describe, expect, test } from "bun:test";
import {
  BUILTIN_VOICEPRINT_CALIBRATION_PROFILES,
  CAMPLUSPLUS_PROVISIONAL_RAW_COSINE_PROFILE,
  CAMPLUSPLUS_VOICEPRINT_MODEL,
  computeVoiceprintOperatingPoint,
  DEFAULT_VOICEPRINT_THRESHOLDS,
  MIN_OWNER_ACCEPT_THRESHOLD,
  resolveVoiceprintThresholdsForModel,
  validateVoiceprintThresholds,
  voiceprintCalibrationScoresFromTelemetry,
  voiceprintScoresFromHistogram,
  type VoiceprintModelInfo,
} from "../src/identity/voiceprint/index.js";
import {
  aggregateVoiceprintScoreTelemetry,
  createVoiceprintScoreHistogram,
  type VoiceprintScoreTelemetryRecord,
} from "../src/identity/voiceprint/scoring-telemetry.js";

// A small deterministic "normal-ish" sampler: a fixed set of offsets around a
// mean so tests are reproducible without RNG. Clamped into [-1, 1] (cosine range).
function cluster(mean: number, spread: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    // Deterministic spread pattern in [-1, 1] scaled by `spread`.
    const t = (i / (n - 1)) * 2 - 1; // -1..1
    const value = mean + t * spread;
    out.push(Math.max(-1, Math.min(1, value)));
  }
  return out;
}

const referenceModel: VoiceprintModelInfo = {
  provider: "reference",
  modelId: "reference-fbank-v0",
};

describe("computeVoiceprintOperatingPoint — EER + recommendation", () => {
  test("separable genuine~0.88 / impostor~0.38 recommends accept in [0.5, 0.7]", () => {
    const genuine = cluster(0.88, 0.06, 40); // ~[0.82, 0.94]
    const impostor = cluster(0.38, 0.08, 40); // ~[0.30, 0.46]
    const point = computeVoiceprintOperatingPoint(genuine, impostor);
    expect(point.kind).toBe("operating_point");
    if (point.kind !== "operating_point") return;
    expect(point.recommended.ownerAccept).toBeGreaterThanOrEqual(0.5);
    expect(point.recommended.ownerAccept).toBeLessThanOrEqual(0.7);
    expect(point.recommended.ownerAccept).toBeGreaterThanOrEqual(point.recommended.ownerPossible);
    // The clouds don't overlap, so a perfectly-separating threshold exists.
    expect(point.eer.rate).toBe(0);
    // The recommendation is always a valid raw-cosine threshold set.
    expect(() => validateVoiceprintThresholds(point.recommended)).not.toThrow();
  });

  test("separable data keeps a NON-EMPTY possible_owner band (ownerPossible < ownerAccept)", () => {
    // Regression: previously ownerPossible collapsed to equal ownerAccept on any
    // well-separated distribution, making the possible_owner interval empty.
    const genuine = cluster(0.88, 0.06, 40);
    const impostor = cluster(0.38, 0.08, 40);
    const point = computeVoiceprintOperatingPoint(genuine, impostor);
    expect(point.kind).toBe("operating_point");
    if (point.kind !== "operating_point") return;
    expect(point.recommended.ownerPossible).toBeLessThan(point.recommended.ownerAccept);
    expect(() => validateVoiceprintThresholds(point.recommended)).not.toThrow();

    // Also on a discrete CAM++-like set.
    const cam = computeVoiceprintOperatingPoint([0.6, 0.62, 0.88, 0.9], [0.36, 0.38, 0.4, 0.42]);
    expect(cam.kind).toBe("operating_point");
    if (cam.kind !== "operating_point") return;
    expect(cam.recommended.ownerPossible).toBeLessThan(cam.recommended.ownerAccept);
  });

  test("candidate list that filters to empty is refused, not crashed", () => {
    // All-non-finite explicit candidates filter down to an empty sweep: this must
    // return a typed insufficient_data result rather than throwing a raw TypeError
    // from an empty EER search.
    const refused = computeVoiceprintOperatingPoint([0.9, 0.8], [0.1, 0.2], {
      candidateThresholds: [Number.NaN, Number.POSITIVE_INFINITY],
    });
    expect(refused.kind).toBe("insufficient_data");
    if (refused.kind === "insufficient_data") {
      expect(refused.reason).toBe("no_valid_candidates");
    }
    // A single valid explicit candidate still calibrates (guard is empty-only).
    const ok = computeVoiceprintOperatingPoint([0.9, 0.8], [0.1, 0.2], {
      candidateThresholds: [0.5, Number.NaN],
    });
    expect(ok.kind).toBe("operating_point");
  });

  test("perfectly separable set gives EER 0", () => {
    const genuine = [0.9, 0.91, 0.92, 0.95];
    const impostor = [0.1, 0.12, 0.2, 0.25];
    const point = computeVoiceprintOperatingPoint(genuine, impostor);
    expect(point.kind).toBe("operating_point");
    if (point.kind !== "operating_point") return;
    expect(point.eer.rate).toBe(0);
    expect(point.eer.threshold).toBeGreaterThan(0.25);
    expect(point.eer.threshold).toBeLessThan(0.9);
  });

  test("heavily-overlapping distributions give a high EER but still a valid recommendation", () => {
    // Both clouds centered at ~0.6 with wide, overlapping spread.
    const genuine = cluster(0.62, 0.25, 40);
    const impostor = cluster(0.58, 0.25, 40);
    const point = computeVoiceprintOperatingPoint(genuine, impostor);
    expect(point.kind).toBe("operating_point");
    if (point.kind !== "operating_point") return;
    expect(point.eer.rate).toBeGreaterThan(0.2); // meaningful overlap
    // Even with overlap, the recommendation is valid + honors the invariants.
    expect(point.recommended.ownerAccept).toBeGreaterThanOrEqual(MIN_OWNER_ACCEPT_THRESHOLD);
    expect(point.recommended.ownerAccept).toBeGreaterThanOrEqual(point.recommended.ownerPossible);
    expect(() => validateVoiceprintThresholds(point.recommended)).not.toThrow();
  });

  test("empty / one-sided input is refused, not silently mis-calibrated", () => {
    const some = [0.8, 0.9];
    expect(computeVoiceprintOperatingPoint([], some).kind).toBe("insufficient_data");
    expect(computeVoiceprintOperatingPoint(some, []).kind).toBe("insufficient_data");
    const bothEmpty = computeVoiceprintOperatingPoint([], []);
    expect(bothEmpty.kind).toBe("insufficient_data");
    if (bothEmpty.kind === "insufficient_data") {
      expect(bothEmpty.reason).toBe("genuine_empty");
    }
    const nan = computeVoiceprintOperatingPoint([Number.NaN, 0.9], some);
    expect(nan.kind).toBe("insufficient_data");
    if (nan.kind === "insufficient_data") {
      expect(nan.reason).toBe("non_finite_scores");
    }
  });

  test("recommendation can never be out of range even for a degenerate low-score set", () => {
    // Both clouds low: without the floor, ownerAccept would land below 0.5.
    const genuine = [0.2, 0.25, 0.3];
    const impostor = [0.05, 0.08, 0.1];
    const point = computeVoiceprintOperatingPoint(genuine, impostor);
    expect(point.kind).toBe("operating_point");
    if (point.kind !== "operating_point") return;
    expect(point.recommended.ownerAccept).toBeGreaterThanOrEqual(MIN_OWNER_ACCEPT_THRESHOLD);
    expect(() => validateVoiceprintThresholds(point.recommended)).not.toThrow();
  });
});

describe("histogram -> scores derivation round-trips a known distribution", () => {
  test("scoresFromHistogram reproduces per-bin midpoint counts", () => {
    const hist = createVoiceprintScoreHistogram({ min: 0, max: 1, binCount: 10 });
    // Set counts directly: 3 in the [0.3,0.4) bin (index 3) and 2 in [0.8,0.9) (index 8).
    hist.bins[3] = 3;
    hist.bins[8] = 2;
    hist.count = 5;
    const scores = voiceprintScoresFromHistogram(hist);
    expect(scores.length).toBe(5);
    // Bin 3 midpoint = 0.35, bin 8 midpoint = 0.85.
    expect(scores.filter((s) => Math.abs(s - 0.35) < 1e-9).length).toBe(3);
    expect(scores.filter((s) => Math.abs(s - 0.85) < 1e-9).length).toBe(2);
  });

  test("telemetry aggregate derives genuine/impostor arrays for calibration", () => {
    const records: VoiceprintScoreTelemetryRecord[] = [];
    const push = (
      decision: VoiceprintScoreTelemetryRecord["decision"],
      score: number,
    ) =>
      records.push({
        version: 1,
        op: "score",
        at: "2026-07-11T00:00:00.000Z",
        outcome: "scored",
        sessionRef: "vpref_test",
        decision,
        score,
        thresholdUsed: 0.55,
      });
    for (const s of [0.85, 0.9, 0.88]) push("owner_speaking", s);
    for (const s of [0.1, 0.2, 0.15]) push("unknown_speaker", s);
    push("possible_owner", 0.5); // ambiguous, excluded by default

    const aggregate = aggregateVoiceprintScoreTelemetry(records);
    const { genuineScores, impostorScores } = voiceprintCalibrationScoresFromTelemetry(aggregate);
    expect(genuineScores.length).toBe(3);
    expect(impostorScores.length).toBe(3);
    // Fed into the operating point, this separable field data calibrates cleanly.
    const point = computeVoiceprintOperatingPoint(genuineScores, impostorScores);
    expect(point.kind).toBe("operating_point");
    if (point.kind !== "operating_point") return;
    expect(point.eer.rate).toBe(0);
  });
});

describe("per-model resolver", () => {
  test("returns the CAM++ provisional profile for CAM++ raw_cosine", () => {
    const resolved = resolveVoiceprintThresholdsForModel(
      CAMPLUSPLUS_VOICEPRINT_MODEL,
      "raw_cosine",
      { profiles: BUILTIN_VOICEPRINT_CALIBRATION_PROFILES },
    );
    expect(resolved).toEqual(CAMPLUSPLUS_PROVISIONAL_RAW_COSINE_PROFILE.thresholds);
    // The shipped profile is explicitly labeled provisional.
    expect(CAMPLUSPLUS_PROVISIONAL_RAW_COSINE_PROFILE.provisional).toBe(true);
  });

  test("returns DEFAULT for the reference model (no profile matches)", () => {
    const resolved = resolveVoiceprintThresholdsForModel(
      referenceModel,
      "raw_cosine",
      { profiles: BUILTIN_VOICEPRINT_CALIBRATION_PROFILES },
    );
    expect(resolved).toEqual(DEFAULT_VOICEPRINT_THRESHOLDS);
  });

  test("returns DEFAULT when no profiles are provided (opt-in: live default unchanged)", () => {
    const resolved = resolveVoiceprintThresholdsForModel(
      CAMPLUSPLUS_VOICEPRINT_MODEL,
      "raw_cosine",
    );
    expect(resolved).toEqual(DEFAULT_VOICEPRINT_THRESHOLDS);
  });

  test("does not cross score spaces: a raw_cosine profile does not match asnorm_zscore", () => {
    const resolved = resolveVoiceprintThresholdsForModel(
      CAMPLUSPLUS_VOICEPRINT_MODEL,
      "asnorm_zscore",
      { profiles: BUILTIN_VOICEPRINT_CALIBRATION_PROFILES },
    );
    expect(resolved).toEqual(DEFAULT_VOICEPRINT_THRESHOLDS);
  });

  test("validateVoiceprintThresholds rejects an out-of-range override on a resolved profile", () => {
    expect(() =>
      resolveVoiceprintThresholdsForModel(CAMPLUSPLUS_VOICEPRINT_MODEL, "raw_cosine", {
        profiles: BUILTIN_VOICEPRINT_CALIBRATION_PROFILES,
        overrides: [{ ownerAccept: 0.3 }], // below MIN_OWNER_ACCEPT_THRESHOLD
      }),
    ).toThrow();
  });
});
