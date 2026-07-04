// =============================================================================
// test-sweep.ts — M9 stage 9c-1: satisfaction/cancel sweep over armed latents.
//   - a later "we bought X" turn retires the armed latent (armed → resolved)
//   - a later "never mind the X" turn suppresses it (armed → suppressed) + blocks re-mint
//   - the sweep is topic-scoped: an unrelated cancel does NOT retire a latent
//   - classifySatisfaction unit cases
// =============================================================================

import { describe, test, expect } from "bun:test";
import { LatentService } from "../src/ambient/latent-service.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import { classifySatisfaction } from "../src/ambient/latent-recognizer.js";

const TS = "2026-06-06T10:00:00Z";
const turn = (text: string) => ({ role: "user" as const, text, ts: TS });

async function armedLatentFor(svc: LatentService, store: InMemoryIntentionStore, sessionKey: string, needText: string) {
  svc.onTranscript(sessionKey, turn(needText), "ambient");
  await svc.tick();
  const list = await store.list({ origin: "latent", state: "armed", sessionKey });
  return list[0];
}

describe("classifySatisfaction (topic-scoped)", () => {
  test("satisfy with topic overlap → satisfied", () => {
    expect(classifySatisfaction("buy coffee", "ok we bought the coffee")).toBe("satisfied");
  });
  test("cancel with topic overlap → cancelled", () => {
    expect(classifySatisfaction("buy paper towels", "never mind the paper towels")).toBe("cancelled");
  });
  test("bare cancel without topic overlap → null (no nuke)", () => {
    expect(classifySatisfaction("buy coffee", "never mind")).toBeNull();
  });
  test("unrelated satisfy → null", () => {
    expect(classifySatisfaction("buy coffee", "we bought a car")).toBeNull();
  });
  test("plain need → null", () => {
    expect(classifySatisfaction("buy coffee", "we still need coffee")).toBeNull();
  });

  // Regression: every latent's content is `buy <item>`, so before the stop-word
  // filter the shared token "buy" (plus "got") made ordinary shopping talk about
  // a DIFFERENT item spuriously "satisfy" an unrelated reminder.
  test("satisfy verb + different item does NOT match (shared 'buy'/'got' tokens)", () => {
    // Both later turns contain "buy" (the token every latent shares) plus a
    // satisfy verb — the exact shape that falsely matched before the fix.
    expect(classifySatisfaction("buy coffee", "I still need to buy milk, already got the eggs")).toBeNull();
    expect(classifySatisfaction("buy coffee", "just bought milk and still have to buy bread")).toBeNull();
  });

  test("true positive still classifies (real item overlap survives the filter)", () => {
    expect(classifySatisfaction("buy coffee", "we finally bought the coffee")).toBe("satisfied");
    expect(classifySatisfaction("buy batteries", "picked up the batteries")).toBe("satisfied");
  });

  // Regression: two different multi-word items sharing only a HEAD NOUN must not
  // match — requires EVERY item token present, not just one shared word.
  test("different item sharing a head noun does NOT match", () => {
    expect(classifySatisfaction("almond milk", "we bought the oat milk")).toBeNull();
    expect(classifySatisfaction("orange juice", "already got the apple juice")).toBeNull();
    expect(classifySatisfaction("black beans", "picked up the green beans")).toBeNull();
    // The exact same multi-word item still resolves.
    expect(classifySatisfaction("almond milk", "we bought the almond milk")).toBe("satisfied");
  });

  // A coarser topic still generalizes: "coffee" resolves on "bought coffee".
  test("a coarser topic still matches a generalization", () => {
    expect(classifySatisfaction("coffee", "ok we bought the coffee")).toBe("satisfied");
  });
});

describe("satisfaction sweep over armed latents", () => {
  test("later 'we bought it' retires the armed latent (→ resolved)", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store });
    const coffee = await armedLatentFor(svc, store, "s1", "we're out of coffee");
    expect(coffee.state).toBe("armed");

    svc.onTranscript("s1", turn("ok we bought the coffee"), "ambient");
    await svc.tick();
    expect((await store.get(coffee.id))!.state).toBe("resolved");
  });

  test("later 'never mind' (topic-scoped) suppresses + blocks re-mint", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store });
    const pt = await armedLatentFor(svc, store, "s2", "we need more paper towels");
    expect(pt.state).toBe("armed");

    svc.onTranscript("s2", turn("actually never mind the paper towels"), "ambient");
    await svc.tick();
    expect((await store.get(pt.id))!.state).toBe("suppressed");

    // Suppressed content is not re-minted on a later need.
    svc.onTranscript("s2", turn("we need paper towels"), "ambient");
    await svc.tick();
    const reminted = (await store.list({ origin: "latent", state: "armed", sessionKey: "s2" }));
    expect(reminted).toHaveLength(0);
  });

  test("unrelated armed latent is NOT retired by a different topic's satisfaction", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store });
    const coffee = await armedLatentFor(svc, store, "s3", "we're out of coffee");

    svc.onTranscript("s3", turn("we bought a new lamp"), "ambient");
    await svc.tick();
    expect((await store.get(coffee.id))!.state).toBe("armed"); // untouched
  });

  // Regression: a live reminder must survive ordinary shopping chatter about a
  // different item that happens to contain a satisfy verb ("bought"/"got").
  test("a live reminder survives 'bought/got' talk about a different item", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store });
    const coffee = await armedLatentFor(svc, store, "s4", "we're out of coffee");
    expect(coffee.state).toBe("armed");

    // Contains "buy" (the shared token) + a satisfy verb about a different item.
    svc.onTranscript("s4", turn("I need to buy milk and I already got the eggs"), "ambient");
    await svc.tick();
    expect((await store.get(coffee.id))!.state).toBe("armed"); // NOT falsely deleted
  });

  // Regression (head-noun collision, end-to-end): a multi-word reminder must
  // survive a satisfy turn about a DIFFERENT item that shares only its head noun.
  test("a multi-word reminder survives a same-head-noun different item", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store });
    const almond = await armedLatentFor(svc, store, "s6", "we're out of almond milk");
    expect(almond.state).toBe("armed");

    svc.onTranscript("s6", turn("we bought the oat milk"), "ambient");
    await svc.tick();
    expect((await store.get(almond.id))!.state).toBe("armed"); // NOT retired by "oat milk"

    // The exact item still resolves it.
    svc.onTranscript("s6", turn("ok we finally bought the almond milk"), "ambient");
    await svc.tick();
    expect((await store.get(almond.id))!.state).toBe("resolved");
  });
});

describe("sweep respects evidence timestamp (codex HIGH fix)", () => {
  test("a strictly-earlier 'we bought it' does NOT retire a later need", async () => {
    const store = new InMemoryIntentionStore();
    const svc = new LatentService({ store });
    const at = (text: string, ts: string) => ({ role: "user" as const, text, ts });
    // T1: satisfaction stated BEFORE the need exists.
    svc.onTranscript("s5", at("ok we bought the coffee", "2026-06-06T09:00:00Z"), "ambient");
    await svc.tick();
    // T2: the need is minted now (evidence.ts = T2 > T1).
    svc.onTranscript("s5", at("we're out of coffee", "2026-06-06T10:00:00Z"), "ambient");
    await svc.tick();
    const coffee = (await store.list({ origin: "latent", state: "armed", sessionKey: "s5" }))[0];
    expect(coffee).toBeDefined();
    // T3: innocuous later turn → dirties the session so the sweep runs over the armed latent.
    svc.onTranscript("s5", at("sounds good", "2026-06-06T11:00:00Z"), "ambient");
    await svc.tick();
    // The earlier "bought coffee" (T1 < T2) must NOT have resolved the later need.
    expect((await store.get(coffee.id))!.state).toBe("armed");
  });
});
