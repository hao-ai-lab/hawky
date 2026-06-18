// =============================================================================
// test-where.ts — M8 WhereAdapter + region RPCs + intention_create where
// Run: bun test tests/test-where.ts
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { WhereAdapter } from "../src/ambient/arm-where.js";
import type { RegionDescriptor } from "../src/ambient/arm-where.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import type { Intention } from "../src/ambient/intention.js";
import { buildObviousIntention } from "../src/ambient/create-intention.js";
import { armIntention } from "../src/ambient/arming.js";
import { fireIntention, _resetSatisfiedTerms } from "../src/ambient/fire.js";
import type { NodeInvoker } from "../src/ambient/delivery-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION = "session:test";

function makeIntention(place: string, state?: "pending_arm"): Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> {
  return {
    content: "Remind me when I get there",
    trigger: { all: [{ kind: "where", place }] },
    strength: "hard",
    origin: "obvious",
    evidence: { ts: "2026-06-07T12:00:00Z", sessionKey: SESSION },
    sensitivity: "private",
  };
}

function makeNoSessionIntention(place: string): Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> {
  return {
    content: "Remind me",
    trigger: { all: [{ kind: "where", place }] },
    strength: "hard",
    origin: "obvious",
    evidence: { ts: "2026-06-07T12:00:00Z" },
    sensitivity: "private",
  };
}

function makeAdapter(opts: { timeoutMs?: number } = {}) {
  const emitted: { sessionKey: string; regions: RegionDescriptor[] }[] = [];
  const adapter = new WhereAdapter({
    emitRegions(sessionKey, regions) {
      emitted.push({ sessionKey, regions });
    },
    timeoutMs: opts.timeoutMs ?? 500,
  });
  return { adapter, emitted };
}

// ---------------------------------------------------------------------------
// WhereAdapter.arm — success path
// ---------------------------------------------------------------------------

describe("WhereAdapter.arm → ack → armed", () => {
  test("emits regions-update, waits for ack, returns ok:true", async () => {
    const { adapter, emitted } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("home"));

    // Resolve the ack after a tick.
    const armPromise = adapter.arm(intention);
    await Promise.resolve(); // let arm run to the pending-ack stage
    adapter.resolveAck(intention.id, { ok: true });

    const result = await armPromise;
    expect(result.ok).toBe(true);
    expect(result.state).toBe("armed");
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0].sessionKey).toBe(SESSION);
    expect(emitted[0].regions[0].place).toBe("home");
    expect(emitted[0].regions[0].intentionId).toBe(intention.id);
  });
});

// ---------------------------------------------------------------------------
// WhereAdapter.arm — timeout path
// ---------------------------------------------------------------------------

describe("WhereAdapter.arm → timeout → deferred (recoverable, #481)", () => {
  test("returns device_ack_timeout flagged deferred when ack not received in time", async () => {
    const { adapter, emitted } = makeAdapter({ timeoutMs: 50 });
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("grocery store named Safeway"));

    const result = await adapter.arm(intention);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("device_ack_timeout");
    // #481: a timeout is now RECOVERABLE. The result is flagged deferred and the
    // intention is KEPT as a pending arm (no removal emit) so a late device ack
    // can still arm it — the device may still be completing a slow "Always" auth
    // grant. (Old behavior emitted a removal here; that permanently dropped the
    // region and is exactly the bug #481 fixes.)
    expect(result.deferred).toBe(true);
    expect(adapter.isPendingArm(intention)).toBe(true);
    // The region must NOT have been removed from the device set.
    expect(emitted.some((e) => e.regions.length === 0)).toBe(false);
    expect(emitted.some((e) => e.regions.some((r) => r.intentionId === intention.id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WhereAdapter.arm — no place term
// ---------------------------------------------------------------------------

describe("WhereAdapter.arm → no place → arm_failed", () => {
  test("category-only where term → arm_failed no_where_place_term", async () => {
    const { adapter } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "Remind me",
      trigger: { all: [{ kind: "where", category: "grocery" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-07T12:00:00Z", sessionKey: SESSION },
      sensitivity: "private",
    });

    const result = await adapter.arm(intention);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("arm_failed");
    expect(result.reason).toBe("no_where_place_term");
  });

  test("no where term at all → arm_failed no_where_place_term", async () => {
    const { adapter } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "Remind me",
      trigger: { all: [{ kind: "manual" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: "2026-06-07T12:00:00Z", sessionKey: SESSION },
      sensitivity: "private",
    });

    const result = await adapter.arm(intention);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_where_place_term");
  });

  test("missing sessionKey → arm_failed no_session_key", async () => {
    const { adapter } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeNoSessionIntention("home"));

    const result = await adapter.arm(intention);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_session_key");
  });
});

// ---------------------------------------------------------------------------
// region.entered → fire → surfaced (mock NodeInvoker)
// ---------------------------------------------------------------------------

describe("region.entered → fire → surfaced", () => {
  beforeEach(() => {
    _resetSatisfiedTerms();
  });

  test("armed where-intention fires and transitions to surfaced on region entry", async () => {
    const { adapter } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("home"));

    // Arm via armIntention (advances store to armed).
    const adapters = new Map([["where", adapter]]);
    const armP = armIntention(intention, adapters, store);
    await Promise.resolve();
    adapter.resolveAck(intention.id, { ok: true });
    const armResult = await armP;
    expect(armResult).toBe("armed");

    // Simulate region entry: find the where termKey.
    const whereTK = WhereAdapter.wherePlaceTermKey(intention)!;
    expect(whereTK).toBe("where:home:");

    // Build a mock NodeInvoker that delivers successfully.
    let surfaced = false;
    const nodes: NodeInvoker = {
      listConnected() {
        return [{ nodeId: SESSION, commands: ["frontend.message"] }];
      },
      async invoke(_nodeId, _command, _args) {
        surfaced = true;
        return { ok: true };
      },
    };

    const armed = (await store.get(intention.id))!;
    const result = await fireIntention(armed, whereTK, {
      store,
      nodes,
      scoreCtx: undefined,
    });

    expect(result.delivered).toBe(true);
    expect(surfaced).toBe(true);
    const afterFire = await store.get(intention.id);
    expect(afterFire?.state).toBe("surfaced");
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-enter
// ---------------------------------------------------------------------------

describe("idempotent re-enter: second fire on same intention is a no-op", () => {
  beforeEach(() => {
    _resetSatisfiedTerms();
  });

  test("second fireIntention call on surfaced intention returns delivered:false not_armed", async () => {
    const { adapter } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("office"));

    // Arm.
    const adapters = new Map([["where", adapter]]);
    const armP = armIntention(intention, adapters, store);
    await Promise.resolve();
    adapter.resolveAck(intention.id, { ok: true });
    await armP;

    const whereTK = WhereAdapter.wherePlaceTermKey(intention)!;
    let invokeCount = 0;
    const nodes: NodeInvoker = {
      listConnected() {
        return [{ nodeId: SESSION, commands: ["frontend.message"] }];
      },
      async invoke() {
        invokeCount++;
        return { ok: true };
      },
    };

    const armed = (await store.get(intention.id))!;
    const first = await fireIntention(armed, whereTK, { store, nodes, scoreCtx: undefined });
    expect(first.delivered).toBe(true);

    // Second fire: intention is now surfaced.
    const second = await fireIntention(armed, whereTK, { store, nodes, scoreCtx: undefined });
    expect(second.delivered).toBe(false);
    expect(second.reason).toBe("not_armed");
    expect(invokeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// auth-denied → arm_failed (state transition)
// ---------------------------------------------------------------------------

describe("armed → arm_failed transition (auth revocation, M8)", () => {
  test("armed intention can transition to arm_failed (new legal transition)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      ...makeIntention("home"),
      state: "pending_arm",
    });

    // Manually advance to armed (simulate successful arm).
    await store.transition(intention.id, "armed");
    const armed = await store.get(intention.id);
    expect(armed?.state).toBe("armed");

    // Auth denied → arm_failed is now a legal transition.
    const revoked = await store.transition(intention.id, "arm_failed");
    expect(revoked.state).toBe("arm_failed");
  });
});

// ---------------------------------------------------------------------------
// intention_create {content, where:"home"} → armed
// ---------------------------------------------------------------------------

describe("buildObviousIntention + where", () => {
  // All where tests pass whereEnabled:true to bypass the AMBIENT_WHERE flag gate
  // (the flag gate is tested separately below).

  test("content + where:home → builds TriggerWhere, no when term", () => {
    const result = buildObviousIntention({ content: "Remind me", where: "home" }, { whereEnabled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const terms = result.request.trigger.all ?? [];
    expect(terms.some((t) => t.kind === "where" && t.place === "home")).toBe(true);
    expect(terms.some((t) => t.kind === "when")).toBe(false);
  });

  test("content + when + where → ok: composite when∧where now allowed", () => {
    const T0 = Date.parse("2026-06-07T12:00:00.000Z");
    const result = buildObviousIntention(
      { content: "Buy groceries", when: "in 10 minutes", where: "Whole Foods" },
      { now: T0, timezone: "UTC", whereEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const terms = result.request.trigger.all ?? [];
    expect(terms.some((t) => t.kind === "when")).toBe(true);
    expect(terms.some((t) => t.kind === "where" && t.place === "Whole Foods")).toBe(true);
  });

  test("bare category 'a store' → needsClarification bare_category_where", () => {
    const result = buildObviousIntention({ content: "Buy milk", where: "a store" }, { whereEnabled: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsClarification).toBe(true);
    expect(result.reason).toBe("bare_category_where");
  });

  test("bare category 'a grocery' → needsClarification", () => {
    const result = buildObviousIntention({ content: "Buy milk", where: "a grocery" }, { whereEnabled: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bare_category_where");
  });

  test("neither when nor where → needsClarification missing_when", () => {
    const result = buildObviousIntention({ content: "Buy eggs" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsClarification).toBe(true);
    expect(result.reason).toBe("missing_when");
  });

  test("named place 'the office' is NOT treated as bare category (specific enough)", () => {
    const result = buildObviousIntention({ content: "Arrive", where: "my office" }, { whereEnabled: true });
    expect(result.ok).toBe(true);
  });

  test("place 'Whole Foods on Market Street' passes gate", () => {
    const result = buildObviousIntention({ content: "Buy groceries", where: "Whole Foods on Market Street" }, { whereEnabled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const terms = result.request.trigger.all ?? [];
    expect(terms.some((t) => t.kind === "where" && t.place === "Whole Foods on Market Street")).toBe(true);
  });

  test("AMBIENT_WHERE flag off → where arg yields needsClarification where_unavailable", () => {
    const result = buildObviousIntention({ content: "Pick up milk", where: "home" }, { whereEnabled: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("where_unavailable");
    expect(result.ask).toBe("Location reminders aren't available yet.");
  });
});

// ---------------------------------------------------------------------------
// Multi-region per-session set behavior (Finding 6)
// ---------------------------------------------------------------------------

describe("WhereAdapter multi-region: per-session SET behavior", () => {
  test("arming a second intention in the same session emits both regions", async () => {
    const { adapter, emitted } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const i1 = await store.create(makeIntention("home"));
    const i2 = await store.create(makeIntention("office"));

    // Arm i1.
    const arm1 = adapter.arm(i1);
    await Promise.resolve();
    adapter.resolveAck(i1.id, { ok: true });
    await arm1;

    // Arm i2 — should emit [home, office] (full set including pending i2).
    const arm2 = adapter.arm(i2);
    await Promise.resolve();
    adapter.resolveAck(i2.id, { ok: true });
    await arm2;

    // The emit during arm2 should include both regions.
    const arm2Emit = emitted.find((e) =>
      e.regions.some((r) => r.intentionId === i2.id) &&
      e.regions.some((r) => r.intentionId === i1.id)
    );
    expect(arm2Emit).toBeDefined();
  });

  test("disarming one intention emits the remaining set (not empty)", async () => {
    const { adapter, emitted } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const i1 = await store.create(makeIntention("home"));
    const i2 = await store.create(makeIntention("office"));

    // Arm both.
    const arm1 = adapter.arm(i1);
    await Promise.resolve();
    adapter.resolveAck(i1.id, { ok: true });
    await arm1;
    const arm2 = adapter.arm(i2);
    await Promise.resolve();
    adapter.resolveAck(i2.id, { ok: true });
    await arm2;

    emitted.length = 0; // reset captured emissions

    // Disarm i1 — should emit [office] only.
    await adapter.disarm(i1);
    expect(emitted.length).toBe(1);
    expect(emitted[0].regions.length).toBe(1);
    expect(emitted[0].regions[0].intentionId).toBe(i2.id);
    expect(emitted[0].regions[0].place).toBe("office");
  });

  test("disarming the last intention in a session emits empty set", async () => {
    const { adapter, emitted } = makeAdapter();
    const store = new InMemoryIntentionStore();
    const i1 = await store.create(makeIntention("home"));

    const arm1 = adapter.arm(i1);
    await Promise.resolve();
    adapter.resolveAck(i1.id, { ok: true });
    await arm1;
    emitted.length = 0;

    await adapter.disarm(i1);
    expect(emitted.length).toBe(1);
    expect(emitted[0].regions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synchronous ack path: resolver registered BEFORE emitRegions (Finding 7)
// ---------------------------------------------------------------------------

describe("WhereAdapter: synchronous ack path", () => {
  test("synchronous ack (resolved inside emitRegions callback) completes arm ok", async () => {
    const emitted: { sessionKey: string; regions: RegionDescriptor[] }[] = [];
    let capturedAdapter: WhereAdapter | undefined;

    const adapter = new WhereAdapter({
      emitRegions(sessionKey, regions) {
        emitted.push({ sessionKey, regions });
        // Simulate synchronous device ack: resolve inside emitRegions.
        if (capturedAdapter && regions.length > 0) {
          const id = regions[0].intentionId;
          capturedAdapter.resolveAck(id, { ok: true });
        }
      },
      timeoutMs: 50,
    });
    capturedAdapter = adapter;

    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("home"));

    const result = await adapter.arm(intention);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("armed");
  });
});

// ---------------------------------------------------------------------------
// arm_failed transition in IntentionService (Finding 5)
// ---------------------------------------------------------------------------

describe("IntentionService: device_ack_timeout is deferred (recoverable), not terminal (#481)", () => {
  test("where intention ack timeout → stays pending_arm (NOT arm_failed) so a late ack can arm it", async () => {
    const { IntentionService } = await import("../src/ambient/intention-service.js");
    const { InMemoryIntentionStore } = await import("../src/ambient/intention-store.js");

    const store = new InMemoryIntentionStore();
    const fakeCron = {
      scheduleAt(_id: string, _isoTime: string, _cb: () => void) {},
      cancel(_id: string) {},
      cancelAll() {},
    };

    // Provide whereDeps with an emitRegions that never acks → device_ack_timeout.
    const loop = new IntentionService({
      broadcast: () => 1,
      hasSession: () => true,
      store,
      now: () => Date.parse("2026-06-07T12:00:00.000Z"),
      whenCron: fakeCron,
      // timeoutMs: 1 ms so arm immediately hits device_ack_timeout (deferred).
      whereDeps: {
        emitRegions: () => { /* do nothing → ack never arrives → timeout */ },
        timeoutMs: 1,
      },
    });

    // Set AMBIENT_WHERE=1 so buildObviousIntention allows the where arg.
    const prevWhere = process.env.AMBIENT_WHERE;
    process.env.AMBIENT_WHERE = "1";
    let r: Awaited<ReturnType<typeof loop.handleCreateIntention>>;
    try {
      r = await loop.handleCreateIntention(
        { content: "Pick up coffee", where: "home" },
        "sess-armfail",
        "UTC",
      );
    } finally {
      if (prevWhere === undefined) delete process.env.AMBIENT_WHERE;
      else process.env.AMBIENT_WHERE = prevWhere;
    }
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // #481: a device_ack_timeout is RECOVERABLE — the device is still working on
    // it (e.g. awaiting "Always" auth). The intention must stay pending_arm so a
    // late region.armed can still arm it, NOT terminal arm_failed.
    expect(r.state).toBe("pending_arm");
    const stored = await store.get(r.intentionId);
    expect(stored?.state).toBe("pending_arm");

    // The where adapter must still hold it as a pending arm awaiting a late ack.
    const wa = loop.getAdapter("where") as InstanceType<typeof WhereAdapter>;
    expect(stored).not.toBeNull();
    expect(wa.isPendingArm(stored!)).toBe(true);
  });

  test("late region.armed ok:true after timeout → armFromLateAck promotes pending_arm → armed", async () => {
    const { adapter } = makeAdapter({ timeoutMs: 5 });
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("Whole Foods"));

    // prepare() times out → deferred; intention remains a pending arm.
    const prep = await adapter.prepare(intention);
    expect(prep.ok).toBe(false);
    expect(prep.reason).toBe("device_ack_timeout");
    expect(prep.deferred).toBe(true);
    expect(adapter.isPendingArm(intention)).toBe(true);

    // A LATE positive ack arrives (device finally got Always auth + monitoring).
    const armed = adapter.armFromLateAck(intention, { ok: true });
    expect(armed).toBe(true);
    expect(adapter.isPendingArm(intention)).toBe(false);
  });

  test("late region.armed ok:false after timeout → armFromLateAck drops it (device gave up)", async () => {
    const { adapter } = makeAdapter({ timeoutMs: 5 });
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("Whole Foods"));

    await adapter.prepare(intention);
    expect(adapter.isPendingArm(intention)).toBe(true);

    const armed = adapter.armFromLateAck(intention, { ok: false, reason: "denied" });
    expect(armed).toBe(false);
    expect(adapter.isPendingArm(intention)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// when∧where composite (two-phase arm now supported — Finding 3 updated)
// ---------------------------------------------------------------------------

describe("buildObviousIntention: when∧where composite now allowed", () => {
  const T0 = Date.parse("2026-06-07T12:00:00.000Z");

  test("valid when + valid where → ok: composite intention built with both terms", () => {
    const result = buildObviousIntention(
      { content: "Stop by", when: "in 30 minutes", where: "Whole Foods" },
      { now: T0, timezone: "UTC", whereEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const terms = result.request.trigger.all ?? [];
    expect(terms.some((t) => t.kind === "when")).toBe(true);
    expect(terms.some((t) => t.kind === "where" && t.place === "Whole Foods")).toBe(true);
  });

  test("when + bare-category where → bare_category_where (not a composite)", () => {
    const result = buildObviousIntention(
      { content: "Stop by", when: "in 30 minutes", where: "a store" },
      { now: T0, timezone: "UTC", whereEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bare_category_where");
  });
});

// ---------------------------------------------------------------------------
// Stronger precision gate: additional bare-category rejections (Finding 4)
// ---------------------------------------------------------------------------

describe("buildObviousIntention: stronger precision gate — bare category nouns", () => {
  const W = { whereEnabled: true };

  test("'store' → bare_category_where", () => {
    const r = buildObviousIntention({ content: "Buy", where: "store" }, W);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bare_category_where");
  });

  test("'coffee shop' → bare_category_where", () => {
    const r = buildObviousIntention({ content: "Get coffee", where: "coffee shop" }, W);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bare_category_where");
  });

  test("'grocery store' → bare_category_where", () => {
    const r = buildObviousIntention({ content: "Buy milk", where: "grocery store" }, W);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bare_category_where");
  });

  test("'any store' → bare_category_where", () => {
    const r = buildObviousIntention({ content: "Shop", where: "any store" }, W);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bare_category_where");
  });

  test("'a store' → bare_category_where", () => {
    const r = buildObviousIntention({ content: "Buy eggs", where: "a store" }, W);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bare_category_where");
  });

  test("'Safeway' (specific named place) passes gate", () => {
    const r = buildObviousIntention({ content: "Pick up", where: "Safeway" }, W);
    expect(r.ok).toBe(true);
  });

  test("'Whole Foods on Market Street' passes gate", () => {
    const r = buildObviousIntention({ content: "Shop", where: "Whole Foods on Market Street" }, W);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RPC session scoping: location.auth revokes only reporter's session (Finding 2)
// Tested at the store + adapter level (agent-methods RPC tested via integration).
// ---------------------------------------------------------------------------

describe("location.auth session-scoping: only revokes reporting session's intentions", () => {
  test("intentions from a different session are NOT revoked", async () => {
    // Simulate: store has where-intentions from two sessions.
    // Only the intention belonging to the reporting session should be revoked.
    const store = new InMemoryIntentionStore();

    const iA = await store.create({
      content: "Session A reminder",
      trigger: { all: [{ kind: "where", place: "home" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date().toISOString(), sessionKey: "sess-A" },
      sensitivity: "private",
    });
    await store.transition(iA.id, "armed");

    const iB = await store.create({
      content: "Session B reminder",
      trigger: { all: [{ kind: "where", place: "office" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date().toISOString(), sessionKey: "sess-B" },
      sensitivity: "private",
    });
    await store.transition(iB.id, "armed");

    // Revoke only sess-A's intentions (simulate what location.auth does).
    const reportingSession = "sess-A";
    const [pendingArm, armed] = await Promise.all([
      store.list({ state: "pending_arm" }),
      store.list({ state: "armed" }),
    ]);
    const toRevoke = [...pendingArm, ...armed].filter(
      (i) => i.evidence.sessionKey === reportingSession &&
             (i.trigger.all ?? []).some((t) => t.kind === "where"),
    );
    for (const i of toRevoke) {
      await store.transition(i.id, "arm_failed");
    }

    expect((await store.get(iA.id))?.state).toBe("arm_failed");
    expect((await store.get(iB.id))?.state).toBe("armed"); // untouched
  });
});

// ---------------------------------------------------------------------------
// WhereAdapter.wherePlaceTermKey helper
// ---------------------------------------------------------------------------

describe("WhereAdapter.wherePlaceTermKey", () => {
  test("returns key for first where term with a place", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(makeIntention("home"));
    expect(WhereAdapter.wherePlaceTermKey(intention)).toBe("where:home:");
  });

  test("returns undefined for category-only where term", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create({
      content: "Remind",
      trigger: { all: [{ kind: "where", category: "coffee" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });
    expect(WhereAdapter.wherePlaceTermKey(intention)).toBeUndefined();
  });
});
