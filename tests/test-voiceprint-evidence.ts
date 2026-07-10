import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPEAKER_EVIDENCE_CONFIG,
  foldSpeakerEvidence,
  initialSpeakerEvidenceState,
  readSpeakerEvidence,
  reduceSpeakerEvidence,
  type SpeakerEvidenceConfig,
  type SpeakerEvidenceState,
  type SpeakerEvidenceTurn,
} from "../src/identity/voiceprint/index.js";
import type { VoiceprintDecision } from "../src/identity/voiceprint/types.js";

function turns(
  decisions: readonly VoiceprintDecision[],
  score?: number,
): SpeakerEvidenceTurn[] {
  return decisions.map((decision) =>
    score === undefined ? { decision } : { decision, score },
  );
}

function fold(
  decisions: readonly VoiceprintDecision[],
  config?: Partial<SpeakerEvidenceConfig>,
): SpeakerEvidenceState {
  return foldSpeakerEvidence(turns(decisions), config);
}

describe("speaker evidence accumulator (session-level hysteresis)", () => {
  test("initial state is unknown with empty ring and zero streaks", () => {
    const state = initialSpeakerEvidenceState();
    expect(state.verdict).toBe("unknown");
    expect(state.ownerStreak).toBe(0);
    expect(state.nonOwnerStreak).toBe(0);
    expect(state.recent).toEqual([]);
    expect(readSpeakerEvidence(state).confidence).toBe(0);
  });

  test("all-owner sequence stabilizes to owner_present only after K", () => {
    const k = DEFAULT_SPEAKER_EVIDENCE_CONFIG.flipThreshold; // 3
    let state = initialSpeakerEvidenceState();

    for (let i = 1; i <= k; i += 1) {
      state = reduceSpeakerEvidence(state, { decision: "owner_speaking" });
      if (i < k) {
        // Before reaching K consecutive owner turns, must NOT be owner_present.
        expect(state.verdict).not.toBe("owner_present");
      } else {
        expect(state.verdict).toBe("owner_present");
      }
    }
    expect(state.ownerStreak).toBe(k);
  });

  test("a single unknown among owners does NOT flip a settled owner verdict", () => {
    // Settle to owner_present, then feed one outlier unknown turn.
    let state = fold([
      "owner_speaking",
      "owner_speaking",
      "owner_speaking",
    ]);
    expect(state.verdict).toBe("owner_present");

    state = reduceSpeakerEvidence(state, { decision: "unknown_speaker" });
    // The single outlier resets the owner streak but must NOT flip the verdict.
    expect(state.ownerStreak).toBe(0);
    expect(state.verdict).toBe("owner_present");

    // A subsequent owner turn keeps it owner_present.
    state = reduceSpeakerEvidence(state, { decision: "owner_speaking" });
    expect(state.verdict).toBe("owner_present");
  });

  test("sustained unknown (>= K) flips to not_owner", () => {
    const state = fold([
      "owner_speaking",
      "owner_speaking",
      "owner_speaking",
      "unknown_speaker",
      "unknown_speaker",
      "unknown_speaker",
    ]);
    expect(state.verdict).toBe("not_owner");
    expect(state.nonOwnerStreak).toBe(3);
  });

  test("a single owner-ish turn does NOT soften a settled not_owner verdict", () => {
    // Settle to not_owner, then feed one stray owner-ish outlier turn.
    let state = fold([
      "unknown_speaker",
      "unknown_speaker",
      "unknown_speaker",
    ]);
    expect(state.verdict).toBe("not_owner");

    // A lone weak possible_owner grey-band match must NOT downgrade the settled
    // not_owner back to provisional (symmetric with owner_present stickiness).
    state = reduceSpeakerEvidence(state, { decision: "possible_owner" });
    expect(state.verdict).toBe("not_owner");

    // A lone strong owner turn (no hard flip yet) also must not soften it.
    state = reduceSpeakerEvidence(state, { decision: "owner_speaking" });
    expect(state.verdict).toBe("not_owner");
    expect(state.ownerStreak).toBe(1);
  });

  test("not_owner only leaves via a hard owner flip (K consecutive owners)", () => {
    const k = DEFAULT_SPEAKER_EVIDENCE_CONFIG.flipThreshold; // 3
    let state = fold(["unknown_speaker", "unknown_speaker", "unknown_speaker"]);
    expect(state.verdict).toBe("not_owner");
    for (let i = 1; i <= k; i += 1) {
      state = reduceSpeakerEvidence(state, { decision: "owner_speaking" });
      if (i < k) {
        // Still sticky until K consecutive owner turns land the hard flip.
        expect(state.verdict).toBe("not_owner");
      } else {
        expect(state.verdict).toBe("owner_present");
      }
    }
  });

  test("alternating owner/unknown stays provisional (no flapping)", () => {
    const state = fold([
      "owner_speaking",
      "unknown_speaker",
      "owner_speaking",
      "unknown_speaker",
      "owner_speaking",
      "unknown_speaker",
    ]);
    // Never K consecutive of either -> never a hard flip. There is owner-ish
    // evidence in the window, so it settles at provisional, not owner/not_owner.
    expect(state.verdict).toBe("provisional");
    expect(state.ownerStreak).toBeLessThan(DEFAULT_SPEAKER_EVIDENCE_CONFIG.flipThreshold);
    expect(state.nonOwnerStreak).toBeLessThan(DEFAULT_SPEAKER_EVIDENCE_CONFIG.flipThreshold);
  });

  test("possible_owner-only sequence lands in provisional, never owner_present", () => {
    const state = fold([
      "possible_owner",
      "possible_owner",
      "possible_owner",
      "possible_owner",
      "possible_owner",
    ]);
    expect(state.verdict).toBe("provisional");
    expect(state.verdict).not.toBe("owner_present");
  });

  test("possible_owner does not count toward the owner_present streak flip", () => {
    // Mix owner and possible so the owner streak never reaches K.
    const state = fold([
      "owner_speaking",
      "possible_owner",
      "owner_speaking",
      "possible_owner",
    ]);
    expect(state.ownerStreak).toBe(0); // last turn was possible_owner
    // Majority of window is owner-ish but strong owner < majority; still not a
    // hard owner_present flip via streak. It settles provisional.
    expect(state.verdict).toBe("provisional");
  });

  test("stale gap decays owner_present back toward unknown before folding", () => {
    const cfg: Partial<SpeakerEvidenceConfig> = { staleTimeoutMs: 1000 };
    let state = foldSpeakerEvidence(
      [
        { decision: "owner_speaking", atMs: 0 },
        { decision: "owner_speaking", atMs: 100 },
        { decision: "owner_speaking", atMs: 200 },
      ],
      cfg,
    );
    expect(state.verdict).toBe("owner_present");

    // A turn far in the future (gap > staleTimeoutMs) decays evidence first.
    // The incoming lone owner turn then only rebuilds a streak of 1.
    state = reduceSpeakerEvidence(
      state,
      { decision: "owner_speaking", atMs: 5000 },
      cfg,
    );
    expect(state.ownerStreak).toBe(1);
    expect(state.verdict).not.toBe("owner_present");
  });

  test("stale gap of an unknown turn decays toward unknown, not not_owner", () => {
    const cfg: Partial<SpeakerEvidenceConfig> = { staleTimeoutMs: 1000 };
    let state = foldSpeakerEvidence(
      [
        { decision: "owner_speaking", atMs: 0 },
        { decision: "owner_speaking", atMs: 100 },
        { decision: "owner_speaking", atMs: 200 },
      ],
      cfg,
    );
    expect(state.verdict).toBe("owner_present");

    state = reduceSpeakerEvidence(
      state,
      { decision: "unknown_speaker", atMs: 10_000 },
      cfg,
    );
    expect(state.verdict).toBe("unknown");
    expect(state.ownerStreak).toBe(0);
    expect(state.nonOwnerStreak).toBe(1);
  });

  test("config K/window is respected: K=2 flips faster", () => {
    const cfg: Partial<SpeakerEvidenceConfig> = { flipThreshold: 2, windowSize: 4 };
    let state = initialSpeakerEvidenceState();
    state = reduceSpeakerEvidence(state, { decision: "owner_speaking" }, cfg);
    expect(state.verdict).not.toBe("owner_present");
    state = reduceSpeakerEvidence(state, { decision: "owner_speaking" }, cfg);
    expect(state.verdict).toBe("owner_present");
  });

  test("config K/window is respected: larger K needs more turns", () => {
    const cfg: Partial<SpeakerEvidenceConfig> = { flipThreshold: 4, windowSize: 6 };
    const three = fold(
      ["owner_speaking", "owner_speaking", "owner_speaking"],
      cfg,
    );
    expect(three.verdict).not.toBe("owner_present");
    const four = fold(
      ["owner_speaking", "owner_speaking", "owner_speaking", "owner_speaking"],
      cfg,
    );
    expect(four.verdict).toBe("owner_present");
  });

  test("recent ring is bounded by windowSize", () => {
    const cfg: Partial<SpeakerEvidenceConfig> = { flipThreshold: 3, windowSize: 3 };
    const state = fold(
      [
        "owner_speaking",
        "owner_speaking",
        "owner_speaking",
        "owner_speaking",
        "owner_speaking",
      ],
      cfg,
    );
    expect(state.recent.length).toBe(3);
  });

  test("non-consecutive owner-ish turns do NOT hard-flip to owner_present", () => {
    // Owner turns interleaved with possible_owner never reach K-in-a-row, so the
    // consecutive-streak flip rule keeps this at provisional (no majority arm).
    const cfg: Partial<SpeakerEvidenceConfig> = { flipThreshold: 3, windowSize: 5 };
    const state = fold(
      [
        "owner_speaking",
        "possible_owner",
        "owner_speaking",
        "possible_owner",
        "owner_speaking",
      ],
      cfg,
    );
    expect(state.ownerStreak).toBe(1);
    expect(state.verdict).toBe("provisional");
  });

  test("readSpeakerEvidence reports confidence blended from agreement + scores", () => {
    const state = foldSpeakerEvidence([
      { decision: "owner_speaking", score: 0.9 },
      { decision: "owner_speaking", score: 0.88 },
      { decision: "owner_speaking", score: 0.92 },
    ]);
    const reading = readSpeakerEvidence(state);
    expect(reading.verdict).toBe("owner_present");
    expect(reading.confidence).toBeGreaterThan(0.5);
    expect(reading.confidence).toBeLessThanOrEqual(1);
    expect(reading.ownerStreak).toBe(3);
  });

  test("not_owner confidence rises as the speaker is more clearly not the owner", () => {
    // Three unknown_speaker turns settle to not_owner. A clearly-different
    // speaker (very low cosine) must report HIGHER not_owner confidence than a
    // borderline speaker (cosine just under the owner threshold), not lower.
    const clearlyOther = readSpeakerEvidence(
      foldSpeakerEvidence([
        { decision: "unknown_speaker", score: 0.0 },
        { decision: "unknown_speaker", score: 0.0 },
        { decision: "unknown_speaker", score: 0.0 },
      ]),
    );
    const borderline = readSpeakerEvidence(
      foldSpeakerEvidence([
        { decision: "unknown_speaker", score: 0.7 },
        { decision: "unknown_speaker", score: 0.7 },
        { decision: "unknown_speaker", score: 0.7 },
      ]),
    );
    expect(clearlyOther.verdict).toBe("not_owner");
    expect(borderline.verdict).toBe("not_owner");
    expect(clearlyOther.confidence).toBeGreaterThan(borderline.confidence);
  });

  test("invalid config is rejected", () => {
    expect(() =>
      reduceSpeakerEvidence(initialSpeakerEvidenceState(), { decision: "owner_speaking" }, {
        flipThreshold: 0,
      }),
    ).toThrow(/flipThreshold/);
    expect(() =>
      reduceSpeakerEvidence(initialSpeakerEvidenceState(), { decision: "owner_speaking" }, {
        flipThreshold: 4,
        windowSize: 2,
      }),
    ).toThrow(/<= windowSize/);
  });

  test("reduce does not mutate the input state (pure)", () => {
    const state = initialSpeakerEvidenceState();
    const next = reduceSpeakerEvidence(state, { decision: "owner_speaking" });
    expect(state.recent).toEqual([]);
    expect(state.ownerStreak).toBe(0);
    expect(next).not.toBe(state);
    expect(next.recent.length).toBe(1);
  });
});
