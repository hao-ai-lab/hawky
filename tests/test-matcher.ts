// =============================================================================
// Test: matchLatent (M9 §9a)
// Run: bun test tests/test-matcher.ts
// =============================================================================

import { describe, expect, test } from "bun:test";
import { matchLatent, SURFACE_THRESHOLD, type ContextSnapshot } from "../src/ambient/matcher.js";
import type { Intention } from "../src/ambient/intention.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeIntention(overrides: Partial<Intention> = {}): Intention {
  return {
    id: "i1",
    content: "test",
    trigger: {},
    strength: "soft",
    origin: "latent",
    state: "armed",
    evidence: { ts: "2026-06-07T00:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-07T00:00:00Z",
    ...overrides,
  };
}

/** Build a ContextSnapshot. nowHHMM is "HH:MM" in "UTC". */
function makeCtx(overrides: Partial<ContextSnapshot> & { nowHHMM?: string } = {}): ContextSnapshot {
  const { nowHHMM, ...rest } = overrides;
  // Default: 2026-06-07 20:00 UTC
  const now = nowHHMM
    ? (() => {
        const [hh, mm] = nowHHMM.split(":").map(Number);
        const d = new Date("2026-06-07T00:00:00Z");
        d.setUTCHours(hh, mm, 0, 0);
        return d.getTime();
      })()
    : new Date("2026-06-07T20:00:00Z").getTime();
  return {
    now,
    tz: "UTC",
    transcriptWindow: [],
    ...rest,
  };
}

function turn(text: string): import("../src/ambient/transcript-window.js").TranscriptTurn {
  return { role: "user", text, ts: "2026-06-07T20:00:00Z" };
}

// -----------------------------------------------------------------------------
// Empty / only-armable triggers → no surface
// -----------------------------------------------------------------------------

describe("empty trigger → no surface", () => {
  test("trigger.all undefined → surface:false, confidence:0", () => {
    const i = makeIntention({ trigger: {} });
    const v = matchLatent(i, makeCtx());
    expect(v.surface).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.matchedTerms).toEqual([]);
  });

  test("trigger.all empty array → surface:false", () => {
    const i = makeIntention({ trigger: { all: [] } });
    const v = matchLatent(i, makeCtx());
    expect(v.surface).toBe(false);
    expect(v.confidence).toBe(0);
  });

  test("only provided-when (armable) → no match-only terms → surface:false", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "when", at: "2026-06-07T20:00:00Z", provenance: "provided", confidence: 1.0 }] } });
    const v = matchLatent(i, makeCtx());
    expect(v.surface).toBe(false);
    expect(v.confidence).toBe(0);
  });

  test("only where-with-place (armable) → surface:false", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "where", place: "grocery", confidence: 1.0 }] } });
    const v = matchLatent(i, makeCtx());
    expect(v.surface).toBe(false);
  });

  test("when+where-with-place (both armable) → surface:false", () => {
    const i = makeIntention({
      trigger: {
        all: [
          { kind: "when", at: "2026-06-07T20:00:00Z", provenance: "provided" },
          { kind: "where", place: "gym", confidence: 1.0 },
        ],
      },
    });
    const v = matchLatent(i, makeCtx());
    expect(v.surface).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// topic term
// -----------------------------------------------------------------------------

describe("topic term", () => {
  test("topic in transcript → matches", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "dinner", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("What should we have for dinner tonight?")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.confidence).toBeCloseTo(0.9);
    expect(v.matchedTerms).toContain("topic:dinner");
  });

  test("topic NOT in transcript → no surface", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "dinner", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("The weather looks nice today.")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.matchedTerms).toEqual([]);
  });

  test("topic match is case-insensitive", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "Dinner", confidence: 0.8 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("We should talk about DINNER.")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("topic substring does not match (whole-word check)", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "din", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("What should we have for dinner?")] });
    const v = matchLatent(i, ctx);
    // "din" is not a whole word in "dinner"
    expect(v.surface).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// where (category-only) term
// -----------------------------------------------------------------------------

describe("where category-only term", () => {
  test("category in transcript → matches", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "where", category: "coffee", confidence: 0.85 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("I'm at the coffee shop.")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.matchedTerms).toContain("where::coffee");
  });

  test("category via ctx.location → matches", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "where", category: "gym", confidence: 0.9 }] } });
    const ctx = makeCtx({ location: { category: "gym" } });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("category not in transcript and not in location → no surface", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "where", category: "gym", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("Nothing relevant here.")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// who term
// -----------------------------------------------------------------------------

describe("who term", () => {
  test("entity in transcript → matches", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "who", entity: "alice", confidence: 0.8 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("Have you talked to Alice recently?")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.matchedTerms[0]).toContain("alice");
  });

  test("scene in transcript → matches", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "who", scene: "meeting", confidence: 0.75 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("We have a meeting tomorrow.")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("neither entity nor scene in transcript → no surface", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "who", entity: "bob", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("Nothing about that person.")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// inferred when slot
// -----------------------------------------------------------------------------

describe("inferred when slot", () => {
  test("now inside slot → matches", () => {
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred", confidence: 0.8 }] },
    });
    const ctx = makeCtx({ nowHHMM: "20:00" }); // 20:00 UTC, within 18–22
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.matchedTerms).toContain("when:slot:18:00-22:00");
  });

  test("now outside slot → no surface", () => {
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred", confidence: 0.9 }] },
    });
    const ctx = makeCtx({ nowHHMM: "10:00" }); // outside window
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
  });

  test("edge: now exactly at slot start → matches", () => {
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred", confidence: 0.9 }] },
    });
    const ctx = makeCtx({ nowHHMM: "18:00" });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("edge: now exactly at slot end → matches", () => {
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred", confidence: 0.9 }] },
    });
    const ctx = makeCtx({ nowHHMM: "22:00" });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("past-midnight slot: now inside (late night) → matches", () => {
    // Slot 22:00–06:00 wraps midnight.
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "22:00", end: "06:00" }, provenance: "inferred", confidence: 0.8 }] },
    });
    const ctx = makeCtx({ nowHHMM: "23:30" }); // inside
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("past-midnight slot: now inside (early morning) → matches", () => {
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "22:00", end: "06:00" }, provenance: "inferred", confidence: 0.8 }] },
    });
    const ctx = makeCtx({ nowHHMM: "03:00" }); // inside (early morning)
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
  });

  test("past-midnight slot: now outside (afternoon) → no surface", () => {
    const i = makeIntention({
      trigger: { all: [{ kind: "when", window: { start: "22:00", end: "06:00" }, provenance: "inferred", confidence: 0.8 }] },
    });
    const ctx = makeCtx({ nowHHMM: "14:00" }); // outside
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
  });

  test("inferred when without window (no slot) → does not match (not evaluable)", () => {
    // An inferred `when` without a window has no slot to check; should not surface.
    const i = makeIntention({
      trigger: { all: [{ kind: "when", provenance: "inferred", confidence: 0.9 }] },
    });
    // The term IS match-only (non-armable) but has no window, so it can never match.
    const ctx = makeCtx({ nowHHMM: "20:00" });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Threshold boundary
// -----------------------------------------------------------------------------

describe("SURFACE_THRESHOLD boundary", () => {
  test("confidence exactly 0.6 → surface:true", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "dinner", confidence: 0.6 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("dinner plans tonight?")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.confidence).toBeCloseTo(SURFACE_THRESHOLD);
  });

  test("confidence just below 0.6 (0.59) → surface:false", () => {
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "dinner", confidence: 0.59 }] } });
    const ctx = makeCtx({ transcriptWindow: [turn("dinner plans tonight?")] });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
    expect(v.confidence).toBeCloseTo(0.59);
  });
});

// -----------------------------------------------------------------------------
// MIN aggregation (conjunction)
// -----------------------------------------------------------------------------

describe("MIN aggregation over matched terms", () => {
  test("two matching terms → confidence = min(c1, c2)", () => {
    const i = makeIntention({
      trigger: {
        all: [
          { kind: "topic", topic: "dinner", confidence: 0.9 },
          { kind: "who", entity: "alice", confidence: 0.7 },
        ],
      },
    });
    const ctx = makeCtx({
      transcriptWindow: [turn("What should alice and I have for dinner?")],
    });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.confidence).toBeCloseTo(0.7); // min(0.9, 0.7)
    expect(v.matchedTerms).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// Conjunction: topic∧slot (both needed)
// -----------------------------------------------------------------------------

describe("conjunction: topic AND inferred-when slot", () => {
  test("both match → surface:true", () => {
    const i = makeIntention({
      trigger: {
        all: [
          { kind: "topic", topic: "meditation", confidence: 0.8 },
          { kind: "when", window: { start: "06:00", end: "09:00" }, provenance: "inferred", confidence: 0.9 },
        ],
      },
    });
    const ctx = makeCtx({
      nowHHMM: "07:30",
      transcriptWindow: [turn("I want to start a meditation practice.")],
    });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(true);
    expect(v.confidence).toBeCloseTo(0.8); // min(0.8, 0.9)
    expect(v.matchedTerms).toHaveLength(2);
  });

  test("topic matches but slot doesn't → surface:false", () => {
    const i = makeIntention({
      trigger: {
        all: [
          { kind: "topic", topic: "meditation", confidence: 0.8 },
          { kind: "when", window: { start: "06:00", end: "09:00" }, provenance: "inferred", confidence: 0.9 },
        ],
      },
    });
    const ctx = makeCtx({
      nowHHMM: "20:00", // outside 06–09
      transcriptWindow: [turn("I want to start a meditation practice.")],
    });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
    expect(v.matchedTerms).toEqual([]);
  });

  test("slot matches but topic doesn't → surface:false", () => {
    const i = makeIntention({
      trigger: {
        all: [
          { kind: "topic", topic: "meditation", confidence: 0.8 },
          { kind: "when", window: { start: "06:00", end: "09:00" }, provenance: "inferred", confidence: 0.9 },
        ],
      },
    });
    const ctx = makeCtx({
      nowHHMM: "07:30",
      transcriptWindow: [turn("I'm going to the gym today.")],
    });
    const v = matchLatent(i, ctx);
    expect(v.surface).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Recency: old turns outside RECENCY_WINDOW do not contribute
// -----------------------------------------------------------------------------

describe("recencyWeight: old turns don't match", () => {
  test("matching turn beyond recency window → no surface", () => {
    // Build 12 turns; the matching turn is index 0 (oldest), beyond RECENCY_WINDOW=10.
    const turnsArr = Array.from({ length: 12 }, (_, i) =>
      i === 0 ? turn("We should discuss dinner tonight.") : turn(`filler turn ${i}`),
    );
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "dinner", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: turnsArr });
    const v = matchLatent(i, ctx);
    // Turn at index 0 in a 12-turn window: 0 < 12-10=2 → recencyWeight=0 → no match.
    expect(v.surface).toBe(false);
  });

  test("matching turn within recency window → surface", () => {
    // 12 turns; matching turn at index 2 (just within last 10 of 12).
    const turnsArr = Array.from({ length: 12 }, (_, i) =>
      i === 2 ? turn("We should discuss dinner tonight.") : turn(`filler turn ${i}`),
    );
    const i = makeIntention({ trigger: { all: [{ kind: "topic", topic: "dinner", confidence: 0.9 }] } });
    const ctx = makeCtx({ transcriptWindow: turnsArr });
    const v = matchLatent(i, ctx);
    // index 2 >= 12-10=2 → recencyWeight=1.0 → matches.
    expect(v.surface).toBe(true);
  });
});

describe("multi-word topics (codex HIGH fix)", () => {
  test("a multi-word topic matches a contiguous phrase in the window", () => {
    const intention = makeIntention({
      content: "buy dish soap",
      trigger: { all: [{ kind: "topic", topic: "dish soap", provenance: "inferred", confidence: 0.9 }] },
    });
    const ctx = makeCtx({ transcriptWindow: [turn("we should grab some dish soap later")] });
    expect(matchLatent(intention, ctx).surface).toBe(true);
  });

  test("a multi-word topic does NOT match when only one word is present", () => {
    const intention = makeIntention({
      content: "buy dish soap",
      trigger: { all: [{ kind: "topic", topic: "dish soap", provenance: "inferred", confidence: 0.9 }] },
    });
    const ctx = makeCtx({ transcriptWindow: [turn("please wash that dish")] });
    expect(matchLatent(intention, ctx).surface).toBe(false);
  });
});
