#!/usr/bin/env bun
/**
 * Evidence-layer benchmark (layer 2 of docs/voiceprint-architecture.md
 * "Benchmark & multi-speaker testing").
 *
 * Simulates realistic turn-decision sequences through the REAL A2 reducer
 * (`reduceSpeakerEvidence` from src/identity/voiceprint/evidence.ts) plus the
 * auto-scorer's short-turn neutrality rule (replicated from
 * src/gateway/voiceprint-auto-score.ts `fold()`: an `unknown_speaker` turn
 * shorter than `minEvidenceTurnMs` is SKIPPED — it neither votes nor resets
 * the owner streak — but it still refreshes `updatedAtMs` so a run of short
 * turns cannot stale-decay a settled verdict).
 *
 * Deterministic: a seeded LCG generates every scenario; no Math.random().
 *
 * Run: bun run scripts/bench-voiceprint-evidence.ts
 */

import {
  initialSpeakerEvidenceState,
  reduceSpeakerEvidence,
  type SpeakerEvidenceConfig,
  type SpeakerEvidenceState,
  type SpeakerEvidenceVerdict,
} from "../src/identity/voiceprint/evidence.js";
import type { VoiceprintDecision } from "../src/identity/voiceprint/types.js";

// ---------------------------------------------------------------------------
// Deterministic RNG (numerical-recipes LCG; fixed seeds, no Math.random)
// ---------------------------------------------------------------------------

export type Rng = () => number;

export function makeLcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

// ---------------------------------------------------------------------------
// Simulated turns + the auto-scorer fold gating (replicated exactly)
// ---------------------------------------------------------------------------

/** One finalized turn as the auto-scorer would see it. */
export interface SimTurn {
  decision: VoiceprintDecision;
  /** endMs - startMs of the finalized turn. */
  durationMs: number;
  /** Wall-clock ms at which the turn is folded (drives staleness decay). */
  atMs: number;
  /** True while the OWNER is actually the one speaking (ground truth). */
  ownerSpeaking: boolean;
}

export interface BenchConfig {
  key: string;
  label: string;
  evidence: Partial<SpeakerEvidenceConfig>;
  /** 0 disables the short-turn gate (legacy behavior). */
  minEvidenceTurnMs: number;
}

/**
 * Replicates `VoiceprintAutoScorer.fold()` gating for one scored turn:
 * a short `unknown_speaker` turn is skipped (perfectly neutral) EXCEPT that it
 * refreshes the evidence timestamp; every other decision folds through the
 * real reducer with the turn's timestamp.
 */
export function foldTurnLikeAutoScorer(
  state: SpeakerEvidenceState,
  turn: SimTurn,
  cfg: BenchConfig,
): SpeakerEvidenceState {
  if (
    turn.decision === "unknown_speaker" &&
    cfg.minEvidenceTurnMs > 0 &&
    turn.durationMs < cfg.minEvidenceTurnMs
  ) {
    return { ...state, updatedAtMs: turn.atMs };
  }
  return reduceSpeakerEvidence(
    state,
    { decision: turn.decision, atMs: turn.atMs },
    cfg.evidence,
  );
}

// ---------------------------------------------------------------------------
// Scenario generators (seeded, deterministic)
// ---------------------------------------------------------------------------

export interface Scenario {
  name: string;
  description: string;
  turns: SimTurn[];
  /** Turn index (0-based) at which a guest permanently takes over, if any. */
  takeoverStartIndex?: number;
  expectedFinal: SpeakerEvidenceVerdict;
}

interface Clock {
  nowMs: number;
}

function ownerLongTurn(rng: Rng, clock: Clock, gapMs: number): SimTurn {
  const durationMs = uniform(rng, 2000, 6000);
  clock.nowMs += gapMs + durationMs;
  const r = rng();
  const decision: VoiceprintDecision =
    r < 0.85 ? "owner_speaking" : r < 0.95 ? "possible_owner" : "unknown_speaker";
  return { decision, durationMs, atMs: clock.nowMs, ownerSpeaking: true };
}

function ownerBackchannel(rng: Rng, clock: Clock, gapMs: number): SimTurn {
  const durationMs = uniform(rng, 500, 1500);
  clock.nowMs += gapMs + durationMs;
  const decision: VoiceprintDecision =
    rng() < 0.7 ? "unknown_speaker" : "owner_speaking";
  return { decision, durationMs, atMs: clock.nowMs, ownerSpeaking: true };
}

function guestTurn(rng: Rng, clock: Clock, gapMs: number): SimTurn {
  const durationMs = uniform(rng, 2000, 4000);
  clock.nowMs += gapMs + durationMs;
  return {
    decision: "unknown_speaker",
    durationMs,
    atMs: clock.nowMs,
    ownerSpeaking: false,
  };
}

function shortGap(rng: Rng): number {
  return uniform(rng, 300, 2000);
}

/** 1. Owner-only: long owner turns interleaved with short backchannels. */
export function scenarioOwnerOnly(seed: number): Scenario {
  const rng = makeLcg(seed);
  const clock: Clock = { nowMs: 1_000_000 };
  const turns: SimTurn[] = [];
  for (let i = 0; i < 40; i += 1) {
    const gap = shortGap(rng);
    turns.push(
      rng() < 0.35 ? ownerBackchannel(rng, clock, gap) : ownerLongTurn(rng, clock, gap),
    );
  }
  return {
    name: "owner-only",
    description: "40 owner turns; 35% short backchannels (0.5-1.5s, unknown p=0.7)",
    turns,
    expectedFinal: "owner_present",
  };
}

/** 2. Owner + guest interleave: owner blocks alternating with guest blocks. */
export function scenarioInterleave(seed: number): Scenario {
  const rng = makeLcg(seed);
  const clock: Clock = { nowMs: 1_000_000 };
  const turns: SimTurn[] = [];
  const blocks: Array<{ kind: "owner" | "guest"; count: number }> = [
    { kind: "owner", count: 4 },
    { kind: "guest", count: 3 },
    { kind: "owner", count: 4 },
    { kind: "guest", count: 5 },
    { kind: "owner", count: 4 },
  ];
  for (const block of blocks) {
    for (let i = 0; i < block.count; i += 1) {
      const gap = shortGap(rng);
      turns.push(
        block.kind === "owner"
          ? ownerLongTurn(rng, clock, gap)
          : guestTurn(rng, clock, gap),
      );
    }
  }
  return {
    name: "owner+guest interleave",
    description: "owner x4 / guest x3 / owner x4 / guest x5 / owner x4",
    turns,
    expectedFinal: "owner_present",
  };
}

/** 3. Guest takeover: owner establishes, then a guest speaks exclusively. */
export function scenarioTakeover(seed: number): Scenario {
  const rng = makeLcg(seed);
  const clock: Clock = { nowMs: 1_000_000 };
  const turns: SimTurn[] = [];
  for (let i = 0; i < 6; i += 1) {
    turns.push(ownerLongTurn(rng, clock, shortGap(rng)));
  }
  const takeoverStartIndex = turns.length;
  for (let i = 0; i < 14; i += 1) {
    turns.push(guestTurn(rng, clock, shortGap(rng)));
  }
  return {
    name: "guest takeover",
    description: "6 owner turns, then 14 exclusive guest turns (2-4s, unknown)",
    turns,
    takeoverStartIndex,
    expectedFinal: "not_owner",
  };
}

/** 4. Sparse: owner turns separated by long gaps (staleTimeoutMs interaction). */
export function scenarioSparse(seed: number): Scenario {
  const rng = makeLcg(seed);
  const clock: Clock = { nowMs: 1_000_000 };
  const turns: SimTurn[] = [];
  for (let i = 0; i < 10; i += 1) {
    // Gaps of 1.5-5 min; one 15-min gap in the middle exceeds even the
    // production 10-min stale timeout and must decay + re-establish.
    const gapMs = i === 5 ? 900_000 : uniform(rng, 90_000, 300_000);
    const durationMs = uniform(rng, 2000, 4000);
    clock.nowMs += gapMs + durationMs;
    const decision: VoiceprintDecision =
      rng() < 0.9 ? "owner_speaking" : "possible_owner";
    turns.push({ decision, durationMs, atMs: clock.nowMs, ownerSpeaking: true });
  }
  return {
    name: "sparse owner",
    description: "10 owner turns, 1.5-5 min gaps, one 15-min gap before turn 7",
    turns,
    expectedFinal: "owner_present",
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface BenchMetrics {
  /** 1-based count of turns fed until verdict first hit owner_present; null = never. */
  turnsToEstablish: number | null;
  /** Times an established owner_present verdict was subsequently lost. */
  ownerPresentLost: number;
  /** Turns after takeover start until verdict hit not_owner; null = never / n.a. */
  turnsToDetectGuest: number | null;
  finalVerdict: SpeakerEvidenceVerdict;
  finalCorrect: boolean;
}

export function runScenario(scenario: Scenario, cfg: BenchConfig): BenchMetrics {
  let state = initialSpeakerEvidenceState();
  let turnsToEstablish: number | null = null;
  let ownerPresentLost = 0;
  let turnsToDetectGuest: number | null = null;
  let prevVerdict: SpeakerEvidenceVerdict = state.verdict;

  scenario.turns.forEach((turn, index) => {
    state = foldTurnLikeAutoScorer(state, turn, cfg);
    const verdict = state.verdict;
    if (turnsToEstablish === null && verdict === "owner_present") {
      turnsToEstablish = index + 1;
    }
    if (prevVerdict === "owner_present" && verdict !== "owner_present") {
      ownerPresentLost += 1;
    }
    if (
      scenario.takeoverStartIndex !== undefined &&
      index >= scenario.takeoverStartIndex &&
      turnsToDetectGuest === null &&
      verdict === "not_owner"
    ) {
      turnsToDetectGuest = index - scenario.takeoverStartIndex + 1;
    }
    prevVerdict = verdict;
  });

  return {
    turnsToEstablish,
    ownerPresentLost,
    turnsToDetectGuest,
    finalVerdict: state.verdict,
    finalCorrect: state.verdict === scenario.expectedFinal,
  };
}

// ---------------------------------------------------------------------------
// Configs under test
// ---------------------------------------------------------------------------

export const BENCH_CONFIGS: BenchConfig[] = [
  {
    key: "a",
    label: "legacy sym flip=2",
    evidence: { flipThreshold: 2 },
    minEvidenceTurnMs: 0,
  },
  {
    key: "b",
    label: "legacy sym flip=3",
    evidence: { flipThreshold: 3 },
    minEvidenceTurnMs: 0,
  },
  {
    key: "c",
    label: "PRODUCTION o=2/n=4 min=2000 stale=600s",
    evidence: {
      ownerFlipThreshold: 2,
      nonOwnerFlipThreshold: 4,
      staleTimeoutMs: 600_000,
    },
    minEvidenceTurnMs: 2000,
  },
  {
    key: "d1",
    label: "prod variant nonOwnerFlip=3",
    evidence: {
      ownerFlipThreshold: 2,
      nonOwnerFlipThreshold: 3,
      staleTimeoutMs: 600_000,
    },
    minEvidenceTurnMs: 2000,
  },
  {
    key: "d2",
    label: "prod variant nonOwnerFlip=5",
    evidence: {
      ownerFlipThreshold: 2,
      nonOwnerFlipThreshold: 5,
      staleTimeoutMs: 600_000,
    },
    minEvidenceTurnMs: 2000,
  },
  {
    key: "d3",
    label: "prod variant minTurn=1500",
    evidence: {
      ownerFlipThreshold: 2,
      nonOwnerFlipThreshold: 4,
      staleTimeoutMs: 600_000,
    },
    minEvidenceTurnMs: 1500,
  },
];

export function buildScenarios(): Scenario[] {
  return [
    scenarioOwnerOnly(0xa11ce),
    scenarioInterleave(0xbee5),
    scenarioTakeover(0xcafe),
    scenarioSparse(0xdead),
  ];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(value: number | null): string {
  return value === null ? "never" : String(value);
}

export function renderReport(): string {
  const lines: string[] = [];
  lines.push("# Voiceprint evidence-layer benchmark (A2 reducer + fold gating)");
  lines.push("");
  for (const scenario of buildScenarios()) {
    lines.push(`## ${scenario.name} — ${scenario.description}`);
    lines.push(`Expected final verdict: \`${scenario.expectedFinal}\``);
    lines.push("");
    lines.push(
      "| Config | Turns to establish | owner_present lost | Turns to detect guest | Final verdict | Correct |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const cfg of BENCH_CONFIGS) {
      const m = runScenario(scenario, cfg);
      const guest =
        scenario.takeoverStartIndex === undefined ? "n/a" : fmt(m.turnsToDetectGuest);
      lines.push(
        `| ${cfg.label} | ${fmt(m.turnsToEstablish)} | ${m.ownerPresentLost} | ${guest} | ${m.finalVerdict} | ${m.finalCorrect ? "yes" : "NO"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  console.log(renderReport());
}
