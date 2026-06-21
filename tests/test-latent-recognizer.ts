// =============================================================================
// Test: latent-recognizer (M8 §3.1, §3.3, §3.7)
// Run: bun test tests/test-latent-recognizer.ts
// Covers: DeterministicLatentRecognizer positive/negative corpus;
//         dedupAndSupersede surfaced-block + suppression-block.
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  DeterministicLatentRecognizer,
  ModelLatentRecognizer,
} from "../src/ambient/latent-recognizer.js";
import type { RecognizerInput, MintedIntention } from "../src/ambient/latent-recognizer.js";
import { dedupAndSupersede } from "../src/ambient/dedup.js";
import type { Intention } from "../src/ambient/intention.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(texts: string[], ts = "2026-06-06T10:00:00Z"): RecognizerInput {
  return {
    window: texts.map((text) => ({ role: "user" as const, text, ts })),
    recentIntentions: [],
    now: Date.now(),
    tz: "America/Los_Angeles",
  };
}

function makeIntention(
  content: string,
  state: Intention["state"],
  origin: Intention["origin"] = "latent",
): Intention {
  return {
    id: `id-${content}`,
    content,
    trigger: {},
    strength: "soft",
    origin,
    state,
    evidence: { ts: "2026-06-06T09:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-06T09:00:00Z",
    updatedAt: "2026-06-06T09:00:00Z",
  };
}

function makeMinted(content: string, ts = "2026-06-06T10:30:00Z"): MintedIntention {
  return {
    content,
    origin: "latent",
    strength: "soft",
    confidence: 0.7,
    trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred", confidence: 0.7 }] },
    evidence: { ts },
    sensitivity: "private",
  };
}

// ---------------------------------------------------------------------------
// DeterministicLatentRecognizer — positive cases
// ---------------------------------------------------------------------------

describe("DeterministicLatentRecognizer — positive cases", () => {
  const rec = new DeterministicLatentRecognizer();

  test("'we're out of coffee' → mints 'buy coffee' with correct shape", async () => {
    const results = await rec.recognize(makeInput(["we're out of coffee"]));
    expect(results).toHaveLength(1);
    const m = results[0];
    expect(m.origin).toBe("latent");
    expect(m.strength).toBe("soft");
    expect(m.content).toBe("buy coffee");
    expect(m.confidence).toBeGreaterThan(0);
    expect(m.confidence).toBeLessThanOrEqual(1);
  });

  test("minted intention has an inferred topic trigger", async () => {
    const results = await rec.recognize(makeInput(["we're out of coffee"]));
    const m = results[0];
    const topicTerm = m.trigger.all?.[0];
    expect(topicTerm?.kind).toBe("topic");
    expect((topicTerm as { provenance?: string }).provenance).toBe("inferred");
  });

  test("'we need more milk' → mints 'buy milk'", async () => {
    const results = await rec.recognize(makeInput(["we need more milk"]));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("buy milk");
  });

  test("'getting low on paper towels' → mints 'buy paper towels'", async () => {
    const results = await rec.recognize(makeInput(["getting low on paper towels"]));
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("paper towels");
  });

  test("assistant turns are ignored", async () => {
    const input: RecognizerInput = {
      window: [{ role: "assistant", text: "we're out of coffee", ts: "2026-06-06T10:00:00Z" }],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    expect(results).toHaveLength(0);
  });

  test("duplicate turns within same batch → deduplicated to one mint", async () => {
    const results = await rec.recognize(
      makeInput(["we're out of coffee", "we're out of coffee"]),
    );
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DeterministicLatentRecognizer — negative corpus (do-not-mint)
// ---------------------------------------------------------------------------

describe("DeterministicLatentRecognizer — negative corpus", () => {
  const rec = new DeterministicLatentRecognizer();

  test("question: 'do we need coffee?' → no mint", async () => {
    const results = await rec.recognize(makeInput(["do we need coffee?"]));
    expect(results).toHaveLength(0);
  });

  test("hypothetical: 'if we run out of coffee we should buy some' → no mint", async () => {
    const results = await rec.recognize(
      makeInput(["if we run out of coffee we should buy some"]),
    );
    expect(results).toHaveLength(0);
  });

  test("already satisfied: 'we bought coffee yesterday' → no mint", async () => {
    const results = await rec.recognize(makeInput(["we bought coffee yesterday"]));
    expect(results).toHaveLength(0);
  });

  test("third-party: 'she needs coffee' → no mint", async () => {
    const results = await rec.recognize(makeInput(["she needs coffee"]));
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dedup — surfaced blocks duplicate mint (M8 §3.7)
// ---------------------------------------------------------------------------

describe("dedupAndSupersede — active states always block (Fix M8 #2)", () => {
  test("active armed latent: newer evidence still blocks (no supersede+create)", () => {
    // Fix: armed is an active state → always block, even with newer ts.
    const existing: Intention[] = [makeIntention("buy coffee", "armed")];
    const minted = [makeMinted("buy coffee")]; // ts=10:30, existing=09:00 → newer, but blocked
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(supersede).toHaveLength(0);
    expect(create).toHaveLength(0);
  });

  test("active surfaced latent: same timestamp → blocked", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "surfaced")];
    const minted = [makeMinted("buy coffee", "2026-06-06T09:00:00Z")];
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(0);
    expect(supersede).toHaveLength(0);
  });

  test("active surfaced latent: newer evidence still blocks (fix: no supersede+create)", () => {
    // Fix M8 #2: surfaced is an active state → BLOCK regardless of newer ts.
    // Old (buggy) behavior was supersede+create; correct behavior is block.
    const existing: Intention[] = [makeIntention("buy coffee", "surfaced")];
    const minted = [makeMinted("buy coffee", "2026-06-06T11:00:00Z")];
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(supersede).toHaveLength(0);
    expect(create).toHaveLength(0);
  });

  test("active pending_arm latent: newer evidence still blocks", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "pending_arm")];
    const minted = [makeMinted("buy coffee", "2026-06-06T11:00:00Z")];
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(supersede).toHaveLength(0);
    expect(create).toHaveLength(0);
  });

  test("non-matching content is not blocked by a surfaced intention", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "surfaced")];
    const minted = [makeMinted("buy milk")];
    const { create } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(1);
    expect(create[0].content).toBe("buy milk");
  });
});

// ---------------------------------------------------------------------------
// dedup — obvious-origin active intentions block latent duplicates (Fix M8 #3)
// ---------------------------------------------------------------------------

describe("dedupAndSupersede — obvious-origin active blocks latent mint", () => {
  test("active obvious armed intention blocks latent mint of same content", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "armed", "obvious")];
    const minted = [makeMinted("buy coffee")];
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(0);
    expect(supersede).toHaveLength(0);
  });

  test("active obvious surfaced intention blocks latent mint of same content", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "surfaced", "obvious")];
    const minted = [makeMinted("buy coffee", "2026-06-06T11:00:00Z")];
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(0);
    expect(supersede).toHaveLength(0);
  });

  test("obvious-origin does not block a different content item", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "armed", "obvious")];
    const minted = [makeMinted("buy milk")];
    const { create } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// dedup — extra suppressed keys (Fix M8 #1: suppression survives prune)
// ---------------------------------------------------------------------------

describe("dedupAndSupersede — extraSuppressed blocks re-mint after prune", () => {
  test("content in extraSuppressed is blocked even when not in existing[]", () => {
    const existing: Intention[] = [];
    const extraSuppressed = new Set(["buy coffee"]);
    const minted = [makeMinted("buy coffee", "2026-06-06T12:00:00Z")];
    const { create, supersede } = dedupAndSupersede(minted, existing, extraSuppressed);
    expect(create).toHaveLength(0);
    expect(supersede).toHaveLength(0);
  });

  test("extraSuppressed check is case-insensitive", () => {
    const existing: Intention[] = [];
    const extraSuppressed = new Set(["buy coffee"]);
    const minted = [makeMinted("Buy Coffee")];
    const { create } = dedupAndSupersede(minted, existing, extraSuppressed);
    expect(create).toHaveLength(0);
  });

  test("extraSuppressed does not block a different item", () => {
    const existing: Intention[] = [];
    const extraSuppressed = new Set(["buy coffee"]);
    const minted = [makeMinted("buy milk")];
    const { create } = dedupAndSupersede(minted, existing, extraSuppressed);
    expect(create).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DeterministicLatentRecognizer — in-window stale satisfaction (Fix M8 #4)
// ---------------------------------------------------------------------------

describe("DeterministicLatentRecognizer — in-window stale satisfaction", () => {
  const rec = new DeterministicLatentRecognizer();

  test("'out of coffee' then 'we bought coffee' → no mint", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we're out of coffee", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "we bought coffee", ts: "2026-06-06T09:05:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    const coffee = results.find((r) => r.content === "buy coffee");
    expect(coffee).toBeUndefined();
  });

  test("'out of coffee' without satisfaction → mints", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we're out of coffee", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "also need milk", ts: "2026-06-06T09:01:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    const coffee = results.find((r) => r.content === "buy coffee");
    expect(coffee).toBeDefined();
  });

  test("satisfaction only cancels overlapping topic, not unrelated", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we're out of coffee", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "we need milk", ts: "2026-06-06T09:01:00Z" },
        { role: "user" as const, text: "we bought milk", ts: "2026-06-06T09:02:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    const coffee = results.find((r) => r.content === "buy coffee");
    const milk = results.find((r) => r.content === "buy milk");
    expect(coffee).toBeDefined(); // not cancelled
    expect(milk).toBeUndefined(); // cancelled
  });
});

// ---------------------------------------------------------------------------
// MED-5: generic cancel drops the most-recent pending candidate regardless
// of topic overlap — "never mind" / "forget it" / "cancel that"
// ---------------------------------------------------------------------------

describe("MED-5: generic cancel drops pending candidate without topic overlap", () => {
  const rec = new DeterministicLatentRecognizer();

  test("'we're out of coffee' then 'never mind' → no mint (generic cancel, no topic overlap needed)", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we're out of coffee", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "never mind", ts: "2026-06-06T09:01:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    expect(results.find((r) => r.content === "buy coffee")).toBeUndefined();
  });

  test("'we need milk' then 'forget it' → no mint", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we need milk", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "forget it", ts: "2026-06-06T09:01:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    expect(results.find((r) => r.content === "buy milk")).toBeUndefined();
  });

  test("'we're out of coffee' then 'cancel that' → no mint", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we're out of coffee", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "cancel that", ts: "2026-06-06T09:01:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    expect(results.find((r) => r.content === "buy coffee")).toBeUndefined();
  });

  test("unrelated turn after coffee mint does not cancel it", async () => {
    const input: RecognizerInput = {
      window: [
        { role: "user" as const, text: "we're out of coffee", ts: "2026-06-06T09:00:00Z" },
        { role: "user" as const, text: "also need to check the mail", ts: "2026-06-06T09:01:00Z" },
      ],
      recentIntentions: [],
      now: Date.now(),
      tz: "UTC",
    };
    const results = await rec.recognize(input);
    expect(results.find((r) => r.content === "buy coffee")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MED-6: possessive-person subjects treated as third-party → no mint
// ---------------------------------------------------------------------------

describe("MED-6: possessive-person subject → no mint (third-party filter)", () => {
  const rec = new DeterministicLatentRecognizer();

  test("'my mom needs milk' → no mint", async () => {
    const results = await rec.recognize(makeInput(["my mom needs milk"]));
    expect(results).toHaveLength(0);
  });

  test("'my dad needs coffee' → no mint", async () => {
    const results = await rec.recognize(makeInput(["my dad needs coffee"]));
    expect(results).toHaveLength(0);
  });

  test("'my friend needs a ride' → no mint", async () => {
    const results = await rec.recognize(makeInput(["my friend needs a ride"]));
    expect(results).toHaveLength(0);
  });

  test("'we need coffee' → still mints (not third-party)", async () => {
    const results = await rec.recognize(makeInput(["we need coffee"]));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("buy coffee");
  });
});

// ---------------------------------------------------------------------------
// dedup — suppressed blocks re-mint (M8 §3.7)
// ---------------------------------------------------------------------------

describe("dedupAndSupersede — suppressed blocks re-mint", () => {
  test("suppressed content is not re-minted", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "suppressed")];
    const minted = [makeMinted("buy coffee", "2026-06-06T12:00:00Z")];
    const { create, supersede } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(0);
    expect(supersede).toHaveLength(0);
  });

  test("suppressed check is case-insensitive", () => {
    const existing: Intention[] = [makeIntention("Buy Coffee", "suppressed")];
    const minted = [makeMinted("buy coffee")];
    const { create } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(0);
  });

  test("suppressed one item does not block a different item", () => {
    const existing: Intention[] = [makeIntention("buy coffee", "suppressed")];
    const minted = [makeMinted("buy milk")];
    const { create } = dedupAndSupersede(minted, existing);
    expect(create).toHaveLength(1);
    expect(create[0].content).toBe("buy milk");
  });
});

// ---------------------------------------------------------------------------
// Fix 1: ModelLatentRecognizer throws on invoke/parse failure → index.ts fallback
// ---------------------------------------------------------------------------

describe("ModelLatentRecognizer — throws on failure, fallback wiring", () => {
  function makeRecognizeInput(texts: string[], ts = "2026-06-07T10:00:00Z"): RecognizerInput {
    return {
      window: texts.map((text) => ({ role: "user" as const, text, ts })),
      recentIntentions: [],
      now: Date.now(),
      tz: "America/Los_Angeles",
    };
  }

  test("throwing modelInvokeFn → recognize() rejects (does NOT swallow)", async () => {
    const rec = new ModelLatentRecognizer(async () => {
      throw new Error("model outage");
    });
    await expect(rec.recognize(makeRecognizeInput(["we're out of milk"]))).rejects.toThrow("model outage");
  });

  test("non-JSON model response → recognize() rejects", async () => {
    const rec = new ModelLatentRecognizer(async () => "not json at all");
    await expect(rec.recognize(makeRecognizeInput(["we're out of milk"]))).rejects.toThrow();
  });

  test("index.ts-style wrapper falls back to DeterministicLatentRecognizer when ModelLatentRecognizer throws", async () => {
    const modelRec = new ModelLatentRecognizer(async () => {
      throw new Error("model down");
    });
    const deterministicFallback = new DeterministicLatentRecognizer();

    // Mirrors the index.ts wrapper pattern.
    const wrappedRecognizer = {
      recognize: async (input: RecognizerInput) => {
        try {
          return await modelRec.recognize(input);
        } catch {
          return deterministicFallback.recognize(input);
        }
      },
    };

    const result = await wrappedRecognizer.recognize(makeRecognizeInput(["we're out of coffee"]));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("buy coffee");
  });

  test("valid 'no needs' response (empty array) → returns [] without throwing", async () => {
    const rec = new ModelLatentRecognizer(async () => "[]");
    const result = await rec.recognize(makeRecognizeInput(["the weather is nice today"]));
    expect(result).toHaveLength(0);
  });

  test("empty window → returns [] without invoking model", async () => {
    let invoked = false;
    const rec = new ModelLatentRecognizer(async () => { invoked = true; return "[]"; });
    const result = await rec.recognize(makeRecognizeInput([]));
    expect(result).toHaveLength(0);
    expect(invoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: ModelLatentRecognizer — deterministic post-parse validation
// ---------------------------------------------------------------------------

describe("ModelLatentRecognizer — post-parse validation drops bad model mints", () => {
  function makeInput(texts: string[], ts = "2026-06-07T10:00:00Z"): RecognizerInput {
    return {
      window: texts.map((text) => ({ role: "user" as const, text, ts })),
      recentIntentions: [],
      now: Date.now(),
      tz: "America/Los_Angeles",
    };
  }

  test("model emits question content → dropped", async () => {
    // Content containing "?" is a question — NEGATIVE_PATTERNS matches.
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "do we need coffee?", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(makeInput(["we need coffee"]));
    expect(result).toHaveLength(0);
  });

  test("model emits third-party need → dropped", async () => {
    // "she needs coffee" matches third-party NEGATIVE_PATTERN.
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "she needs coffee", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(makeInput(["she needs coffee"]));
    expect(result).toHaveLength(0);
  });

  test("model emits speculative need → dropped", async () => {
    // "might need coffee" matches speculative NEGATIVE_PATTERN.
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "might need coffee", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(makeInput(["we might need coffee"]));
    expect(result).toHaveLength(0);
  });

  test("model emits already-active duplicate → dropped", async () => {
    const activeIntention = makeIntention("buy coffee", "armed");
    const input: RecognizerInput = {
      window: [{ role: "user" as const, text: "we're out of coffee", ts: "2026-06-07T10:00:00Z" }],
      recentIntentions: [activeIntention],
      now: Date.now(),
      tz: "America/Los_Angeles",
    };
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(input);
    expect(result).toHaveLength(0);
  });

  test("model emits already-satisfied content → dropped", async () => {
    // Window has "we bought coffee" — satisfies "buy coffee".
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(
      makeInput(["we're out of coffee", "we bought coffee"]),
    );
    expect(result).toHaveLength(0);
  });

  test("model emits genuine need → kept", async () => {
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "buy milk", confidence: 0.85, topic: "milk" }]),
    );
    const result = await rec.recognize(makeInput(["we're out of milk"]));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("buy milk");
  });
});

// ---------------------------------------------------------------------------
// FIX-1: ModelLatentRecognizer — satisfaction check uses only LATER turns
// Earlier "we bought coffee yesterday" must not falsely drop a valid later
// assertion "we're out of coffee" — only turns AFTER the source turn count.
// ---------------------------------------------------------------------------

describe("ModelLatentRecognizer — satisfaction applies only AFTER source turn (Fix-1)", () => {
  function makeWindowInput(
    turns: { text: string; ts: string }[],
  ): RecognizerInput {
    return {
      window: turns.map((t) => ({ role: "user" as const, text: t.text, ts: t.ts })),
      recentIntentions: [],
      now: Date.now(),
      tz: "America/Los_Angeles",
    };
  }

  test("earlier 'bought coffee' + later 'out of coffee' → candidate KEPT (not falsely dropped)", async () => {
    // Bug: old code checked ALL window turns; "bought coffee" (earlier) falsely dropped
    // the valid need asserted in the LATER turn "we're out of coffee".
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(
      makeWindowInput([
        { text: "we bought coffee yesterday", ts: "2026-06-07T09:00:00Z" },
        { text: "we're out of coffee", ts: "2026-06-07T09:30:00Z" },
      ]),
    );
    // The need is asserted in the LATER turn; satisfaction is in an EARLIER turn
    // and must not drop the candidate.
    expect(result.find((r) => r.content === "buy coffee")).toBeDefined();
  });

  test("'out of coffee' then 'just bought coffee' → candidate DROPPED (genuine later satisfaction)", async () => {
    // The need is asserted in an earlier turn; a LATER turn satisfies it — must drop.
    const rec = new ModelLatentRecognizer(
      async () => JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]),
    );
    const result = await rec.recognize(
      makeWindowInput([
        { text: "we're out of coffee", ts: "2026-06-07T09:00:00Z" },
        { text: "we just bought coffee", ts: "2026-06-07T09:30:00Z" },
      ]),
    );
    expect(result.find((r) => r.content === "buy coffee")).toBeUndefined();
  });
});
