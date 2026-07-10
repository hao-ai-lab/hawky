/**
 * LIVENESS NONCE — replay resistance for client-supplied voiceprint embeddings.
 *
 * A8. When `acceptClientEmbeddings` is opted in, a `score_turns` turn may carry a
 * client-computed embedding that is scored DIRECTLY against the owner template,
 * skipping the sidecar and the biometric audio (see live-client-embedding.ts).
 * Without a per-request challenge, a captured/leaked owner vector could be
 * REPLAYED indefinitely and accepted as the owner every time.
 *
 * This module issues short-lived, single-use, session-bound nonces and verifies
 * them on submission. Each accepted client embedding must carry a fresh nonce
 * the gateway issued for THIS session, that has not expired and has not already
 * been consumed. Consuming a nonce burns it: replaying the same submission fails.
 *
 * HONESTY / SCOPE. This stops NAIVE REPLAY of a captured submission — an attacker
 * cannot resend a previously observed (nonce, embedding) pair, because the nonce
 * is single-use, and cannot mint their own nonce. It does NOT stop a compromised
 * or malicious client that legitimately requests a fresh nonce and then submits
 * an ARBITRARY vector: nothing here binds the nonce to the actual on-device
 * capture. True capture-binding requires device attestation + mixing the nonce
 * into the on-device capture/signature (the iOS half + a deeper follow-up). A8 =
 * replay resistance only; attestation/capture-binding is a follow-up that MUST
 * land before `acceptClientEmbeddings` is enabled in production.
 *
 * This file is PURE: no timers, no `Date.now()`, no crypto side effects beyond an
 * injectable token generator. Time is driven by an injected `nowMs`, so tests are
 * deterministic. A small stateful holder lives in the gateway
 * (voiceprint-liveness.ts).
 */
import { randomBytes } from "node:crypto";

/** Default nonce lifetime: short by design so a leaked nonce is useless quickly. */
export const DEFAULT_VOICEPRINT_LIVENESS_NONCE_TTL_MS = 60_000;

/** Default per-session cap on live (unexpired, unused) nonces. */
export const DEFAULT_VOICEPRINT_LIVENESS_MAX_NONCES_PER_SESSION = 32;

export interface VoiceprintLivenessChallenge {
  /** Opaque, high-entropy token the client echoes back with its embedding. */
  nonce: string;
  /** Absolute expiry (ms epoch, in the injected clock's frame). */
  expiresAtMs: number;
}

export type VoiceprintLivenessRejectionReason =
  | "unknown_nonce"
  | "expired"
  | "wrong_session"
  | "already_used";

export type VoiceprintLivenessVerifyResult =
  | { ok: true }
  | { ok: false; rejected: true; reason: VoiceprintLivenessRejectionReason };

export interface VoiceprintLivenessNonceStoreOptions {
  /** Nonce lifetime in ms. Defaults to {@link DEFAULT_VOICEPRINT_LIVENESS_NONCE_TTL_MS}. */
  ttlMs?: number;
  /** Per-session cap on live nonces. Defaults to {@link DEFAULT_VOICEPRINT_LIVENESS_MAX_NONCES_PER_SESSION}. */
  maxNoncesPerSession?: number;
  /**
   * High-entropy opaque token generator. Injectable for deterministic tests. The
   * default uses `node:crypto` randomBytes so tokens are unguessable in prod.
   */
  generateToken?: () => string;
}

interface StoredNonce {
  sessionKey: string;
  expiresAtMs: number;
  used: boolean;
}

/**
 * Pure, in-memory nonce store. Bounded: expired entries are evicted lazily on
 * every issue/verify, and a per-session cap drops the OLDEST live nonce when the
 * session would exceed it (a flood of un-consumed challenges cannot grow the
 * store without bound).
 */
export class VoiceprintLivenessNonceStore {
  private readonly ttlMs: number;
  private readonly maxNoncesPerSession: number;
  private readonly generateToken: () => string;
  private readonly nonces = new Map<string, StoredNonce>();

  constructor(options: VoiceprintLivenessNonceStoreOptions = {}) {
    this.ttlMs = normalizePositiveMs(
      options.ttlMs,
      DEFAULT_VOICEPRINT_LIVENESS_NONCE_TTL_MS,
    );
    this.maxNoncesPerSession = normalizePositiveInt(
      options.maxNoncesPerSession,
      DEFAULT_VOICEPRINT_LIVENESS_MAX_NONCES_PER_SESSION,
    );
    this.generateToken = options.generateToken ?? defaultGenerateToken;
  }

  /** Issue a fresh challenge bound to `sessionKey`, valid for `ttlMs` from `nowMs`. */
  issueChallenge(sessionKey: string, nowMs: number): VoiceprintLivenessChallenge {
    const session = normalizeSessionKey(sessionKey);
    this.evictExpired(nowMs);

    const nonce = this.generateToken();
    if (this.nonces.has(nonce)) {
      // Astronomically unlikely with 256-bit tokens, but a collision must never
      // silently reuse an existing (possibly cross-session) nonce.
      throw new Error("voiceprint liveness nonce collision");
    }
    const expiresAtMs = nowMs + this.ttlMs;
    this.nonces.set(nonce, { sessionKey: session, expiresAtMs, used: false });
    this.enforceSessionCap(session);
    return { nonce, expiresAtMs };
  }

  /**
   * Verify a nonce for `sessionKey` at `nowMs` and CONSUME it (single-use). On
   * success the nonce is burned so a replay of the same nonce fails with
   * `already_used`. Cross-session, expired, and unknown nonces are rejected and
   * never consumed as a side effect of a wrong-session/expired check.
   */
  verifyAndConsume(
    sessionKey: string,
    nonce: string,
    nowMs: number,
  ): VoiceprintLivenessVerifyResult {
    const session = normalizeSessionKey(sessionKey);
    // NOTE: we do NOT bulk-evict here. Evicting first would collapse the distinct
    // `expired` / `already_used` reasons into `unknown_nonce`. Expired and burned
    // nonces are retained (until they expire) so a replay reports the precise
    // reason; issueChallenge/liveCount handle bounded cleanup.
    const token = typeof nonce === "string" ? nonce : "";
    const stored = token ? this.nonces.get(token) : undefined;
    if (!stored) {
      return rejected("unknown_nonce");
    }
    if (stored.sessionKey !== session) {
      // Do NOT consume: a nonce issued for another session must remain valid for
      // its own session (and an attacker probing cross-session cannot burn it).
      return rejected("wrong_session");
    }
    if (nowMs >= stored.expiresAtMs) {
      // Fully expired: drop it and report expired (a subsequent probe of the same
      // token would then be unknown_nonce, which is acceptable — the nonce is dead).
      this.nonces.delete(token);
      return rejected("expired");
    }
    if (stored.used) {
      // Retained-but-burned: replay of the same nonce reports already_used until
      // it expires out of the store.
      return rejected("already_used");
    }

    // Burn it. Single-use: the same (nonce) can never verify twice. The entry is
    // RETAINED (used=true) so a replay is `already_used`, not `unknown_nonce`.
    stored.used = true;
    return { ok: true };
  }

  /** Live (unexpired, unused) nonce count for a session — for tests/introspection. */
  liveCount(sessionKey: string, nowMs: number): number {
    const session = normalizeSessionKey(sessionKey);
    this.evictExpired(nowMs);
    let count = 0;
    for (const stored of this.nonces.values()) {
      if (stored.sessionKey === session && !stored.used) {
        count += 1;
      }
    }
    return count;
  }

  private evictExpired(nowMs: number): void {
    // Only remove truly expired entries. Burned (used=true) but still-fresh
    // nonces are RETAINED so a replay within the TTL reports `already_used`
    // rather than `unknown_nonce`.
    for (const [token, stored] of this.nonces) {
      if (nowMs >= stored.expiresAtMs) {
        this.nonces.delete(token);
      }
    }
  }

  private enforceSessionCap(sessionKey: string): void {
    // Map iteration is insertion-ordered, so the first matching entries are the
    // oldest. Drop oldest live nonces for this session until under the cap.
    let live: string[] | undefined;
    for (const [token, stored] of this.nonces) {
      if (stored.sessionKey === sessionKey) {
        (live ??= []).push(token);
      }
    }
    if (!live || live.length <= this.maxNoncesPerSession) {
      return;
    }
    const dropCount = live.length - this.maxNoncesPerSession;
    for (let i = 0; i < dropCount; i += 1) {
      this.nonces.delete(live[i]!);
    }
  }
}

export function createVoiceprintLivenessNonceStore(
  options: VoiceprintLivenessNonceStoreOptions = {},
): VoiceprintLivenessNonceStore {
  return new VoiceprintLivenessNonceStore(options);
}

function rejected(
  reason: VoiceprintLivenessRejectionReason,
): VoiceprintLivenessVerifyResult {
  return { ok: false, rejected: true, reason };
}

function normalizeSessionKey(sessionKey: string): string {
  const trimmed = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!trimmed) {
    throw new Error("voiceprint liveness nonce requires a non-empty sessionKey");
  }
  return trimmed;
}

function normalizePositiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("voiceprint liveness nonce ttlMs must be a positive number");
  }
  return value;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error("voiceprint liveness nonce maxNoncesPerSession must be a positive integer");
  }
  return value;
}

function defaultGenerateToken(): string {
  // 32 bytes = 256 bits of entropy, URL-safe. Callers in non-node contexts can
  // inject their own generator via VoiceprintLivenessNonceStoreOptions.
  return randomBytes(32).toString("base64url");
}
