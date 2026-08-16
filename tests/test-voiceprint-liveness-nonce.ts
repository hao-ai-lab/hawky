import { describe, expect, test } from "bun:test";
import {
  createVoiceprintLivenessNonceStore,
  DEFAULT_VOICEPRINT_LIVENESS_NONCE_TTL_MS,
  VoiceprintLivenessNonceStore,
} from "../src/identity/voiceprint/index.js";

/**
 * A8 replay-resistance core. Time is driven entirely by an injected nowMs and the
 * token generator is injectable, so every case is deterministic.
 */
function deterministicStore(options: {
  ttlMs?: number;
  maxNoncesPerSession?: number;
} = {}) {
  let counter = 0;
  return createVoiceprintLivenessNonceStore({
    ...options,
    generateToken: () => `nonce-${(counter += 1)}`,
  });
}

describe("voiceprint liveness nonce store", () => {
  test("issue then verifyAndConsume succeeds and burns the nonce", () => {
    const store = deterministicStore({ ttlMs: 60_000 });
    const challenge = store.issueChallenge("live:s1", 1_000);
    expect(challenge.nonce).toBe("nonce-1");
    expect(challenge.expiresAtMs).toBe(61_000);

    const ok = store.verifyAndConsume("live:s1", challenge.nonce, 2_000);
    expect(ok).toEqual({ ok: true });
    expect(store.liveCount("live:s1", 2_000)).toBe(0);
  });

  test("replaying the same nonce is rejected as already_used", () => {
    const store = deterministicStore();
    const challenge = store.issueChallenge("live:s1", 0);
    expect(store.verifyAndConsume("live:s1", challenge.nonce, 10)).toEqual({ ok: true });

    const replay = store.verifyAndConsume("live:s1", challenge.nonce, 20);
    expect(replay).toEqual({ ok: false, rejected: true, reason: "already_used" });
  });

  test("expired nonce is rejected as expired", () => {
    const store = deterministicStore({ ttlMs: 60_000 });
    const challenge = store.issueChallenge("live:s1", 0);
    // At exactly expiresAtMs the nonce is no longer valid (>= expiry).
    const expired = store.verifyAndConsume("live:s1", challenge.nonce, 60_000);
    expect(expired).toEqual({ ok: false, rejected: true, reason: "expired" });
  });

  test("nonce from another session is rejected as wrong_session (and not consumed)", () => {
    const store = deterministicStore();
    const challenge = store.issueChallenge("live:s1", 0);

    const wrong = store.verifyAndConsume("live:other", challenge.nonce, 10);
    expect(wrong).toEqual({ ok: false, rejected: true, reason: "wrong_session" });

    // The real session can still consume it (cross-session probe did not burn it).
    expect(store.verifyAndConsume("live:s1", challenge.nonce, 20)).toEqual({ ok: true });
  });

  test("unknown nonce is rejected as unknown_nonce", () => {
    const store = deterministicStore();
    store.issueChallenge("live:s1", 0);
    const unknown = store.verifyAndConsume("live:s1", "never-issued", 10);
    expect(unknown).toEqual({ ok: false, rejected: true, reason: "unknown_nonce" });
  });

  test("nonces are single-use and session-scoped across many issuances", () => {
    const store = deterministicStore({ ttlMs: 1_000 });
    const a = store.issueChallenge("live:s1", 0);
    const b = store.issueChallenge("live:s1", 0);
    expect(a.nonce).not.toBe(b.nonce);

    expect(store.verifyAndConsume("live:s1", a.nonce, 1)).toEqual({ ok: true });
    // b is still live and independent of a.
    expect(store.verifyAndConsume("live:s1", b.nonce, 1)).toEqual({ ok: true });
    expect(store.verifyAndConsume("live:s1", b.nonce, 1)).toEqual({
      ok: false,
      rejected: true,
      reason: "already_used",
    });
  });

  test("bounds the store: per-session cap evicts oldest live nonces", () => {
    const store = deterministicStore({ ttlMs: 1_000_000, maxNoncesPerSession: 2 });
    const a = store.issueChallenge("live:s1", 0);
    const b = store.issueChallenge("live:s1", 0);
    const c = store.issueChallenge("live:s1", 0); // evicts a (oldest)

    expect(store.liveCount("live:s1", 0)).toBe(2);
    expect(store.verifyAndConsume("live:s1", a.nonce, 0)).toEqual({
      ok: false,
      rejected: true,
      reason: "unknown_nonce",
    });
    expect(store.verifyAndConsume("live:s1", b.nonce, 0)).toEqual({ ok: true });
    expect(store.verifyAndConsume("live:s1", c.nonce, 0)).toEqual({ ok: true });
  });

  test("expired nonces are evicted lazily and do not count toward the cap", () => {
    const store = deterministicStore({ ttlMs: 100, maxNoncesPerSession: 8 });
    store.issueChallenge("live:s1", 0);
    store.issueChallenge("live:s1", 0);
    expect(store.liveCount("live:s1", 0)).toBe(2);
    // After TTL, live nonces are gone.
    expect(store.liveCount("live:s1", 100)).toBe(0);
  });

  test("default ttl is 60s and construction rejects invalid options", () => {
    expect(DEFAULT_VOICEPRINT_LIVENESS_NONCE_TTL_MS).toBe(60_000);
    const store = createVoiceprintLivenessNonceStore({
      generateToken: () => "n",
    });
    const challenge = store.issueChallenge("live:s1", 5_000);
    expect(challenge.expiresAtMs).toBe(65_000);

    expect(() => new VoiceprintLivenessNonceStore({ ttlMs: 0 })).toThrow();
    expect(() => new VoiceprintLivenessNonceStore({ ttlMs: -1 })).toThrow();
    expect(() => new VoiceprintLivenessNonceStore({ maxNoncesPerSession: 0 })).toThrow();
    expect(() => new VoiceprintLivenessNonceStore({ maxNoncesPerSession: 1.5 })).toThrow();
  });

  test("empty sessionKey is rejected", () => {
    const store = deterministicStore();
    expect(() => store.issueChallenge("   ", 0)).toThrow();
    expect(() => store.verifyAndConsume("", "n", 0)).toThrow();
  });

  test("default token generator produces distinct high-entropy tokens", () => {
    const store = createVoiceprintLivenessNonceStore();
    const a = store.issueChallenge("live:s1", 0);
    const b = store.issueChallenge("live:s1", 0);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce.length).toBeGreaterThanOrEqual(40);
  });
});
