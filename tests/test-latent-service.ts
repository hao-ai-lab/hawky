// =============================================================================
// Test: LatentService (M8 §3.2, §9 H1)
// Run: bun test tests/test-latent-service.ts
// Covers: tick-based heartbeat loop; dirty/clean tracking; Ambient → stored+armed;
//   Quiet → nothing; dedup; mode propagation; suppress; obvious-blocks-latent.
// Uses tick() / flush() directly (no real timers, no debounce).
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { LatentService } from "../src/ambient/latent-service.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a LatentService with a controllable clock. No timer injection needed. */
function makeService(storeOpts?: { store?: InMemoryIntentionStore }) {
  const store = storeOpts?.store ?? new InMemoryIntentionStore();
  let now = Date.parse("2026-06-06T10:00:00Z");

  const service = new LatentService({
    store,
    now: () => now,
    tz: "America/Los_Angeles",
  });

  function advanceClock(ms: number) {
    now += ms;
  }

  return { service, store, advanceClock };
}

const TS = "2026-06-06T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Tick-based: dirty ambient session mints
// ---------------------------------------------------------------------------

describe("LatentService — tick() mints for dirty ambient sessions", () => {
  test("append ambient turn → tick() → latent intention stored and armed", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-1", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await service.tick();

    const all = await store.list();
    expect(all.length).toBeGreaterThanOrEqual(1);

    const coffee = all.find((i) => i.content === "buy coffee");
    expect(coffee).toBeDefined();
    expect(coffee!.state).toBe("armed");
    expect(coffee!.origin).toBe("latent");
    expect(coffee!.strength).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// Tick-based: quiet session does not mint
// ---------------------------------------------------------------------------

describe("LatentService — tick() skips quiet sessions without minting", () => {
  test("append quiet turn → tick() → no latent intention stored", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-q", { role: "user", text: "we're out of coffee", ts: TS }, "quiet");
    await service.tick();

    const all = await store.list();
    expect(all.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tick-based: no new turns since last tick → session not re-recognized
// ---------------------------------------------------------------------------

describe("LatentService — tick() skips sessions with no new turns (not dirty)", () => {
  test("tick once → tick again with no new turns → recognizer not called a second time", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-nd", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");

    // First tick: dirty → runs recognition.
    await service.tick();
    const countAfterFirstTick = (await store.list()).length;
    expect(countAfterFirstTick).toBeGreaterThanOrEqual(1);

    // Second tick: NOT dirty (no new turns) → no recognition, store unchanged.
    await service.tick();
    const countAfterSecondTick = (await store.list()).length;
    // Store count should not grow (no new intentions minted).
    expect(countAfterSecondTick).toBe(countAfterFirstTick);
  });
});

// ---------------------------------------------------------------------------
// Tick-based: multiple sessions in one tick
// ---------------------------------------------------------------------------

describe("LatentService — tick() processes multiple sessions in one pass", () => {
  test("two dirty ambient sessions → both recognized in one tick", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-a", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    service.onTranscript("sess-b", { role: "user", text: "we need milk", ts: TS }, "ambient");

    await service.tick();

    const all = await store.list();
    expect(all.find((i) => i.content === "buy coffee")).toBeDefined();
    expect(all.find((i) => i.content === "buy milk")).toBeDefined();
  });

  test("ambient + quiet sessions in one tick → only ambient mints", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-amb", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    service.onTranscript("sess-qui", { role: "user", text: "we need milk", ts: TS }, "quiet");

    await service.tick();

    const all = await store.list();
    expect(all.find((i) => i.content === "buy coffee")).toBeDefined();
    // milk must NOT be minted (quiet session)
    expect(all.find((i) => i.content === "buy milk")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// flush() test seam: append → flush() → recognition settled (no timers needed)
// ---------------------------------------------------------------------------

describe("LatentService — flush() test seam works for single session", () => {
  test("ambient mode: flush() drives recognition synchronously", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-f", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await service.flush("sess-f");

    const all = await store.list();
    expect(all.find((i) => i.content === "buy coffee")).toBeDefined();
  });

  test("quiet mode: flush() does not mint", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-fq", { role: "user", text: "we're out of coffee", ts: TS }, "quiet");
    await service.flush("sess-fq");

    const all = await store.list();
    expect(all.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dedup: repeated transcript doesn't create duplicate
// ---------------------------------------------------------------------------

describe("LatentService — dedup across repeated transcripts", () => {
  test("same content twice → only one latent intention", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-d", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await service.flush("sess-d");

    // Second call with slightly newer ts
    const TS2 = "2026-06-06T10:01:00.000Z";
    service.onTranscript("sess-d", { role: "user", text: "we're out of coffee", ts: TS2 }, "ambient");
    await service.flush("sess-d");

    const all = await store.list();
    const coffeeItems = all.filter((i) => i.content === "buy coffee" && i.state !== "superseded");
    // At most 1 active buy-coffee intention (older may be superseded, newer created).
    expect(coffeeItems.length).toBeLessThanOrEqual(1);
    // At least one should exist in some state.
    const anyActive = all.filter((i) => i.content === "buy coffee" && (i.state === "armed" || i.state === "pending_arm"));
    expect(anyActive.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mode propagation: directive mode also mints; quiet does not
// ---------------------------------------------------------------------------

describe("LatentService — mode propagation", () => {
  test("directive mode mints latent intention", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-dir", { role: "user", text: "we need more milk", ts: TS }, "directive");
    await service.flush("sess-dir");

    const all = await store.list();
    const milk = all.find((i) => i.content === "buy milk");
    expect(milk).toBeDefined();
    expect(milk!.state).toBe("armed");
  });

  test("quiet mode connection does not mint", async () => {
    const store = new InMemoryIntentionStore();
    const { service } = makeService({ store });

    service.onTranscript("sess-quiet2", { role: "user", text: "we need more milk", ts: TS }, "quiet");
    await service.flush("sess-quiet2");

    const all = await store.list();
    expect(all.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative corpus: questions and hypotheticals not minted in ambient
// ---------------------------------------------------------------------------

describe("LatentService — negative corpus not minted in ambient", () => {
  test("question 'do we need coffee?' → nothing stored", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-neg", { role: "user", text: "do we need coffee?", ts: TS }, "ambient");
    await service.flush("sess-neg");

    const all = await store.list();
    expect(all.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix M8 #1: suppress() method — suppression survives prune
// ---------------------------------------------------------------------------

describe("LatentService — suppress() blocks future mints", () => {
  test("suppress(content) prevents re-minting even after store is pruned", async () => {
    const { service, store } = makeService();

    // First mint
    service.onTranscript("sess-sup", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await service.flush("sess-sup");
    const before = await store.list();
    expect(before.find((i) => i.content === "buy coffee")).toBeDefined();

    // Suppress + prune (simulates what happens when user declines)
    service.suppress("buy coffee");
    await store.prune?.(["armed", "pending_arm", "suppressed"]);

    // Second transcript with newer ts — should NOT mint
    const TS2 = "2026-06-06T11:00:00.000Z";
    service.onTranscript("sess-sup", { role: "user", text: "we're out of coffee", ts: TS2 }, "ambient");
    await service.flush("sess-sup");

    const after = await store.list();
    const active = after.filter((i) => i.content === "buy coffee" && i.state !== "superseded");
    expect(active).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix M8 #3: obvious-origin active intentions block latent mints
// ---------------------------------------------------------------------------

describe("LatentService — obvious-origin active blocks latent mint", () => {
  test("existing obvious-armed intention prevents latent duplicate", async () => {
    const store = new InMemoryIntentionStore();

    // Pre-seed an obvious-origin armed intention
    await store.create({
      content: "buy coffee",
      trigger: {},
      strength: "hard",
      origin: "obvious",
      state: "armed",
      evidence: { ts: TS },
      sensitivity: "private",
    });

    const { service } = makeService({ store });

    service.onTranscript("sess-ob", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await service.flush("sess-ob");

    const all = await store.list();
    const latentCoffee = all.filter((i) => i.content === "buy coffee" && i.origin === "latent");
    expect(latentCoffee).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix M8 #10 (Test 10): transcript.append RPC path → mode-dependent minting
// Tests that LatentService.onTranscript correctly gate-mints on Ambient vs Quiet
// (full gateway integration is in agent-methods; here we verify the service layer)
// ---------------------------------------------------------------------------

describe("LatentService — onTranscript respects conn.mode (gateway RPC path)", () => {
  test("ambient mode → latent intention minted", async () => {
    const { service, store } = makeService();
    service.onTranscript("sess-rpc-a", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    await service.flush("sess-rpc-a");
    const all = await store.list();
    expect(all.find((i) => i.content === "buy coffee" && i.origin === "latent")).toBeDefined();
  });

  test("quiet mode → nothing minted (RPC with conn.mode=quiet)", async () => {
    const { service, store } = makeService();
    service.onTranscript("sess-rpc-q", { role: "user", text: "we're out of coffee", ts: TS }, "quiet");
    await service.flush("sess-rpc-q");
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  test("directive mode → latent intention minted", async () => {
    const { service, store } = makeService();
    service.onTranscript("sess-rpc-d", { role: "user", text: "we need more milk", ts: TS }, "directive");
    await service.flush("sess-rpc-d");
    const all = await store.list();
    expect(all.find((i) => i.content === "buy milk" && i.origin === "latent")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mode recorded at last onTranscript: mode update before tick takes effect
// ---------------------------------------------------------------------------

describe("LatentService — last recorded mode is used at tick time", () => {
  test("ambient turn then quiet turn: session recorded as quiet, tick does not mint", async () => {
    const { service, store } = makeService();

    // First turn ambient — marks dirty.
    service.onTranscript("sess-modeupdate", { role: "user", text: "we're out of coffee", ts: TS }, "ambient");
    // Second turn quiet — updates recorded mode to quiet (still dirty).
    service.onTranscript("sess-modeupdate", { role: "user", text: "never mind", ts: TS }, "quiet");

    // Tick: session is dirty but mode is quiet → no recognition.
    await service.tick();
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  test("ambient then quiet then ambient again: last mode is ambient, tick mints", async () => {
    const { service, store } = makeService();

    service.onTranscript("sess-modeupdate2", { role: "user", text: "ok the pantry is fine", ts: TS }, "ambient");
    service.onTranscript("sess-modeupdate2", { role: "user", text: "ok", ts: TS }, "quiet");
    service.onTranscript("sess-modeupdate2", { role: "user", text: "we need milk", ts: TS }, "ambient");

    await service.tick();

    const all = await store.list();
    expect(all.find((i) => i.content === "buy milk")).toBeDefined();
  });
});
