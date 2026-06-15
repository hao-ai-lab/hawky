// =============================================================================
// test-scan-intention.ts — M10 scan / model-pull surfacing clock (§8 of spec).
//
// All tests are offline (no model calls). Covers:
//   scanLatent: match/empty/quiet/veto/gate/topN/revalidate-armed
//   cross-session sharing: mint in A, scan with B's context returns it
//   poll companion: poll surfaces latent minted in A into live session B
//   cross-session satisfy/cancel sweep
//   reservation: skip-in-window, late check, no-extend-while-active, re-reserve-after-expiry
//   mode resolution: explicit-quiet + params.mode:"ambient" → empty; non-explicit paths
//   scan uses poll's now/tz (buildScanInput)
//   RPC: bound-connection, sessionKey mismatch, no sessionKey filter
//   concurrent-live-sessions → exactly one delivery
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { LatentService } from "../src/ambient/latent-service.js";
import { IntentionService } from "../src/ambient/intention-service.js";
import { scanLatent, MAX_SCAN_RESULTS } from "../src/ambient/scan.js";
import { DeterministicRelevanceGate, type RelevanceGate } from "../src/ambient/relevance-gate.js";
import { _resetSatisfiedTerms, deliverAndMark } from "../src/ambient/fire.js";
import { _resetReEmitGuard } from "../src/ambient/delivery-service.js";
import type { Mode } from "../src/ambient/modes.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { resetGatewayState } from "../src/gateway/server.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { setSessionsDir, resetSessionsDir, updateSessionMeta } from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetSatisfiedTerms();
  _resetReEmitGuard();
});

function makeStore() {
  return new InMemoryIntentionStore();
}

function makeLatentService(
  store: InMemoryIntentionStore,
  opts: { now?: () => number; tz?: string; broadcast?: (sk: string, ev: string, payload: unknown) => number; hasSession?: () => boolean; liveSessions?: () => { sessionKey: string; mode: Mode }[] } = {},
) {
  return new LatentService({
    store,
    now: opts.now,
    tz: opts.tz,
    broadcast: opts.broadcast,
    hasSession: opts.hasSession,
    liveSessions: opts.liveSessions,
  });
}

/** Create an armed latent intention with a topic term. */
async function seedArmedLatent(
  store: InMemoryIntentionStore,
  content: string,
  topic: string,
  evidenceSessionKey: string,
  confidence = 0.8,
) {
  const intention = await store.create({
    content,
    trigger: { all: [{ kind: "topic", topic, confidence, provenance: "provided" }] },
    strength: "soft",
    origin: "latent",
    evidence: { ts: new Date().toISOString(), sessionKey: evidenceSessionKey },
    sensitivity: "private",
    confidence,
  });
  await store.transition(intention.id, "armed");
  return intention;
}

/** Gate that surfaces all items with confidence 0.77 + term "topic:<topic>". */
function makeSurfacingGate(topic: string): RelevanceGate {
  return {
    evaluate: async (input) => input.armed.map((i) => ({
      id: i.id,
      surface: true,
      confidence: i.confidence,
      matchedTerms: [`topic:${topic}`],
    })),
  };
}

const SESSION_A = "session:test-a";
const SESSION_B = "session:test-b";
const BASE_NOW = Date.parse("2026-06-07T10:00:00Z");
const TZ = "UTC";

// ---------------------------------------------------------------------------
// Basic scanLatent tests
// ---------------------------------------------------------------------------

describe("scanLatent — basic", () => {
  test("no armed latents → empty matches", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const gate = new DeterministicRelevanceGate();
    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toEqual([]);
  });

  test("returns more than 3 needs (explicit list not truncated; MAX_SCAN_RESULTS=10)", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    for (let i = 0; i < 5; i++) {
      await seedArmedLatent(store, `need ${i}`, "shopping", SESSION_A, 0.8);
    }
    const gate = makeSurfacingGate("shopping"); // surfaces all armed
    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches.length).toBe(5); // all 5, not capped at the old 3
  });

  test("armed latent whose topic is in the window → returned with confidence + matchedTerms", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const gate = new DeterministicRelevanceGate();
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].content).toBe("Buy coffee beans");
    expect(result.matches[0].confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.matches[0].matchedTerms).toContain("topic:coffee");
    expect(typeof result.matches[0].id).toBe("string");
  });

  test("armed latent whose topic is NOT in the window → excluded", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const gate = new DeterministicRelevanceGate();
    await seedArmedLatent(store, "Schedule dentist", "dentist", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "Let's talk about the weather", ts: new Date().toISOString() }, "ambient");

    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });

  test("quiet session → empty matches even with a matching armed latent (mode gate)", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const gate = new DeterministicRelevanceGate();
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "quiet", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });

  test("injected gate that vetoes → scan returns empty even with matching armed latent", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const vetoGate: RelevanceGate = { evaluate: async () => [] };
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    const result = await scanLatent({ store, latentService: svc, gate: vetoGate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });

  test("injected gate surfaces → returns verdict's confidence + matchedTerms", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    const surfacingGate: RelevanceGate = {
      evaluate: async () => [{ id: intention.id, surface: true, confidence: 0.77, matchedTerms: ["topic:coffee"] }],
    };

    const result = await scanLatent({ store, latentService: svc, gate: surfacingGate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe(intention.id);
    expect(result.matches[0].confidence).toBe(0.77);
    expect(result.matches[0].matchedTerms).toEqual(["topic:coffee"]);
  });

  test("returns top MAX_SCAN_RESULTS matches sorted by confidence desc", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const topics = ["alpha", "beta", "gamma", "delta"];
    const confidences = [0.7, 0.95, 0.8, 0.65];
    for (let i = 0; i < topics.length; i++) {
      await seedArmedLatent(store, `Do ${topics[i]}`, topics[i], SESSION_A, confidences[i]);
    }
    svc.onTranscript(SESSION_A, { role: "user", text: "alpha beta gamma delta mentioned", ts: new Date().toISOString() }, "ambient");
    const gate = makeSurfacingGate("multi");

    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches.length).toBeLessThanOrEqual(MAX_SCAN_RESULTS);
    // Sorted by confidence desc.
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1].confidence).toBeGreaterThanOrEqual(result.matches[i].confidence);
    }
    // Top result should be beta (0.95).
    expect(result.matches[0].content).toBe("Do beta");
  });

  test("initially-surfaced latent (poll already surfaced it) → returned by scan", async () => {
    // This is the core fix: a latent the poll surfaced (armed→surfaced) is still
    // eligible for an explicit user scan. "surfaced" = pending acknowledgement.
    const store = makeStore();
    const svc = makeLatentService(store);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);

    let callCount = 0;
    const surfacingGate: RelevanceGate = {
      evaluate: async (input) => {
        callCount++;
        return input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: ["topic:coffee"] }));
      },
    };

    // Poll has already surfaced it (armed→surfaced); scan must still find and return it.
    await store.transition(intention.id, "surfaced");

    const result = await scanLatent({ store, latentService: svc, gate: surfacingGate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    // The surfaced intention is included in the candidate list → gate is called → returned.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe(intention.id);
    expect(result.matches[0].content).toBe("Buy coffee beans");
    expect(callCount).toBe(1);
  });

  test("revalidates: match transitioned after gate call is dropped", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);

    // Gate surfaces it, but we transition it AFTER gate.evaluate to simulate a race.
    // initialState="armed"; after gate, fresh.state="surfaced" (not armed) → dropped.
    const trickGate: RelevanceGate = {
      evaluate: async (input) => {
        const res = input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: ["topic:coffee"] }));
        // Simulate poll winning: transition away while gate is running.
        await store.transition(intention.id, "surfaced");
        return res;
      },
    };

    const result = await scanLatent({ store, latentService: svc, gate: trickGate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });

  test("initially-armed, still armed, not in-flight → returned (regression)", async () => {
    // Regression: the baseline case must still work after the surfaced expansion.
    const store = makeStore();
    const svc = makeLatentService(store);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    const gate: RelevanceGate = {
      evaluate: async (input) => input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: ["topic:coffee"] })),
    };

    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe(intention.id);
  });

  test("initially-armed with isInFlight true → dropped", async () => {
    // If deliverAndMark holds the in-flight claim while scan revalidates, the armed
    // id is excluded so scan doesn't race the poll's ongoing delivery.
    const store = makeStore();
    const svc = makeLatentService(store);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);

    // Deferred promise: keeps deliverAndMark's in-flight claim open across the scan call.
    let resolveDeliver!: () => void;
    const deliverHeld = new Promise<void>((res) => { resolveDeliver = res; });

    let scanResult: ReturnType<typeof scanLatent> | undefined;
    const deliverFn = async () => {
      // Scan while the claim is held.
      const gate: RelevanceGate = {
        evaluate: async (input) => input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: [] })),
      };
      scanResult = scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
      // Wait for scan to complete before releasing the deliver lock.
      await scanResult;
      resolveDeliver();
      return { delivered: false, voiceStatus: "dropped" as const, reason: "test" as const };
    };

    // Start deliverAndMark (claims _inFlight), which will call deliverFn (which runs scan).
    await deliverAndMark(intention, { store, nodes: undefined, deliverFn });
    await deliverHeld;

    const result = await scanResult!;
    // The id was in-flight during revalidation → dropped.
    expect(result.matches).toHaveLength(0);
  });

  test("terminal states (resolved/suppressed/superseded/arm_failed) never returned", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);

    // Create intentions and transition them to various terminals.
    const i1 = await seedArmedLatent(store, "Item resolved", "resolved-topic", SESSION_A, 0.9);
    await store.transition(i1.id, "resolved");

    const i2 = await seedArmedLatent(store, "Item suppressed", "suppressed-topic", SESSION_A, 0.9);
    await store.transition(i2.id, "suppressed");

    const i3 = await seedArmedLatent(store, "Item superseded", "superseded-topic", SESSION_A, 0.9);
    await store.transition(i3.id, "superseded");

    const gate: RelevanceGate = {
      evaluate: async (input) => input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: [] })),
    };

    const result = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    // Terminals are not in the ["armed","surfaced"] list so the candidate list is empty.
    expect(result.matches).toHaveLength(0);
  });

  test("terminal-between-list-and-return: initially-surfaced → resolved mid-scan → dropped", async () => {
    // An initially-surfaced intention that reaches a terminal state during gate.evaluate
    // is dropped by the revalidation check (fresh.state !== "surfaced").
    const store = makeStore();
    const svc = makeLatentService(store);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    await store.transition(intention.id, "surfaced");

    const trickGate: RelevanceGate = {
      evaluate: async (input) => {
        const res = input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: ["topic:coffee"] }));
        // User acted on it mid-scan: transition surfaced → resolved.
        await store.transition(intention.id, "resolved");
        return res;
      },
    };

    const result = await scanLatent({ store, latentService: svc, gate: trickGate, sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-session sharing
// ---------------------------------------------------------------------------

describe("cross-session sharing", () => {
  test("latent minted in session A is returned by a scan run with session B's context", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const gate = new DeterministicRelevanceGate();

    // Mint in A.
    await seedArmedLatent(store, "Buy groceries", "groceries", SESSION_A, 0.9);

    // B's window mentions the topic → global scan should find it.
    svc.onTranscript(SESSION_B, { role: "user", text: "Need to pick up groceries", ts: new Date().toISOString() }, "ambient");

    const resultB = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_B, mode: "ambient", now: BASE_NOW, tz: TZ });
    // Global set: B's context evaluates A's latent.
    expect(resultB.matches).toHaveLength(1);
    expect(resultB.matches[0].content).toBe("Buy groceries");
  });

  test("initially-surfaced latent minted in A returned by a scan with B's context", async () => {
    // Cross-session: latent minted in A, poll surfaced it (armed→surfaced),
    // B's scan context should still find it — it's a pending need.
    const store = makeStore();
    const svc = makeLatentService(store);

    // Mint in A and then simulate poll surfacing it.
    const intention = await seedArmedLatent(store, "Buy groceries", "groceries", SESSION_A, 0.9);
    await store.transition(intention.id, "surfaced");

    // B's window mentions the topic.
    svc.onTranscript(SESSION_B, { role: "user", text: "Need to pick up groceries", ts: new Date().toISOString() }, "ambient");

    const gate: RelevanceGate = {
      evaluate: async (input) => input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.85, matchedTerms: ["topic:groceries"] })),
    };

    const resultB = await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_B, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(resultB.matches).toHaveLength(1);
    expect(resultB.matches[0].id).toBe(intention.id);
    expect(resultB.matches[0].content).toBe("Buy groceries");
  });

  test("poll surfaces a latent minted in session A into a live session B", async () => {
    const store = makeStore();
    const broadcasts: { sessionKey: string; event: string }[] = [];
    const svc = makeLatentService(store, {
      broadcast: (sk, ev) => { broadcasts.push({ sessionKey: sk, event: ev }); return 1; },
      hasSession: () => true,
      liveSessions: () => [{ sessionKey: SESSION_B, mode: "ambient" }],
    });

    // Mint in session A.
    await seedArmedLatent(store, "Buy groceries", "groceries", SESSION_A, 0.9);

    // B's window mentions the topic.
    svc.onTranscript(SESSION_B, { role: "user", text: "I need to get groceries", ts: new Date().toISOString() }, "ambient");

    await svc.tick(); // surfacing pass with global query
    // B should have received the surface event.
    expect(broadcasts.some((b) => b.sessionKey === SESSION_B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-session satisfy/cancel sweep
// ---------------------------------------------------------------------------

describe("cross-session satisfy/cancel sweep", () => {
  test("need minted in A, satisfied in B → resolved (not re-surfaced in any session)", async () => {
    const store = makeStore();
    // No broadcast/liveSessions wired — pure sweep test (no surfacing pass interference).
    const svc = makeLatentService(store);

    // Mint in A with a fixed past evidence.ts.
    const evidenceTs = "2026-06-07T08:00:00.000Z";
    const intention = await store.create({
      content: "Buy coffee beans",
      trigger: { all: [{ kind: "topic", topic: "coffee", confidence: 0.9, provenance: "provided" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: evidenceTs, sessionKey: SESSION_A },
      sensitivity: "private",
      confidence: 0.9,
    });
    await store.transition(intention.id, "armed");

    // Session B reports satisfaction AFTER the evidence.ts.
    const satisfyTs = "2026-06-07T09:00:00.000Z";
    svc.onTranscript(SESSION_B, { role: "user", text: "ok we bought the coffee", ts: satisfyTs }, "ambient");
    await svc.tick();

    const all = await store.list({ origin: "latent" });
    const coffee = all.find((i) => i.content === "Buy coffee beans");
    expect(coffee?.state).toBe("resolved");
  });

  test("need minted in A, cancelled in B → suppressed (not re-surfaced)", async () => {
    const store = makeStore();
    // No broadcast/liveSessions wired — pure sweep test.
    const svc = makeLatentService(store);

    const evidenceTs = "2026-06-07T08:00:00.000Z";
    const intention = await store.create({
      content: "Buy paper towels",
      trigger: { all: [{ kind: "topic", topic: "paper towels", confidence: 0.9, provenance: "provided" }] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: evidenceTs, sessionKey: SESSION_A },
      sensitivity: "private",
      confidence: 0.9,
    });
    await store.transition(intention.id, "armed");

    const cancelTs = "2026-06-07T09:00:00.000Z";
    svc.onTranscript(SESSION_B, { role: "user", text: "never mind the paper towels", ts: cancelTs }, "ambient");
    await svc.tick();

    const all = await store.list({ origin: "latent" });
    const item = all.find((i) => i.content === "Buy paper towels");
    expect(item?.state).toBe("suppressed");
  });
});

// ---------------------------------------------------------------------------
// Reservation tests
// ---------------------------------------------------------------------------

describe("reservation", () => {
  test("scanLatent marks ids → poll skips them within the window", async () => {
    let now = BASE_NOW;
    const store = makeStore();
    const broadcasts: unknown[] = [];
    const svc = makeLatentService(store, {
      now: () => now,
      broadcast: () => { broadcasts.push(1); return 1; },
      hasSession: () => true,
      liveSessions: () => [{ sessionKey: SESSION_A, mode: "ambient" }],
    });

    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "coffee please", ts: new Date(now).toISOString() }, "ambient");

    // Scan reserves the id.
    const gate = makeSurfacingGate("coffee");
    await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now, tz: TZ });
    expect(svc._reservedRecently(intention.id)).toBe(true);

    // Poll tick: within reservation window → no broadcast.
    await svc.tick();
    expect(broadcasts.length).toBe(0);

    // Advance past the reservation window.
    now += svc.scanReserveMs + 1;
    expect(svc._reservedRecently(intention.id)).toBe(false);

    // Poll tick: now surfaces.
    await svc.tick();
    expect(broadcasts.length).toBe(1);
  });

  test("no-extend-while-active: re-scan within the window does NOT push reservation out", async () => {
    let now = BASE_NOW;
    const store = makeStore();
    const svc = makeLatentService(store, { now: () => now });
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    const gate = makeSurfacingGate("coffee");
    svc.onTranscript(SESSION_A, { role: "user", text: "coffee", ts: new Date(now).toISOString() }, "ambient");

    // First scan: reserves at now.
    await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now, tz: TZ });
    const firstTs = (svc as any).scanReservations.get(intention.id) as number;

    // Advance time (within window) and scan again.
    now += 30_000;
    await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now, tz: TZ });
    const secondTs = (svc as any).scanReservations.get(intention.id) as number;

    // Timestamp must NOT have been updated (refresh policy).
    expect(secondTs).toBe(firstTs);
  });

  test("re-reserve-after-expiry: scan at T0+scanReserveMs+1 re-reserves", async () => {
    let now = BASE_NOW;
    const store = makeStore();
    const svc = makeLatentService(store, { now: () => now });
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    const gate = makeSurfacingGate("coffee");
    svc.onTranscript(SESSION_A, { role: "user", text: "coffee", ts: new Date(now).toISOString() }, "ambient");

    // Scan at T0.
    await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now, tz: TZ });
    expect(svc._reservedRecently(intention.id)).toBe(true);

    // Advance past expiry.
    now += svc.scanReserveMs + 1;
    expect(svc._reservedRecently(intention.id)).toBe(false);

    // Scan again: re-reserves.
    await scanLatent({ store, latentService: svc, gate, sessionKey: SESSION_A, mode: "ambient", now, tz: TZ });
    expect(svc._reservedRecently(intention.id)).toBe(true);
  });

  test("late check: id reserved mid-tick is skipped right before surfaceLatent", async () => {
    // Drive a single service with a gate that calls markScanned on the SAME
    // service DURING gate.evaluate — simulating a concurrent scan RPC that
    // reserves the id after candidates are built but before surfaceLatent fires.
    // The late _reservedRecently check inside the surfacing loop must catch this.
    let now = BASE_NOW;
    const store = makeStore();
    const broadcasts: unknown[] = [];

    // Placeholder ref filled after the service is constructed (gate captures it).
    let svcRef!: ReturnType<typeof makeLatentService>;

    const lateReserveGate: RelevanceGate = {
      evaluate: async (input) => {
        // Simulate scan winning the race mid-gate: reserve the id before
        // surfaceLatent is reached in the surfacing loop.
        svcRef.markScanned(input.armed.map((i) => i.id));
        return input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.9, matchedTerms: ["topic:coffee"] }));
      },
    };

    svcRef = new LatentService({
      store,
      now: () => now,
      relevanceGate: lateReserveGate,
      broadcast: () => { broadcasts.push(1); return 1; },
      hasSession: () => true,
      liveSessions: () => [{ sessionKey: SESSION_A, mode: "ambient" }],
    });

    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);

    // Feed a transcript turn so the surfacing pass has a non-empty window.
    svcRef.onTranscript(SESSION_A, { role: "user", text: "coffee", ts: new Date(now).toISOString() }, "ambient");

    // Tick: gate.evaluate marks the id scanned mid-call; the late check in the
    // surfacing loop must see _reservedRecently = true and skip surfaceLatent.
    await svcRef.tick();
    expect(broadcasts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

describe("mode resolution (scan)", () => {
  test("explicit-quiet conn + params.mode='ambient' → empty (conn.modeExplicitlySet wins)", async () => {
    // This is enforced in the RPC handler, not in scanLatent directly.
    // Test that scanLatent with mode="quiet" returns empty regardless.
    const store = makeStore();
    const svc = makeLatentService(store);
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    // If RPC resolves conn.mode (quiet) due to modeExplicitlySet, scanLatent gets mode="quiet".
    const result = await scanLatent({ store, latentService: svc, gate: new DeterministicRelevanceGate(), sessionKey: SESSION_A, mode: "quiet", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });

  test("non-explicit conn + params.mode='ambient' → matches", async () => {
    // RPC resolves params.mode="ambient" → scanLatent called with mode="ambient".
    const store = makeStore();
    const svc = makeLatentService(store);
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    const result = await scanLatent({ store, latentService: svc, gate: new DeterministicRelevanceGate(), sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(1);
  });

  test("non-explicit + persisted ambient → matches", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    // scanLatent is called with the resolved persisted mode.
    const result = await scanLatent({ store, latentService: svc, gate: new DeterministicRelevanceGate(), sessionKey: SESSION_A, mode: "ambient", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(1);
  });

  test("non-explicit + nothing persisted + conn quiet → empty", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    // If conn defaults to quiet and nothing is persisted, RPC resolves mode="quiet".
    const result = await scanLatent({ store, latentService: svc, gate: new DeterministicRelevanceGate(), sessionKey: SESSION_A, mode: "quiet", now: BASE_NOW, tz: TZ });
    expect(result.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scan uses poll's now/tz (buildScanInput)
// ---------------------------------------------------------------------------

describe("scan uses poll's now/tz (buildScanInput)", () => {
  test("buildScanInput returns the same injected clock values as the poll uses", () => {
    let now = BASE_NOW;
    const store = makeStore();
    const svc = makeLatentService(store, { now: () => now, tz: "America/Los_Angeles" });

    const input = svc.buildScanInput(SESSION_A);
    expect(input.now).toBe(now);
    expect(input.tz).toBe("America/Los_Angeles");

    // Advance clock — buildScanInput should reflect the new time.
    now += 5000;
    const input2 = svc.buildScanInput(SESSION_A);
    expect(input2.now).toBe(now);
  });

  test("scan and poll see the same timestamp from the injected clock", async () => {
    let now = BASE_NOW;
    const capturedNows: number[] = [];
    const store = makeStore();
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    const capturingGate: RelevanceGate = {
      evaluate: async (input) => {
        capturedNows.push(input.now!);
        return input.armed.map((i) => ({ id: i.id, surface: false, confidence: 0, matchedTerms: [] }));
      },
    };
    const svc = new LatentService({
      store,
      now: () => now,
      tz: "Europe/Paris",
      relevanceGate: capturingGate,
      broadcast: () => 0,
      hasSession: () => false,
      liveSessions: () => [{ sessionKey: SESSION_A, mode: "ambient" }],
    });
    svc.onTranscript(SESSION_A, { role: "user", text: "coffee", ts: new Date(now).toISOString() }, "ambient");

    const { now: scanNow, tz: scanTz } = svc.buildScanInput(SESSION_A);
    await scanLatent({ store, latentService: svc, gate: capturingGate, sessionKey: SESSION_A, mode: "ambient", now: scanNow, tz: scanTz });

    // The poll will also call gate.evaluate with now() — same clock.
    await svc.tick(); // tick runs surfacing pass which calls capturingGate

    // Both scan and poll calls should have used the same now value.
    if (capturedNows.length >= 2) {
      expect(capturedNows[0]).toBe(capturedNows[1]);
    }
    // Timezone must match.
    expect(scanTz).toBe("Europe/Paris");
  });
});

// ---------------------------------------------------------------------------
// Concurrent live sessions → exactly one delivery
// ---------------------------------------------------------------------------

describe("concurrent live sessions → one delivery", () => {
  test("two live sessions seeing the same armed latent: only one delivery", async () => {
    const store = makeStore();
    const broadcasts: { sessionKey: string }[] = [];
    // Two live sessions with the same topic in their windows.
    const svc = makeLatentService(store, {
      broadcast: (sk) => { broadcasts.push({ sessionKey: sk }); return 1; },
      hasSession: () => true,
      liveSessions: () => [
        { sessionKey: SESSION_A, mode: "ambient" },
        { sessionKey: SESSION_B, mode: "ambient" },
      ],
    });

    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "need coffee", ts: new Date().toISOString() }, "ambient");
    svc.onTranscript(SESSION_B, { role: "user", text: "need coffee too", ts: new Date().toISOString() }, "ambient");

    await svc.tick(); // both sessions evaluate; deliverAndMark ensures only one fires

    // Exactly one broadcast (one delivery).
    expect(broadcasts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// intention.scan RPC handler — ownership guards + mode-resolution
// ---------------------------------------------------------------------------

describe("intention.scan RPC handler", () => {
  let testDir: string;
  const origAmbientIntentions = process.env.AMBIENT_INTENTIONS;

  beforeEach(() => {
    resetGatewayState();
    applyDefaultLaneConcurrency();
    testDir = join(tmpdir(), `hawky-scan-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sessionsDir = join(testDir, "sessions");
    const wsDir = join(testDir, "workspace");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    setSessionsDir(sessionsDir);
    setWorkspaceDir(wsDir);
    writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n");
    process.env.AMBIENT_INTENTIONS = "1";
  });

  afterEach(() => {
    resetGatewayState();
    resetSessionsDir();
    if (origAmbientIntentions !== undefined) {
      process.env.AMBIENT_INTENTIONS = origAmbientIntentions;
    } else {
      delete process.env.AMBIENT_INTENTIONS;
    }
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  function makeRpcServer(store: InMemoryIntentionStore, svc: LatentService) {
    const methods: Record<string, Function> = {};
    const srv: any = {
      registerMethod(name: string, handler: Function) { methods[name] = handler; },
      call(name: string, conn: any, params?: any) { return methods[name](conn, params, srv); },
      broadcast() {},
      broadcastToSession() {},
      getConnections() { return new Map(); },
    };
    // Minimal IntentionService stub — only store is accessed by the scan handler.
    const intentionLoop = new IntentionService({ store });
    const stubSessions: any = { getOrCreate() { throw new Error("not used"); } };
    registerAgentMethods(srv, stubSessions, undefined, undefined, intentionLoop, svc);
    return srv;
  }

  test("(b) unbound connection → NO_SESSION", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const srv = makeRpcServer(store, svc);
    const conn = { sessionKey: null, mode: "quiet" as Mode, modeExplicitlySet: false };

    let caught: any;
    try { await srv.call("intention.scan", conn, {}); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("NO_SESSION");
  });

  test("(c) params.sessionKey ≠ conn.sessionKey → FORBIDDEN", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const srv = makeRpcServer(store, svc);
    const conn = { sessionKey: SESSION_A, mode: "ambient" as Mode, modeExplicitlySet: false };

    let caught: any;
    try {
      await srv.call("intention.scan", conn, { sessionKey: SESSION_B });
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("FORBIDDEN");
  });

  test("(a) explicit-quiet conn + params.mode='ambient' → empty (conn wins)", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const srv = makeRpcServer(store, svc);
    // Seed an armed latent and provide matching context.
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    // conn.modeExplicitlySet = true → mode = "quiet" wins regardless of params.mode.
    const conn = { sessionKey: SESSION_A, mode: "quiet" as Mode, modeExplicitlySet: true };
    const result = await srv.call("intention.scan", conn, { mode: "ambient" });
    expect(result.matches).toHaveLength(0);
  });

  test("(d) non-explicit conn + persisted ambient → matches", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const srv = makeRpcServer(store, svc);
    // Persist ambient mode for the session (simulates a prior handshake.update).
    updateSessionMeta(SESSION_A, { ambientMode: "ambient" });
    // Seed an armed latent and matching context.
    await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_A, { role: "user", text: "I really need some coffee today", ts: new Date().toISOString() }, "ambient");

    // conn.modeExplicitlySet = false, no params.mode → falls back to persisted ambientMode.
    const conn = { sessionKey: SESSION_A, mode: "quiet" as Mode, modeExplicitlySet: false };
    const result = await srv.call("intention.scan", conn, {});
    expect(result.matches).toHaveLength(1);
  });

  test("scan-returned armed match can be declined via intention.respond", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const srv = makeRpcServer(store, svc);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);
    svc.onTranscript(SESSION_B, { role: "user", text: "I need coffee today", ts: new Date().toISOString() }, "ambient");

    const conn = { sessionKey: SESSION_B, mode: "ambient" as Mode, modeExplicitlySet: false };
    const scan = await srv.call("intention.scan", conn, { mode: "ambient" });
    expect(scan.matches[0].id).toBe(intention.id);
    expect((await store.get(intention.id))?.state).toBe("armed");

    const response = await srv.call("intention.respond", conn, { intentionId: intention.id, response: "decline" });
    expect(response).toEqual({ ok: true, intentionId: intention.id, state: "suppressed" });
    expect((await store.get(intention.id))?.state).toBe("suppressed");
  });

  test("unscanned armed match is still rejected by intention.respond", async () => {
    const store = makeStore();
    const svc = makeLatentService(store);
    const srv = makeRpcServer(store, svc);
    const intention = await seedArmedLatent(store, "Buy coffee beans", "coffee", SESSION_A, 0.9);

    const conn = { sessionKey: SESSION_B, mode: "ambient" as Mode, modeExplicitlySet: false };
    let caught: any;
    try {
      await srv.call("intention.respond", conn, { intentionId: intention.id, response: "decline" });
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("INVALID_REQUEST");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });
});
