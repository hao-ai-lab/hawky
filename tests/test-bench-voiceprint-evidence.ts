import { describe, expect, test } from "bun:test";

import {
  BENCH_CONFIGS,
  buildScenarios,
  foldTurnLikeAutoScorer,
  makeLcg,
  runScenario,
  scenarioOwnerOnly,
  scenarioTakeover,
  type BenchConfig,
} from "../scripts/bench-voiceprint-evidence.js";
import {
  initialSpeakerEvidenceState,
  reduceSpeakerEvidence,
} from "../src/identity/voiceprint/evidence.js";

const production = BENCH_CONFIGS.find((c) => c.key === "c")!;

describe("bench-voiceprint-evidence harness", () => {
  test("LCG scenarios are deterministic for a fixed seed", () => {
    expect(scenarioOwnerOnly(0xa11ce)).toEqual(scenarioOwnerOnly(0xa11ce));
    expect(makeLcg(42)()).toBe(makeLcg(42)());
  });

  test("short unknown turn is neutral but refreshes the timestamp (fold gating)", () => {
    // Establish owner_present first (production ownerFlipThreshold = 2).
    let state = initialSpeakerEvidenceState();
    for (const atMs of [1000, 2000]) {
      state = reduceSpeakerEvidence(
        state,
        { decision: "owner_speaking", atMs },
        production.evidence,
      );
    }
    expect(state.verdict).toBe("owner_present");
    const before = state;

    const after = foldTurnLikeAutoScorer(
      state,
      { decision: "unknown_speaker", durationMs: 800, atMs: 3000, ownerSpeaking: true },
      production,
    );
    // Neutral: verdict, streaks, and ring untouched; only updatedAtMs moves.
    expect(after.verdict).toBe("owner_present");
    expect(after.ownerStreak).toBe(before.ownerStreak);
    expect(after.nonOwnerStreak).toBe(before.nonOwnerStreak);
    expect(after.recent).toEqual(before.recent);
    expect(after.updatedAtMs).toBe(3000);
  });

  test("long unknown turn DOES vote under production config", () => {
    let state = initialSpeakerEvidenceState();
    state = reduceSpeakerEvidence(
      state,
      { decision: "owner_speaking", atMs: 1000 },
      production.evidence,
    );
    const after = foldTurnLikeAutoScorer(
      state,
      { decision: "unknown_speaker", durationMs: 2500, atMs: 2000, ownerSpeaking: false },
      production,
    );
    expect(after.ownerStreak).toBe(0);
    expect(after.nonOwnerStreak).toBe(1);
  });

  test("production config: owner-only never loses owner_present; takeover is detected", () => {
    const [ownerOnly, , takeover] = buildScenarios();
    const ownerMetrics = runScenario(ownerOnly, production);
    expect(ownerMetrics.turnsToEstablish).not.toBeNull();
    expect(ownerMetrics.ownerPresentLost).toBe(0);
    expect(ownerMetrics.finalCorrect).toBe(true);

    const takeoverMetrics = runScenario(takeover, production);
    expect(takeoverMetrics.turnsToDetectGuest).toBe(4);
    expect(takeoverMetrics.finalVerdict).toBe("not_owner");
  });

  test("legacy symmetric flip=2 false-flips on owner backchannels", () => {
    const legacy: BenchConfig = BENCH_CONFIGS.find((c) => c.key === "a")!;
    const metrics = runScenario(scenarioOwnerOnly(0xa11ce), legacy);
    expect(metrics.ownerPresentLost).toBeGreaterThan(0);
  });

  test("takeover scenario marks ground truth speaker per turn", () => {
    const takeover = scenarioTakeover(0xcafe);
    const start = takeover.takeoverStartIndex!;
    expect(takeover.turns.slice(0, start).every((t) => t.ownerSpeaking)).toBe(true);
    expect(takeover.turns.slice(start).every((t) => !t.ownerSpeaking)).toBe(true);
  });
});
