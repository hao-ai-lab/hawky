// =============================================================================
// test-surface.ts — M9 stage 9b: surfaceLatent + deliverAndMark + store filters
//   - surfaceLatent surfaces an armed latent (armed -> surfaced) via deliverAndMark
//   - guards: non-armed / non-latent -> not_surfaceable; surface-once (state guard)
//   - deliverAndMark shared in-flight claim (poll vs tool cannot double-deliver)
//   - latent soft delivery is not retried (no_frontend_node leaves it armed)
//   - IntentionStore.list supports state[] arrays + sessionKey filtering
//   - LatentService stamps evidence.sessionKey at mint time
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { surfaceLatent, deliverAndMark, _resetSatisfiedTerms } from "../src/ambient/fire.js";
import type { FireDeps } from "../src/ambient/fire.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { _resetReEmitGuard } from "../src/ambient/delivery-service.js";
import { LatentService } from "../src/ambient/latent-service.js";
import type { Intention } from "../src/ambient/intention.js";

beforeEach(() => {
  _resetSatisfiedTerms();
  _resetReEmitGuard();
});

const TS = "2026-06-06T10:00:00Z";

async function makeArmedLatent(
  store: InMemoryIntentionStore,
  opts: { content?: string; sessionKey?: string } = {},
): Promise<Intention> {
  const i = await store.create({
    content: opts.content ?? "buy coffee",
    trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred", confidence: 0.9 }] },
    strength: "soft",
    origin: "latent",
    evidence: { ts: TS, sessionKey: opts.sessionKey ?? "sess-A" },
    sensitivity: "private",
    confidence: 0.9,
  });
  await store.transition(i.id, "armed");
  return (await store.get(i.id))!;
}

const okDeliver: FireDeps["deliverFn"] = async () => ({ delivered: true, voiceStatus: "spoken" });

describe("surfaceLatent", () => {
  test("armed latent → delivered + transitions to surfaced", async () => {
    const store = new InMemoryIntentionStore();
    const i = await makeArmedLatent(store);
    const r = await surfaceLatent(i, { store, nodes: undefined, deliverFn: okDeliver });
    expect(r.delivered).toBe(true);
    expect((await store.get(i.id))!.state).toBe("surfaced");
  });

  test("non-armed latent (pending_arm) → not_surfaceable", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "buy milk",
      trigger: { all: [{ kind: "topic", topic: "milk", provenance: "inferred" }] },
      strength: "soft", origin: "latent", evidence: { ts: TS, sessionKey: "s" }, sensitivity: "private",
    });
    const r = await surfaceLatent(i, { store, nodes: undefined, deliverFn: okDeliver });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("not_surfaceable");
    expect((await store.get(i.id))!.state).toBe("pending_arm");
  });

  test("armed OBVIOUS intention → not_surfaceable (surface is latent-only)", async () => {
    const store = new InMemoryIntentionStore();
    const i = await store.create({
      content: "take pills",
      trigger: { all: [{ kind: "when", at: TS }] },
      strength: "hard", origin: "obvious", evidence: { ts: TS, sessionKey: "s" }, sensitivity: "private",
    });
    await store.transition(i.id, "armed");
    const r = await surfaceLatent(i, { store, nodes: undefined, deliverFn: okDeliver });
    expect(r.reason).toBe("not_surfaceable");
  });

  test("surface-once: second surfaceLatent is a no-op (state guard)", async () => {
    const store = new InMemoryIntentionStore();
    const i = await makeArmedLatent(store);
    const r1 = await surfaceLatent(i, { store, nodes: undefined, deliverFn: okDeliver });
    expect(r1.delivered).toBe(true);
    const r2 = await surfaceLatent(i, { store, nodes: undefined, deliverFn: okDeliver });
    expect(r2.delivered).toBe(false);
    expect(r2.reason).toBe("not_surfaceable"); // already surfaced, no longer armed
  });

  test("soft latent is NOT retried — no_frontend_node leaves it armed", async () => {
    const store = new InMemoryIntentionStore();
    const i = await makeArmedLatent(store);
    const failDeliver: FireDeps["deliverFn"] = async () => ({
      delivered: false, voiceStatus: "dropped", reason: "no_frontend_node",
    });
    const r = await surfaceLatent(i, { store, nodes: undefined, deliverFn: failDeliver });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("no_frontend_node");
    expect((await store.get(i.id))!.state).toBe("armed"); // stays armed; next poll re-attempts
  });
});

describe("deliverAndMark — shared in-flight claim", () => {
  test("concurrent calls: exactly one delivers, the other gets in_flight", async () => {
    const store = new InMemoryIntentionStore();
    const i = await makeArmedLatent(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blockingDeliver: FireDeps["deliverFn"] = async () => {
      await gate;
      return { delivered: true, voiceStatus: "spoken" };
    };
    const p1 = deliverAndMark(i, { store, nodes: undefined, deliverFn: blockingDeliver });
    const p2 = deliverAndMark(i, { store, nodes: undefined, deliverFn: blockingDeliver });
    const r2 = await p2; // claim held by p1 → immediate in_flight
    expect(r2.reason).toBe("in_flight");
    release();
    const r1 = await p1;
    expect(r1.delivered).toBe(true);
    expect((await store.get(i.id))!.state).toBe("surfaced");
  });
});

describe("IntentionStore.list — state[] + sessionKey filters", () => {
  test("state array matches any listed state", async () => {
    const store = new InMemoryIntentionStore();
    const a = await makeArmedLatent(store, { content: "a" });           // armed
    const b = await makeArmedLatent(store, { content: "b" });
    await store.transition(b.id, "surfaced");                            // surfaced
    await store.create({                                                // pending_arm
      content: "c", trigger: {}, strength: "soft", origin: "latent",
      evidence: { ts: TS, sessionKey: "sess-A" }, sensitivity: "private",
    });
    const armedOrSurfaced = await store.list({ state: ["armed", "surfaced"] });
    expect(armedOrSurfaced.map((x) => x.content).sort()).toEqual(["a", "b"]);
    expect(await store.list({ state: "armed" })).toHaveLength(1); // scalar still works
  });

  test("sessionKey filters by evidence.sessionKey", async () => {
    const store = new InMemoryIntentionStore();
    await makeArmedLatent(store, { content: "x", sessionKey: "sess-A" });
    await makeArmedLatent(store, { content: "y", sessionKey: "sess-B" });
    const a = await store.list({ sessionKey: "sess-A" });
    expect(a.map((x) => x.content)).toEqual(["x"]);
  });
});

describe("LatentService stamps evidence.sessionKey at mint", () => {
  test("onTranscript(sessionKey) → minted intention carries that sessionKey", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store }); // deterministic recognizer
    svc.onTranscript("sess-Z", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await svc.flush("sess-Z");
    const latent = await store.list({ origin: "latent" });
    expect(latent.length).toBeGreaterThanOrEqual(1);
    expect(latent.every((i) => i.evidence.sessionKey === "sess-Z")).toBe(true);
  });
});
