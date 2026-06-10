// =============================================================================
// Test: Ambient contracts (M0)
// Run: bun test tests/test-ambient-contracts.ts
// Verifies: canTransition, InMemoryIntentionStore, decideDelivery
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  canTransition,
  InMemoryIntentionStore,
  decideDelivery,
} from "../src/ambient/index.js";
import type { PushItem } from "../src/ambient/index.js";

// =============================================================================
// canTransition
// =============================================================================

describe("canTransition", () => {
  test("accepts pending_arm → armed", () => {
    expect(canTransition("pending_arm", "armed")).toBe(true);
  });

  test("accepts armed → surfaced", () => {
    expect(canTransition("armed", "surfaced")).toBe(true);
  });

  test("accepts surfaced → resolved", () => {
    expect(canTransition("surfaced", "resolved")).toBe(true);
  });

  test("rejects pending_arm → surfaced", () => {
    expect(canTransition("pending_arm", "surfaced")).toBe(false);
  });

  test("rejects arm_failed → armed", () => {
    expect(canTransition("arm_failed", "armed")).toBe(false);
  });

  test("rejects resolved → armed", () => {
    expect(canTransition("resolved", "armed")).toBe(false);
  });

  test("accepts pending_arm → superseded", () => {
    expect(canTransition("pending_arm", "superseded")).toBe(true);
  });

  test("accepts armed → superseded", () => {
    expect(canTransition("armed", "superseded")).toBe(true);
  });

  test("rejects superseded → pending_arm (no outgoing transitions)", () => {
    expect(canTransition("superseded", "pending_arm")).toBe(false);
  });

  test("rejects superseded → armed (no outgoing transitions)", () => {
    expect(canTransition("superseded", "armed")).toBe(false);
  });
});

// =============================================================================
// InMemoryIntentionStore
// =============================================================================

describe("InMemoryIntentionStore", () => {
  test("create defaults state to pending_arm", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "buy milk",
      trigger: { all: [{ kind: "when", at: "2026-06-05T18:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T10:00:00Z" },
      sensitivity: "private",
    });
    expect(intention.state).toBe("pending_arm");
    expect(intention.id).toBeTruthy();
  });

  test("get returns created intention", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "buy milk",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T10:00:00Z" },
      sensitivity: "private",
    });
    const found = await store.get(intention.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(intention.id);
  });

  test("get returns null for unknown id", async () => {
    const store = new InMemoryIntentionStore();
    expect(await store.get("nonexistent")).toBeNull();
  });

  test("transition: pending_arm → armed → surfaced → resolved", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "send slides to Sam",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-05T10:00:00Z" },
      sensitivity: "private",
      confidence: 0.8,
    });

    const armed = await store.transition(intention.id, "armed");
    expect(armed.state).toBe("armed");

    const fired = await store.transition(intention.id, "surfaced");
    expect(fired.state).toBe("surfaced");

    const resolved = await store.resolve(intention.id);
    expect(resolved.state).toBe("resolved");
  });

  test("list({ state }) filters correctly", async () => {
    const store = new InMemoryIntentionStore();
    await store.create({
      content: "item A",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T10:00:00Z" },
      sensitivity: "private",
    });
    const intentionB = await store.create({
      content: "item B",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T10:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(intentionB.id, "armed");

    const pending = await store.list({ state: "pending_arm" });
    expect(pending.length).toBe(1);
    expect(pending[0].content).toBe("item A");

    const armed = await store.list({ state: "armed" });
    expect(armed.length).toBe(1);
    expect(armed[0].content).toBe("item B");
  });

  test("illegal transition throws", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "test",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T10:00:00Z" },
      sensitivity: "private",
    });
    // pending_arm → surfaced is illegal
    expect(store.transition(intention.id, "surfaced")).rejects.toThrow();
  });

  test("list({ dueBefore }) returns only intentions whose when.at <= cutoff", async () => {
    const store = new InMemoryIntentionStore();
    await store.create({
      content: "early task",
      trigger: { all: [{ kind: "when", at: "2026-06-05T08:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "late task",
      trigger: { all: [{ kind: "when", at: "2026-06-05T20:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "no-time task",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });

    const due = await store.list({ dueBefore: "2026-06-05T12:00:00Z" });
    expect(due.length).toBe(1);
    expect(due[0].content).toBe("early task");
  });

  test("REPRO #450: list({ place:X }) must NOT return where.category:X intentions", async () => {
    // Before the fix, list({ place: "office" }) incorrectly returns a
    // where.category:"office" intention due to the legacy overload on line 136.
    // This test proves the bug and passes only after the overload is removed.
    const store = new InMemoryIntentionStore();
    await store.create({
      content: "office category task",
      trigger: { all: [{ kind: "where", category: "office" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });
    // No where.place:"office" intention is created — only where.category:"office".
    const results = await store.list({ place: "office" });
    expect(results.length).toBe(0);
  });

  test("list({ place }) matches only where.place, not where.category", async () => {
    const store = new InMemoryIntentionStore();
    await store.create({
      content: "gym task",
      trigger: { all: [{ kind: "where", place: "gym" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "office category task",
      trigger: { all: [{ kind: "where", category: "office" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "home task",
      trigger: { all: [{ kind: "where", place: "home" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });

    const gymResults = await store.list({ place: "gym" });
    expect(gymResults.length).toBe(1);
    expect(gymResults[0].content).toBe("gym task");

    // "office" only exists as where.category, not where.place — must not match
    const officeResults = await store.list({ place: "office" });
    expect(officeResults.length).toBe(0);
  });

  test("list({ category }) matches only where.category", async () => {
    const store = new InMemoryIntentionStore();
    await store.create({
      content: "office category task",
      trigger: { all: [{ kind: "where", category: "office" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "office place task",
      trigger: { all: [{ kind: "where", place: "office" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });

    // category filter: only where.category === "office", not where.place
    const categoryResults = await store.list({ category: "office" });
    expect(categoryResults.length).toBe(1);
    expect(categoryResults[0].content).toBe("office category task");
  });

  test("mutating a returned intention does not change the stored intention", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "original content",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" },
      sensitivity: "private",
    });

    // Mutate the returned object
    intention.content = "mutated content";

    // The store should still have the original value
    const fetched = await store.get(intention.id);
    expect(fetched?.content).toBe("original content");
  });
});

// =============================================================================
// decideDelivery — ported C1a cases
// =============================================================================

describe("decideDelivery", () => {
  test("at: set → speak + cancel", () => {
    const item: PushItem = {
      id: "p1",
      title: "Dentist appointment",
      body: "In 15 minutes",
      source: "intention",
      at: "2026-06-05T18:00:00Z",
    };
    const d = decideDelivery(item);
    expect(d.deliver).toBe("speak");
    expect(d.busy).toBe("cancel");
    expect(d.push).toBe(true);
  });

  test("kind:critical → speak + cancel", () => {
    const item: PushItem = {
      id: "p2",
      title: "Server down",
      body: "Gateway unreachable",
      source: "external",
      kind: "critical",
    };
    const d = decideDelivery(item);
    expect(d.deliver).toBe("speak");
    expect(d.busy).toBe("cancel");
    expect(d.push).toBe(true);
  });

  test("strength:hard → speak + queue", () => {
    const item: PushItem = {
      id: "p3",
      title: "Take vitamins",
      body: "Take vitamins",
      source: "intention",
      strength: "hard",
    };
    const d = decideDelivery(item);
    expect(d.deliver).toBe("speak");
    expect(d.busy).toBe("queue");
    expect(d.push).toBe(true);
  });

  test("intent/fact → context + downgrade", () => {
    const item: PushItem = {
      id: "p4",
      title: "Context note",
      body: "User mentioned coffee preference",
      source: "intention",
    };
    const d = decideDelivery(item);
    expect(d.deliver).toBe("context");
    expect(d.busy).toBe("downgrade");
    expect(d.push).toBe(false);
  });
});
