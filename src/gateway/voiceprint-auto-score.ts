// WS1 — live owner recognition, Phase 1: gateway auto-score of finalized realtime
// turns + edge-triggered identity push.
//
// This module owns ONLY the background orchestration around the EXISTING scoring
// seam (`scoreTurns`, injected by voiceprint-methods.ts and backed by the same
// buildScorePlanTurns -> runAndStoreLiveVoiceprintScoringPlan -> audit/A7-telemetry
// path the `identity.voiceprint.score_turns` RPC runs). It never re-implements any
// scoring, consent, allowed-root, or telemetry logic.
//
// Responsibilities:
//   - per-session single-flight batching of finalized turns (queue while a batch
//     is in flight; drained when it settles — bounded, no unbounded fan-out);
//   - WAIT-FOR-AUDIO: a turn whose audio artifact is not yet resolvable/readable
//     is retried a few times with short spacing, then DROPPED fail-safe (a missing
//     tail chunk can never produce a false owner);
//   - folding scored per-turn states into the A2 speaker-evidence reducer
//     (identity/voiceprint/evidence.ts) keyed by sessionKey;
//   - EDGE-TRIGGERED `voiceprint.identity` broadcast on identity establish/flip
//     (a hard-verdict change — never per turn, never on a same-verdict turn);
//   - a pendingScoredStates buffer the next `realtime_event` response for the
//     session drains (belt + suspenders piggyback next to the broadcast).
//
// FAIL-SAFE INVARIANTS: `enqueue` never throws and the background batch promise
// never rejects (everything is caught + logged), so the hot realtime_event path is
// never blocked, delayed, or failed by scoring. Skipped/errored states are NEVER
// fed to the evidence reducer, so a scoring failure can never manufacture an
// owner verdict. The broadcast payload carries ONLY scalars ({sessionKey, verdict,
// decision, confidence, at}) — no embeddings, no audio paths, no secrets
// (mirroring the A7 telemetry discipline).

import { createSubsystemLogger } from "../logging/index.js";
import {
  initialSpeakerEvidenceState,
  readSpeakerEvidence,
  reduceSpeakerEvidence,
  type SpeakerEvidenceConfig,
  type SpeakerEvidenceState,
  type SpeakerEvidenceVerdict,
  type VoiceprintDecision,
  type VoiceprintTranscriptIdentityState,
} from "../identity/voiceprint/index.js";

const log = createSubsystemLogger("gateway/voiceprint-auto-score");

/**
 * One finalized realtime turn queued for background auto-scoring. This is the
 * whitelisted subset of `VoiceprintRealtimeFinalizedTurn` the scoring seam needs
 * (deliberately NO client-supplied audioPath: the seam re-resolves audio strictly
 * through the registered artifact store + allowed roots).
 */
export interface VoiceprintAutoScoreTurn {
  transcriptItemId: string;
  role: "user" | "assistant";
  text?: string;
  startMs: number;
  endMs: number;
  audioArtifactId?: string;
  route?: string;
}

/** What the injected scoring seam returns — the vetted per-turn states only. */
export interface VoiceprintAutoScoreBatchResult {
  states: VoiceprintTranscriptIdentityState[];
}

/**
 * Scalar-only identity summary. This is BOTH the `voiceprint.identity` broadcast
 * payload shape (with sessionKey) and the piggybacked `identity` response field
 * (without it). Never carries embeddings/paths/keys.
 */
export interface VoiceprintIdentitySummary {
  verdict: SpeakerEvidenceVerdict;
  /** The per-turn decision that most recently moved the evidence, when any. */
  decision?: VoiceprintDecision;
  confidence: number;
  at: string;
}

/** Drained by the next realtime_event response for the session (piggyback). */
export interface VoiceprintAutoScorePending {
  scoredStates: VoiceprintTranscriptIdentityState[];
  identity: VoiceprintIdentitySummary;
}

/**
 * Tuning knobs (retry pacing, evidence config, buffer bound, settle hook). These
 * are NOT file-config surface — production uses the defaults; tests inject fast
 * retries and a deterministic settle hook via
 * `VoiceprintLiveScoringConfig.autoScoreTuning`.
 */
export interface VoiceprintAutoScoreTuning {
  /** Extra readiness re-checks after the initial one (default 3). */
  audioRetryAttempts?: number;
  /** Spacing between readiness re-checks in ms (default 2000). */
  audioRetryDelayMs?: number;
  /** A2 evidence reducer overrides (default DEFAULT_SPEAKER_EVIDENCE_CONFIG). */
  evidenceConfig?: Partial<SpeakerEvidenceConfig>;
  /**
   * Minimum turn duration (ms) for an `unknown_speaker` decision to VOTE in the
   * evidence reducer (default 0 = every decision votes). Sub-2s utterances carry
   * too little speech for a reliable speaker embedding, so a short turn's
   * "unknown" means "could not tell", NOT "someone else" — counting it as
   * non-owner evidence lets the owner's own "mm-hm"s flip the verdict to
   * not_owner. Positive decisions (owner/possible) always vote: clearing the
   * owner threshold DESPITE little audio is strong evidence, and possible_owner
   * (which resets both streaks but cannot hard-flip) cannot overturn a settled
   * verdict. The state still reaches the piggyback/UI either way.
   */
  minEvidenceTurnMs?: number;
  /** Bound on the per-session pending piggyback buffer (default 32). */
  maxPendingScoredStates?: number;
  /** Test hook: called after a background batch loop fully settles. Never awaited. */
  onBatchSettled?: (sessionKey: string) => void;
  /** Test hook: clock override for evidence timestamps. */
  nowMs?: () => number;
}

export interface VoiceprintAutoScorerOptions extends VoiceprintAutoScoreTuning {
  /**
   * The REUSED internal scoring seam (score_turns' own pipeline). May reject —
   * the scorer treats any rejection as "skip this batch, fail-safe".
   */
  scoreTurns(
    sessionKey: string,
    turns: readonly VoiceprintAutoScoreTurn[],
  ): Promise<VoiceprintAutoScoreBatchResult>;
  /**
   * Whether a turn's audio is resolvable + readable RIGHT NOW (registered
   * artifact under the allowed roots with the WAV on disk). A throw counts as
   * "not ready".
   */
  isTurnAudioReady(sessionKey: string, turn: VoiceprintAutoScoreTurn): boolean;
  /**
   * Gateway event push (server.broadcast). Optional and called defensively so
   * test harnesses without a broadcast still work; a throw is caught + logged.
   */
  broadcast?(event: string, payload: Record<string, unknown>): void;
}

const DEFAULT_AUDIO_RETRY_ATTEMPTS = 3;
const DEFAULT_AUDIO_RETRY_DELAY_MS = 2000;
const DEFAULT_MAX_PENDING_SCORED_STATES = 32;

/** The gateway event name pushed on an identity establish/flip. */
export const VOICEPRINT_IDENTITY_EVENT = "voiceprint.identity";

interface SessionAutoScoreState {
  evidence: SpeakerEvidenceState;
  /**
   * The verdict of the LAST emitted `voiceprint.identity` broadcast (or the
   * initial `unknown` before any). Edge-trigger comparisons run against this,
   * not against every intermediate verdict.
   */
  lastBroadcastVerdict: SpeakerEvidenceVerdict;
  lastDecision?: VoiceprintDecision;
  lastAt?: string;
  pendingScoredStates: VoiceprintTranscriptIdentityState[];
  queue: VoiceprintAutoScoreTurn[];
  inFlight: Promise<void> | null;
}

export class VoiceprintAutoScorer {
  private readonly options: VoiceprintAutoScorerOptions;
  private readonly sessions = new Map<string, SessionAutoScoreState>();

  constructor(options: VoiceprintAutoScorerOptions) {
    this.options = options;
  }

  /**
   * Fire-and-forget entry point from the realtime_event handler. NEVER throws
   * and NEVER returns a promise the caller could accidentally await — the hot
   * path continues immediately. If a batch for the session is already in flight
   * the turns are queued and drained when it settles (single-flight per session).
   */
  enqueue(sessionKey: string, turns: readonly VoiceprintAutoScoreTurn[]): void {
    try {
      if (turns.length === 0) {
        return;
      }
      const state = this.stateFor(sessionKey);
      state.queue.push(...turns);
      if (state.inFlight) {
        log.info("voiceprint auto-score batch in flight; turns queued", {
          session_key: sessionKey,
          queued: state.queue.length,
        });
        return;
      }
      // The drain loop catches its own faults per batch; this outer catch +
      // finally guarantees the tracked promise NEVER rejects (no unhandled
      // rejection, ever) and the in-flight slot is always released.
      state.inFlight = this.drainLoop(sessionKey, state)
        .catch((error) => {
          log.warn("voiceprint auto-score drain loop failed", {
            session_key: sessionKey,
            error: messageOf(error),
          });
        })
        .finally(() => {
          if (this.sessions.get(sessionKey) === state) {
            state.inFlight = null;
          }
          try {
            this.options.onBatchSettled?.(sessionKey);
          } catch {
            // Test hook only; never propagate.
          }
        });
    } catch (error) {
      // FAIL-SAFE: an enqueue fault is logged and dropped; the realtime_event
      // response must never be affected.
      log.warn("voiceprint auto-score enqueue failed", {
        session_key: sessionKey,
        error: messageOf(error),
      });
    }
  }

  /**
   * Drain the pending piggyback buffer for the session. Returns undefined when
   * nothing is buffered so the realtime_event response stays byte-for-byte
   * unchanged unless there is genuinely something additive to attach.
   */
  takePending(sessionKey: string): VoiceprintAutoScorePending | undefined {
    const state = this.sessions.get(sessionKey);
    if (!state || state.pendingScoredStates.length === 0) {
      return undefined;
    }
    return {
      scoredStates: state.pendingScoredStates.splice(0),
      identity: this.identitySummary(state),
    };
  }

  /** Current scalar identity summary for a session, if any evidence exists. */
  identityFor(sessionKey: string): VoiceprintIdentitySummary | undefined {
    const state = this.sessions.get(sessionKey);
    return state ? this.identitySummary(state) : undefined;
  }

  /**
   * Clear ALL per-session auto-score state (evidence, pending buffer, queue).
   * Wired into identity.voiceprint.realtime_reset so evidence shares the turn
   * tracker's lifecycle. An in-flight batch detects the swap (map identity
   * check) and drops its late results instead of resurrecting the session.
   */
  reset(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Test/diagnostic hook: resolves once no batch is in flight for any session.
   * Never rejects (in-flight promises are rejection-proof by construction).
   */
  async settle(): Promise<void> {
    for (;;) {
      const inFlight = [...this.sessions.values()]
        .map((state) => state.inFlight)
        .filter((p): p is Promise<void> => p !== null);
      if (inFlight.length === 0) {
        return;
      }
      await Promise.all(inFlight);
    }
  }

  private stateFor(sessionKey: string): SessionAutoScoreState {
    const current = this.sessions.get(sessionKey);
    if (current) {
      return current;
    }
    const created: SessionAutoScoreState = {
      evidence: initialSpeakerEvidenceState(),
      lastBroadcastVerdict: "unknown",
      pendingScoredStates: [],
      queue: [],
      inFlight: null,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private async drainLoop(
    sessionKey: string,
    state: SessionAutoScoreState,
  ): Promise<void> {
    // Re-check map identity each round: a realtime_reset mid-batch must drop
    // late results, never resurrect the cleared session state.
    while (state.queue.length > 0 && this.sessions.get(sessionKey) === state) {
      const turns = state.queue.splice(0);
      try {
        const ready = await this.waitForTurnAudio(sessionKey, turns);
        if (this.sessions.get(sessionKey) !== state) {
          return;
        }
        if (ready.length === 0) {
          continue;
        }
        const result = await this.options.scoreTurns(sessionKey, ready);
        if (this.sessions.get(sessionKey) !== state) {
          return;
        }
        this.fold(sessionKey, state, result.states, ready);
      } catch (error) {
        // FAIL-SAFE: the whole batch is skipped and logged. No state is fed to
        // the evidence reducer, so a scoring fault can never move the verdict
        // toward owner — and the loop keeps draining later batches.
        log.warn("voiceprint auto-score batch failed; turns skipped", {
          session_key: sessionKey,
          turns: turns.length,
          error: messageOf(error),
        });
      }
    }
  }

  /**
   * WAIT-FOR-AUDIO: the live-session WAV may still be landing on the gateway
   * when a turn finalizes. Re-check readiness up to `audioRetryAttempts` more
   * times with `audioRetryDelayMs` spacing; turns whose audio never resolves are
   * DROPPED (fail-safe skip), never scored from a guess.
   */
  private async waitForTurnAudio(
    sessionKey: string,
    turns: readonly VoiceprintAutoScoreTurn[],
  ): Promise<VoiceprintAutoScoreTurn[]> {
    const attempts = this.options.audioRetryAttempts ?? DEFAULT_AUDIO_RETRY_ATTEMPTS;
    const delayMs = this.options.audioRetryDelayMs ?? DEFAULT_AUDIO_RETRY_DELAY_MS;
    const ready: VoiceprintAutoScoreTurn[] = [];
    let waiting = [...turns];
    for (let attempt = 0; ; attempt += 1) {
      const stillWaiting: VoiceprintAutoScoreTurn[] = [];
      for (const turn of waiting) {
        if (this.turnAudioReady(sessionKey, turn)) {
          ready.push(turn);
        } else {
          stillWaiting.push(turn);
        }
      }
      waiting = stillWaiting;
      if (waiting.length === 0 || attempt >= attempts) {
        break;
      }
      await sleep(delayMs);
    }
    if (waiting.length > 0) {
      log.warn("voiceprint auto-score audio never resolved; turns skipped", {
        session_key: sessionKey,
        skipped: waiting.length,
        transcript_item_ids: waiting.map((turn) => turn.transcriptItemId),
        audio_artifact_ids: waiting.map((turn) => turn.audioArtifactId ?? null),
        turn_windows_ms: waiting.map((turn) => [turn.startMs ?? null, turn.endMs ?? null]),
      });
    }
    return ready;
  }

  private turnAudioReady(sessionKey: string, turn: VoiceprintAutoScoreTurn): boolean {
    try {
      return this.options.isTurnAudioReady(sessionKey, turn);
    } catch {
      return false;
    }
  }

  /**
   * Fold scored per-turn states into the A2 evidence reducer and emit an
   * EDGE-TRIGGERED `voiceprint.identity` broadcast on identity establish/flip.
   *
   * Only genuinely SCORED states move the evidence: a state with an error, a
   * skip reason, or a non-decision result is buffered for the piggyback but
   * NEVER folded (fail-safe: faults cannot manufacture a verdict).
   *
   * Edge-trigger discipline: a broadcast fires only when the stabilized verdict
   * CHANGES relative to the last broadcast AND the change involves a hard
   * verdict (`owner_present`/`not_owner`) on either side — i.e. an identity
   * ESTABLISH (unknown/provisional -> hard) or FLIP (hard -> anything else).
   * The intermediate unknown -> provisional drift is not an identity event, and
   * a repeat same-verdict turn emits nothing.
   */
  private fold(
    sessionKey: string,
    state: SessionAutoScoreState,
    states: readonly VoiceprintTranscriptIdentityState[],
    turns: readonly VoiceprintAutoScoreTurn[],
  ): void {
    if (states.length === 0) {
      return;
    }
    state.pendingScoredStates.push(...states);
    const cap = this.options.maxPendingScoredStates ?? DEFAULT_MAX_PENDING_SCORED_STATES;
    if (state.pendingScoredStates.length > cap) {
      state.pendingScoredStates.splice(0, state.pendingScoredStates.length - cap);
    }

    const minEvidenceTurnMs = this.options.minEvidenceTurnMs ?? 0;
    const turnDurations = new Map(
      turns.map((turn) => [turn.transcriptItemId, turn.endMs - turn.startMs]),
    );
    for (const scored of states) {
      const decision = scoredStateDecision(scored);
      if (!decision) {
        continue;
      }
      // Short-turn "unknown" is "could not tell", not "someone else": it neither
      // votes toward not_owner NOR resets the owner streak (skipping the fold
      // keeps it perfectly neutral). It DOES refresh the evidence timestamp:
      // otherwise a stretch of only short turns longer than staleTimeoutMs would
      // decay a settled owner to unknown — the exact mid-conversation flap this
      // neutrality exists to prevent. A state whose duration is unknowable (not
      // in this batch — currently unreachable) votes normally: voting can only
      // move the verdict toward not_owner, the fail-safe direction.
      // See minEvidenceTurnMs.
      if (decision === "unknown_speaker" && minEvidenceTurnMs > 0) {
        const durationMs = turnDurations.get(scored.transcriptItemId);
        if (durationMs !== undefined && durationMs < minEvidenceTurnMs) {
          const atMs = this.options.nowMs?.() ?? Date.now();
          state.evidence = { ...state.evidence, updatedAtMs: atMs };
          continue;
        }
      }
      const atMs = this.options.nowMs?.() ?? Date.now();
      state.evidence = reduceSpeakerEvidence(
        state.evidence,
        { decision, atMs },
        this.options.evidenceConfig,
      );
      state.lastDecision = decision;
      state.lastAt = new Date(atMs).toISOString();
      const verdict = state.evidence.verdict;
      if (
        verdict !== state.lastBroadcastVerdict &&
        (isHardVerdict(verdict) || isHardVerdict(state.lastBroadcastVerdict))
      ) {
        state.lastBroadcastVerdict = verdict;
        this.emitIdentity(sessionKey, state);
      }
    }
  }

  private identitySummary(state: SessionAutoScoreState): VoiceprintIdentitySummary {
    return {
      verdict: state.evidence.verdict,
      ...(state.lastDecision !== undefined ? { decision: state.lastDecision } : {}),
      confidence: readSpeakerEvidence(state.evidence).confidence,
      at: state.lastAt ?? new Date(this.options.nowMs?.() ?? Date.now()).toISOString(),
    };
  }

  private emitIdentity(sessionKey: string, state: SessionAutoScoreState): void {
    // Scalars only — no embeddings, no audio paths, no secrets (A7 discipline).
    const summary = this.identitySummary(state);
    try {
      this.options.broadcast?.(VOICEPRINT_IDENTITY_EVENT, {
        sessionKey,
        ...summary,
      });
      log.info("voiceprint.identity emitted", {
        session_key: sessionKey,
        verdict: summary.verdict,
        confidence: summary.confidence,
      });
    } catch (error) {
      // A broadcast fault must never break scoring or the drain loop.
      log.warn("voiceprint.identity broadcast failed", {
        session_key: sessionKey,
        error: messageOf(error),
      });
    }
  }
}

export function createVoiceprintAutoScorer(
  options: VoiceprintAutoScorerOptions,
): VoiceprintAutoScorer {
  return new VoiceprintAutoScorer(options);
}

/**
 * Map a vetted per-turn state to the A2 reducer's decision input. ONLY the three
 * per-turn classifier decisions qualify; skipped/errored/cluster/confirmed states
 * return undefined and never move the evidence.
 */
function scoredStateDecision(
  state: VoiceprintTranscriptIdentityState,
): VoiceprintDecision | undefined {
  if (state.error !== undefined || state.skipReason !== undefined) {
    return undefined;
  }
  const result = state.result;
  if (
    result === "owner_speaking" ||
    result === "possible_owner" ||
    result === "unknown_speaker"
  ) {
    return result;
  }
  return undefined;
}

function isHardVerdict(verdict: SpeakerEvidenceVerdict): boolean {
  return verdict === "owner_present" || verdict === "not_owner";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
