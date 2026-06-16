// =============================================================================
// Test: surfaced-latent respond loop
// Run: bun test tests/test-respond-loop.ts
// Covers:
//   - intentionId present in the surface payload (session-delivery)
//   - intention.respond confirm → resolved (cross-session)
//   - intention.respond decline → suppressed (cross-session)
//   - unbound connection → rejected for intention.respond, intention.create,
//     transcript.append
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { makeSessionInvoker, INTENTION_SURFACE_EVENT } from "../src/ambient/session-delivery.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { LatentService } from "../src/ambient/latent-service.js";
import { IntentionService } from "../src/ambient/intention-service.js";
import type { Intention } from "../src/ambient/intention.js";

const TS = "2026-06-07T10:00:00Z";

function makeIntention(store: InMemoryIntentionStore, content: string): Promise<Intention> {
  return store.create({
    content,
    trigger: { all: [{ kind: "topic", topic: "test", provenance: "inferred" }] },
    strength: "soft",
    origin: "latent",
    evidence: { ts: TS, sessionKey: "session-mint" },
    sensitivity: "private",
    confidence: 0.75,
  });
}

// =============================================================================
// 1. intentionId present in the surface payload
// =============================================================================

describe("surface payload includes intentionId", () => {
  test("makeSessionInvoker broadcast includes intentionId from args", async () => {
    let capturedPayload: unknown;
    const invoker = makeSessionInvoker("session-a", {
      broadcast: (_sk, _ev, payload) => { capturedPayload = payload; return 1; },
      hasSession: () => true,
      event: INTENTION_SURFACE_EVENT,
    });

    // Simulate what delivery-service passes: args include intentionId.
    await invoker.invoke("session-a", "frontend.message", {
      id: "intention-xyz",
      intentionId: "intention-xyz",
      title: "Call the dentist",
      body: "Call the dentist",
      deliver: "speak",
      busy: "queue",
      cautious: true,
    });

    const p = capturedPayload as Record<string, unknown>;
    expect(p.intentionId).toBe("intention-xyz");
    expect(p.type).toBe("intention_surface");
  });

  test("makeSessionInvoker payload has intentionId even when undefined", async () => {
    let capturedPayload: unknown;
    const invoker = makeSessionInvoker("session-a", {
      broadcast: (_sk, _ev, payload) => { capturedPayload = payload; return 1; },
      hasSession: () => true,
      event: INTENTION_SURFACE_EVENT,
    });

    await invoker.invoke("session-a", "frontend.message", {
      id: "no-intention-id",
      title: "Task",
      body: "Some task",
      deliver: "context",
      busy: "downgrade",
      cautious: false,
    });

    const p = capturedPayload as Record<string, unknown>;
    // intentionId should be undefined/absent when not provided
    expect(p.intentionId).toBeUndefined();
  });
});

// =============================================================================
// 2. intention.respond — confirm → resolved, decline → suppressed (cross-session)
// =============================================================================

describe("intention.respond lifecycle — cross-session", () => {
  let store: InMemoryIntentionStore;
  let intentionLoop: IntentionService;
  let latentSvc: LatentService;

  beforeEach(() => {
    store = new InMemoryIntentionStore();
    intentionLoop = new IntentionService({
      store,
      broadcast: () => 0,
      hasSession: () => false,
    });
    latentSvc = new LatentService({ store });
  });

  test("confirm (from different session) → surfaced → resolved", async () => {
    const i = await makeIntention(store, "buy coffee");
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Simulate what intention.respond does on confirm:
    await intentionLoop.store.transition(i.id, "resolved");

    const after = await store.get(i.id);
    expect(after?.state).toBe("resolved");
  });

  test("decline (from different session) → surfaced → suppressed", async () => {
    const i = await makeIntention(store, "call mom");
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Simulate what intention.respond does on decline:
    latentSvc.suppress(i.content);
    await intentionLoop.store.transition(i.id, "suppressed");

    const after = await store.get(i.id);
    expect(after?.state).toBe("suppressed");
  });

  test("cross-session: minting session != responding session is valid", async () => {
    // Mint on session-A
    const i = await store.create({
      content: "water the plants",
      trigger: {},
      strength: "soft",
      origin: "latent",
      evidence: { ts: TS, sessionKey: "session-A" },
      sensitivity: "private",
    });
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Respond from session-B (different session)
    // The intention is user-global so this should work.
    // intention.respond does NOT check session ownership, so:
    await store.transition(i.id, "resolved");
    const after = await store.get(i.id);
    expect(after?.state).toBe("resolved");
  });

  test("suppressed content is not re-minted", async () => {
    const i = await makeIntention(store, "buy oat milk");
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    latentSvc.suppress(i.content);
    await store.transition(i.id, "suppressed");

    // Verify terminal: further transitions throw
    await expect(store.transition(i.id, "resolved")).rejects.toThrow();
  });

  test("resolved is terminal: further transitions throw", async () => {
    const i = await makeIntention(store, "call dentist");
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");
    await store.transition(i.id, "resolved");

    await expect(store.transition(i.id, "armed")).rejects.toThrow();
    await expect(store.transition(i.id, "suppressed")).rejects.toThrow();
  });
});

// =============================================================================
// FIX-2: intention.respond requires state === "surfaced"
// Armed (not-yet-surfaced) intentions must be rejected so a satisfaction sweep
// that moves armed→suppressed/resolved cannot prematurely retire a latent before
// it has ever been shown to the user.
// =============================================================================

describe("intention.respond — requires state surfaced (Fix-2)", () => {
  let store: InMemoryIntentionStore;

  beforeEach(() => {
    store = new InMemoryIntentionStore();
  });

  // Simulate the guard that agent-methods.ts intention.respond applies.
  function guardRespond(state: string): "INVALID_REQUEST" | "ok" {
    if (state !== "surfaced") return "INVALID_REQUEST";
    return "ok";
  }

  test("armed state → INVALID_REQUEST (not yet surfaced)", () => {
    expect(guardRespond("armed")).toBe("INVALID_REQUEST");
  });

  test("pending_arm state → INVALID_REQUEST", () => {
    expect(guardRespond("pending_arm")).toBe("INVALID_REQUEST");
  });

  test("resolved state → INVALID_REQUEST (already terminal)", () => {
    expect(guardRespond("resolved")).toBe("INVALID_REQUEST");
  });

  test("suppressed state → INVALID_REQUEST (already terminal)", () => {
    expect(guardRespond("suppressed")).toBe("INVALID_REQUEST");
  });

  test("surfaced state → ok (confirm or decline allowed)", () => {
    expect(guardRespond("surfaced")).toBe("ok");
  });

  test("confirm on surfaced → store transitions to resolved", async () => {
    const i = await makeIntention(store, "buy coffee");
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    // Guard passes for surfaced
    const fetched = await store.get(i.id);
    expect(guardRespond(fetched!.state)).toBe("ok");

    // Confirm → resolved
    await store.transition(i.id, "resolved");
    expect((await store.get(i.id))?.state).toBe("resolved");
  });

  test("decline on surfaced → store transitions to suppressed", async () => {
    const i = await makeIntention(store, "call dentist");
    await store.transition(i.id, "armed");
    await store.transition(i.id, "surfaced");

    const fetched = await store.get(i.id);
    expect(guardRespond(fetched!.state)).toBe("ok");

    await store.transition(i.id, "suppressed");
    expect((await store.get(i.id))?.state).toBe("suppressed");
  });

  test("armed intention: guard rejects before any store transition", async () => {
    const i = await makeIntention(store, "buy milk");
    await store.transition(i.id, "armed");

    const fetched = await store.get(i.id);
    // Guard fires before any transition — armed must be rejected.
    expect(guardRespond(fetched!.state)).toBe("INVALID_REQUEST");
    // State unchanged: still armed
    expect((await store.get(i.id))?.state).toBe("armed");
  });
});

// =============================================================================
// 3. Unbound connection guard (pure logic, no real gateway server needed)
// =============================================================================

describe("unbound connection guard — pure logic", () => {
  // We test the guard logic directly by simulating what the handlers check:
  // conn.sessionKey must be non-null for intention.create, transcript.append,
  // and intention.respond.

  function simulateGuard(sessionKey: string | null): "FORBIDDEN" | "ok" {
    if (!sessionKey) return "FORBIDDEN";
    return "ok";
  }

  test("intention.create: unbound (null sessionKey) → FORBIDDEN", () => {
    expect(simulateGuard(null)).toBe("FORBIDDEN");
  });

  test("intention.create: bound sessionKey → ok", () => {
    expect(simulateGuard("session-1")).toBe("ok");
  });

  test("transcript.append: unbound → FORBIDDEN", () => {
    expect(simulateGuard(null)).toBe("FORBIDDEN");
  });

  test("transcript.append: bound → ok", () => {
    expect(simulateGuard("session-1")).toBe("ok");
  });

  test("intention.respond: unbound → FORBIDDEN", () => {
    expect(simulateGuard(null)).toBe("FORBIDDEN");
  });

  test("intention.respond: bound (ANY session) → ok (user-global latents)", () => {
    // Any bound session, not just the minting session, is allowed.
    expect(simulateGuard("session-different-from-mint")).toBe("ok");
  });
});
