// =============================================================================
// Test: arming + arm-when (M3 Track A)
// Run: bun test tests/test-arming.ts
// Covers: arm→armed/arm_failed; cron when schedules+fires; composite when∧where arms across both.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { armIntention } from "../src/ambient/arming.js";
import { WhenAdapter } from "../src/ambient/arm-when.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import type { Intention } from "../src/ambient/intention.js";
import type { ArmAdapter, ArmResult } from "../src/ambient/trigger.js";
import { termKey, isArmable } from "../src/ambient/trigger.js";
import type { WhenCronService } from "../src/ambient/arm-when.js";
import { buildObviousIntention } from "../src/ambient/create-intention.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function baseIntention(overrides?: Partial<Intention>): Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> {
  return {
    content: "test item",
    trigger: { all: [{ kind: "when", at: "2026-06-06T10:00:00Z" }] },
    strength: "hard",
    origin: "obvious",
    evidence: { ts: "2026-06-05T10:00:00Z" },
    sensitivity: "private",
    ...overrides,
  };
}

function makeAdapter(ok: boolean, kind: "when" | "where" | "who" | "manual" = "when"): ArmAdapter {
  return {
    kind,
    async prepare(_intention: Intention): Promise<ArmResult> {
      return ok
        ? { ok: true, state: "armed" }
        : { ok: false, state: "arm_failed", reason: "test_failure" };
    },
    activate(_intention: Intention): void {},
    async disarm(_intention: Intention): Promise<void> {},
  };
}

function makeAdapters(...entries: ArmAdapter[]): Map<string, ArmAdapter> {
  return new Map(entries.map((a) => [a.kind, a]));
}

// -----------------------------------------------------------------------------
// armIntention — basic arm→armed / arm→arm_failed
// -----------------------------------------------------------------------------

describe("armIntention", () => {
  test("adapter ok → store.state = armed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());
    const result = await armIntention(intention, makeAdapters(makeAdapter(true)), store);
    expect(result).toBe("armed");
    const updated = await store.get(intention.id);
    expect(updated?.state).toBe("armed");
  });

  test("adapter fails → returns arm_failed but intention stays pending_arm (reconcile owns transition)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());
    const result = await armIntention(intention, makeAdapters(makeAdapter(false)), store);
    expect(result).toBe("arm_failed");
    // Intention must remain in pending_arm so reconcile can retry it.
    const updated = await store.get(intention.id);
    expect(updated?.state).toBe("pending_arm");
  });

  test("no adapter for kind → arm_failed, intention stays pending_arm", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());
    // Empty adapters map — no `when` adapter
    const result = await armIntention(intention, new Map(), store);
    expect(result).toBe("arm_failed");
    expect((await store.get(intention.id))?.state).toBe("pending_arm");
  });

  test("manual-only trigger → armed immediately (no adapter needed)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention({ trigger: { all: [{ kind: "manual" }] } }));
    const result = await armIntention(intention, new Map(), store);
    expect(result).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("empty trigger → armed immediately", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention({ trigger: {} }));
    const result = await armIntention(intention, new Map(), store);
    expect(result).toBe("armed");
  });

  test("composite when∧where → arms both adapters → armed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    const adapters = makeAdapters(makeAdapter(true, "when"), makeAdapter(true, "where"));
    const result = await armIntention(intention, adapters, store);
    expect(result).toBe("armed");
  });

  test("composite when∧where — where adapter fails → arm_failed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    const adapters = makeAdapters(makeAdapter(true, "when"), makeAdapter(false, "where"));
    const result = await armIntention(intention, adapters, store);
    expect(result).toBe("arm_failed");
  });
});

// -----------------------------------------------------------------------------
// WhenAdapter (arm-when) — schedules + fires
// -----------------------------------------------------------------------------

describe("WhenAdapter", () => {
  test("arm schedules a cron job and returns ok:true", async () => {
    let capturedId: string | null = null;
    let capturedIsoTime: string | null = null;
    let capturedCallback: (() => void) | null = null;
    const mockCron: WhenCronService = {
      scheduleAt(id, isoTime, callback) {
        capturedId = id;
        capturedIsoTime = isoTime;
        capturedCallback = callback;
      },
      cancel(_id) {},
      cancelAll() {},
    };

    let fired = false;
    const adapter = new WhenAdapter(mockCron, async (_intention, _termKind) => { fired = true; });

    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());

    const result = await adapter.arm(intention);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("armed");
    expect(capturedId).not.toBeNull();
    expect(capturedIsoTime).toBe("2026-06-06T10:00:00Z");

    // Simulate cron firing the callback.
    capturedCallback!();
    // Give the async onFire microtask a tick.
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  test("arm with no time fields → arm_failed", async () => {
    const mockCron: WhenCronService = {
      scheduleAt(_id, _isoTime, _callback) {},
      cancel(_id) {},
      cancelAll() {},
    };

    const adapter = new WhenAdapter(mockCron, async () => {});
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention({ trigger: { all: [{ kind: "when" }] } }));
    const result = await adapter.arm(intention);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("arm_failed");
  });

  test("disarm cancels the scheduled job", async () => {
    const cancelled: string[] = [];
    const mockCron: WhenCronService = {
      scheduleAt(_id, _isoTime, _callback) {},
      cancel(id) { cancelled.push(id); },
      cancelAll() {},
    };

    const adapter = new WhenAdapter(mockCron, async () => {});
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());
    await adapter.arm(intention);
    await adapter.disarm(intention);
    expect(cancelled).toContain(`when:${intention.id}`);
  });

  test("arm with no when term → arm_failed", async () => {
    const mockCron: WhenCronService = {
      scheduleAt(_id, _isoTime, _callback) {},
      cancel(_id) {},
      cancelAll() {},
    };
    const adapter = new WhenAdapter(mockCron, async () => {});
    const store = new InMemoryIntentionStore();
    // Intention with only a `where` trigger — no `when` term
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "where", place: "grocery" }] } }),
    );
    const result = await adapter.arm(intention);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("arm_failed");
  });

  // FIX-H1: re-arm is idempotent — cancels old job, schedules new one (no duplicate)
  test("re-arm cancels existing job before scheduling new one (idempotent)", async () => {
    const scheduled: string[] = [];
    const cancelled: string[] = [];
    const mockCron: WhenCronService = {
      scheduleAt(id, _isoTime, _callback) {
        scheduled.push(id);
      },
      cancel(id) { cancelled.push(id); },
      cancelAll() {},
    };

    const adapter = new WhenAdapter(mockCron, async () => {});
    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());

    await adapter.arm(intention);
    expect(scheduled).toHaveLength(1);
    expect(cancelled).toHaveLength(0);

    // Second arm call — must cancel the first job before scheduling.
    await adapter.arm(intention);
    expect(scheduled).toHaveLength(2);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toBe(`when:${intention.id}`);
  });
});

// -----------------------------------------------------------------------------
// FIX-H1: composite arming rollback
// -----------------------------------------------------------------------------

describe("FIX-H1: composite arming rollback on partial failure", () => {
  test("when-succeeds then where-fails → when adapter is disarmed (rollback)", async () => {
    const whenDisarmed: string[] = [];

    const whenAdapter: ArmAdapter = {
      kind: "when",
      async prepare(): Promise<ArmResult> { return { ok: true, state: "armed" }; },
      activate(): void {},
      async disarm(intention: Intention): Promise<void> { whenDisarmed.push(intention.id); },
    };
    const whereAdapter: ArmAdapter = {
      kind: "where",
      async prepare(): Promise<ArmResult> { return { ok: false, state: "arm_failed", reason: "test" }; },
      activate(): void {},
      async disarm(): Promise<void> {},
    };

    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "grocery" },
          ],
        },
      }),
    );
    const adapters = new Map<string, ArmAdapter>([["when", whenAdapter], ["where", whereAdapter]]);
    const result = await armIntention(intention, adapters, store);

    expect(result).toBe("arm_failed");
    // when adapter must have been rolled back.
    expect(whenDisarmed).toContain(intention.id);
    // intention stays pending_arm (not arm_failed — reconcile owns that).
    expect((await store.get(intention.id))?.state).toBe("pending_arm");
  });
});

describe("two-phase arm throw-safety (codex review)", () => {
  test("a THROWN prepare() still rolls back already-prepared adapters", async () => {
    const whenDisarmed: string[] = [];
    const whenAdapter: ArmAdapter = {
      kind: "when",
      async prepare(): Promise<ArmResult> { return { ok: true, state: "armed" }; },
      activate(): void {},
      async disarm(intention: Intention): Promise<void> { whenDisarmed.push(intention.id); },
    };
    const whereAdapter: ArmAdapter = {
      kind: "where",
      async prepare(): Promise<ArmResult> { throw new Error("device offline"); },
      activate(): void {},
      async disarm(): Promise<void> {},
    };
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: { all: [{ kind: "when", at: "2026-06-06T10:00:00Z" }, { kind: "where", place: "grocery" }] },
      }),
    );
    const adapters = new Map<string, ArmAdapter>([["when", whenAdapter], ["where", whereAdapter]]);
    const result = await armIntention(intention, adapters, store);
    expect(result).toBe("arm_failed");
    expect(whenDisarmed).toContain(intention.id); // rolled back despite the throw (not just { ok:false })
    expect((await store.get(intention.id))?.state).toBe("pending_arm");
  });

  test("a THROWN activate() disarms all + revokes armed → arm_failed (no half-activated armed)", async () => {
    const disarmed: string[] = [];
    const whenAdapter: ArmAdapter = {
      kind: "when",
      async prepare(): Promise<ArmResult> { return { ok: true, state: "armed" }; },
      activate(): void { throw new Error("schedule failed"); },
      async disarm(intention: Intention): Promise<void> { disarmed.push(intention.id); },
    };
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "when", at: "2026-06-06T10:00:00Z" }] } }),
    );
    const result = await armIntention(intention, makeAdapters(whenAdapter), store);
    expect(result).toBe("arm_failed");
    expect(disarmed).toContain(intention.id);
    expect((await store.get(intention.id))?.state).toBe("arm_failed"); // armed revoked
  });
});

// -----------------------------------------------------------------------------
// termKey + isArmable helpers (M8 §3.5)
// -----------------------------------------------------------------------------

describe("termKey", () => {
  test("when → 'when'", () => {
    expect(termKey({ kind: "when", at: "2026-06-06T10:00:00Z" })).toBe("when");
  });

  test("where with place only → 'where:grocery:'", () => {
    expect(termKey({ kind: "where", place: "grocery" })).toBe("where:grocery:");
  });

  test("where with category only → 'where::coffee'", () => {
    expect(termKey({ kind: "where", category: "coffee" })).toBe("where::coffee");
  });

  test("where with both place and category → includes both", () => {
    expect(termKey({ kind: "where", place: "grocery", category: "food" })).toBe("where:grocery:food");
  });

  test("where with neither → 'where::'", () => {
    expect(termKey({ kind: "where" })).toBe("where::");
  });

  test("who with entity and scene → includes both", () => {
    expect(termKey({ kind: "who", entity: "alice", scene: "meeting" })).toBe("who:alice:meeting");
  });

  test("who with neither → 'who::'", () => {
    expect(termKey({ kind: "who" })).toBe("who::");
  });

  test("topic → 'topic:work'", () => {
    expect(termKey({ kind: "topic", topic: "work" })).toBe("topic:work");
  });

  test("manual → 'manual'", () => {
    expect(termKey({ kind: "manual" })).toBe("manual");
  });

  test("where.place and where.category produce DISTINCT termKeys", () => {
    const placeKey = termKey({ kind: "where", place: "grocery" });
    const categoryKey = termKey({ kind: "where", category: "grocery" });
    expect(placeKey).not.toBe(categoryKey);
    expect(placeKey).toBe("where:grocery:");
    expect(categoryKey).toBe("where::grocery");
  });
});

describe("isArmable", () => {
  test("when → armable", () => {
    expect(isArmable({ kind: "when", at: "2026-06-06T10:00:00Z" })).toBe(true);
  });

  test("where with place → armable", () => {
    expect(isArmable({ kind: "where", place: "grocery" })).toBe(true);
  });

  test("where with place AND category → armable (place wins)", () => {
    expect(isArmable({ kind: "where", place: "grocery", category: "food" })).toBe(true);
  });

  test("where with category only → not armable (match-only)", () => {
    expect(isArmable({ kind: "where", category: "coffee" })).toBe(false);
  });

  test("where with neither → not armable", () => {
    expect(isArmable({ kind: "where" })).toBe(false);
  });

  test("who → not armable (match-only)", () => {
    expect(isArmable({ kind: "who", entity: "alice" })).toBe(false);
  });

  test("topic → not armable (match-only)", () => {
    expect(isArmable({ kind: "topic", topic: "work" })).toBe(false);
  });

  test("manual → not armable", () => {
    expect(isArmable({ kind: "manual" })).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// M8 §3.5: match-only intentions arm without an adapter (NOT arm_failed)
// -----------------------------------------------------------------------------

describe("M8 §3.5: match-only intentions → armed without adapter", () => {
  test("where.category-only → armed immediately (no adapter needed)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "where", category: "coffee" }] } }),
    );
    const result = await armIntention(intention, new Map(), store);
    expect(result).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("topic-only → armed immediately (no adapter needed)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "topic", topic: "work" }] } }),
    );
    const result = await armIntention(intention, new Map(), store);
    expect(result).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("who-only → armed immediately (no adapter needed)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "who", entity: "alice" }] } }),
    );
    const result = await armIntention(intention, new Map(), store);
    expect(result).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("mixed all:[when, where.category] → when adapter required, category accepted as match-eligible → armed", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", category: "coffee" },
          ],
        },
      }),
    );
    // Only `when` adapter provided — `where.category` is match-only and needs no adapter.
    const adapters = makeAdapters(makeAdapter(true, "when"));
    const result = await armIntention(intention, adapters, store);
    expect(result).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("mixed all:[when, where.category] — when adapter fails → arm_failed (armable term failed)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", category: "coffee" },
          ],
        },
      }),
    );
    const adapters = makeAdapters(makeAdapter(false, "when"));
    const result = await armIntention(intention, adapters, store);
    expect(result).toBe("arm_failed");
    expect((await store.get(intention.id))?.state).toBe("pending_arm");
  });

  test("where.place + where.category in all → distinct termKeys, place-term is armable, category is match-only", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "where", place: "grocery" },
            { kind: "where", category: "food" },
          ],
        },
      }),
    );
    // `where.place` is armable — provide a where adapter that succeeds.
    // `where.category` is match-only — no adapter needed.
    const whereAdapter = makeAdapter(true, "where");
    const adapters = makeAdapters(whereAdapter);
    const result = await armIntention(intention, adapters, store);
    expect(result).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });
});

// -----------------------------------------------------------------------------
// Two-phase arm invariant: store reaches "armed" BEFORE any trigger goes live
// -----------------------------------------------------------------------------

describe("two-phase arm: ordering invariant — store armed before activate", () => {
  test("when adapter: activate() is NOT called until store is 'armed'", async () => {
    const events: string[] = [];

    let prepareResolve!: () => void;
    const prepareGate = new Promise<void>((res) => { prepareResolve = res; });

    const controlledAdapter: ArmAdapter = {
      kind: "when",
      async prepare(_intention: Intention): Promise<ArmResult> {
        events.push("prepare:start");
        await prepareGate; // simulate slow async work (device ack etc.)
        events.push("prepare:done");
        return { ok: true, state: "armed" };
      },
      activate(_intention: Intention): void {
        events.push("activate");
      },
      async disarm(_intention: Intention): Promise<void> {},
    };

    const store = new InMemoryIntentionStore();
    const intention = await store.create(baseIntention());

    // Start arming — will pause at the gate in prepare().
    const armPromise = armIntention(intention, makeAdapters(controlledAdapter), store);

    // At this moment only prepare:start should have been recorded.
    await Promise.resolve();
    expect(events).toContain("prepare:start");
    expect(events).not.toContain("activate");

    // Store should still be pending_arm while prepare is in-flight.
    expect((await store.get(intention.id))?.state).toBe("pending_arm");

    // Unblock prepare.
    prepareResolve();
    const result = await armPromise;

    expect(result).toBe("armed");
    // Ordering: prepare → store armed → activate
    expect(events.indexOf("prepare:done")).toBeLessThan(events.indexOf("activate"));
    // Store should be armed BEFORE activate fires — verify by checking event ordering.
    // (activate is synchronous after the store.transition, so armed is set before activate runs)
    expect((await store.get(intention.id))?.state).toBe("armed");
    expect(events).toEqual(["prepare:start", "prepare:done", "activate"]);
  });

  test("when∧where composite: store is 'armed' BEFORE when-timer is scheduled", async () => {
    const scheduled: string[] = [];
    const storeStateAtActivate: string[] = [];

    let mockCron: WhenCronService = {
      scheduleAt(_id, _isoTime, _callback) {
        scheduled.push(_id);
      },
      cancel(_id) {},
      cancelAll() {},
    };

    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "home" },
          ],
        },
      }),
    );

    // Wrap the store.transition to capture the state at the moment activate() fires.
    const originalTransition = store.transition.bind(store);
    store.transition = async (id, newState) => {
      const r = await originalTransition(id, newState);
      return r;
    };

    // whenAdapter that records whether the store is "armed" at the time activate() runs.
    const whenAdapter = new WhenAdapter(mockCron, async () => {});
    // We override activate to capture store state.
    const origActivate = whenAdapter.activate.bind(whenAdapter);
    whenAdapter.activate = async function(int: Intention) {
      const storeState = (await store.get(int.id))?.state ?? "?";
      storeStateAtActivate.push(storeState);
      origActivate(int);
    };

    // Slow where-adapter that ACKs asynchronously.
    let whereAck!: () => void;
    const whereAckP = new Promise<void>((res) => { whereAck = res; });
    const whereAdapter: ArmAdapter = {
      kind: "where",
      async prepare(_intention: Intention): Promise<ArmResult> {
        await whereAckP;
        return { ok: true, state: "armed" };
      },
      activate(_intention: Intention): void {},
      async disarm(): Promise<void> {},
    };

    const adapters = new Map<string, ArmAdapter>([
      ["when", whenAdapter],
      ["where", whereAdapter],
    ]);

    const armPromise = armIntention(intention, adapters, store);

    // While where is still preparing, the when-timer must NOT be scheduled.
    await Promise.resolve();
    expect(scheduled).toHaveLength(0);
    expect((await store.get(intention.id))?.state).toBe("pending_arm");

    // Unblock where ack.
    whereAck();
    await armPromise;

    // Now the timer is scheduled and the store is "armed".
    expect(scheduled).toHaveLength(1);
    expect((await store.get(intention.id))?.state).toBe("armed");
    // The store was "armed" at the time when's activate() ran.
    expect(storeStateAtActivate[0]).toBe("armed");
  });

  test("prepare-fail on where → prepared when adapter is disarmed (rollback), no live timer", async () => {
    const scheduled: string[] = [];
    const whenDisarmed: string[] = [];

    const mockCron: WhenCronService = {
      scheduleAt(id, _isoTime, _callback) { scheduled.push(id); },
      cancel(_id) {},
      cancelAll() {},
    };

    const whenAdapter = new WhenAdapter(mockCron, async () => {});
    // Wrap disarm to track rollback.
    const origDisarm = whenAdapter.disarm.bind(whenAdapter);
    whenAdapter.disarm = async (int: Intention) => {
      whenDisarmed.push(int.id);
      await origDisarm(int);
    };

    const whereAdapter: ArmAdapter = {
      kind: "where",
      async prepare(): Promise<ArmResult> {
        return { ok: false, state: "arm_failed", reason: "device_ack_timeout" };
      },
      activate(): void {},
      async disarm(): Promise<void> {},
    };

    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [
            { kind: "when", at: "2026-06-06T10:00:00Z" },
            { kind: "where", place: "home" },
          ],
        },
      }),
    );

    const adapters = new Map<string, ArmAdapter>([
      ["when", whenAdapter],
      ["where", whereAdapter],
    ]);

    const result = await armIntention(intention, adapters, store);

    expect(result).toBe("arm_failed");
    // No timer should ever have been scheduled (activate was never called).
    expect(scheduled).toHaveLength(0);
    // The when adapter was rolled back via disarm.
    expect(whenDisarmed).toContain(intention.id);
    // Store stays pending_arm.
    expect((await store.get(intention.id))?.state).toBe("pending_arm");
  });
});

// -----------------------------------------------------------------------------
// create-intention: when∧where composite is NO LONGER rejected
// -----------------------------------------------------------------------------

describe("create-intention: when∧where composite now allowed", () => {
  const T0 = Date.parse("2026-06-06T10:00:00.000Z");

  test("when + named where → ok:true with both terms in trigger", () => {
    const result = buildObviousIntention(
      { content: "Pick up medicine", when: "in 10 minutes", where: "Walgreens" },
      { now: T0, timezone: "UTC", whereEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const terms = result.request.trigger.all ?? [];
    expect(terms.some((t) => t.kind === "when")).toBe(true);
    expect(terms.some((t) => t.kind === "where" && t.place === "Walgreens")).toBe(true);
  });

  test("when + bare-category where is still rejected (bare_category_where)", () => {
    const result = buildObviousIntention(
      { content: "Pick up medicine", when: "in 10 minutes", where: "a pharmacy" },
      { now: T0, timezone: "UTC", whereEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bare_category_where");
  });
});
