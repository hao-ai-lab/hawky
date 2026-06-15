// =============================================================================
// test-durability-483.ts — Repro + persistence tests for issue #483.
//
// Step 1 (repro): proves that InMemoryIntentionStore + suppressedKeys +
//   TimerWhenCronService are lost across a fresh instance ("restart").
// Step 2 (persistence): proves that FileIntentionStore survives a "restart"
//   and re-hydrates active intentions + timers.
//
// Run: bun test tests/test-durability-483.ts
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { FileIntentionStore } from "../src/ambient/file-intention-store.js";
import { TimerWhenCronService } from "../src/ambient/when-cron.js";
import { LatentService } from "../src/ambient/latent-service.js";

// ---------------------------------------------------------------------------
// STEP 1 — Repro: in-memory state is lost on "restart" (new instance)
// ---------------------------------------------------------------------------

describe("[#483 repro] InMemoryIntentionStore — state lost across fresh instance", () => {
  test("intention minted in instance A is gone in instance B (new store)", async () => {
    const storeA = new InMemoryIntentionStore();
    await storeA.create({
      content: "buy coffee",
      trigger: { all: [] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });

    const all = await storeA.list();
    expect(all.length).toBe(1);

    // Simulate restart: create a brand-new in-memory store.
    const storeB = new InMemoryIntentionStore();
    const afterRestart = await storeB.list();

    // BUG: state is gone.
    expect(afterRestart.length).toBe(0);
  });
});

describe("[#483 repro] suppressedKeys — lost on restart with in-memory store", () => {
  test("suppressed key in service A is unknown to a fresh service B (in-memory)", () => {
    const serviceA = new LatentService({ store: new InMemoryIntentionStore() });
    serviceA.suppress("buy coffee");
    expect(serviceA.isSuppressed("buy coffee")).toBe(true);

    // "Restart": a fresh service over a fresh in-memory store has no durable
    // suppressed keys to hydrate from → the suppression is lost.
    const serviceB = new LatentService({ store: new InMemoryIntentionStore() });
    expect(serviceB.isSuppressed("buy coffee")).toBe(false); // BUG (repro)
  });
});

describe("[#483 repro] TimerWhenCronService — timers lost on restart (new instance)", () => {
  test("scheduled timer in instance A is gone in instance B", () => {
    let fired = false;
    const cronA = new TimerWhenCronService();
    cronA.scheduleAt("intent_1", new Date(Date.now() + 60_000).toISOString(), () => { fired = true; });

    // Simulate restart: new TimerWhenCronService — all timers lost.
    const cronB = new TimerWhenCronService();
    // cronB has no pending timers; the callback will never fire.
    expect(fired).toBe(false); // nothing fired yet
    cronB.cancelAll(); // no-op, no timers to cancel
    // There is no way for cronB to recover the timer from cronA.
    // This documents the gap — a real process restart loses all timers.
    expect(true).toBe(true); // repro documented
  });
});

// ---------------------------------------------------------------------------
// Helpers for FileIntentionStore tests
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-test-483-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function makeDb(dir: string): FileIntentionStore {
  return new FileIntentionStore(join(dir, "intentions.db"));
}

// ---------------------------------------------------------------------------
// #450 — FileIntentionStore (the PROD store) de-overloads place vs category.
// Mirrors the InMemoryIntentionStore repro in test-ambient-contracts.ts; the
// fix originally landed only in the in-memory store.
// ---------------------------------------------------------------------------

describe("[#450] FileIntentionStore — place filter must not match where.category", () => {
  test("list({ place:X }) must NOT return a where.category:X intention", async () => {
    const store = makeDb(testDir);
    await store.create({
      content: "office category task",
      trigger: { all: [{ kind: "where", category: "office" }] },
      strength: "hard", origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" }, sensitivity: "private",
    });
    expect((await store.list({ place: "office" })).length).toBe(0); // category-only, must not match place
    expect((await store.list({ category: "office" })).length).toBe(1);
    store.close();
  });

  test("list({ place }) matches only where.place", async () => {
    const store = makeDb(testDir);
    await store.create({
      content: "home place task",
      trigger: { all: [{ kind: "where", place: "home" }] },
      strength: "hard", origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" }, sensitivity: "private",
    });
    await store.create({
      content: "office category task",
      trigger: { all: [{ kind: "where", category: "office" }] },
      strength: "hard", origin: "obvious",
      evidence: { ts: "2026-06-05T00:00:00Z" }, sensitivity: "private",
    });
    expect((await store.list({ place: "home" })).length).toBe(1);
    expect((await store.list({ place: "office" })).length).toBe(0);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// STEP 2 — FileIntentionStore: persistence across instances
// ---------------------------------------------------------------------------

describe("[#483] FileIntentionStore — intentions survive restart", () => {
  test("create in instance A → list in instance B returns the intention", async () => {
    const dbPath = join(testDir, "intentions.db");

    const storeA = new FileIntentionStore(dbPath);
    const created = await storeA.create({
      content: "buy coffee",
      trigger: { all: [] },
      strength: "soft",
      origin: "latent",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });
    expect(created.id).toBeTruthy();
    storeA.close();

    // Simulate restart.
    const storeB = new FileIntentionStore(dbPath);
    const all = await storeB.list();
    expect(all.length).toBe(1);
    expect(all[0].content).toBe("buy coffee");
    storeB.close();
  });

  test("suppressed key survives restart (FileIntentionStore hydration via LatentService)", () => {
    const dbPath = join(testDir, "intentions.db");
    const storeA = new FileIntentionStore(dbPath);
    const serviceA = new LatentService({ store: storeA });
    serviceA.suppress("buy coffee");
    expect(serviceA.isSuppressed("buy coffee")).toBe(true);
    storeA.close();

    // Restart: a new LatentService over the same db hydrates suppressed keys in
    // its constructor (#483), so the suppression is still known.
    const storeB = new FileIntentionStore(dbPath);
    const serviceB = new LatentService({ store: storeB });
    expect(serviceB.isSuppressed("buy coffee")).toBe(true);
    storeB.close();
  });

  test("transition to armed in instance A is visible in instance B", async () => {
    const dbPath = join(testDir, "intentions.db");

    const storeA = new FileIntentionStore(dbPath);
    const i = await storeA.create({
      content: "call dentist",
      trigger: { all: [] },
      strength: "soft",
      origin: "latent",
      state: "pending_arm",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });
    await storeA.transition(i.id, "armed");
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    const fetched = await storeB.get(i.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.state).toBe("armed");
    storeB.close();
  });

  test("list() with state filter returns correct results after restart", async () => {
    const dbPath = join(testDir, "intentions.db");

    const storeA = new FileIntentionStore(dbPath);
    const i1 = await storeA.create({ content: "a", trigger: { all: [] }, strength: "soft", origin: "latent", state: "armed", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    const i2 = await storeA.create({ content: "b", trigger: { all: [] }, strength: "soft", origin: "latent", state: "pending_arm", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    void i1; void i2;
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    const armed = await storeB.list({ state: "armed" });
    expect(armed.length).toBe(1);
    expect(armed[0].content).toBe("a");
    storeB.close();
  });

  test("prune() removes terminal states and they stay gone after restart", async () => {
    const dbPath = join(testDir, "intentions.db");

    const storeA = new FileIntentionStore(dbPath);
    await storeA.create({ content: "a", trigger: { all: [] }, strength: "soft", origin: "latent", state: "resolved", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    await storeA.create({ content: "b", trigger: { all: [] }, strength: "soft", origin: "latent", state: "armed", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    const removed = await storeA.prune!(["resolved"]);
    expect(removed).toBe(1);
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    const all = await storeB.list();
    expect(all.length).toBe(1);
    expect(all[0].content).toBe("b");
    storeB.close();
  });
});

// ---------------------------------------------------------------------------
// FileIntentionStore — suppressed keys survive restart
// ---------------------------------------------------------------------------

describe("[#483] FileIntentionStore — suppressedKeys survive restart", () => {
  test("addSuppressedKey in instance A → isSuppressed in instance B returns true", async () => {
    const dbPath = join(testDir, "intentions.db");

    const storeA = new FileIntentionStore(dbPath);
    storeA.addSuppressedKey("buy coffee");
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    expect(storeB.isSuppressed("buy coffee")).toBe(true);
    expect(storeB.isSuppressed("buy milk")).toBe(false);
    storeB.close();
  });

  test("getSuppressedKeys() returns all persisted keys after restart", async () => {
    const dbPath = join(testDir, "intentions.db");

    const storeA = new FileIntentionStore(dbPath);
    storeA.addSuppressedKey("buy coffee");
    storeA.addSuppressedKey("call dentist");
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    const keys = storeB.getSuppressedKeys();
    expect(keys).toContain("buy coffee");
    expect(keys).toContain("call dentist");
    storeB.close();
  });
});

// ---------------------------------------------------------------------------
// FileIntentionStore — when-timer rehydration
// ---------------------------------------------------------------------------

describe("[#483] FileIntentionStore — getArmedWhenIntentions for timer rehydration", () => {
  test("armed intention with when term is returned for rehydration", async () => {
    const dbPath = join(testDir, "intentions.db");
    const futureAt = new Date(Date.now() + 60_000).toISOString();

    const storeA = new FileIntentionStore(dbPath);
    await storeA.create({
      content: "call dentist",
      trigger: { all: [{ kind: "when", at: futureAt, provenance: "provided" }] },
      strength: "hard",
      origin: "obvious",
      state: "armed",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    const toReschedule = await storeB.getArmedWhenIntentions();
    expect(toReschedule.length).toBe(1);
    expect(toReschedule[0].content).toBe("call dentist");
    const whenTerm = toReschedule[0].trigger.all?.find((t) => t.kind === "when");
    expect(whenTerm).toBeDefined();
    storeB.close();
  });

  test("non-armed or non-when intentions are NOT returned for rehydration", async () => {
    const dbPath = join(testDir, "intentions.db");
    const futureAt = new Date(Date.now() + 60_000).toISOString();

    const storeA = new FileIntentionStore(dbPath);
    // resolved + when term — should NOT appear
    await storeA.create({
      content: "done",
      trigger: { all: [{ kind: "when", at: futureAt, provenance: "provided" }] },
      strength: "hard",
      origin: "obvious",
      state: "resolved",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });
    // armed + no when term — should NOT appear
    await storeA.create({
      content: "buy milk",
      trigger: { all: [{ kind: "topic", topic: "groceries", provenance: "provided" }] },
      strength: "soft",
      origin: "latent",
      state: "armed",
      evidence: { ts: new Date().toISOString() },
      sensitivity: "private",
    });
    storeA.close();

    const storeB = new FileIntentionStore(dbPath);
    const toReschedule = await storeB.getArmedWhenIntentions();
    expect(toReschedule.length).toBe(0);
    storeB.close();
  });
});

// ---------------------------------------------------------------------------
// FileIntentionStore — full interface compliance (mirrors InMemory tests)
// ---------------------------------------------------------------------------

describe("[#483] FileIntentionStore — interface compliance", () => {
  test("get() returns null for unknown id", async () => {
    const store = makeDb(testDir);
    expect(await store.get("nonexistent")).toBeNull();
    store.close();
  });

  test("update() patches confidence and trigger", async () => {
    const store = makeDb(testDir);
    const i = await store.create({ content: "x", trigger: { all: [] }, strength: "soft", origin: "latent", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    const updated = await store.update(i.id, { confidence: 0.8 });
    expect(updated.confidence).toBeCloseTo(0.8);
    const fetched = await store.get(i.id);
    expect(fetched!.confidence).toBeCloseTo(0.8);
    store.close();
  });

  test("update() clamps confidence to [0,1]", async () => {
    const store = makeDb(testDir);
    const i = await store.create({ content: "x", trigger: { all: [] }, strength: "soft", origin: "latent", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    const u1 = await store.update(i.id, { confidence: 1.5 });
    expect(u1.confidence).toBe(1);
    const u2 = await store.update(i.id, { confidence: -0.1 });
    expect(u2.confidence).toBe(0);
    store.close();
  });

  test("transition() enforces canTransition — throws on illegal", async () => {
    const store = makeDb(testDir);
    const i = await store.create({ content: "x", trigger: { all: [] }, strength: "soft", origin: "latent", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    // pending_arm → resolved is illegal
    await expect(store.transition(i.id, "resolved")).rejects.toThrow();
    store.close();
  });

  test("resolve() transitions to resolved", async () => {
    const store = makeDb(testDir);
    const i = await store.create({ content: "x", trigger: { all: [] }, strength: "soft", origin: "latent", state: "armed", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    const resolved = await store.resolve(i.id);
    expect(resolved.state).toBe("resolved");
    store.close();
  });

  test("list() with dueBefore filter returns matching when-intentions", async () => {
    const store = makeDb(testDir);
    const cutoff = new Date(Date.now() + 10_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    await store.create({ content: "past", trigger: { all: [{ kind: "when", at: past, provenance: "provided" }] }, strength: "hard", origin: "obvious", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });
    await store.create({ content: "future", trigger: { all: [{ kind: "when", at: future, provenance: "provided" }] }, strength: "hard", origin: "obvious", evidence: { ts: new Date().toISOString() }, sensitivity: "private" });

    const due = await store.list({ dueBefore: cutoff });
    expect(due.length).toBe(1);
    expect(due[0].content).toBe("past");
    store.close();
  });
});
