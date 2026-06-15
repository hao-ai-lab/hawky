// =============================================================================
// Test: M6 schema foundation
// Covers: surfaced/suppressed states, transitions, TriggerTopic, provenance
// defaulting, confidence clamping, update(), topic/whoEntity/whoScene queries,
// suppressed pruning, surfaced survives ticks.
// Run: bun test tests/test-m8-schema.ts
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  canTransition,
  InMemoryIntentionStore,
} from "../src/ambient/index.js";
import type { TriggerTopic } from "../src/ambient/index.js";

// =============================================================================
// canTransition — new states
// =============================================================================

describe("canTransition — surfaced + suppressed", () => {
  test("armed → surfaced is legal", () => {
    expect(canTransition("armed", "surfaced")).toBe(true);
  });

  test("surfaced → resolved is legal", () => {
    expect(canTransition("surfaced", "resolved")).toBe(true);
  });

  test("surfaced → armed is legal", () => {
    expect(canTransition("surfaced", "armed")).toBe(true);
  });

  test("surfaced → suppressed is legal", () => {
    expect(canTransition("surfaced", "suppressed")).toBe(true);
  });

  test("suppressed → anything is illegal (terminal)", () => {
    expect(canTransition("suppressed", "resolved")).toBe(false);
    expect(canTransition("suppressed", "armed")).toBe(false);
    expect(canTransition("suppressed", "surfaced")).toBe(false);
    expect(canTransition("suppressed", "pending_arm")).toBe(false);
  });

  test("pending_arm → surfaced is illegal", () => {
    expect(canTransition("pending_arm", "surfaced")).toBe(false);
  });

  test("armed → suppressed / resolved are legal (M9 satisfaction sweep)", () => {
    // The sweep retires an armed latent directly when a later turn satisfies
    // (→ resolved) or cancels (→ suppressed) its topic, before it ever surfaces.
    expect(canTransition("armed", "suppressed")).toBe(true);
    expect(canTransition("armed", "resolved")).toBe(true);
  });

});

// =============================================================================
// Store transitions — surfaced/suppressed
// =============================================================================

function makeStore() {
  return new InMemoryIntentionStore();
}

async function createArmed() {
  const store = makeStore();
  const i = await store.create({
    content: "bring umbrella",
    trigger: {},
    strength: "soft",
    origin: "latent",
    evidence: { ts: "2026-06-06T10:00:00Z" },
    sensitivity: "private",
    confidence: 0.7,
  });
  await store.transition(i.id, "armed");
  return { store, id: i.id };
}

describe("InMemoryIntentionStore — surfaced/suppressed transitions", () => {
  test("armed → surfaced → resolved", async () => {
    const { store, id } = await createArmed();
    const surfaced = await store.transition(id, "surfaced");
    expect(surfaced.state).toBe("surfaced");
    const resolved = await store.resolve(id);
    expect(resolved.state).toBe("resolved");
  });

  test("armed → surfaced → armed (confirm with trigger)", async () => {
    const { store, id } = await createArmed();
    await store.transition(id, "surfaced");
    const armed = await store.transition(id, "armed");
    expect(armed.state).toBe("armed");
  });

  test("armed → surfaced → suppressed", async () => {
    const { store, id } = await createArmed();
    await store.transition(id, "surfaced");
    const suppressed = await store.transition(id, "suppressed");
    expect(suppressed.state).toBe("suppressed");
  });

  test("suppressed → anything throws", async () => {
    const { store, id } = await createArmed();
    await store.transition(id, "surfaced");
    await store.transition(id, "suppressed");
    await expect(store.transition(id, "resolved")).rejects.toThrow();
  });
});

// =============================================================================
// update()
// =============================================================================

describe("InMemoryIntentionStore — update()", () => {
  test("update confidence promotes value", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "test update",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
      confidence: 0.5,
    });
    const updated = await store.update(i.id, { confidence: 0.9 });
    expect(updated.confidence).toBe(0.9);
    expect(typeof updated.updatedAt).toBe("string");
  });

  test("update with trigger replaces trigger", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "test trigger patch",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    const newTrigger = { all: [{ kind: "when" as const, at: "2026-07-01T09:00:00Z" }] };
    const updated = await store.update(i.id, { trigger: newTrigger });
    expect(updated.trigger.all?.[0]?.kind).toBe("when");
  });

  test("update throws for unknown id", async () => {
    const store = makeStore();
    await expect(store.update("nonexistent", { confidence: 0.8 })).rejects.toThrow();
  });

  test("update does not change state", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "state unchanged",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(i.id, "armed");
    const updated = await store.update(i.id, { confidence: 0.75 });
    expect(updated.state).toBe("armed");
  });
});

// =============================================================================
// Confidence clamping
// =============================================================================

describe("confidence clamping", () => {
  test("create clamps confidence > 1 to 1", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "clamp high",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
      confidence: 1.5,
    });
    expect(i.confidence).toBe(1);
  });

  test("create clamps confidence < 0 to 0", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "clamp low",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
      confidence: -0.3,
    });
    expect(i.confidence).toBe(0);
  });

  test("update clamps confidence > 1 to 1", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "update clamp high",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    const updated = await store.update(i.id, { confidence: 2.0 });
    expect(updated.confidence).toBe(1);
  });

  test("update clamps confidence < 0 to 0", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "update clamp low",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    const updated = await store.update(i.id, { confidence: -1 });
    expect(updated.confidence).toBe(0);
  });

  test("term confidence clamped in create", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "term confidence clamp",
      trigger: { all: [{ kind: "when", at: "2026-07-01T09:00:00Z", confidence: 1.8 }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    expect((i.trigger.all?.[0] as { confidence?: number }).confidence).toBe(1);
  });

  test("term confidence clamped in update", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "term confidence clamp update",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    const updated = await store.update(i.id, {
      trigger: { all: [{ kind: "topic", topic: "health", confidence: -0.5 }] },
    });
    expect((updated.trigger.all?.[0] as { confidence?: number }).confidence).toBe(0);
  });
});

// =============================================================================
// Provenance defaulting
// =============================================================================

describe("provenance defaulting", () => {
  test("create defaults provenance to 'provided' when absent", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "provenance default",
      trigger: { all: [{ kind: "when", at: "2026-07-01T09:00:00Z" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    expect((i.trigger.all?.[0] as { provenance?: string }).provenance).toBe("provided");
  });

  test("create preserves explicit provenance 'inferred'", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "provenance inferred",
      trigger: { all: [{ kind: "topic", topic: "health", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    expect((i.trigger.all?.[0] as TriggerTopic).provenance).toBe("inferred");
  });

  test("update defaults provenance to 'provided' in trigger patch", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "provenance update default",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    const updated = await store.update(i.id, {
      trigger: { all: [{ kind: "who", entity: "Alice" }] },
    });
    expect((updated.trigger.all?.[0] as { provenance?: string }).provenance).toBe("provided");
  });
});

// =============================================================================
// TriggerTopic + topic normalization
// =============================================================================

describe("TriggerTopic + normalization", () => {
  test("topic normalized to lowercase+trim on create", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "topic normalization",
      trigger: { all: [{ kind: "topic", topic: "  Health  " }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    expect((i.trigger.all?.[0] as TriggerTopic).topic).toBe("health");
  });

  test("topic normalized on update", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "topic normalization update",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    const updated = await store.update(i.id, {
      trigger: { all: [{ kind: "topic", topic: "  WORK " }] },
    });
    expect((updated.trigger.all?.[0] as TriggerTopic).topic).toBe("work");
  });
});

// =============================================================================
// Query: topic
// =============================================================================

describe("list({ topic })", () => {
  test("matches intention with topic term", async () => {
    const store = makeStore();
    await store.create({
      content: "health task",
      trigger: { all: [{ kind: "topic", topic: "health" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "work task",
      trigger: { all: [{ kind: "topic", topic: "work" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });

    const results = await store.list({ topic: "health" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("health task");
  });

  test("query normalizes topic before matching", async () => {
    const store = makeStore();
    await store.create({
      content: "health task",
      trigger: { all: [{ kind: "topic", topic: "health" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });

    const results = await store.list({ topic: "  HEALTH  " });
    expect(results.length).toBe(1);
  });

  test("does not match where.category with topic query", async () => {
    const store = makeStore();
    await store.create({
      content: "office category task",
      trigger: { all: [{ kind: "where", category: "health" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });

    const results = await store.list({ topic: "health" });
    expect(results.length).toBe(0);
  });

});

// =============================================================================
// Query: whoEntity + whoScene
// =============================================================================

describe("list({ whoEntity, whoScene })", () => {
  test("whoEntity matches who term by entity", async () => {
    const store = makeStore();
    await store.create({
      content: "alice task",
      trigger: { all: [{ kind: "who", entity: "Alice" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "bob task",
      trigger: { all: [{ kind: "who", entity: "Bob" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });

    const results = await store.list({ whoEntity: "Alice" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("alice task");
  });

  test("whoScene matches who term by scene", async () => {
    const store = makeStore();
    await store.create({
      content: "meeting task",
      trigger: { all: [{ kind: "who", scene: "standup" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    await store.create({
      content: "lunch task",
      trigger: { all: [{ kind: "who", scene: "lunch" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });

    const results = await store.list({ whoScene: "standup" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("meeting task");
  });

  test("whoEntity does not match by scene", async () => {
    const store = makeStore();
    await store.create({
      content: "scene task",
      trigger: { all: [{ kind: "who", scene: "Alice" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });

    const results = await store.list({ whoEntity: "Alice" });
    expect(results.length).toBe(0);
  });
});

// =============================================================================
// Suppressed prune + surfaced survives ticks
// =============================================================================

describe("prune includes suppressed, not surfaced", () => {
  test("prune removes suppressed intentions", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "to suppress",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");
    await store.transition(i.id, "suppressed");

    const removed = await store.prune!(["superseded", "resolved", "suppressed"]);
    expect(removed).toBe(1);
    expect(await store.get(i.id)).toBeNull();
  });

  test("prune does NOT remove surfaced intentions", async () => {
    const store = makeStore();
    const i = await store.create({
      content: "surfaced, keep me",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-06T10:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    const removed = await store.prune!(["superseded", "resolved", "suppressed"]);
    expect(removed).toBe(0);
    const found = await store.get(i.id);
    expect(found?.state).toBe("surfaced");
  });
});
