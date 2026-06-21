// =============================================================================
// test-surface-poll.ts — M9 stage 9c-2: the surfacing poll (two-pass tick).
//   - an armed latent surfaces (cautious) when its topic is in the live window
//   - a need minted THIS tick is not echoed back the same tick
//   - surface-once: a second poll does not re-surface
//   - a quiet live session is not surfaced (mode gate via liveSessions)
//   - no surfacing deps wired → poll is a no-op (pure recognition)
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { LatentService } from "../src/ambient/latent-service.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { _resetSatisfiedTerms } from "../src/ambient/fire.js";
import { _resetReEmitGuard } from "../src/ambient/delivery-service.js";
import type { Mode } from "../src/ambient/modes.js";

beforeEach(() => {
  _resetSatisfiedTerms();
  _resetReEmitGuard();
});

const TS = "2026-06-06T10:00:00Z";
const turn = (text: string) => ({ role: "user" as const, text, ts: TS });

function makeSvc(live: () => { sessionKey: string; mode: Mode }[]) {
  const store = new InMemoryIntentionStore();
  const broadcasts: { sessionKey: string; event: string; payload: any }[] = [];
  const svc = new LatentService({
    store,
    broadcast: (sessionKey, event, payload) => {
      broadcasts.push({ sessionKey, event, payload });
      return 1;
    },
    hasSession: () => true,
    liveSessions: live,
  });
  return { svc, store, broadcasts };
}

describe("M9 9c-2 surfacing poll", () => {
  test("armed latent surfaces (cautious) when its topic is in the live window", async () => {
    const { svc, store, broadcasts } = makeSvc(() => [{ sessionKey: "s1", mode: "ambient" }]);
    svc.onTranscript("s1", turn("we're out of coffee"), "ambient");
    await svc.tick(); // mint + arm; NOT surfaced the same tick
    expect(broadcasts.length).toBe(0);
    const coffee = (await store.list({ origin: "latent", state: "armed", sessionKey: "s1" }))[0];
    expect(coffee).toBeDefined();

    await svc.tick(); // surfacing pass: topic "coffee" still in window → surface
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].event).toBe("agent.intention_surface");
    expect(broadcasts[0].payload.cautious).toBe(true); // latent → cautious channel
    expect((await store.get(coffee.id))!.state).toBe("surfaced");
  });

  test("does not echo a need minted in the same tick", async () => {
    const { svc, broadcasts } = makeSvc(() => [{ sessionKey: "s2", mode: "ambient" }]);
    svc.onTranscript("s2", turn("we need more dish soap"), "ambient");
    await svc.tick(); // mint+arm AND surfacing run in the same tick → skipped
    expect(broadcasts.length).toBe(0);
  });

  test("surface-once: a second poll does not re-surface", async () => {
    const { svc, broadcasts } = makeSvc(() => [{ sessionKey: "s3", mode: "ambient" }]);
    svc.onTranscript("s3", turn("we're out of milk"), "ambient");
    await svc.tick();
    await svc.tick(); // surfaces
    expect(broadcasts.length).toBe(1);
    await svc.tick(); // now surfaced (not armed) → no re-surface
    expect(broadcasts.length).toBe(1);
  });

  test("a quiet live session is not surfaced (mode gate via liveSessions)", async () => {
    const { svc, broadcasts } = makeSvc(() => [{ sessionKey: "s4", mode: "quiet" }]);
    svc.onTranscript("s4", turn("we're out of tea"), "ambient"); // recognized under ambient
    await svc.tick();
    await svc.tick(); // live connection is quiet → surfacing skips
    expect(broadcasts.length).toBe(0);
  });

  test("no surfacing deps wired → poll is a no-op (pure recognition)", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store }); // no broadcast/hasSession/liveSessions
    svc.onTranscript("s5", turn("we're out of sugar"), "ambient");
    await svc.tick();
    await svc.tick();
    const armed = await store.list({ origin: "latent", state: "armed", sessionKey: "s5" });
    expect(armed.length).toBe(1); // armed but never surfaced
  });
});

describe("M11 — surfacing pass uses the injected relevance gate", () => {
  test("gate veto → nothing surfaces (even when the deterministic matcher would)", async () => {
    const store = new InMemoryIntentionStore();
    const broadcasts: { sessionKey: string; event: string; payload: any }[] = [];
    const svc = new LatentService({
      store,
      broadcast: (sessionKey, event, payload) => { broadcasts.push({ sessionKey, event, payload }); return 1; },
      hasSession: () => true,
      liveSessions: () => [{ sessionKey: "sg1", mode: "ambient" }],
      relevanceGate: { evaluate: async () => [] }, // LLM gate vetoes everything
    });
    svc.onTranscript("sg1", turn("we're out of coffee"), "ambient");
    await svc.tick(); // mint + arm
    await svc.tick(); // surfacing pass → gate vetoes
    expect(broadcasts.length).toBe(0);
  });

  test("gate surfaces → cautious broadcast + state surfaced", async () => {
    const store = new InMemoryIntentionStore();
    const broadcasts: { sessionKey: string; event: string; payload: any }[] = [];
    const svc = new LatentService({
      store,
      broadcast: (sessionKey, event, payload) => { broadcasts.push({ sessionKey, event, payload }); return 1; },
      hasSession: () => true,
      liveSessions: () => [{ sessionKey: "sg2", mode: "ambient" }],
      relevanceGate: {
        evaluate: async (input) =>
          input.armed.map((i) => ({ id: i.id, surface: true, confidence: 0.95, matchedTerms: ["topic:coffee"] })),
      },
    });
    svc.onTranscript("sg2", turn("we're out of coffee"), "ambient");
    await svc.tick();
    await svc.tick();
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].payload.cautious).toBe(true);
    expect((await store.list({ origin: "latent", sessionKey: "sg2" }))[0].state).toBe("surfaced");
  });
});
