// =============================================================================
// Test: fire.ts (M3 Track A)
// Run: bun test tests/test-fire.ts
// Covers: fireIntention routes into the delivery spine; transitions fired→resolved;
//         composite when∧where arms across both and fires on conjunction.
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import { fireIntention, deliverAndMark, _resetSatisfiedTerms, _getSatisfiedTerms } from "../src/ambient/fire.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { armIntention } from "../src/ambient/arming.js";
import { WhenAdapter } from "../src/ambient/arm-when.js";
import type { Intention } from "../src/ambient/intention.js";
import type { DeliverResult } from "../src/ambient/delivery-service.js";
import type { FireDeps } from "../src/ambient/fire.js";
import type { ArmAdapter, ArmResult } from "../src/ambient/trigger.js";
import { termKey } from "../src/ambient/trigger.js";
import type { WhenCronService } from "../src/ambient/arm-when.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeIntentionData(overrides?: Partial<Intention>): Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> {
  return {
    content: "buy milk",
    trigger: { all: [{ kind: "when", at: "2026-06-06T10:00:00Z" }] },
    strength: "hard",
    origin: "obvious",
    evidence: { ts: "2026-06-05T10:00:00Z" },
    sensitivity: "private",
    ...overrides,
  };
}

function makeDeliverFn(delivered: boolean): FireDeps["deliverFn"] {
  return async (_item, _ctx, _nodes): Promise<DeliverResult> => ({
    delivered,
    voiceStatus: delivered ? "spoken" : "dropped",
    reason: delivered ? undefined : "no_frontend_node",
  });
}

// -----------------------------------------------------------------------------
// fireIntention — routes into the delivery spine and transitions state
// -----------------------------------------------------------------------------

describe("fireIntention", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("on delivered → state transitions to fired", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());
    // Arm the Intention so it's in the right state.
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: makeDeliverFn(true),
    };

    const result = await fireIntention(armedIntention, "when", deps);
    expect(result.delivered).toBe(true);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });

  test("on not delivered → state stays armed (no transition)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: makeDeliverFn(false),
    };

    const result = await fireIntention(armedIntention, "when", deps);
    expect(result.delivered).toBe(false);
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("fired state can be resolved (state machine: armed→fired→resolved)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: makeDeliverFn(true),
    };

    await fireIntention(armedIntention, "when", deps);
    expect((await store.get(intention.id))?.state).toBe("surfaced");

    // Resolve the Intention.
    const resolved = await store.resolve(intention.id);
    expect(resolved.state).toBe("resolved");
  });

  test("fireIntention returns the DeliverResult from deliverFn", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const customResult: DeliverResult = {
      delivered: true,
      voiceStatus: "context",
    };

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => customResult,
    };

    const result = await fireIntention(armedIntention, "when", deps);
    expect(result.voiceStatus).toBe("context");
  });

  // FIX-H3: concurrent fireIntention atomicity — Promise.all → exactly one delivery
  test("Promise.all([fireIntention, fireIntention]) → exactly one delivery, no illegal transition", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        deliverCount++;
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    // Fire both concurrently — only one should deliver.
    const [r1, r2] = await Promise.all([
      fireIntention(armedIntention, "when", deps),
      fireIntention(armedIntention, "when", deps),
    ]);

    const delivered = [r1, r2].filter((r) => r.delivered).length;
    expect(delivered).toBe(1);           // exactly one delivery
    expect(deliverCount).toBe(1);        // deliverFn called exactly once
    expect((await store.get(intention.id))?.state).toBe("surfaced"); // no illegal transition throw
  });

  // MEDIUM-1: double-deliver idempotency
  test("calling fireIntention twice → exactly one delivery, no throw", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        deliverCount++;
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    const r1 = await fireIntention(armedIntention, "when", deps);
    const r2 = await fireIntention(armedIntention, "when", deps); // second call — intention is now "surfaced"
    expect(r1.delivered).toBe(true);
    expect(r2.delivered).toBe(false); // idempotent: not re-delivered
    expect(deliverCount).toBe(1);    // deliverFn called only once
    expect((await store.get(intention.id))?.state).toBe("surfaced"); // no throw
  });
});

// -----------------------------------------------------------------------------
// HIGH-2: Composite when∧where conjunction latch
// -----------------------------------------------------------------------------

describe("composite when ∧ where — conjunction latch", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("composite all:[when,where] does NOT fire on 'when' alone", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };

    // Only "when" fires — conjunction incomplete, no delivery.
    const result = await fireIntention(armedIntention, "when", deps);
    expect(result.delivered).toBe(false);
    expect(deliverCount).toBe(0);
    expect((await store.get(intention.id))?.state).toBe("armed"); // still armed
  });

  test("composite all:[when,where] fires only after BOTH when and where satisfied", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };

    // First term: "when" — not yet complete.
    const r1 = await fireIntention(armedIntention, "when", deps);
    expect(r1.delivered).toBe(false);
    expect(deliverCount).toBe(0);

    // Second term: "where" — conjunction complete, fires.
    const r2 = await fireIntention(armedIntention, "where:grocery:", deps);
    expect(r2.delivered).toBe(true);
    expect(deliverCount).toBe(1);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });

  // FIX-H: concurrent composite-term race — Promise.all([when, where]) → both recorded, exactly one delivery
  test("Promise.all([fireIntention(when), fireIntention(where)]) → both terms recorded, exactly one delivery, intention resolved", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        deliverCount++;
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    // Race both terms concurrently.
    const [r1, r2] = await Promise.all([
      fireIntention(armedIntention, "when", deps),
      fireIntention(armedIntention, "where:grocery:", deps),
    ]);

    const deliveredResults = [r1, r2].filter((r) => r.delivered);
    const notDeliveredResults = [r1, r2].filter((r) => !r.delivered);

    // Exactly one delivery.
    expect(deliveredResults.length).toBe(1);
    // The non-delivered result is either in_flight (race loser) or conjunction_incomplete.
    expect(notDeliveredResults.length).toBe(1);
    // deliverFn called exactly once.
    expect(deliverCount).toBe(1);
    // Intention ends in fired state (not stuck in armed).
    expect((await store.get(intention.id))?.state).toBe("surfaced");
    // Latch cleared after successful delivery.
    expect(_getSatisfiedTerms(intention.id)).toBeUndefined();
  });

  test("single-term trigger fires immediately on the single term", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData()); // single `when` term
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };

    const result = await fireIntention(armedIntention, "when", deps);
    expect(result.delivered).toBe(true);
    expect(deliverCount).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Composite when∧where — arms across both and fires on conjunction
// -----------------------------------------------------------------------------

describe("composite when ∧ where — arm + fire", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  function makeAdapter(kind: "when" | "where", ok: boolean): ArmAdapter {
    return {
      kind,
      async prepare(): Promise<ArmResult> {
        return ok ? { ok: true, state: "armed" } : { ok: false, state: "arm_failed" };
      },
      activate(): void {},
      async disarm(): Promise<void> {},
    };
  }

  test("arms composite when∧where with both adapters → armed, then fires", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );

    const adapters = new Map([
      ["when", makeAdapter("when", true)],
      ["where", makeAdapter("where", true)],
    ]);

    const armResult = await armIntention(intention, adapters, store);
    expect(armResult).toBe("armed");

    const armedIntention = (await store.get(intention.id))!;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: makeDeliverFn(true),
    };

    // Must satisfy both terms.
    await fireIntention(armedIntention, "when", deps); // incomplete
    const fireResult = await fireIntention(armedIntention, "where:grocery:", deps); // complete
    expect(fireResult.delivered).toBe(true);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });

  test("where adapter fails → arm_failed, fire never called", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );

    const adapters = new Map([
      ["when", makeAdapter("when", true)],
      ["where", makeAdapter("where", false)],
    ]);

    const armResult = await armIntention(intention, adapters, store);
    expect(armResult).toBe("arm_failed");
    // With the HIGH-1 fix: armIntention on failure leaves the intention in pending_arm,
    // not arm_failed. The store state is still pending_arm here.
    expect((await store.get(intention.id))?.state).toBe("pending_arm");
  });
});

// -----------------------------------------------------------------------------
// HIGH regression: composite deadlock — latch survives delivery failure, retry succeeds
// -----------------------------------------------------------------------------

describe("HIGH regression: composite latch survives delivery failure", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("composite all:[when,where], deliverFn fails first → latch kept → retry delivers exactly once", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    let shouldFail = true;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        deliverCount++;
        if (shouldFail) return { delivered: false, voiceStatus: "dropped", reason: "no_frontend_node" };
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    // Satisfy "when".
    const r1 = await fireIntention(armedIntention, "when", deps);
    expect(r1.delivered).toBe(false);
    expect(deliverCount).toBe(0); // conjunction incomplete, deliverFn not called

    // Satisfy "where" — conjunction complete, but deliverFn fails.
    const r2 = await fireIntention(armedIntention, "where:grocery:", deps);
    expect(r2.delivered).toBe(false);
    expect(deliverCount).toBe(1);
    // Latch must survive so retry can re-fire.
    expect(_getSatisfiedTerms(intention.id)).toBeDefined();
    expect((await store.get(intention.id))?.state).toBe("armed"); // still armed

    // Retry: "where" fires again — latch already has both terms → deliverFn called again.
    shouldFail = false;
    const r3 = await fireIntention(armedIntention, "where:grocery:", deps);
    expect(r3.delivered).toBe(true);
    expect(deliverCount).toBe(2);
    // Latch cleared after success.
    expect(_getSatisfiedTerms(intention.id)).toBeUndefined();
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });
});

// -----------------------------------------------------------------------------
// MEDIUM-1 regression: latch pruned for already-resolved intentions
// -----------------------------------------------------------------------------

describe("MEDIUM-1 regression: latch pruned on non-armed intention", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("fireIntention for an already-resolved intention → delivered:false AND latch entry removed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    // Manually plant a stale latch entry (simulates partially-satisfied state).
    // We do this by calling fireIntention once for "when" (partial satisfaction).
    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };
    await fireIntention(armedIntention, "when", deps); // partial: latch created with {"when"}
    expect(_getSatisfiedTerms(intention.id)).toBeDefined();

    // Now externally resolve the intention (simulates it being resolved elsewhere).
    await store.transition(intention.id, "surfaced");
    await store.resolve(intention.id);
    expect((await store.get(intention.id))?.state).toBe("resolved");

    // fireIntention on the resolved intention → should prune the latch and return delivered:false.
    const result = await fireIntention(armedIntention, "where:grocery:", deps);
    expect(result.delivered).toBe(false);
    expect(deliverCount).toBe(0); // no actual delivery
    expect(_getSatisfiedTerms(intention.id)).toBeUndefined(); // latch pruned
  });
});

// -----------------------------------------------------------------------------
// WhenAdapter + fireIntention integration — cron fires → state machine completes
// -----------------------------------------------------------------------------

describe("WhenAdapter + fireIntention integration", () => {
  beforeEach(() => _resetSatisfiedTerms());

  test("cron fires callback → fireIntention runs → state = fired", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntentionData());

    // Track whether fireIntention was invoked.
    let fireInvoked = false;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        fireInvoked = true;
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    let scheduledCallback: (() => void) | null = null;
    const mockCron: WhenCronService = {
      scheduleAt(_id, _isoTime, callback) {
        scheduledCallback = callback;
      },
      cancel(_id) {},
      cancelAll() {},
    };

    const adapter = new WhenAdapter(mockCron, async (firedIntention, termKind) => {
      await fireIntention(firedIntention, termKind, deps);
    });

    // Arm the Intention (schedules the cron entry).
    const armResult = await adapter.arm(intention);
    expect(armResult.ok).toBe(true);

    // Transition to armed in store so fireIntention can transition to fired.
    await store.transition(intention.id, "armed");

    // Simulate cron firing.
    scheduledCallback!();
    // Wait for async chain to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(fireInvoked).toBe(true);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });
});

// -----------------------------------------------------------------------------
// HIGH-3: match-only intentions must never enter "surfaced"
// An intention with ONLY match-only terms (topic/who/category-where) should
// return {delivered:false, reason:"not_armable"} and NOT transition to fired.
// -----------------------------------------------------------------------------

describe("HIGH-3: match-only intentions never enter fired", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("topic-only trigger → not_armable, state stays armed (not fired)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred" }] },
        strength: "soft",
        origin: "latent",
      }),
    );
    await store.transition(intention.id, "armed");
    const armed = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };

    const result = await fireIntention(armed, "topic:coffee", deps);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("not_armable");
    expect(deliverCount).toBe(0);
    expect((await store.get(intention.id))?.state).toBe("armed"); // not fired
  });

  test("who-only trigger → not_armable, state stays armed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: { all: [{ kind: "who", entity: "Alice" }] },
        strength: "soft",
        origin: "latent",
      }),
    );
    await store.transition(intention.id, "armed");
    const armed = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => ({ delivered: true, voiceStatus: "spoken" }),
    };

    const result = await fireIntention(armed, "who:Alice:", deps);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("not_armable");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("where.category-only trigger → not_armable, state stays armed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: { all: [{ kind: "where", category: "grocery" }] },
        strength: "soft",
        origin: "latent",
      }),
    );
    await store.transition(intention.id, "armed");
    const armed = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => ({ delivered: true, voiceStatus: "spoken" }),
    };

    const result = await fireIntention(armed, "where::grocery", deps);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("not_armable");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("when + topic in all → has armable term → CAN fire via 'when'", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "topic", topic: "coffee", provenance: "inferred" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armed = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };

    // conjunction: only "when" fires — not yet complete (topic not yet fired).
    // But since topic is in `all`, it also must fire.
    const r1 = await fireIntention(armed, "when", deps);
    // conjunction_incomplete since topic hasn't fired yet
    expect(r1.delivered).toBe(false);
    expect(r1.reason).toBe("conjunction_incomplete");

    const r2 = await fireIntention(armed, "topic:coffee", deps);
    // Both satisfied — fires
    expect(r2.delivered).toBe(true);
    expect(deliverCount).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// M8 §3.5: term-keyed fire — firedTermKey uses termKey() values, not raw kinds
// -----------------------------------------------------------------------------

describe("M8 §3.5: term-keyed fireIntention", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("termKey helper produces the right keys for fire calls", () => {
    expect(termKey({ kind: "when", at: "2026-06-06T10:00:00Z" })).toBe("when");
    expect(termKey({ kind: "where", place: "grocery" })).toBe("where:grocery:");
    expect(termKey({ kind: "where", category: "coffee" })).toBe("where::coffee");
    expect(termKey({ kind: "topic", topic: "work" })).toBe("topic:work");
    expect(termKey({ kind: "manual" })).toBe("manual");
  });

  test("firing with wrong key (raw 'where' on a where:grocery: term) → kind_not_in_trigger", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: { all: [{ kind: "when", at: "2026-06-06T10:00:00Z" }, { kind: "where", place: "grocery" }] },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = { store, nodes: undefined, deliverFn: makeDeliverFn(true) };

    // Passing raw "where" (old kind-based key) should no longer match.
    const result = await fireIntention(armedIntention, "where", deps);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("kind_not_in_trigger");
  });

  test("where.place fires with termKey 'where:grocery:'", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: { all: [{ kind: "when", at: "2026-06-06T10:00:00Z" }, { kind: "where", place: "grocery" }] },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = { store, nodes: undefined, deliverFn: makeDeliverFn(true) };

    await fireIntention(armedIntention, "when", deps);
    const result = await fireIntention(armedIntention, "where:grocery:", deps);
    expect(result.delivered).toBe(true);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });

  test("where.place and where.category in all → distinct keys, both must fire", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      makeIntentionData({
        trigger: {
          all: [
            { kind: "where", place: "grocery" },
            { kind: "where", category: "food" },
          ],
        },
      }),
    );
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    let deliverCount = 0;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => { deliverCount++; return { delivered: true, voiceStatus: "spoken" }; },
    };

    // Only place fires — conjunction incomplete.
    const r1 = await fireIntention(armedIntention, "where:grocery:", deps);
    expect(r1.delivered).toBe(false);
    expect(deliverCount).toBe(0);

    // Category fires — conjunction complete, delivers.
    const r2 = await fireIntention(armedIntention, "where::food", deps);
    expect(r2.delivered).toBe(true);
    expect(deliverCount).toBe(1);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });
});

// -----------------------------------------------------------------------------
// Fix 2: deliverAndMark re-checks state after claiming _inFlight
// A concurrent suppression between the caller's read and the claim must result
// in no delivery and no illegal-transition error.
// -----------------------------------------------------------------------------

describe("Fix 2: deliverAndMark re-checks state after claiming in-flight", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("intention suppressed between claim and deliver → no delivery, no throw", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "buy coffee",
      trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-07T09:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    // Concurrently suppress the intention before deliverAndMark's re-fetch.
    await store.transition(intention.id, "suppressed");

    let deliverCalled = false;
    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        deliverCalled = true;
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    // deliverAndMark re-fetches and sees "suppressed" → abort, no deliver, no transition.
    const result = await deliverAndMark(armedIntention, deps);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("not_armed");
    expect(deliverCalled).toBe(false);
    // State should remain suppressed (not have thrown an illegal transition).
    expect((await store.get(intention.id))?.state).toBe("suppressed");
  });

  test("intention still armed → delivers and transitions to surfaced normally", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "buy milk",
      trigger: { all: [{ kind: "topic", topic: "milk", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-07T09:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => ({ delivered: true, voiceStatus: "spoken" }),
    };

    const result = await deliverAndMark(armedIntention, deps);
    expect(result.delivered).toBe(true);
    expect((await store.get(intention.id))?.state).toBe("surfaced");
  });
});

// -----------------------------------------------------------------------------
// FIX-3: deliverAndMark post-delivery re-check — mid-delivery race
// State changes to "suppressed" DURING delivery must not throw an illegal
// transition and must return a controlled result.
// -----------------------------------------------------------------------------

describe("FIX-3: deliverAndMark post-delivery state re-check", () => {
  beforeEach(() => { _resetSatisfiedTerms(); });

  test("state changes to suppressed DURING delivery → no throw, no illegal transition, returns delivered result", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "buy bread",
      trigger: { all: [{ kind: "topic", topic: "bread", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-07T09:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      // deliverFn suppresses the intention mid-delivery, simulating a race.
      deliverFn: async () => {
        // Mid-delivery: satisfaction sweep suppresses the intention.
        await store.transition(intention.id, "suppressed");
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    // Must not throw; must return the delivery result without attempting the
    // now-illegal armed→surfaced transition.
    const result = await deliverAndMark(armedIntention, deps);
    expect(result).toBeDefined();

    // State must remain suppressed (not have been overwritten by a transition).
    expect((await store.get(intention.id))?.state).toBe("suppressed");
  });

  test("state changes to resolved DURING delivery → no throw, state stays resolved", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "buy eggs",
      trigger: { all: [{ kind: "topic", topic: "eggs", provenance: "inferred" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: "2026-06-07T09:00:00Z" },
      sensitivity: "private",
    });
    await store.transition(intention.id, "armed");
    const armedIntention = (await store.get(intention.id))!;

    const deps: FireDeps = {
      store,
      nodes: undefined,
      deliverFn: async () => {
        // Mid-delivery race: transition to surfaced then resolved.
        await store.transition(intention.id, "surfaced");
        await store.transition(intention.id, "resolved");
        return { delivered: true, voiceStatus: "spoken" };
      },
    };

    await expect(deliverAndMark(armedIntention, deps)).resolves.toBeDefined();
    // State should remain resolved.
    expect((await store.get(intention.id))?.state).toBe("resolved");
  });
});
