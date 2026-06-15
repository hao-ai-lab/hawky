// =============================================================================
// test-relevance-gate.ts — M11: LLM relevance gate + deterministic fallback.
// =============================================================================

import { describe, test, expect } from "bun:test";
import {
  DeterministicRelevanceGate,
  LlmRelevanceGate,
  makeRelevanceGate,
  type RelevanceInput,
} from "../src/ambient/relevance-gate.js";
import type { Intention } from "../src/ambient/intention.js";
import type { TranscriptTurn } from "../src/ambient/transcript-window.js";

function latent(id: string, content: string, topic: string): Intention {
  return {
    id,
    content,
    trigger: { all: [{ kind: "topic", topic, provenance: "inferred", confidence: 0.9 }] },
    strength: "soft",
    origin: "latent",
    state: "armed",
    evidence: { ts: "2026-06-07T00:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-07T00:00:00Z",
  };
}
const turn = (text: string): TranscriptTurn => ({ role: "user", text, ts: "2026-06-07T00:00:00Z" });
const input = (armed: Intention[], window: TranscriptTurn[]): RelevanceInput => ({
  armed,
  window,
  now: Date.parse("2026-06-07T00:00:00Z"),
  tz: "UTC",
});

describe("DeterministicRelevanceGate", () => {
  test("surfaces when topic in window; populates matchedTerms", async () => {
    const v = await new DeterministicRelevanceGate().evaluate(
      input([latent("i1", "buy coffee", "coffee")], [turn("we really need coffee")]),
    );
    expect(v).toHaveLength(1);
    expect(v[0].surface).toBe(true);
    expect(v[0].matchedTerms).toContain("topic:coffee");
  });

  test("does not surface when topic absent", async () => {
    const v = await new DeterministicRelevanceGate().evaluate(
      input([latent("i1", "buy coffee", "coffee")], [turn("nice weather today")]),
    );
    expect(v[0].surface).toBe(false);
  });

  test("ignores non-match-surfaceable (armable-only / non-latent)", async () => {
    const obvious: Intention = {
      ...latent("i2", "take pills", "x"),
      origin: "obvious",
      trigger: { all: [{ kind: "when", at: "2026-06-07T08:00:00Z", provenance: "provided" }] },
    };
    const v = await new DeterministicRelevanceGate().evaluate(input([obvious], [turn("pills")]));
    expect(v).toHaveLength(0);
  });
});

describe("LlmRelevanceGate", () => {
  const arm = [latent("i1", "buy coffee", "coffee"), latent("i2", "buy milk", "milk")];

  test("parses verdicts; veto + below-threshold not surfaced; matchedTerms populated", async () => {
    const invoke = async () =>
      JSON.stringify([
        { id: "i1", surface: true, confidence: 0.9 },
        { id: "i2", surface: true, confidence: 0.3 }, // below SURFACE_THRESHOLD
      ]);
    const v = await new LlmRelevanceGate(invoke).evaluate(input(arm, [turn("coffee and milk")]));
    expect(v.find((x) => x.id === "i1")!.surface).toBe(true);
    expect(v.find((x) => x.id === "i2")!.surface).toBe(false);
    expect(v.find((x) => x.id === "i1")!.matchedTerms).toContain("topic:coffee");
  });

  test("drops unknown ids; omitted eligible ids are NOT backfilled", async () => {
    // Unknown id ("nope") dropped. The eligible ids (i1, i2) are omitted by the
    // LLM → treated as not-surface, NOT filled via the deterministic matcher.
    const invoke = async () => JSON.stringify([{ id: "nope", surface: true, confidence: 0.9 }]);
    const v = await new LlmRelevanceGate(invoke).evaluate(input(arm, [turn("x")]));
    expect(v).toHaveLength(0);
  });

  test("throws on non-JSON output", async () => {
    const g = new LlmRelevanceGate(async () => "not json at all");
    expect(g.evaluate(input(arm, [turn("x")]))).rejects.toThrow();
  });
});

describe("makeRelevanceGate (LLM-only, fail-soft)", () => {
  const coffee = [latent("i1", "buy coffee", "coffee")];

  test("LLM throw → empty (no deterministic fallback)", async () => {
    const g = makeRelevanceGate(async () => {
      throw new Error("model down");
    });
    const v = await g.evaluate(input(coffee, [turn("we need coffee")]));
    expect(v).toHaveLength(0);
  });

  test("malformed JSON → empty (no deterministic fallback)", async () => {
    const g = makeRelevanceGate(async () => "{bad");
    const v = await g.evaluate(input(coffee, [turn("we need coffee")]));
    expect(v).toHaveLength(0);
  });

  test("no invoke fn → empty (LLM-only; no deterministic surfacing)", async () => {
    const g = makeRelevanceGate();
    const v = await g.evaluate(input(coffee, [turn("we need coffee")]));
    expect(v).toHaveLength(0);
  });
});

describe("LlmRelevanceGate partial-output (omitted ids are not backfilled)", () => {
  const arm = [
    latent("i1", "buy coffee", "coffee"),
    latent("i2", "call dentist", "dentist"),
    latent("i3", "check email", "email"),
  ];

  test("LLM omits eligible ids → omitted ids absent (not backfilled)", async () => {
    // LLM only returns a verdict for i1; i2 and i3 are omitted → not surfaced,
    // and NOT filled via the deterministic matcher.
    const invoke = async () => JSON.stringify([{ id: "i1", surface: true, confidence: 0.9 }]);
    const w = [turn("I should call my dentist soon")];
    const v = await new LlmRelevanceGate(invoke).evaluate(input(arm, w));

    const ids = v.map((x) => x.id);
    expect(ids).toContain("i1");
    expect(ids).not.toContain("i2"); // omitted → not backfilled
    expect(ids).not.toContain("i3");
    expect(v.find((x) => x.id === "i1")!.surface).toBe(true);
  });

  test("LLM returns all ids → no deterministic fill needed", async () => {
    const twoArm = [latent("a", "coffee", "coffee"), latent("b", "milk", "milk")];
    const invoke = async () =>
      JSON.stringify([
        { id: "a", surface: true, confidence: 0.8 },
        { id: "b", surface: false, confidence: 0.4 },
      ]);
    const v = await new LlmRelevanceGate(invoke).evaluate(input(twoArm, [turn("coffee")]));
    expect(v).toHaveLength(2);
    expect(v.find((x) => x.id === "a")!.surface).toBe(true);
    expect(v.find((x) => x.id === "b")!.surface).toBe(false);
  });
});
