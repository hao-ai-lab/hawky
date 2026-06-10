// =============================================================================
// test-intention-service.ts — M5 one-shot scheduling migration tests.
// Drives the real ambient modules through IntentionService with an injected fake
// WhenCronService (no real timers) + mock broadcast.
//
// Firing path: handleCreateIntention → arm → WhenAdapter.scheduleAt (fake cron)
//   → test triggers callback → handleFire → fireIntention → deliver.
// Prune path: tick() is prune-only; tests call it directly.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { IntentionService, MAX_DELIVER_ATTEMPTS, INTENTION_SURFACE_EVENT } from "../src/ambient/intention-service.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { buildPushItem } from "../src/ambient/broker.js";
import { scoreDelivery } from "../src/ambient/delivery-gate.js";
import { _resetReEmitGuard } from "../src/ambient/delivery-service.js";
import { _resetSatisfiedTerms } from "../src/ambient/fire.js";
import type { WhenCronService } from "../src/ambient/arm-when.js";

type Bcast = { sessionKey: string; event: string; payload: any };

/**
 * A controllable fake WhenCronService. Captures scheduled callbacks by id
 * so tests can fire them at will. Also captures cancelAll calls.
 */
function makeFakeCron() {
  const jobs = new Map<string, { isoTime: string; callback: () => void }>();
  let cancelAllCalled = false;

  const cron: WhenCronService = {
    scheduleAt(id: string, isoTime: string, callback: () => void): void {
      jobs.set(id, { isoTime, callback });
    },
    cancel(jobId: string): void {
      jobs.delete(jobId);
    },
    cancelAll(): void {
      jobs.clear();
      cancelAllCalled = true;
    },
  };

  return {
    cron,
    jobs,
    get cancelAllCalled() { return cancelAllCalled; },
    /** Fire all jobs matching the predicate (defaults to all). */
    fireJob(id: string): boolean {
      const job = jobs.get(id);
      if (!job) return false;
      jobs.delete(id);
      job.callback();
      return true;
    },
    /** Fire the first job whose id starts with prefix. */
    fireFirst(prefix: string): string | undefined {
      for (const [id, job] of jobs) {
        if (id.startsWith(prefix)) {
          jobs.delete(id);
          job.callback();
          return id;
        }
      }
      return undefined;
    },
    /** Return the id of the first job matching the prefix, without firing. */
    peekFirst(prefix: string): string | undefined {
      for (const id of jobs.keys()) {
        if (id.startsWith(prefix)) return id;
      }
      return undefined;
    },
    jobCount(): number { return jobs.size; },
  };
}

function makeLoop(opts: {
  now: () => number;
  hasSession?: (k: string) => boolean;
  deliveredCount?: number;
  retryMs?: number;
}) {
  const broadcasts: Bcast[] = [];
  const store = new InMemoryIntentionStore();
  const fakeCron = makeFakeCron();
  const loop = new IntentionService({
    broadcast: (sessionKey, event, payload) => {
      broadcasts.push({ sessionKey, event, payload });
      return opts.deliveredCount ?? 1;
    },
    hasSession: opts.hasSession ?? (() => true),
    store,
    now: opts.now,
    tickMs: 30_000,
    whenCron: fakeCron.cron,
    retryMs: opts.retryMs ?? 5_000,
    log: () => {},
  });
  return { loop, store, broadcasts, fakeCron };
}

/** Schedule an intention via the structured path, asserting it was not bounced. */
async function schedule(
  loop: IntentionService,
  content: string,
  when: string,
  sessionKey: string,
  tz = "UTC",
): Promise<{ intentionId: string; state: string }> {
  const r = await loop.handleCreateIntention({ content, when }, sessionKey, tz);
  if (!r.ok) throw new Error(`expected scheduled, got clarification: ${r.ask}`);
  return { intentionId: r.intentionId, state: r.state };
}

beforeEach(() => {
  _resetReEmitGuard();
  _resetSatisfiedTerms();
});

const T0 = Date.parse("2026-06-05T12:00:00.000Z");

describe("IntentionService.handleCreateIntention — store + arm + precision gate", () => {
  test("structured slots → armed hard/obvious intention with evidence.sessionKey", async () => {
    let now = T0;
    const { loop, store, fakeCron } = makeLoop({ now: () => now });
    const r = await loop.handleCreateIntention({ content: "Drink water", when: "in 1 minute" }, "sess-A", "UTC");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toBe("armed");
    const intention = (await store.get(r.intentionId))!;
    expect(intention.strength).toBe("hard");
    expect(intention.origin).toBe("obvious");
    expect(intention.state).toBe("armed");
    expect(intention.evidence.sessionKey).toBe("sess-A");
    const whenTerm = intention.trigger.all?.find((t) => t.kind === "when");
    expect(whenTerm && "at" in whenTerm ? Date.parse(whenTerm.at!) : 0).toBeGreaterThan(now);
    // A job should have been scheduled in the fake cron.
    expect(fakeCron.jobCount()).toBe(1);
  });

  test("vague when → clarification, stores nothing (precision gate)", async () => {
    let now = T0;
    const { loop, store } = makeLoop({ now: () => now });
    const r = await loop.handleCreateIntention({ content: "Buy eggs", when: "later" }, "sess-C", "UTC");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needsClarification).toBe(true);
    expect((await store.list()).length).toBe(0);
  });

  test("phone timezone resolves wall-clock 'at' correctly (America/Los_Angeles)", async () => {
    let now = T0; // 2026-06-05T12:00Z = 05:00 LA (PDT) → 5pm LA is in the future
    const { loop, store } = makeLoop({ now: () => now });
    const r = await schedule(loop, "Review notes", "5pm", "sess-tz", "America/Los_Angeles");
    const intention = (await store.get(r.intentionId))!;
    const whenTerm = intention.trigger.all?.find((t) => t.kind === "when");
    const at = whenTerm && "at" in whenTerm ? whenTerm.at! : "";
    const laHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date(at)),
    );
    expect(laHour).toBe(17);
  });
});

describe("IntentionService — fire via one-shot callback", () => {
  test("fires a due when-intention exactly once and broadcasts agent.intention_surface", async () => {
    let now = T0;
    const { loop, store, broadcasts, fakeCron } = makeLoop({ now: () => now });
    const r = await schedule(loop, "Drink water", "in 1 minute", "sess-B");

    // Job scheduled but not fired yet.
    expect(fakeCron.jobCount()).toBe(1);
    expect(broadcasts.length).toBe(0);
    expect((await store.get(r.intentionId))!.state).toBe("armed");

    // Fire the scheduled callback (simulates timer expiry).
    const fired = fakeCron.fireFirst("when:");
    expect(fired).toBeDefined();
    // Wait for the async handleFire chain to settle.
    await new Promise((res) => setTimeout(res, 0));

    expect(broadcasts.length).toBe(1);
    const b = broadcasts[0];
    expect(b.sessionKey).toBe("sess-B");
    expect(b.event).toBe(INTENTION_SURFACE_EVENT);
    expect(b.payload.speak).toBe(true); // hard intention → speak
    expect(String(b.payload.body)).toContain("Drink water");
    expect((await store.get(r.intentionId))!.state).toBe("surfaced");

    // Firing again would be a no-op (no job left, intention is surfaced).
    expect(fakeCron.jobCount()).toBe(0);
  });

  test("does not fire a not-yet-scheduled intention before callback fires", async () => {
    let now = T0;
    const { loop, broadcasts, fakeCron } = makeLoop({ now: () => now });
    await schedule(loop, "Stretch", "in 10 minutes", "sess-C");
    // Job is scheduled but not fired — no broadcast.
    expect(broadcasts.length).toBe(0);
    expect(fakeCron.jobCount()).toBe(1);
  });

  test("tick() is prune-only — does not fire due intentions", async () => {
    let now = T0;
    const { loop, store, broadcasts, fakeCron } = makeLoop({ now: () => now });
    const r = await schedule(loop, "Drink water", "in 1 minute", "sess-tick");
    now += 61_000;

    // Tick does NOT fire (prune only).
    await loop.tick();
    expect(broadcasts.length).toBe(0);
    expect((await store.get(r.intentionId))!.state).toBe("armed");
    expect(fakeCron.jobCount()).toBe(1); // job still pending
  });
});

describe("delivery gate — surfaced hard intention delivers definitively (speak)", () => {
  test("scoreDelivery(buildPushItem(hardIntention), undefined) → push + speak", async () => {
    let now = T0;
    const { loop, store } = makeLoop({ now: () => now });
    const r = await schedule(loop, "Drink water", "in 1 minute", "sess-D");
    const intention = (await store.get(r.intentionId))!;
    const item = buildPushItem({ kind: "intention", intention });
    expect(item.strength).toBe("hard");
    const { decision } = scoreDelivery(item, undefined);
    expect(decision.push).toBe(true);
    expect(decision.deliver).toBe("speak");
  });
});

describe("never-drop: undeliverable obligation is kept armed", () => {
  test("a hard intention with no live session stays armed past MAX_DELIVER_ATTEMPTS", async () => {
    let now = T0;
    const { loop, store, broadcasts, fakeCron } = makeLoop({
      now: () => now,
      hasSession: () => false,
      retryMs: 100,
    });
    const r = await schedule(loop, "Call mom", "in 1 minute", "sess-gone");
    now += 61_000;

    // Fire the initial callback.
    fakeCron.fireFirst("when:");
    await new Promise((res) => setTimeout(res, 0));
    // Intention stays armed (no session).
    expect((await store.get(r.intentionId))!.state).toBe("armed");
    expect(broadcasts.length).toBe(0);

    // Simulate MAX_DELIVER_ATTEMPTS + 5 retry fires.
    for (let i = 0; i < MAX_DELIVER_ATTEMPTS + 5; i++) {
      // Fire the retry job that was re-scheduled.
      const retryId = fakeCron.peekFirst("retry:");
      expect(retryId).toBeDefined();
      fakeCron.fireFirst("retry:");
      await new Promise((res) => setTimeout(res, 0));
      // Must ALWAYS stay armed — never dropped.
      expect((await store.get(r.intentionId))!.state).toBe("armed");
    }
    expect(broadcasts.length).toBe(0); // still never delivered (no session)
  });

  test("broadcast reaching 0 connections keeps the intention armed (never dropped)", async () => {
    let now = T0;
    const { loop, store, fakeCron } = makeLoop({
      now: () => now,
      hasSession: () => true,
      deliveredCount: 0,
      retryMs: 100,
    });
    const r = await schedule(loop, "Drink water", "in 1 minute", "sess-drop");
    now += 61_000;

    // Fire the initial callback.
    fakeCron.fireFirst("when:");
    await new Promise((res) => setTimeout(res, 0));

    for (let i = 0; i < MAX_DELIVER_ATTEMPTS + 5; i++) {
      fakeCron.fireFirst("retry:");
      await new Promise((res) => setTimeout(res, 0));
      expect((await store.get(r.intentionId))!.state).toBe("armed");
    }
  });
});

describe("retry only on no_frontend_node — not on other reasons", () => {
  test("conjunction_incomplete does NOT re-schedule a retry", async () => {
    const { loop, store, fakeCron } = makeLoop({ now: () => T0 });
    // Create a composite all:[when, where] intention so fireIntention returns
    // conjunction_incomplete when only 'when' fires.
    const intention = await loop.store.create({
      content: "Composite test",
      trigger: { all: [{ kind: "when", at: new Date(T0 + 5_000).toISOString() }, { kind: "where", place: "office" }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date(T0).toISOString(), sessionKey: "sess-conj" },
      sensitivity: "private",
    });
    await loop.store.transition(intention.id, "armed");

    // Call handleFire directly for 'when' — conjunction_incomplete, should NOT retry.
    await loop.handleFire(intention, "when");

    // No retry job should have been scheduled.
    expect(fakeCron.peekFirst("retry:")).toBeUndefined();
    // Intention stays armed (conjunction_incomplete does not clear attempts).
    expect((await store.get(intention.id))!.state).toBe("armed");
  });

  test("not_armed does NOT re-schedule a retry", async () => {
    const { loop, store, fakeCron } = makeLoop({ now: () => T0 });
    const intention = await loop.store.create({
      content: "Not armed test",
      trigger: { all: [{ kind: "when", at: new Date(T0 + 5_000).toISOString() }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date(T0).toISOString(), sessionKey: "sess-na" },
      sensitivity: "private",
    });
    // Leave in pending_arm (not armed) — fireIntention returns not_armed.
    await loop.handleFire(intention, "when");

    expect(fakeCron.peekFirst("retry:")).toBeUndefined();
  });

  test("kind_not_in_trigger does NOT re-schedule a retry", async () => {
    const { loop, store, fakeCron } = makeLoop({ now: () => T0 });
    const intention = await loop.store.create({
      content: "Kind mismatch test",
      trigger: { all: [{ kind: "when", at: new Date(T0 + 5_000).toISOString() }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date(T0).toISOString(), sessionKey: "sess-km" },
      sensitivity: "private",
    });
    await loop.store.transition(intention.id, "armed");
    // Fire with a wrong term kind — fireIntention returns kind_not_in_trigger.
    await loop.handleFire(intention, "where");

    expect(fakeCron.peekFirst("retry:")).toBeUndefined();
    // Attempts counter cleared for non-retryable reasons.
    expect((await store.get(intention.id))!.state).toBe("armed");
  });
});

describe("cancel/disarm and stop() behavior", () => {
  test("stop() calls cancelAll() — no callback fires after stop", async () => {
    let now = T0;
    const { loop, store, broadcasts, fakeCron } = makeLoop({ now: () => now });
    const r = await schedule(loop, "Stop test", "in 1 minute", "sess-stop");
    now += 61_000;

    // Stop before the timer fires.
    loop.stop();
    expect(fakeCron.cancelAllCalled).toBe(true);

    // Firing any lingering job after stop should be a no-op (jobs cleared).
    const fired = fakeCron.fireFirst("when:");
    expect(fired).toBeUndefined(); // jobs were cleared by cancelAll
    expect(broadcasts.length).toBe(0);
    expect((await store.get(r.intentionId))!.state).toBe("armed"); // not surfaced
  });

  test("stop() also cancels pending retry timers", async () => {
    let now = T0;
    const { loop, store, broadcasts, fakeCron } = makeLoop({
      now: () => now,
      hasSession: () => false,
      retryMs: 100,
    });
    const r = await schedule(loop, "Retry stop test", "in 1 minute", "sess-retrystop");
    now += 61_000;

    // Fire the initial callback → no_frontend_node → retry scheduled.
    fakeCron.fireFirst("when:");
    await new Promise((res) => setTimeout(res, 0));
    expect(fakeCron.peekFirst("retry:")).toBeDefined();

    // Stop — cancelAll removes the retry too.
    loop.stop();
    expect(fakeCron.cancelAllCalled).toBe(true);
    // No retry job exists after cancelAll.
    const firedRetry = fakeCron.fireFirst("retry:");
    expect(firedRetry).toBeUndefined();
  });
});

describe("prune-only tick still drops terminal states", () => {
  test("tick() prunes superseded/resolved intentions from the store", async () => {
    const { loop, store } = makeLoop({ now: () => T0 });
    const i1 = await store.create({
      content: "to supersede",
      trigger: { all: [{ kind: "when", at: new Date(T0 + 5_000).toISOString() }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date(T0).toISOString() },
      sensitivity: "private",
    });
    // Manually transition to superseded.
    await store.transition(i1.id, "superseded");
    expect((await store.get(i1.id))!.state).toBe("superseded");

    await loop.tick();
    // After prune, the superseded intention should be removed.
    expect(await store.get(i1.id)).toBeNull();
  });
});

describe("past/now fires once (not synchronously)", () => {
  test("past `at` schedules exactly one callback (fires on next macrotask via fake cron)", async () => {
    const { loop, store, broadcasts, fakeCron } = makeLoop({ now: () => T0 });
    // Create an intention with `at` in the past.
    const intention = await loop.store.create({
      content: "Past fire test",
      trigger: { all: [{ kind: "when", at: new Date(T0 - 1_000).toISOString() }] },
      strength: "hard",
      origin: "obvious",
      evidence: { ts: new Date(T0).toISOString(), sessionKey: "sess-past" },
      sensitivity: "private",
    });
    const { WhenAdapter } = await import("../src/ambient/arm-when.js");
    const whenAdapter = new WhenAdapter(fakeCron.cron, (i, k) => loop.handleFire(i, k));
    const armResult = await whenAdapter.arm(intention);
    expect(armResult.ok).toBe(true);
    await loop.store.transition(intention.id, "armed");

    // Exactly one job scheduled.
    expect(fakeCron.jobCount()).toBe(1);

    // Fire it (simulates the macrotask running).
    fakeCron.fireFirst("when:");
    await new Promise((res) => setTimeout(res, 0));

    expect(broadcasts.length).toBe(1);
    expect((await store.get(intention.id))!.state).toBe("surfaced");
    // No retry — delivered successfully.
    expect(fakeCron.peekFirst("retry:")).toBeUndefined();
  });
});
