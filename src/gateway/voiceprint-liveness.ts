/**
 * Gateway-side stateful holder for the voiceprint liveness nonce store.
 *
 * The pure store (identity/voiceprint/liveness-nonce.ts) is time-injectable and
 * side-effect free; this thin wrapper owns the process-lifetime instance and
 * supplies the wall clock (`Date.now`) so RPC handlers do not thread a clock
 * through. Tests construct the pure store directly with an injected `nowMs`.
 *
 * See the TRUST BOUNDARY / HONESTY note in liveness-nonce.ts: this provides
 * REPLAY RESISTANCE for client-supplied embeddings, not capture-binding.
 */
import {
  type VoiceprintLivenessChallenge,
  type VoiceprintLivenessNonceStoreOptions,
  type VoiceprintLivenessVerifyResult,
  VoiceprintLivenessNonceStore,
} from "../identity/voiceprint/index.js";

export interface VoiceprintLivenessChallengeStore {
  issueChallenge(sessionKey: string, nowMs?: number): VoiceprintLivenessChallenge;
  verifyAndConsume(
    sessionKey: string,
    nonce: string,
    nowMs?: number,
  ): VoiceprintLivenessVerifyResult;
}

export interface VoiceprintLivenessChallengeStoreOptions
  extends VoiceprintLivenessNonceStoreOptions {
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
}

class GatewayVoiceprintLivenessStore implements VoiceprintLivenessChallengeStore {
  private readonly store: VoiceprintLivenessNonceStore;
  private readonly now: () => number;

  constructor(options: VoiceprintLivenessChallengeStoreOptions = {}) {
    const { now, ...storeOptions } = options;
    this.store = new VoiceprintLivenessNonceStore(storeOptions);
    this.now = now ?? Date.now;
  }

  issueChallenge(sessionKey: string, nowMs?: number): VoiceprintLivenessChallenge {
    return this.store.issueChallenge(sessionKey, nowMs ?? this.now());
  }

  verifyAndConsume(
    sessionKey: string,
    nonce: string,
    nowMs?: number,
  ): VoiceprintLivenessVerifyResult {
    return this.store.verifyAndConsume(sessionKey, nonce, nowMs ?? this.now());
  }
}

export function createVoiceprintLivenessChallengeStore(
  options: VoiceprintLivenessChallengeStoreOptions = {},
): VoiceprintLivenessChallengeStore {
  return new GatewayVoiceprintLivenessStore(options);
}
