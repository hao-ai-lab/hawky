// =============================================================================
// test-when-notification.ts — #482: hard timed-reminder local-notification
// wiring tests.
//
// Validates that:
//   1. When-arm arm payload carries NO notification metadata BEFORE the fix
//      (regression test proving the gap existed).
//   2. After fix: WhenAdapter.activate() calls emitWhenArmed with the correct
//      descriptor (intentionId, fireDate, title, body).
//   3. WhenAdapter.disarm() calls emitWhenDisarmed.
//   4. IntentionService wires whenDeps through to WhenAdapter.
//   5. On successful fire delivery, _disarmWhen is called so emitWhenDisarmed fires.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { WhenAdapter } from "../src/ambient/arm-when.js";
import type { WhenAdapterDeps, WhenNotificationDescriptor } from "../src/ambient/arm-when.js";
import { IntentionService } from "../src/ambient/intention-service.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { _resetSatisfiedTerms } from "../src/ambient/fire.js";
import { _resetReEmitGuard } from "../src/ambient/delivery-service.js";
import type { WhenCronService } from "../src/ambient/arm-when.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeCron() {
  const jobs = new Map<string, { isoTime: string; callback: () => void }>();
  const cron: WhenCronService = {
    scheduleAt(id, isoTime, callback) { jobs.set(id, { isoTime, callback }); },
    cancel(id) { jobs.delete(id); },
    cancelAll() { jobs.clear(); },
  };
  return {
    cron,
    jobs,
    fireFirst(prefix: string): string | undefined {
      for (const [id, job] of jobs) {
        if (id.startsWith(prefix)) { jobs.delete(id); job.callback(); return id; }
      }
      return undefined;
    },
  };
}

const AT = "2026-07-01T09:00:00Z";
const SESSION = "sess-test";

function makeIntention(id = "int-1", content = "Take vitamins") {
  return {
    id,
    content,
    trigger: { all: [{ kind: "when" as const, at: AT }] },
    strength: "hard" as const,
    origin: "obvious" as const,
    state: "pending_arm" as const,
    evidence: { ts: "2026-06-05T00:00:00Z", sessionKey: SESSION },
    sensitivity: "private" as const,
    createdAt: "2026-06-05T00:00:00Z",
    updatedAt: "2026-06-05T00:00:00Z",
  };
}

beforeEach(() => {
  _resetReEmitGuard();
  _resetSatisfiedTerms();
});

// ---------------------------------------------------------------------------
// Proof-of-gap: without whenDeps, NO notification event is emitted
// ---------------------------------------------------------------------------

describe("#482 proof-of-gap: without whenDeps, when-arm emits no notification event", () => {
  test("WhenAdapter without deps: activate() schedules cron but emits nothing", async () => {
    const { cron, jobs } = makeFakeCron();
    const adapter = new WhenAdapter(cron, async () => {});
    const intention = makeIntention();

    await adapter.prepare(intention);
    adapter.activate(intention);

    expect(jobs.size).toBe(1); // cron job scheduled
    // No notification emission path without deps — this was the bug (zero call sites)
  });

  test("IntentionService without whenDeps: arm broadcasts no agent.when.armed event", async () => {
    const broadcasts: { event: string }[] = [];
    const { cron } = makeFakeCron();
    const loop = new IntentionService({
      broadcast: (sk, event) => { broadcasts.push({ event }); return 1; },
      hasSession: () => true,
      store: new InMemoryIntentionStore(),
      now: () => Date.parse("2026-06-05T00:00:00Z"),
      whenCron: cron,
      // No whenDeps — pre-fix state
    });
    await loop.handleCreateIntention({ content: "Buy milk", when: "in 5 minutes" }, SESSION, "UTC");
    const whenArmed = broadcasts.filter(b => b.event === "agent.when.armed");
    expect(whenArmed).toHaveLength(0); // confirms the gap
  });
});

// ---------------------------------------------------------------------------
// Fix: with whenDeps wired, activate() emits correct descriptor
// ---------------------------------------------------------------------------

describe("#482 fix: WhenAdapter with whenDeps emits notification events", () => {
  test("activate() calls emitWhenArmed with intentionId, fireDate, title, body", async () => {
    const { cron } = makeFakeCron();
    const armed: { sessionKey: string; descriptor: WhenNotificationDescriptor }[] = [];
    const deps: WhenAdapterDeps = {
      emitWhenArmed(sk, descriptor) { armed.push({ sessionKey: sk, descriptor }); },
      emitWhenDisarmed() {},
    };
    const adapter = new WhenAdapter(cron, async () => {}, deps);
    const intention = makeIntention("int-2", "Take vitamins");

    await adapter.prepare(intention);
    adapter.activate(intention);

    expect(armed).toHaveLength(1);
    expect(armed[0].sessionKey).toBe(SESSION);
    expect(armed[0].descriptor.intentionId).toBe("int-2");
    expect(armed[0].descriptor.fireDate).toBe(AT);
    expect(armed[0].descriptor.title).toBe("Take vitamins");
    expect(armed[0].descriptor.body).toBe("Take vitamins");
  });

  test("title is trimmed to 60 chars with ellipsis when content is long", async () => {
    const { cron } = makeFakeCron();
    const armed: WhenNotificationDescriptor[] = [];
    const deps: WhenAdapterDeps = {
      emitWhenArmed(_, d) { armed.push(d); },
      emitWhenDisarmed() {},
    };
    const adapter = new WhenAdapter(cron, async () => {}, deps);
    const longContent = "A".repeat(80);
    const intention = makeIntention("int-long", longContent);

    await adapter.prepare(intention);
    adapter.activate(intention);

    expect(armed[0].title.length).toBeLessThanOrEqual(60);
    expect(armed[0].title.endsWith("…")).toBe(true);
  });

  test("disarm() calls emitWhenDisarmed", async () => {
    const { cron } = makeFakeCron();
    const disarmed: string[] = [];
    const deps: WhenAdapterDeps = {
      emitWhenArmed() {},
      emitWhenDisarmed(_, intentionId) { disarmed.push(intentionId); },
    };
    const adapter = new WhenAdapter(cron, async () => {}, deps);
    const intention = makeIntention("int-3");

    await adapter.prepare(intention);
    adapter.activate(intention);
    await adapter.disarm(intention);

    expect(disarmed).toContain("int-3");
  });

  test("disarm() without prior activate() still calls emitWhenDisarmed (cancel idempotency)", async () => {
    const { cron } = makeFakeCron();
    const disarmed: string[] = [];
    const deps: WhenAdapterDeps = {
      emitWhenArmed() {},
      emitWhenDisarmed(_, intentionId) { disarmed.push(intentionId); },
    };
    const adapter = new WhenAdapter(cron, async () => {}, deps);
    const intention = makeIntention("int-4");

    // disarm without prepare/activate
    await adapter.disarm(intention);
    expect(disarmed).toContain("int-4");
  });

  test("no notification emitted when intention has no sessionKey", async () => {
    const { cron } = makeFakeCron();
    const armed: WhenNotificationDescriptor[] = [];
    const deps: WhenAdapterDeps = {
      emitWhenArmed(_, d) { armed.push(d); },
      emitWhenDisarmed() {},
    };
    const adapter = new WhenAdapter(cron, async () => {}, deps);
    const intention = {
      ...makeIntention("int-nosession"),
      evidence: { ts: "2026-06-05T00:00:00Z" }, // no sessionKey
    };

    await adapter.prepare(intention);
    adapter.activate(intention);

    expect(armed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IntentionService integration: whenDeps threaded correctly
// ---------------------------------------------------------------------------

describe("#482 IntentionService with whenDeps broadcasts arm/disarm events", () => {
  test("arm broadcasts via emitWhenArmed for hard when-intention", async () => {
    const T0 = Date.parse("2026-06-05T00:00:00Z");
    const { cron } = makeFakeCron();
    const armed: WhenNotificationDescriptor[] = [];

    const loop = new IntentionService({
      broadcast: () => 1,
      hasSession: () => true,
      store: new InMemoryIntentionStore(),
      now: () => T0,
      whenCron: cron,
      whenDeps: {
        emitWhenArmed(_, descriptor) { armed.push(descriptor); },
        emitWhenDisarmed() {},
      },
    });

    const r = await loop.handleCreateIntention({ content: "Call dentist", when: "in 10 minutes" }, SESSION, "UTC");
    expect(r.ok).toBe(true);
    expect(armed).toHaveLength(1);
    expect(armed[0].title).toBe("Call dentist");
    expect(armed[0].intentionId).toBeTruthy();
  });

  test("successful fire delivery KEEPS the local notification (open app still gets a system alert)", async () => {
    const T0 = Date.parse("2026-06-05T00:00:00Z");
    const fakeCronInst = makeFakeCron();
    const disarmed: string[] = [];

    const loop = new IntentionService({
      broadcast: () => 1,
      hasSession: () => true,
      store: new InMemoryIntentionStore(),
      now: () => T0,
      whenCron: fakeCronInst.cron,
      whenDeps: {
        emitWhenArmed() {},
        emitWhenDisarmed(_, intentionId) { disarmed.push(intentionId); },
      },
    });

    const r = await loop.handleCreateIntention({ content: "Stretch", when: "in 5 minutes" }, SESSION, "UTC");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const intentionId = r.intentionId;

    // Fire the intention
    fakeCronInst.fireFirst("when:");

    // Wait for async handleFire to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // emitWhenDisarmed must NOT be called on the post-fire path: we deliberately
    // keep the device's local notification so an open app also gets a system
    // alert (the in-session surface is voice-only and easy to miss).
    expect(disarmed).not.toContain(intentionId);
  });
});
