// =============================================================================
// test-create-intention.ts — structured obvious-intention build + precision gate.
// buildObviousIntention turns explicit slots ({content, when}) into a hard/obvious
// IntentionCreateRequest, resolving the time and bouncing under-specified `when`
// to clarification (the precision gate) instead of storing a guess.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { buildObviousIntention, hasMixedTriggerTerms } from "../src/ambient/create-intention.js";

const T0 = Date.parse("2026-06-05T12:00:00.000Z");

function whenTerm(req: { trigger: { all?: any[] } }) {
  return (req.trigger.all ?? []).find((t) => t.kind === "when");
}

describe("buildObviousIntention — precision gate", () => {
  test("resolves a bare clock ('8pm') to a future ISO", () => {
    const r = buildObviousIntention({ content: "Take pills", when: "8pm" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.content).toBe("Take pills");
    const t = whenTerm(r.request);
    expect(t?.kind).toBe("when");
    expect(Date.parse(t!.at)).toBeGreaterThan(T0); // 20:00Z today
  });

  test("resolves a relative offset ('in 10 minutes')", () => {
    const r = buildObviousIntention({ content: "Stretch", when: "in 10 minutes" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Date.parse(whenTerm(r.request)!.at)).toBe(T0 + 10 * 60_000);
  });

  test("resolves a day-qualified time ('tomorrow at 9am')", () => {
    const r = buildObviousIntention({ content: "Leave", when: "tomorrow at 9am" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(whenTerm(r.request)!.at).toBe("2026-06-06T09:00:00.000Z");
  });

  test("ISO passthrough is used directly (no NLP)", () => {
    const iso = "2026-06-06T03:00:00.000Z";
    const r = buildObviousIntention({ content: "Wake up", when: iso }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(whenTerm(r.request)!.at).toBe(iso);
  });

  test("missing when → needsClarification (does not store a guess)", () => {
    const r = buildObviousIntention({ content: "Buy eggs" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needsClarification).toBe(true);
    expect(r.reason).toBe("missing_when");
    expect(r.ask.length).toBeGreaterThan(0);
  });

  test("vague when ('later') → needsClarification", () => {
    const r = buildObviousIntention({ content: "Buy eggs", when: "later" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unresolvable_when");
  });

  test("missing content → needsClarification", () => {
    const r = buildObviousIntention({ content: "  ", when: "8pm" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing_content");
  });
});

describe("hasMixedTriggerTerms — Fix 3: forbid mixed armable + match-only predicates", () => {
  // armable: when(provided), where+place
  // match-only: topic, who, where(category-only), when(inferred+window)

  test("pure-armable (when only) → not mixed", () => {
    expect(hasMixedTriggerTerms([
      { kind: "when", at: "2026-06-07T08:00:00Z", provenance: "provided" },
    ])).toBe(false);
  });

  test("pure-armable (when + where+place) → not mixed", () => {
    expect(hasMixedTriggerTerms([
      { kind: "when", at: "2026-06-07T08:00:00Z", provenance: "provided" },
      { kind: "where", place: "home", provenance: "provided" },
    ])).toBe(false);
  });

  test("pure match-only (topic only) → not mixed", () => {
    expect(hasMixedTriggerTerms([
      { kind: "topic", topic: "coffee", provenance: "inferred" },
    ])).toBe(false);
  });

  test("pure match-only (topic + who) → not mixed", () => {
    expect(hasMixedTriggerTerms([
      { kind: "topic", topic: "coffee", provenance: "inferred" },
      { kind: "who", entity: "Alice", provenance: "inferred" },
    ])).toBe(false);
  });

  test("mixed: armable when + match-only topic → mixed", () => {
    expect(hasMixedTriggerTerms([
      { kind: "when", at: "2026-06-07T08:00:00Z", provenance: "provided" },
      { kind: "topic", topic: "groceries", provenance: "inferred" },
    ])).toBe(true);
  });

  test("mixed: armable where+place + match-only inferred when-slot → mixed", () => {
    expect(hasMixedTriggerTerms([
      { kind: "where", place: "home", provenance: "provided" },
      { kind: "when", window: { start: "08:00", end: "10:00" }, provenance: "inferred" },
    ])).toBe(true);
  });

  test("buildObviousIntention with pure when → ok (not rejected by guard)", () => {
    const r = buildObviousIntention({ content: "Take pills", when: "8pm" }, { now: T0, timezone: "UTC" });
    expect(r.ok).toBe(true);
  });

  test("single term → not mixed (guard requires at least 2 terms)", () => {
    expect(hasMixedTriggerTerms([{ kind: "topic", topic: "x" }])).toBe(false);
  });
});
