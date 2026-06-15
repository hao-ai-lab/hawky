// =============================================================================
// Test: M6 suite — precision corpus + lifecycle + prune-survival + coexistence
// Run: bun test tests/test-m8-suite.ts
// Covers:
//   - Precision boundary (§3.3): ≥90% no-mint on negatives, ≥80% recall on positives
//   - Confirm lifecycle: surfaced→armed (gains trigger) and surfaced→resolved
//   - Decline lifecycle: surfaced→suppressed; suppressed content not re-minted
//   - Surfaced survives IntentionLoop.tick() prune
//   - Mixed coexistence: obvious hard + latent soft in same store
//   - Term-type matrix: when/where.place/where.category/who/topic/manual round-trips
// =============================================================================

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DeterministicLatentRecognizer,
  type RecognizerInput,
} from "../src/ambient/latent-recognizer.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { IntentionService } from "../src/ambient/intention-service.js";
import { LatentService } from "../src/ambient/latent-service.js";
import { dedupAndSupersede } from "../src/ambient/dedup.js";
import { termKey, isArmable } from "../src/ambient/trigger.js";
import type { Intention } from "../src/ambient/intention.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TS = "2026-06-06T10:00:00Z";

function makeInput(text: string): RecognizerInput {
  return {
    window: [{ role: "user" as const, text, ts: TS }],
    recentIntentions: [],
    now: Date.parse(TS),
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

// ---------------------------------------------------------------------------
// Corpus fixture
// ---------------------------------------------------------------------------

interface CorpusEntry {
  text: string;
  shouldMint: boolean;
  category: string;
  note: string;
}

function loadCorpus(): CorpusEntry[] {
  const fixturePath = join(import.meta.dir, "fixtures", "latent-corpus.jsonl");
  const lines = readFileSync(fixturePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as CorpusEntry);
}

// =============================================================================
// §3.3 Precision boundary
// =============================================================================

describe("Precision boundary — ≥90% no-mint on negatives, ≥80% recall on positives", () => {
  test("run recognizer over corpus; assert thresholds", async () => {
    const rec = new DeterministicLatentRecognizer();
    const corpus = loadCorpus();

    const positives = corpus.filter((e) => e.shouldMint);
    const negatives = corpus.filter((e) => !e.shouldMint);

    expect(positives.length).toBeGreaterThanOrEqual(15);
    expect(negatives.length).toBeGreaterThanOrEqual(15);

    // Run recognizer over each entry individually.
    let truePositives = 0;
    let trueNegatives = 0;
    const fpEntries: CorpusEntry[] = [];
    const fnEntries: CorpusEntry[] = [];

    for (const entry of corpus) {
      const results = await rec.recognize(makeInput(entry.text));
      const minted = results.length > 0;

      if (entry.shouldMint) {
        if (minted) truePositives++;
        else fnEntries.push(entry);
      } else {
        if (!minted) trueNegatives++;
        else fpEntries.push(entry);
      }
    }

    const noMintRate = trueNegatives / negatives.length;
    const recallRate = truePositives / positives.length;

    // Report on failures for easier debugging.
    if (fpEntries.length > 0) {
      console.log("False positives (should NOT mint but did):", fpEntries.map((e) => e.text));
    }
    if (fnEntries.length > 0) {
      console.log("False negatives (should mint but did NOT):", fnEntries.map((e) => e.text));
    }
    console.log(
      `Negative no-mint rate: ${(noMintRate * 100).toFixed(1)}% (${trueNegatives}/${negatives.length})`,
    );
    console.log(
      `Positive recall rate: ${(recallRate * 100).toFixed(1)}% (${truePositives}/${positives.length})`,
    );

    // Assert thresholds (§3.3, §9 MED).
    expect(noMintRate).toBeGreaterThanOrEqual(0.9);
    expect(recallRate).toBeGreaterThanOrEqual(0.8);
  });
});

// =============================================================================
// Confirm lifecycle
// =============================================================================

describe("Confirm lifecycle", () => {
  test("surfaced → update confidence + transition to resolved", async () => {
    const store = new InMemoryIntentionStore();

    // Create and arm a latent intention.
    const i = await store.create({
      content: "buy coffee",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.7,
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Confirm: update confidence then resolve.
    const updated = await store.update(i.id, { confidence: 0.95 });
    expect(updated.confidence).toBe(0.95);
    expect(updated.state).toBe("surfaced"); // state unchanged by update

    const resolved = await store.transition(i.id, "resolved");
    expect(resolved.state).toBe("resolved");
  });

  test("surfaced → update trigger + transition to armed (gains armable trigger)", async () => {
    const store = new InMemoryIntentionStore();

    const i = await store.create({
      content: "buy coffee",
      trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.7,
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Confirm with a new armable when-trigger.
    const newTrigger = { all: [{ kind: "when" as const, at: "2026-06-07T09:00:00Z" }] };
    const patched = await store.update(i.id, { confidence: 0.9, trigger: newTrigger });
    expect(patched.confidence).toBe(0.9);
    expect(patched.trigger.all?.[0]?.kind).toBe("when");

    // Transition back to armed.
    const rearmed = await store.transition(i.id, "armed");
    expect(rearmed.state).toBe("armed");
  });
});

// =============================================================================
// Decline lifecycle
// =============================================================================

describe("Decline lifecycle", () => {
  test("surfaced → suppressed is terminal", async () => {
    const store = new InMemoryIntentionStore();

    const i = await store.create({
      content: "buy milk",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    const suppressed = await store.transition(i.id, "suppressed");
    expect(suppressed.state).toBe("suppressed");

    // suppressed is terminal — any further transition should throw.
    await expect(store.transition(i.id, "resolved")).rejects.toThrow();
    await expect(store.transition(i.id, "armed")).rejects.toThrow();
  });

  test("suppressed content is not re-minted by dedup", () => {
    // A suppressed intention in the active intentions list blocks re-mint.
    const suppressed: Intention[] = [makeIntention("buy milk", "suppressed")];
    const minted = [
      {
        content: "buy milk",
        origin: "latent" as const,
        strength: "soft" as const,
        confidence: 0.7,
        trigger: { all: [{ kind: "topic" as const, topic: "milk", provenance: "inferred" as const, confidence: 0.7 }] },
        evidence: { ts: "2026-06-06T12:00:00Z" },
        sensitivity: "private" as const,
      },
    ];
    const { create, supersede } = dedupAndSupersede(minted, suppressed);
    expect(create).toHaveLength(0);
    expect(supersede).toHaveLength(0);
  });

  test("dedup does not block a different content from a suppressed entry", () => {
    const suppressed: Intention[] = [makeIntention("buy milk", "suppressed")];
    const minted = [
      {
        content: "buy coffee",
        origin: "latent" as const,
        strength: "soft" as const,
        confidence: 0.7,
        trigger: { all: [{ kind: "topic" as const, topic: "coffee", provenance: "inferred" as const, confidence: 0.7 }] },
        evidence: { ts: "2026-06-06T12:00:00Z" },
        sensitivity: "private" as const,
      },
    ];
    const { create } = dedupAndSupersede(minted, suppressed);
    expect(create).toHaveLength(1);
    expect(create[0].content).toBe("buy coffee");
  });
});

// =============================================================================
// Surfaced survives IntentionLoop.tick() prune
// =============================================================================

describe("Surfaced survives prune via IntentionLoop.tick()", () => {
  test("tick() prunes fired/resolved/suppressed but keeps surfaced", async () => {
    const store = new InMemoryIntentionStore();
    const loop = new IntentionService({
      store,
      broadcast: () => 0,
      hasSession: () => false,
      now: () => Date.parse(TS),
    });

    // Create a surfaced latent intention.
    const surfacedI = await store.create({
      content: "buy eggs",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    await store.transition(surfacedI.id, "armed");
    await store.transition(surfacedI.id, "surfaced");

    // Create a resolved intention (should be pruned).
    const resolvedI = await store.create({
      content: "buy bread",
      trigger: { all: [{ kind: "when", at: "2026-06-01T10:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-01T10:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(resolvedI.id, "armed");
    await store.transition(resolvedI.id, "surfaced");
    await store.resolve(resolvedI.id);

    // Create a suppressed intention (should be pruned).
    const suppressedI = await store.create({
      content: "buy milk",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    await store.transition(suppressedI.id, "armed");
    await store.transition(suppressedI.id, "surfaced");
    await store.transition(suppressedI.id, "suppressed");

    // Run one tick — prunes terminal intentions.
    await loop.tick();

    // Surfaced intention must still exist.
    const found = await store.get(surfacedI.id);
    expect(found).not.toBeNull();
    expect(found!.state).toBe("surfaced");

    // Resolved intention must be pruned.
    expect(await store.get(resolvedI.id)).toBeNull();

    // Suppressed intention must be pruned.
    expect(await store.get(suppressedI.id)).toBeNull();
  });
});

// =============================================================================
// Mixed coexistence: obvious + latent in same store
// =============================================================================

describe("Mixed coexistence — obvious hard + latent soft do not interfere", () => {
  test("both intentions coexist, queryable by distinct state/origin", async () => {
    const store = new InMemoryIntentionStore();

    // Obvious hard timed intention.
    const obvious = await store.create({
      content: "call dentist",
      trigger: { all: [{ kind: "when", at: "2026-06-07T09:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: TS, sessionKey: "sess-1" },
      sensitivity: "private",
    });
    await store.transition(obvious.id, "armed");

    // Latent soft match-only intention.
    const latent = await store.create({
      content: "buy coffee",
      trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.7,
    });
    await store.transition(latent.id, "armed");
    await store.transition(latent.id, "surfaced");

    // Both queryable independently.
    const obviousItems = await store.list({ origin: "obvious" });
    const latentItems = await store.list({ origin: "latent" });

    expect(obviousItems.length).toBe(1);
    expect(obviousItems[0].content).toBe("call dentist");
    expect(obviousItems[0].strength).toBe("hard");

    expect(latentItems.length).toBe(1);
    expect(latentItems[0].content).toBe("buy coffee");
    expect(latentItems[0].strength).toBe("soft");

    // Distinct states.
    expect(obviousItems[0].state).toBe("armed");
    expect(latentItems[0].state).toBe("surfaced");

    // Queryable by state as well.
    const armedList = await store.list({ state: "armed" });
    const surfacedList = await store.list({ state: "surfaced" });
    expect(armedList.find((i) => i.id === obvious.id)).toBeDefined();
    expect(surfacedList.find((i) => i.id === latent.id)).toBeDefined();

    // Topic query does not return the obvious item.
    const topicMatch = await store.list({ topic: "coffee" });
    expect(topicMatch.length).toBe(1);
    expect(topicMatch[0].id).toBe(latent.id);
  });
});

// =============================================================================
// Term-type matrix
// =============================================================================

describe("Term-type matrix — all trigger kinds round-trip through store", () => {
  test("when term: create, list (dueBefore), termKey='when', isArmable=true", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "stand-up meeting",
      trigger: { all: [{ kind: "when", at: "2026-06-07T09:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    expect(i.trigger.all?.[0]?.kind).toBe("when");

    const due = await store.list({ dueBefore: "2026-06-08T00:00:00Z" });
    expect(due.find((x) => x.id === i.id)).toBeDefined();

    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("when");
    expect(isArmable(term)).toBe(true);
  });

  test("where.place term: termKey='where:grocery:', isArmable=true", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "buy groceries",
      trigger: { all: [{ kind: "where", place: "grocery" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("where:grocery:");
    expect(isArmable(term)).toBe(true);
  });

  test("where.category term: list by category, termKey='where::food', isArmable=false", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "restock food pantry",
      trigger: { all: [{ kind: "where", category: "food" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    const byCategory = await store.list({ category: "food" });
    expect(byCategory.find((x) => x.id === i.id)).toBeDefined();

    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("where::food");
    expect(isArmable(term)).toBe(false);
  });

  test("who term: list by whoEntity, termKey='who:Alice:', isArmable=false", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "follow up with Alice",
      trigger: { all: [{ kind: "who", entity: "Alice" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    const byWho = await store.list({ whoEntity: "Alice" });
    expect(byWho.find((x) => x.id === i.id)).toBeDefined();

    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("who:Alice:");
    expect(isArmable(term)).toBe(false);
  });

  test("who.scene term: list by whoScene, termKey='who::standup', isArmable=false", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "bring up the deployment issue",
      trigger: { all: [{ kind: "who", scene: "standup" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    const byScene = await store.list({ whoScene: "standup" });
    expect(byScene.find((x) => x.id === i.id)).toBeDefined();

    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("who::standup");
    expect(isArmable(term)).toBe(false);
  });

  test("topic term: list by topic, termKey='topic:work', isArmable=false", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "prepare work report",
      trigger: { all: [{ kind: "topic", topic: "work" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    const byTopic = await store.list({ topic: "work" });
    expect(byTopic.find((x) => x.id === i.id)).toBeDefined();

    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("topic:work");
    expect(isArmable(term)).toBe(false);
  });

  test("manual term: store+list, termKey='manual', isArmable=false", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "water the plants",
      trigger: { all: [{ kind: "manual" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
    });
    const all = await store.list();
    expect(all.find((x) => x.id === i.id)).toBeDefined();

    const term = i.trigger.all![0];
    expect(termKey(term)).toBe("manual");
    expect(isArmable(term)).toBe(false);
  });
});

// =============================================================================
// MED-8: NaN confidence rejection
// =============================================================================

describe("MED-8: NaN/non-finite confidence is rejected → stored as undefined", () => {
  test("NaN confidence on create → stored as undefined (not NaN)", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "buy coffee",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: NaN,
    });
    expect(i.confidence).toBeUndefined();
    // Confirm it's not NaN: NaN !== NaN
    expect(Number.isNaN(i.confidence)).toBe(false);
  });

  test("Infinity confidence on create → stored as undefined", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "buy milk",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: Infinity,
    });
    expect(i.confidence).toBeUndefined();
  });

  test("NaN confidence on update → stored as undefined", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "buy eggs",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.7,
    });
    expect(i.confidence).toBe(0.7);

    const updated = await store.update(i.id, { confidence: NaN });
    expect(updated.confidence).toBeUndefined();
  });

  test("valid confidence 0.5 passes through unchanged", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "buy bread",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.5,
    });
    expect(i.confidence).toBe(0.5);
  });
});

// =============================================================================
// MED-7: intention.respond — confirm/decline gateway lifecycle
// (Tests the service-level operations: suppress + transition, and arm + transition)
// =============================================================================

describe("MED-7: intention.respond — confirm/decline lifecycle (service layer)", () => {
  test("decline path: suppress(content) + transition to suppressed", async () => {
    const store = new InMemoryIntentionStore();
    const latentService = new LatentService({ store });

    const i = await store.create({
      content: "buy coffee",
      trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.7,
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Simulate the decline path from intention.respond RPC.
    latentService.suppress(i.content);
    await store.transition(i.id, "suppressed");

    const after = await store.get(i.id);
    expect(after?.state).toBe("suppressed");

    // Content is in suppressedKeys — a re-mint attempt is blocked.
    // (suppress() adds to in-memory set; dedup checks it.)
    // We simulate by calling onTranscript + flush with a new recognizer run.
    // Since LatentService uses its own store reference, we can test via dedup.
    const { create } = dedupAndSupersede(
      [{
        content: "buy coffee",
        origin: "latent" as const,
        strength: "soft" as const,
        confidence: 0.7,
        trigger: { all: [{ kind: "topic" as const, topic: "coffee", provenance: "inferred" as const }] },
        evidence: { ts: "2026-06-06T12:00:00Z" },
        sensitivity: "private" as const,
      }],
      await store.list(),
    );
    // suppressed state blocks via store, not extraSuppressed — still blocked.
    expect(create).toHaveLength(0);
  });

  test("confirm path (match-only trigger): update confidence → resolve", async () => {
    const store = new InMemoryIntentionStore();

    const i = await store.create({
      content: "buy coffee",
      trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.7,
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Confirm: boost confidence + resolve (no armable trigger → resolve).
    const updated = await store.update(i.id, { confidence: 1.0 });
    expect(updated.confidence).toBe(1.0);

    // No armable terms → transition to resolved.
    const resolved = await store.transition(i.id, "resolved");
    expect(resolved.state).toBe("resolved");
  });

  test("confirm path (when trigger): update confidence → arm transition", async () => {
    const store = new InMemoryIntentionStore();

    const i = await store.create({
      content: "call dentist",
      trigger: { all: [{ kind: "when", at: "2026-06-07T09:00:00Z" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: TS },
      sensitivity: "private",
      confidence: 0.8,
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Confirm: boost confidence.
    const updated = await store.update(i.id, { confidence: 1.0 });
    expect(updated.confidence).toBe(1.0);

    // Has armable term (when) → transition back to armed.
    const rearmed = await store.transition(i.id, "armed");
    expect(rearmed.state).toBe("armed");
  });
});
