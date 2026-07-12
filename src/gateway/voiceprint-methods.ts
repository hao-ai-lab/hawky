import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConnection } from "./connection.js";
import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import type { HawkyConfig } from "../agent/types.js";
import {
  createVoiceprintRealtimeSessionStore,
  type VoiceprintRealtimeSessionStore,
} from "./voiceprint-realtime.js";
import {
  createVoiceprintLivenessChallengeStore,
  type VoiceprintLivenessChallengeStore,
} from "./voiceprint-liveness.js";
import {
  createVoiceprintAutoScorer,
  type VoiceprintAutoScorer,
  type VoiceprintAutoScoreTuning,
} from "./voiceprint-auto-score.js";
import {
  buildVoiceprintConsentGrant,
  buildVoiceprintConsentWithdrawal,
  effectiveConsentAllowsProcessing,
  voiceprintTurnRecordsToMemoryCandidate,
  hashVoiceprintSessionRef,
  isVoiceprintConsentExpired,
  type VoiceprintAuditOp,
  type VoiceprintAuditRecord,
  type VoiceprintConsentScope,
  type VoiceprintEffectiveConsent,
} from "../identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintLifecycle,
  type VoiceprintLifecycle,
} from "./voiceprint-lifecycle.js";
import type { VoiceprintLivenessRejectionReason } from "../identity/voiceprint/index.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getConfigDir } from "../storage/config.js";
import {
  applyVoiceprintStorageBundle,
  assessVoiceprintAudioQuality,
  assessVoiceprintEnrollment,
  buildEmbeddingBatchRequest,
  buildLiveVoiceprintScoringPlan,
  buildVoiceprintStorageBundle,
  buildVoiceprintTemplateArtifact,
  buildVoiceprintTranscriptIdentityState,
  buildVoiceprintTranscriptIdentityStatePatches,
  countVoiceprintStorageSnapshot,
  DEFAULT_OWNER_VOICEPRINT_ENROLLMENT_MIN_SPEECH_MS,
  DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS,
  deviceAttestedVoiceprintQuality,
  emptyVoiceprintStorageSnapshot,
  formatVoiceprintModel,
  ownerEmbeddingsFromVoiceprintTemplateArtifact,
  purgeVoiceprintSubjectFromSnapshot,
  readWavFile,
  readEncryptedVoiceprintTemplateArtifact,
  resolveVoiceprintConsent,
  resolveVoiceprintThresholds,
  runEmbeddingSidecar,
  runLiveVoiceprintScoringJobs,
  VoiceprintSidecarError,
  sameVoiceprintModel,
  sliceWavAudio,
  tombstoneVoiceprintTemplate,
  voiceprintTemplateFileRefFromSource,
  voiceprintConsentAllowsProcessing,
  writeEncryptedVoiceprintTemplateArtifact,
  assertVoiceprintModelIntegrity,
  classifyVoiceprintModelMismatch,
  isReferenceVoiceprintModel,
  sidecarEnvSelectsReferenceBackend,
  REFERENCE_VOICEPRINT_PROVIDER,
  REFERENCE_VOICEPRINT_MODEL_ID,
  type VoiceprintModelIntegrityPin,
  markVoiceprintTranscriptStateError,
  type VoiceprintAudioQualityStatus,
  type VoiceprintEnrollmentAssessment,
  type VoiceprintEnrollmentSource,
  type VoiceprintStorageBundle,
  type VoiceprintStorageCounts,
  type VoiceprintStorageSnapshot,
  type LiveVoiceRealtimeEvent,
  type LiveVoiceRealtimeProviderHint,
  type LiveVoiceprintPlanItemInput,
  type LiveVoiceprintScoringBatchResult,
  type LiveVoiceprintScoringPlan,
  type LiveVoiceprintScoringPlanRun,
  type LiveVoiceprintScoringPlanRunStatus,
  type VoiceprintEmbeddingResponse,
  type VoiceprintTranscriptIdentityStatePatch,
  type VoiceprintAudioQualityThresholds,
  type VoiceprintConsentSnapshot,
  type VoiceprintModelInfo,
  type VoiceprintTemplateArtifact,
  type VoiceprintTemplateFileRef,
  type VoiceprintTemplateFileSource,
  type VoiceprintTemplateStorageRef,
  type VoiceprintThresholds,
  type VoiceprintTranscriptIdentityState,
  type VoiceprintCohort,
  type VoiceprintTurnRecords,
} from "../identity/voiceprint/index.js";
import type { EmbeddingSidecarCommand } from "../identity/voiceprint/index.js";
import {
  configBoolean,
  configPath,
  configString,
  errorMessage,
  objectOrUndefined,
  optionalBoolean,
  optionalConfigPath,
  optionalConfigString,
  optionalNonNegativeFiniteNumber,
  optionalNumber,
  optionalPositiveFiniteNumber,
  optionalPositiveNumber,
  optionalString,
  optionalStringArray,
  optionalStringRecord,
  requiredFiniteNumber,
  requiredString,
  resolveConfigPath,
  validateVoiceprintQualityThresholds,
} from "./voiceprint-param-utils.js";
import {
  resolveAllowedAudioPath,
  resolveLiveTurnAudioArtifact,
  resolveVoiceprintMediaArtifactPath,
  VOICEPRINT_MEDIA_ID_REGEX,
} from "./voiceprint-audio-resolve.js";
import {
  assertDiscriminativeVoiceprintModel,
  VOICEPRINT_PROVIDERS,
} from "./voiceprint-config.js";
import {
  deleteOwnerTemplate,
  embedEnrollmentSources,
  readOwnerTemplateArtifactForEnrollment,
  writeOwnerTemplateFromSources,
} from "./voiceprint-enrollment.js";

// PUBLIC API RE-EXPORTS. Config-resolution helpers moved to ./voiceprint-config.js
// but remain importable from this module (13 external importers depend on the
// original entry point). Pure code motion — no behavior change.
export {
  assertDiscriminativeVoiceprintConfig,
  defaultVoiceprintReferenceEmbedScript,
  resolveVoiceprintLiveScoringConfigFromConfig,
} from "./voiceprint-config.js";

/**
 * A9 reviewed-voiceprint -> memory-candidate BRIDGE wiring. OPT-IN and NO-OP BY
 * DEFAULT: when `enabled` is not true (the default), the bridge RPC refuses with a
 * clear FAILED_PRECONDITION and NOTHING in the distillation / person-snapshot path
 * changes. Resolved from `config.voiceprint.memory_bridge`.
 */
export interface VoiceprintMemoryBridgeGatewayConfig {
  enabled: boolean;
}

export function resolveVoiceprintMemoryBridgeConfigFromConfig(
  config: HawkyConfig,
): VoiceprintMemoryBridgeGatewayConfig {
  return { enabled: config.voiceprint?.memory_bridge?.enabled === true };
}

const log = createSubsystemLogger("gateway/voiceprint-methods");
const VOICEPRINT_STORAGE_FILE_MODE = 0o600;

class VoiceprintStoragePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceprintStoragePersistenceError";
  }
}

/**
 * A fault reading the persisted (file-backed) consent ledger — corrupt/tampered
 * file, partial write, or an fs fault whose message carries an on-disk path. This
 * is a SERVER-SIDE storage fault, not a client-request fault and not a consent
 * denial. Raising a distinct type lets the handler classifiers report it as a
 * sanitized INTERNAL_ERROR (retryable) rather than mislabeling it INVALID_REQUEST
 * or auditing the subject as consent_denied.
 */
class VoiceprintConsentLedgerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceprintConsentLedgerStoreError";
  }
}

interface VoiceprintStorageFile {
  version: 1;
  updatedAt: string;
  snapshot: VoiceprintStorageSnapshot;
}

export interface VoiceprintStorageApplyResult {
  ok: true;
  bundleId: string;
  sessionKey: string;
  counts: VoiceprintStorageCounts;
  clearedTranscriptIdentity: number;
}

export interface VoiceprintSubjectPurgeApplyResult {
  ok: true;
  sessionKey: string;
  removed: VoiceprintStorageCounts;
}

export interface VoiceprintStorageAdapter {
  applyBundle(bundle: VoiceprintStorageBundle): Promise<VoiceprintStorageApplyResult> | VoiceprintStorageApplyResult;
  snapshot?(): VoiceprintStorageSnapshot;
  /**
   * A4 right-to-erasure: remove EVERY derived voiceprint record for a subject
   * (keyed by sessionKey). Optional so existing adapters remain compatible; the
   * built-in in-memory and file adapters implement it.
   */
  purgeSubject?(
    sessionKey: string,
  ): Promise<VoiceprintSubjectPurgeApplyResult> | VoiceprintSubjectPurgeApplyResult;
}

export interface VoiceprintAudioArtifactRegistration {
  sessionKey: string;
  audioArtifactId: string;
  mediaId: string;
  audioPath: string;
  sampleRate?: number;
  recordingStartMs?: number;
  recordingEndMs?: number;
  route?: string;
  registeredAt: string;
}

export interface VoiceprintAudioArtifactResolution
  extends VoiceprintAudioArtifactRegistration {
  requestStartMs?: number;
  requestEndMs?: number;
}

export interface VoiceprintAudioArtifactStore {
  register(
    registration: VoiceprintAudioArtifactRegistration,
  ): VoiceprintAudioArtifactRegistration;
  resolve(input: {
    sessionKey: string;
    audioArtifactId: string;
    startMs?: number;
    endMs?: number;
  }): VoiceprintAudioArtifactResolution | undefined;
  reset?(sessionKey: string): void;
}

export interface VoiceprintLiveScoringConfig {
  sidecar: EmbeddingSidecarCommand;
  ownerEmbeddings?: number[][];
  ownerTemplateArtifact?: VoiceprintTemplateArtifact;
  ownerTemplateFile?: VoiceprintTemplateFileRef;
  ownerTemplateFileSource?: VoiceprintTemplateFileSource;
  allowedAudioRoots?: string[];
  consent?: Partial<VoiceprintConsentSnapshot>;
  qualityThresholds?: Partial<VoiceprintAudioQualityThresholds>;
  templateLearningReviewed?: boolean;
  thresholds?: Partial<VoiceprintThresholds>;
  expectedModel?: VoiceprintModelInfo;
  ownerTemplateRef?: string;
  targetSampleRate?: number;
  timeoutMs?: number;
  /**
   * A5 PRODUCTION GUARD (default false). When true, the reference (non-discriminative)
   * backend can NEVER score real turns: a reference-tagged config is rejected at
   * config-resolve time and any reference-tagged owner template / per-turn embedding
   * is refused at scoring time. See `require_discriminative_model` in config.
   */
  requireDiscriminativeModel?: boolean;
  /**
   * A5 MODEL INTEGRITY PIN. When set, the pinned model file's SHA-256 is verified
   * (once) before the first score, and scoring is REFUSED on mismatch. See
   * `model_sha256` / `model_path` in config.
   */
  modelIntegrityPin?: VoiceprintModelIntegrityPin;
  /**
   * TRUST BOUNDARY opt-in (default false). When true, a per-turn client-computed
   * embedding is scored DIRECTLY against the owner template, skipping the sidecar
   * and the biometric audio entirely. See `accept_client_embeddings` in config
   * and the trust-boundary note in identity/voiceprint/live-client-embedding.ts.
   */
  acceptClientEmbeddings?: boolean;
  /**
   * WS1 live owner recognition (Phase 1) opt-in, DEFAULT FALSE. When true, the
   * gateway itself fire-and-forget background-scores each batch of finalized
   * realtime turns through the SAME internal path `score_turns` runs, folds the
   * scored states into the A2 speaker-evidence reducer keyed by sessionKey, and
   * on an identity establish/flip emits an edge-triggered `voiceprint.identity`
   * broadcast plus piggybacks the scored states on the session's next
   * `identity.voiceprint.realtime_event` response. When false (the default) the
   * realtime handlers are byte-for-byte unchanged. See
   * `auto_score_finalized` in config and gateway/voiceprint-auto-score.ts.
   */
  autoScoreFinalized?: boolean;
  /**
   * Tuning for the WS1 auto-scorer (wait-for-audio retry pacing, evidence
   * config, buffer bound, test settle hook). NOT file-config surface; only
   * relevant when `autoScoreFinalized` is true. Defaults match production
   * (~3 retries with ~2s spacing).
   */
  autoScoreTuning?: VoiceprintAutoScoreTuning;
  /**
   * A8 replay resistance: TTL (ms) for the single-use liveness nonce a client
   * embedding submission must carry (see identity/voiceprint/liveness-nonce.ts).
   * Defaults to DEFAULT_VOICEPRINT_LIVENESS_NONCE_TTL_MS when unset.
   */
  livenessNonceTtlMs?: number;
  /**
   * A3 AS-Norm normalization. Present ONLY when config `voiceprint.live_scoring.as_norm`
   * is `enabled` AND a cohort is resolvable. When present, per-turn scoring
   * normalizes the raw cosine against `cohort` and classifies with
   * `normalizedThresholds` (a z-score-like scale). When absent (the default),
   * scoring is byte-for-byte the raw-cosine path.
   */
  asNorm?: {
    cohort: VoiceprintCohort;
    normalizedThresholds: VoiceprintThresholds;
    topN?: number;
  };
}

export interface VoiceprintScoreTurnsResult {
  ok: true;
  sessionKey: string;
  status: LiveVoiceprintScoringPlanRunStatus;
  turns: number;
  queued: number;
  skipped: number;
  patches: number;
  storageBundleId?: string;
  storage: VoiceprintStorageApplyResult | null;
  states: VoiceprintTranscriptIdentityState[];
  error?: {
    code: string;
    message: string;
  };
}

export function createInMemoryVoiceprintStorage(
  initial?: Partial<VoiceprintStorageSnapshot>,
): VoiceprintStorageAdapter {
  let snapshot = {
    ...emptyVoiceprintStorageSnapshot(),
    ...initial,
  };

  return {
    applyBundle(bundle) {
      snapshot = applyVoiceprintStorageBundle({ snapshot, bundle });
      return {
        ok: true,
        bundleId: bundle.id,
        sessionKey: bundle.sessionKey,
        counts: countVoiceprintStorageSnapshot(snapshot),
        clearedTranscriptIdentity: bundle.clearTranscriptIdentity.length,
      };
    },
    snapshot() {
      return snapshot;
    },
    purgeSubject(sessionKey) {
      const result = purgeVoiceprintSubjectFromSnapshot({ snapshot, sessionKey });
      snapshot = result.snapshot;
      return { ok: true as const, sessionKey, removed: result.removed };
    },
  };
}

export function createInMemoryVoiceprintAudioArtifactStore(): VoiceprintAudioArtifactStore {
  const refs = new Map<string, VoiceprintAudioArtifactRegistration[]>();
  return {
    register(registration) {
      const normalized = normalizeVoiceprintAudioArtifactRegistration(registration);
      const key = voiceprintAudioArtifactStoreKey(normalized);
      const current = refs.get(key) ?? [];
      const next = current
        .filter((item) => item.mediaId !== normalized.mediaId)
        .concat(normalized);
      refs.set(key, next);
      return { ...normalized };
    },
    resolve(input) {
      const sessionKey = input.sessionKey.trim();
      const audioArtifactId = input.audioArtifactId.trim();
      if (!sessionKey || !audioArtifactId) {
        return undefined;
      }
      const found = refs.get(voiceprintAudioArtifactStoreKey({ sessionKey, audioArtifactId })) ?? [];
      return resolveVoiceprintAudioArtifactRegistration(found, {
        startMs: input.startMs,
        endMs: input.endMs,
      });
    },
    reset(sessionKey) {
      const prefix = `${sessionKey.trim()}\u0000`;
      for (const key of refs.keys()) {
        if (key.startsWith(prefix)) {
          refs.delete(key);
        }
      }
    },
  };
}

export function defaultVoiceprintStoragePath(): string {
  return join(getConfigDir(), "state", "voiceprint-storage.json");
}

export function createFileVoiceprintStorage(
  options: { filePath?: string } = {},
): VoiceprintStorageAdapter {
  const filePath = options.filePath ?? defaultVoiceprintStoragePath();

  return {
    applyBundle(bundle) {
      const snapshot = loadVoiceprintStorageSnapshot(filePath);
      const next = applyVoiceprintStorageBundle({ snapshot, bundle });
      writeVoiceprintStorageSnapshot(filePath, next);
      return {
        ok: true,
        bundleId: bundle.id,
        sessionKey: bundle.sessionKey,
        counts: countVoiceprintStorageSnapshot(next),
        clearedTranscriptIdentity: bundle.clearTranscriptIdentity.length,
      };
    },
    snapshot() {
      return loadVoiceprintStorageSnapshot(filePath);
    },
    purgeSubject(sessionKey) {
      const snapshot = loadVoiceprintStorageSnapshot(filePath);
      const result = purgeVoiceprintSubjectFromSnapshot({ snapshot, sessionKey });
      writeVoiceprintStorageSnapshot(filePath, result.snapshot);
      return { ok: true as const, sessionKey, removed: result.removed };
    },
  };
}

export function registerVoiceprintMethods(
  server: GatewayServer,
  storage: VoiceprintStorageAdapter = createFileVoiceprintStorage(),
  realtime: VoiceprintRealtimeSessionStore = createVoiceprintRealtimeSessionStore(),
  scoring?: VoiceprintLiveScoringConfig,
  audioArtifacts: VoiceprintAudioArtifactStore = createInMemoryVoiceprintAudioArtifactStore(),
  liveness: VoiceprintLivenessChallengeStore = createVoiceprintLivenessChallengeStore({
    ttlMs: scoring?.livenessNonceTtlMs,
  }),
  // A4 consent/audit/retention lifecycle. Defaults to an in-memory, NON-enforcing
  // lifecycle so wiring it changes nothing for existing call sites: it records +
  // audits, but does not gate enroll/score unless `enforceConsentLedger` is set.
  lifecycle: VoiceprintLifecycle = createInMemoryVoiceprintLifecycle(),
  // A9 memory bridge. OPT-IN, NO-OP BY DEFAULT: disabled unless config sets
  // `voiceprint.memory_bridge.enabled: true`. Disabled => the bridge RPC refuses and
  // the default distillation / person-snapshot path is byte-for-byte unchanged.
  memoryBridge: VoiceprintMemoryBridgeGatewayConfig = { enabled: false },
): void {
  // WS1 live owner recognition (Phase 1): OPT-IN gateway auto-scoring of
  // finalized realtime turns. `autoScorer` exists ONLY when config sets
  // `voiceprint.live_scoring.auto_score_finalized: true`; when it is undefined
  // (the default) every handler below is byte-for-byte unchanged.
  const autoScorer =
    scoring?.autoScoreFinalized === true
      ? createVoiceprintAutoScorer({
        ...(scoring.autoScoreTuning ?? {}),
        // REUSE, never duplicate: the auto-scorer scores through the exact
        // internal seam `identity.voiceprint.score_turns` runs, so plan build,
        // allowed-root enforcement, fail-closed sidecar handling, storage
        // bundles, A4 audit, and A7 telemetry are all identical.
        scoreTurns: (sessionKey, turns) => {
          const at = new Date().toISOString();
          return scoreVoiceprintTurnsForSession({
            sessionKey,
            input: {
              // Whitelisted turn fields only. Deliberately NO audioPath: audio
              // resolves strictly via the registered artifact store + allowed
              // roots inside buildScorePlanTurns, exactly as score_turns does.
              turns: turns.map((turn) => ({
                transcriptItemId: turn.transcriptItemId,
                role: turn.role,
                text: turn.text,
                startMs: turn.startMs,
                endMs: turn.endMs,
                audioArtifactId: turn.audioArtifactId,
                route: turn.route,
              })),
              createdAt: at,
              updatedAt: at,
            },
            scoring,
            storage,
            audioArtifacts,
            liveness,
            lifecycle,
            logLabel: "identity.voiceprint.auto_score_finalized",
          });
        },
        // WAIT-FOR-AUDIO readiness probe: the live-session WAV may still be
        // uploading when a turn finalizes. Ready means the artifact is
        // registered for the session AND its allowed-root-resolved WAV is on
        // disk (mid-write WAVs are readable by design). A turn with no artifact
        // id has nothing to wait for — the scoring plan skips it fail-safe.
        isTurnAudioReady: (sessionKey, turn) => {
          if (!turn.audioArtifactId) {
            return true;
          }
          const resolved = resolveLiveTurnAudioArtifact({
            sessionKey,
            audioArtifactId: turn.audioArtifactId,
            startMs: turn.startMs,
            endMs: turn.endMs,
            audioArtifacts,
            allowedAudioRoots: scoring.allowedAudioRoots,
          });
          if (!resolved) {
            return false;
          }
          try {
            return existsSync(
              resolveAllowedAudioPath(resolved.audioPath, scoring.allowedAudioRoots),
            );
          } catch {
            return false;
          }
        },
        // Defensive: test harnesses register onto a mock server without a
        // broadcast; production GatewayServer has one (src/gateway/server.ts).
        broadcast: (event, payload) => {
          const candidate = (server as { broadcast?: unknown }).broadcast;
          if (typeof candidate === "function") {
            (candidate as (event: string, payload: unknown) => void).call(server, event, payload);
          }
        },
      })
      : undefined;

  server.registerMethod("identity.voiceprint.realtime_event", async (conn, params) => {
    const input = parseRealtimeEventParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);

    try {
      // Resolve the audio artifact INSIDE the try so an artifact-store or
      // allowed-root resolution fault surfaces as the handler's typed
      // INVALID_REQUEST, not a raw INTERNAL_ERROR that leaks resolution/path detail.
      const event = resolveRealtimeVoiceprintAudioArtifactEvent({
        sessionKey,
        event: input.event,
        audioArtifacts,
        allowedAudioRoots: scoring?.allowedAudioRoots,
      });
      const result = realtime.applyEvent({
        sessionKey,
        event,
        includeMissingAudio: input.includeMissingAudio,
        provider: input.provider,
      });
      log.info("identity.voiceprint.realtime_event", {
        session_key: sessionKey,
        event_type: input.event.type,
        event_status: result.event.status,
        finalized_turns: result.finalizedTurns.length,
      });
      // WS1 auto-score hook (opt-in; `autoScorer` is undefined by default, so
      // this whole block is skipped and the response is byte-for-byte unchanged).
      if (autoScorer) {
        if (result.finalizedTurns.length > 0) {
          // Fire-and-forget: NEVER awaited and internally fully guarded, so
          // background scoring can never delay or fail this realtime response.
          autoScorer.enqueue(sessionKey, result.finalizedTurns);
        }
        // Piggyback (belt + suspenders next to the voiceprint.identity push):
        // drain any states scored since the session's previous realtime_event.
        // ADDITIVE only — when nothing is buffered the response is unchanged.
        const pending = autoScorer.takePending(sessionKey);
        if (pending) {
          return {
            ...result,
            scoredStates: pending.scoredStates,
            identity: pending.identity,
          };
        }
      }
      return result;
    } catch (error) {
      // Classify by fault type: a sidecar/artifact-store/lifecycle infra fault is a
      // retryable INTERNAL_ERROR (sanitized), NOT the client's bad request. Only a
      // genuine request fault falls through to INVALID_REQUEST. This avoids both
      // (1) telling the caller it sent a bad request when the server faulted and
      // (2) leaking a raw on-disk path in the INTERNAL_ERROR case.
      throw voiceprintMethodError(error);
    }
  });

  server.registerMethod("identity.voiceprint.realtime_reset", (conn, params) => {
    const input = parseRealtimeResetParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    audioArtifacts.reset?.(sessionKey);
    // WS1: per-session evidence + pending piggyback states share the turn
    // tracker's lifecycle, so a realtime_reset clears them too (no-op when the
    // auto-score flag is off).
    autoScorer?.reset(sessionKey);
    return realtime.reset(sessionKey);
  });

  // A8 replay resistance. Issue a fresh, single-use, session-bound liveness nonce
  // for the authenticated connection. A client-supplied embedding submission MUST
  // carry a nonce from THIS RPC (see the client-embedding nonce gate in
  // buildScorePlanTurns). This alone stops NAIVE REPLAY of a captured submission;
  // it does NOT bind the nonce to the on-device capture — see the HONESTY note in
  // identity/voiceprint/liveness-nonce.ts (attestation/capture-binding is a
  // follow-up that must land before enabling accept_client_embeddings in prod).
  server.registerMethod("identity.voiceprint.request_embedding_challenge", (conn, params) => {
    const input = parseRequestEmbeddingChallengeParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const challenge = liveness.issueChallenge(sessionKey);
    log.info("identity.voiceprint.request_embedding_challenge", {
      session_key: sessionKey,
      expires_at_ms: challenge.expiresAtMs,
    });
    return {
      ok: true as const,
      sessionKey,
      nonce: challenge.nonce,
      expiresAtMs: challenge.expiresAtMs,
    };
  });

  server.registerMethod("identity.voiceprint.audio_artifact.register", (conn, params) => {
    const input = parseAudioArtifactRegisterParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    if (!scoring?.allowedAudioRoots?.length) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        "Voiceprint audio artifact registration requires configured audio roots.",
      );
    }
    try {
      // Path resolution + registration touch the filesystem (allowed-root checks,
      // sidecar reads). Keep any non-MethodError fault (e.g. a corrupt sidecar file)
      // from escaping as a raw INTERNAL_ERROR that leaks the on-disk path: it maps
      // to a typed INVALID_REQUEST, consistent with the other request-fault paths.
      const resolved = resolveVoiceprintMediaArtifactPath({
        mediaId: input.mediaId,
        allowedAudioRoots: scoring.allowedAudioRoots,
      });
      const registered = audioArtifacts.register({
        sessionKey,
        audioArtifactId: input.audioArtifactId,
        mediaId: input.mediaId,
        audioPath: resolved.audioPath,
        sampleRate: input.sampleRate ?? resolved.sampleRate,
        recordingStartMs: input.recordingStartMs,
        recordingEndMs: input.recordingEndMs,
        route: input.route,
        registeredAt: input.registeredAt ?? new Date().toISOString(),
      });
      log.info("identity.voiceprint.audio_artifact.register", {
        session_key: sessionKey,
        audio_artifact_id: registered.audioArtifactId,
        media_id: registered.mediaId,
      });
      return {
        ok: true,
        sessionKey,
        audioArtifact: registered,
      };
    } catch (error) {
      throw voiceprintMethodError(error);
    }
  });

  server.registerMethod("identity.voiceprint.score_turns", async (conn, params) => {
    const input = parseScoreTurnsParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    if (!scoring) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        "Voiceprint live scorer is not configured on this gateway.",
      );
    }
    // SHARED SCORING SEAM: the WS1 auto-scorer runs the exact same function, so
    // audit + A7 telemetry + fail-closed behavior stay identical for both.
    return scoreVoiceprintTurnsForSession({
      sessionKey,
      input,
      scoring,
      storage,
      audioArtifacts,
      liveness,
      lifecycle,
    });
  });

  server.registerMethod("identity.voiceprint.apply_bundle", async (conn, params) => {
    const bundle = parseApplyBundleParams(params);
    assertVoiceprintSessionAccess(conn, bundle.sessionKey);

    const started = Date.now();
    try {
      const result = await storage.applyBundle(bundle);
      log.info("identity.voiceprint.apply_bundle", {
        session_key: bundle.sessionKey,
        bundle_id: bundle.id,
        states: bundle.transcriptIdentityStates.length,
        annotations: bundle.transcriptSpeakerAnnotations.length,
        clears: bundle.clearTranscriptIdentity.length,
        duration_ms: Date.now() - started,
      });
      return result;
    } catch (error) {
      throw voiceprintMethodError(error);
    }
  });

  // ── Owner voiceprint enrollment lifecycle ────────────────────────────────
  //
  // These three RPCs manage the OWNER template that `score_turns` resolves. They
  // all read/write the SAME encrypted, local-only store that `score_turns`'
  // owner-template resolver reads (`scoring.ownerTemplateFileSource`), so an
  // enrolled owner immediately becomes the template scoring uses, and a deleted
  // one immediately stops resolving. They are inert unless a live-scoring config
  // with an `ownerTemplateFileSource` is present — this changes NO feature-flag
  // posture (`live_scoring.enabled` / `voiceprintRealtimeEnabled` stay as-is).
  //
  // KEY HANDLING: the store is AES-256-GCM encrypted (see template-store.ts). The
  // 32-byte key lives in the key file at `ownerTemplateFileSource.keyPath` (a path
  // under the config root, e.g. ~/.hawky/state/voiceprint/owner-template.key.json),
  // resolved from config by `resolveVoiceprintLiveScoringConfigFromConfig`. LOSING
  // THAT KEY FILE MEANS THE OWNER MUST RE-ENROLL — the encrypted template can no
  // longer be decrypted. The raw key and every embedding are treated as secrets:
  // they are never logged and never echoed in RPC responses.

  server.registerMethod("identity.voiceprint.enroll_owner", async (conn, params) => {
    const input = parseEnrollOwnerParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const config = requireEnrollmentScoringConfig(scoring);
    // Consult the PERSISTED consent ledger (restrict-only) when enforcement is on.
    // When off/inert (default), this returns the config+inline consent unchanged.
    assertEnrollmentConsentAudited(config, input.consent, lifecycle, sessionKey);

    try {
      const embedded = await embedEnrollmentSources({
        sessionKey,
        sources: input.sources,
        scoring: config,
        audioArtifacts,
      });
      const assessment = assessVoiceprintEnrollment({
        sources: embedded.sources,
        minSpeechMs: input.minSpeechMs,
      });
      if (assessment.status !== "accepted") {
        log.info("identity.voiceprint.enroll_owner", {
          session_key: sessionKey,
          status: "rejected",
          reasons: assessment.reasons,
          source_count: assessment.sourceCount,
          speech_ms: assessment.speechMs,
        });
        emitVoiceprintAudit(lifecycle, {
          subjectKey: sessionKey,
          op: "enroll",
          outcome: "rejected",
          counts: { sourceCount: assessment.sourceCount },
        });
        return serializeEnrollmentRejection(sessionKey, assessment);
      }

      const stored = writeOwnerTemplateFromSources({
        scoring: config,
        model: embedded.model,
        sources: embedded.sources,
        minSpeechMs: input.minSpeechMs,
      });
      log.info("identity.voiceprint.enroll_owner", {
        session_key: sessionKey,
        status: "enrolled",
        template_ref: stored.templateRef,
        source_count: assessment.sourceCount,
        speech_ms: assessment.speechMs,
      });
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "enroll",
        outcome: "ok",
        templateRef: stored.templateRef,
        counts: { sourceCount: assessment.sourceCount },
      });
      return serializeEnrollmentSuccess(sessionKey, assessment, stored);
    } catch (error) {
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "enroll",
        outcome: "error",
      });
      throw voiceprintMethodError(error);
    }
  });

  server.registerMethod("identity.voiceprint.add_enrollment_clip", async (conn, params) => {
    const input = parseAddEnrollmentClipParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const config = requireEnrollmentScoringConfig(scoring);
    assertEnrollmentConsentAudited(config, input.consent, lifecycle, sessionKey);

    try {
      const existing = readOwnerTemplateArtifactForEnrollment(config);
      const embedded = await embedEnrollmentSources({
        sessionKey,
        sources: [input.source],
        scoring: config,
        audioArtifacts,
      });
      if (!sameVoiceprintModel(existing.artifact.template.model, embedded.model)) {
        throw new MethodError(
          "FAILED_PRECONDITION",
          `New enrollment clip model ${formatVoiceprintModel(embedded.model)} does not match owner template model ${formatVoiceprintModel(existing.artifact.template.model)}.`,
        );
      }

      const mergedSources = [
        ...existing.sources,
        ...embedded.sources,
      ];
      const assessment = assessVoiceprintEnrollment({
        sources: mergedSources,
        minSpeechMs: input.minSpeechMs,
      });
      if (assessment.status !== "accepted") {
        // The single new clip failed quality (or the merged set is somehow below
        // the floor): reject and leave the stored template untouched.
        log.info("identity.voiceprint.add_enrollment_clip", {
          session_key: sessionKey,
          status: "rejected",
          reasons: assessment.reasons,
        });
        return serializeEnrollmentRejection(sessionKey, assessment);
      }

      const stored = writeOwnerTemplateFromSources({
        scoring: config,
        model: existing.artifact.template.model,
        sources: mergedSources,
        minSpeechMs: input.minSpeechMs,
        createdAt: existing.artifact.template.enrollment.createdAt,
      });
      log.info("identity.voiceprint.add_enrollment_clip", {
        session_key: sessionKey,
        status: "enrolled",
        template_ref: stored.templateRef,
        source_count: assessment.sourceCount,
        speech_ms: assessment.speechMs,
      });
      return serializeEnrollmentSuccess(sessionKey, assessment, stored);
    } catch (error) {
      throw voiceprintMethodError(error);
    }
  });

  server.registerMethod("identity.voiceprint.delete_owner_template", (conn, params) => {
    const input = parseDeleteOwnerTemplateParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const config = requireEnrollmentScoringConfig(scoring);

    try {
      const removed = deleteOwnerTemplate(config, input.deletedAt);
      log.info("identity.voiceprint.delete_owner_template", {
        session_key: sessionKey,
        removed: removed.removed,
        template_ref: removed.templateRef,
      });
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "delete",
        outcome: removed.removed ? "ok" : "noop",
        ...(removed.templateRef !== undefined ? { templateRef: removed.templateRef } : {}),
        counts: { templatesRemoved: removed.removed ? 1 : 0 },
      });
      return {
        ok: true as const,
        sessionKey,
        removed: removed.removed,
        templateRef: removed.templateRef,
      };
    } catch (error) {
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "delete",
        outcome: "error",
      });
      throw voiceprintMethodError(error);
    }
  });

  // ── Owner enrollment status (metadata only, no biometric material) ───────
  //
  // Lets the enrollment UI show "already enrolled" (+ when / how much / quality)
  // instead of always presenting a blank first-time flow. Returns SCALAR
  // metadata read from the template's plaintext header — never the centroid or
  // any embedding (A7 discipline). Gracefully reports `enrolled: false` when
  // enrollment is not configured or no (non-deleted) template exists, rather
  // than throwing, so the UI degrades to the first-time flow.
  server.registerMethod("identity.voiceprint.owner_template_status", (conn, params) => {
    const input = parseDeleteOwnerTemplateParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    if (!scoring?.ownerTemplateFileSource) {
      return { ok: true as const, sessionKey, enrolled: false as const };
    }
    try {
      const fileRef = voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource);
      if (!existsSync(fileRef.filePath)) {
        return { ok: true as const, sessionKey, enrolled: false as const };
      }
      const artifact = readEncryptedVoiceprintTemplateArtifact(fileRef);
      if (artifact.template.deletedAt) {
        return { ok: true as const, sessionKey, enrolled: false as const };
      }
      const enrollment = artifact.template.enrollment;
      const model = artifact.template.model;
      return {
        ok: true as const,
        sessionKey,
        enrolled: true as const,
        templateRef: artifact.template.id,
        enrolledAt: enrollment.createdAt,
        speechMs: enrollment.speechMs,
        sourceCount: enrollment.sourceCount,
        quality: enrollment.quality,
        embeddingDim: artifact.template.embeddingDim,
        model: model
          ? { provider: model.provider, modelId: model.modelId, version: model.version }
          : undefined,
      };
    } catch (error) {
      // A corrupt/unreadable template must not crash the UI query: report
      // not-enrolled so the user can re-enroll over it.
      log.warn("identity.voiceprint.owner_template_status read failed", {
        session_key: sessionKey,
        error: errorMessage(error),
      });
      return { ok: true as const, sessionKey, enrolled: false as const };
    }
  });

  // ── A5 model-version-mismatch backfill: re-embed the owner template ──────
  //
  // When the live scoring model was upgraded (new provider/modelId/version), the
  // STORED owner template — enrolled with the OLD model — is incomparable to new
  // turns (cosine across models is meaningless), so score_turns fails with
  // needs_reenrollment. This RPC RE-EMBEDS the owner template with the CURRENT
  // model FROM RETAINED ENROLLMENT SOURCE AUDIO (supplied per the retention
  // policy) and re-stores it (encrypted) with the updated model tag, resolving the
  // mismatch WITHOUT the owner re-doing the 30s enrollment. If no source audio is
  // available, the caller omits `sources`: the template is then marked STALE and a
  // clear needs_reenrollment rejection is returned (never a silent bad score). Both
  // outcomes emit a `reembed` audit entry.
  server.registerMethod("identity.voiceprint.reembed_owner_template", async (conn, params) => {
    const input = parseReembedOwnerTemplateParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const config = requireEnrollmentScoringConfig(scoring);

    try {
      const existing = readOwnerTemplateArtifactForEnrollment(config);
      const templateModel = existing.artifact.template.model;

      // No retained source audio: mark the template STALE and refuse (needs_reenroll).
      if (input.sources.length === 0) {
        emitVoiceprintAudit(lifecycle, {
          subjectKey: sessionKey,
          op: "reembed",
          outcome: "rejected",
          reason: "needs_reenrollment_no_retained_source",
          templateRef: existing.artifact.template.id,
        });
        log.info("identity.voiceprint.reembed_owner_template", {
          session_key: sessionKey,
          status: "needs_reenrollment",
          template_ref: existing.artifact.template.id,
        });
        return {
          ok: false as const,
          sessionKey,
          status: "needs_reenrollment" as const,
          reason: "no_retained_source_audio",
          templateRef: existing.artifact.template.id,
        };
      }

      // Re-embed the retained source audio with the CURRENT sidecar model.
      const embedded = await embedEnrollmentSources({
        sessionKey,
        sources: input.sources,
        scoring: config,
        audioArtifacts,
      });

      // A5 GUARD: the re-embed must land on a discriminative model when the guard is
      // on; a reference re-embed would re-tag the template test-only.
      assertDiscriminativeVoiceprintModel(
        config.requireDiscriminativeModel,
        embedded.model,
        "Voiceprint re-embed result",
        "store it",
      );
      // The whole point is to move to a DIFFERENT model; if the re-embed produced the
      // SAME model as the stored template, there was no mismatch to resolve.
      if (sameVoiceprintModel(embedded.model, templateModel)) {
        throw new MethodError(
          "FAILED_PRECONDITION",
          `Voiceprint re-embed produced the same model ${formatVoiceprintModel(embedded.model)} as the stored template; no version mismatch to resolve.`,
        );
      }

      const assessment = assessVoiceprintEnrollment({
        sources: embedded.sources,
        minSpeechMs: input.minSpeechMs,
      });
      if (assessment.status !== "accepted") {
        emitVoiceprintAudit(lifecycle, {
          subjectKey: sessionKey,
          op: "reembed",
          outcome: "rejected",
          reason: "quality_rejected",
          templateRef: existing.artifact.template.id,
        });
        return serializeEnrollmentRejection(sessionKey, assessment);
      }

      const stored = writeOwnerTemplateFromSources({
        scoring: config,
        model: embedded.model,
        sources: embedded.sources,
        minSpeechMs: input.minSpeechMs,
        createdAt: existing.artifact.template.enrollment.createdAt,
      });
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "reembed",
        outcome: "ok",
        templateRef: stored.templateRef,
        counts: { sourceCount: assessment.sourceCount },
      });
      log.info("identity.voiceprint.reembed_owner_template", {
        session_key: sessionKey,
        status: "reembedded",
        template_ref: stored.templateRef,
        source_count: assessment.sourceCount,
      });
      return {
        ok: true as const,
        sessionKey,
        status: "reembedded" as const,
        templateRef: stored.templateRef,
        model: embedded.model,
        sourceCount: assessment.sourceCount,
        ownerEmbeddingCount: stored.ownerEmbeddingCount,
      };
    } catch (error) {
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "reembed",
        outcome: "error",
      });
      throw voiceprintMethodError(error);
    }
  });

  // ── A9 reviewed voiceprint -> memory-candidate BRIDGE (opt-in, no-op default) ──
  //
  // Maps a reviewed `VoiceprintTurnRecords` into a single, FAIL-CLOSED
  // `MemoryCandidate`: durable ONLY for a strong, consented, confirmed owner turn;
  // QUARANTINED ("unreviewed_identity_signal", durableMemory=false) otherwise. The
  // mapping is pure and never throws (a bridge fault degrades to a quarantined
  // candidate). The candidate carries scalars + ids + tags only — never a
  // vector/audio/key (enforced by assertVoiceprintMemoryCandidateHasNoSecrets inside
  // the bridge). DISABLED BY DEFAULT: refuses unless `voiceprint.memory_bridge.enabled`
  // is true, so the default distillation path is byte-for-byte unchanged.
  server.registerMethod("identity.voiceprint.bridge_memory_candidate", (conn, params) => {
    if (!memoryBridge.enabled) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        "Voiceprint memory bridge is disabled (set voiceprint.memory_bridge.enabled to enable).",
      );
    }
    const input = parseBridgeMemoryCandidateParams(params);
    // Bind the request to the connection's session and reject a cross-session
    // records payload (the records carry their own sessionKey join).
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.records.speakerTurnTag?.sessionKey);
    // The bridge is fail-closed and never throws; still classify any unexpected fault.
    try {
      const result = voiceprintTurnRecordsToMemoryCandidate(input.records, {
        ...(input.consent !== undefined ? { consent: input.consent } : {}),
        ...(input.thresholds !== undefined ? { thresholds: input.thresholds } : {}),
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      });
      log.info("identity.voiceprint.bridge_memory_candidate", {
        session_key: sessionKey,
        promotable: result.promotable,
        durable_memory: result.candidate.allowedUses.durableMemory,
        review_state: result.candidate.review.state,
        quarantine_reason: result.candidate.quarantineReason,
      });
      return {
        ok: true as const,
        sessionKey,
        promotable: result.promotable,
        degradeReason: result.degradeReason,
        candidate: result.candidate,
      };
    } catch (error) {
      throw voiceprintMethodError(error);
    }
  });

  // ── A4 biometric consent + retention + audit lifecycle ───────────────────
  registerVoiceprintLifecycleMethods(server, {
    scoring,
    storage,
    realtime,
    audioArtifacts,
    // WS1: right-to-erasure must also purge the subject's auto-score state
    // (evidence, piggyback buffer, queue, in-flight batch). Undefined when the
    // auto_score_finalized flag is off — behavior byte-for-byte unchanged.
    autoScorer,
    lifecycle,
  });
}

/**
 * Register the A4 consent-ledger / withdrawal-purge / retention-sweep / audit RPCs.
 * These are always registered; they operate against the provided `lifecycle`
 * stores (in-memory + non-enforcing by default), so they are inert-by-default and
 * additive: no existing RPC's behavior changes.
 */
function registerVoiceprintLifecycleMethods(
  server: GatewayServer,
  deps: {
    scoring?: VoiceprintLiveScoringConfig;
    storage: VoiceprintStorageAdapter;
    realtime: VoiceprintRealtimeSessionStore;
    audioArtifacts: VoiceprintAudioArtifactStore;
    /** WS1 auto-scorer; present only when `auto_score_finalized` is on. */
    autoScorer?: VoiceprintAutoScorer;
    lifecycle: VoiceprintLifecycle;
  },
): void {
  const { scoring, storage, realtime, audioArtifacts, autoScorer, lifecycle } = deps;

  // Record (grant/update) the current consent for the subject/session. Appends a
  // new grant record; the effective consent is the fold of the append-only history.
  server.registerMethod("identity.voiceprint.record_consent", (conn, params) => {
    const input = parseRecordConsentParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const now = input.now ?? new Date().toISOString();
    try {
      const history = lifecycle.consentLedger.history(sessionKey);
      const record = buildVoiceprintConsentGrant({
        subjectKey: sessionKey,
        scopes: input.scopes,
        history,
        grantedAt: input.grantedAt ?? now,
        recordedAt: now,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      lifecycle.consentLedger.append(record);
      const effective = lifecycle.consentLedger.effective(sessionKey);
      log.info("identity.voiceprint.record_consent", {
        session_key: sessionKey,
        scopes: input.scopes,
        seq: record.seq,
      });
      return {
        ok: true as const,
        sessionKey,
        consent: serializeEffectiveConsent(effective),
      };
    } catch (error) {
      throw voiceprintLifecycleMethodError(error);
    }
  });

  // Read current effective consent + full append-only history for the subject.
  server.registerMethod("identity.voiceprint.get_consent", (conn, params) => {
    const input = parseSessionOnlyParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    try {
      const effective = lifecycle.consentLedger.effective(sessionKey);
      return {
        ok: true as const,
        sessionKey,
        consent: serializeEffectiveConsent(effective),
        history: effective.history,
      };
    } catch (error) {
      throw voiceprintLifecycleMethodError(error);
    }
  });

  // Right-to-erasure: append a withdrawal record AND purge everything derived
  // from the subject (encrypted owner template + derived storage states + cached
  // artifacts). Idempotent. Writes a `withdraw` audit entry.
  server.registerMethod("identity.voiceprint.withdraw_consent", async (conn, params) => {
    const input = parseWithdrawConsentParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const now = input.now ?? new Date().toISOString();

    // PHASE 1 — DESTRUCTION. If this throws, data may NOT have been erased: fail
    // CLOSED (throw, no ledger record) so the caller retries and no withdrawal is
    // recorded for an erasure that never happened.
    let outcome: Awaited<ReturnType<typeof purgeVoiceprintSubject>>;
    try {
      outcome = await purgeVoiceprintSubject({
        sessionKey,
        scoring,
        storage,
        realtime,
        audioArtifacts,
        autoScorer,
        deletedAt: now,
      });
    } catch (error) {
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "withdraw",
        outcome: "error",
      });
      throw voiceprintMethodError(error);
    }

    // PHASE 2 — RECORD-KEEPING. The data is already irreversibly erased. Appending
    // the withdrawal record (or re-reading effective consent) can still throw on a
    // corrupt/unwritable ledger. We MUST NOT report the whole withdrawal as failed
    // in that case — that would tell the caller their data survived when it did
    // not, and a retry cannot un-erase it. Instead surface success with the erasure
    // counts and an explicit `recordPersisted: false` so the caller/operator sees
    // the ledger is out of sync and can reconcile, without misrepresenting reality.
    // Append the withdrawal AFTER the purge so a failed purge does not record a
    // withdrawal that never erased data. Append-only: prior grants are retained.
    try {
      const history = lifecycle.consentLedger.history(sessionKey);
      const record = buildVoiceprintConsentWithdrawal({
        subjectKey: sessionKey,
        history,
        withdrawnAt: now,
        recordedAt: now,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      lifecycle.consentLedger.append(record);
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "withdraw",
        outcome: "ok",
        ...(outcome.templateRef !== undefined ? { templateRef: outcome.templateRef } : {}),
        counts: {
          templatesRemoved: outcome.templateRemoved ? 1 : 0,
          ...flattenPurgeCounts(outcome.storageRemoved),
        },
      });
      log.info("identity.voiceprint.withdraw_consent", {
        session_key: sessionKey,
        template_removed: outcome.templateRemoved,
        seq: record.seq,
      });
      return {
        ok: true as const,
        sessionKey,
        templateRemoved: outcome.templateRemoved,
        storageRemoved: outcome.storageRemoved,
        consent: serializeEffectiveConsent(lifecycle.consentLedger.effective(sessionKey)),
      };
    } catch (error) {
      log.warn("identity.voiceprint.withdraw_consent.record_failed", {
        session_key: sessionKey,
        template_removed: outcome.templateRemoved,
        error: errorMessage(error),
      });
      emitVoiceprintAudit(lifecycle, {
        subjectKey: sessionKey,
        op: "withdraw",
        outcome: "error",
        reason: "withdrawal_record_failed",
      });
      return {
        ok: true as const,
        sessionKey,
        templateRemoved: outcome.templateRemoved,
        storageRemoved: outcome.storageRemoved,
        recordPersisted: false as const,
      };
    }
  });

  // Retention sweep: destroy voiceprint data (template + derived states) for any
  // subject whose effective consent's retention anchor is older than the window.
  // Fresh subjects are untouched. Writes a `purge` audit entry per purged subject.
  server.registerMethod("identity.voiceprint.purge_expired", async (conn, params) => {
    // Unbound connections cannot drive an owner-template purge safely; require a
    // bound session even though the sweep spans subjects (operator/self trigger).
    sessionKeyForVoiceprintRequest(conn, undefined);
    const input = parsePurgeExpiredParams(params);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const retentionMs = input.retentionMs ?? lifecycle.retentionMs;

    // Reading the ledger to enumerate expired subjects can throw if the file-backed
    // store is corrupt/tampered. Fail CLOSED and typed: refuse the sweep (purging
    // nothing) rather than escaping as a raw INTERNAL_ERROR that leaks the on-disk
    // path. Never proceed to destroy data off a ledger we could not read.
    const expired: string[] = [];
    try {
      for (const subjectKey of lifecycle.consentLedger.subjectKeys()) {
        const effective = lifecycle.consentLedger.effective(subjectKey);
        if (isVoiceprintConsentExpired({ effective, nowMs, retentionMs })) {
          expired.push(subjectKey);
        }
      }
    } catch (error) {
      throw voiceprintLifecycleMethodError(error);
    }

    const purged: Array<{ sessionKey: string; templateRemoved: boolean }> = [];
    // Subjects whose data WAS erased but whose withdrawal record could not be
    // persisted (ledger write failed). Data erasure is the mandatory outcome, so we
    // do NOT abort the sweep on such a failure — that would leave the remaining
    // expired subjects un-swept with their biometric data intact. Instead we record
    // the inconsistency (audit `error` entry + surface a count) and keep going so
    // every expired subject is purged; an operator can re-run to reconcile records.
    const recordFailures: string[] = [];
    // Subjects whose ERASURE itself faulted (unlink EACCES/EPERM/EBUSY, storage
    // read/write fault). The per-subject purge is wrapped so one subject's failure
    // does NOT abort the sweep and strand later expired subjects with their
    // biometric data intact — the whole point of the retention job. A purge fault
    // is audited (typed `error`) and surfaced as a count; an operator can re-run.
    const purgeFailures: string[] = [];
    for (const subjectKey of expired) {
      let outcome: VoiceprintSubjectPurgeOutcome;
      try {
        outcome = await purgeVoiceprintSubject({
          sessionKey: subjectKey,
          // The owner template is a per-gateway singleton; only purge it for the
          // bound session's subject. For other expired subjects, purge only the
          // derived storage states (their template, if any, is the same file and is
          // handled when that subject is the connection's subject). This keeps the
          // sweep from unexpectedly deleting the current owner's template.
          scoring: subjectKey === conn.sessionKey ? scoring : undefined,
          storage,
          realtime,
          audioArtifacts,
          autoScorer,
          deletedAt: nowIso,
        });
      } catch (error) {
        // Do NOT throw: a raw purge fault would (1) escape as an untyped
        // INTERNAL_ERROR that leaks the on-disk template/storage path and (2)
        // abort the sweep, leaving later expired subjects un-erased. Record it,
        // audit a sanitized error, and continue.
        purgeFailures.push(subjectKey);
        log.warn("identity.voiceprint.purge_expired.purge_failed", {
          subject_key: subjectKey,
          error: errorMessage(error),
        });
        emitVoiceprintAudit(lifecycle, {
          subjectKey,
          op: "purge",
          outcome: "error",
          reason: "purge_failed",
        });
        continue;
      }
      // A withdrawal record marks the subject as purged in the append-only ledger.
      // The purge above already erased the data; if the ledger append now fails we
      // must not throw out of the sweep (that would strand later expired subjects).
      try {
        const history = lifecycle.consentLedger.history(subjectKey);
        lifecycle.consentLedger.append(
          buildVoiceprintConsentWithdrawal({
            subjectKey,
            history,
            withdrawnAt: nowIso,
            recordedAt: nowIso,
            reason: "retention_expired",
          }),
        );
        emitVoiceprintAudit(lifecycle, {
          subjectKey,
          op: "purge",
          outcome: "ok",
          ...(outcome.templateRef !== undefined ? { templateRef: outcome.templateRef } : {}),
          counts: {
            templatesRemoved: outcome.templateRemoved ? 1 : 0,
            ...flattenPurgeCounts(outcome.storageRemoved),
          },
        });
      } catch (error) {
        recordFailures.push(subjectKey);
        log.warn("identity.voiceprint.purge_expired.record_failed", {
          subject_key: subjectKey,
          error: errorMessage(error),
        });
        // Best-effort audit of the erased-but-unrecorded state (also swallows).
        emitVoiceprintAudit(lifecycle, {
          subjectKey,
          op: "purge",
          outcome: "error",
          reason: "withdrawal_record_failed",
        });
      }
      purged.push({ sessionKey: subjectKey, templateRemoved: outcome.templateRemoved });
    }

    log.info("identity.voiceprint.purge_expired", {
      retention_ms: retentionMs,
      expired: expired.length,
      purged: purged.length,
      record_failures: recordFailures.length,
      purge_failures: purgeFailures.length,
    });
    return {
      ok: true as const,
      retentionMs,
      purged,
      ...(recordFailures.length > 0 ? { recordFailures } : {}),
      ...(purgeFailures.length > 0 ? { purgeFailures } : {}),
    };
  });

  // Read the append-only biometric-processing audit log (optionally per-subject).
  server.registerMethod("identity.voiceprint.get_audit_log", (conn, params) => {
    const input = parseSessionOnlyParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    try {
      // Default to the bound subject; a caller may not read another subject's log.
      const records = lifecycle.auditLog.read(sessionKey);
      return {
        ok: true as const,
        sessionKey,
        records,
      };
    } catch (error) {
      throw voiceprintLifecycleMethodError(error);
    }
  });

  // A7 — read the privacy-safe scoring-decision telemetry (scalar scores +
  // decisions + thresholds + model) and per-decision-class histograms for this
  // subject. `sessionRef` is the OPAQUE hash the sink keyed records under (never the
  // raw sessionKey). Returns empty/zeroed when telemetry is OFF (default). This is a
  // read-only distribution view; it carries no embeddings/audio/keys.
  server.registerMethod("identity.voiceprint.get_score_telemetry", (conn, params) => {
    const input = parseSessionOnlyParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    try {
      const sessionRef = hashVoiceprintSessionRef(sessionKey);
      const records = lifecycle.scoreTelemetry.read(sessionRef);
      const aggregate = lifecycle.scoreTelemetry.aggregate(sessionRef);
      return {
        ok: true as const,
        sessionKey,
        sessionRef,
        enabled: lifecycle.scoreTelemetry.enabled,
        records,
        histograms: aggregate.histograms,
        outcomeCounts: aggregate.outcomeCounts,
        decisionCounts: aggregate.decisionCounts,
        total: aggregate.total,
      };
    } catch (error) {
      throw voiceprintLifecycleMethodError(error);
    }
  });
}

export interface EnrollmentAudioSourceInput {
  audioArtifactId?: string;
  audioPath?: string;
  startMs?: number;
  endMs?: number;
  route?: string;
}

interface EnrollOwnerParams {
  sessionKey?: string;
  sources: EnrollmentAudioSourceInput[];
  consent?: Partial<VoiceprintConsentSnapshot>;
  minSpeechMs?: number;
}

interface AddEnrollmentClipParams {
  sessionKey?: string;
  source: EnrollmentAudioSourceInput;
  consent?: Partial<VoiceprintConsentSnapshot>;
  minSpeechMs?: number;
}

interface DeleteOwnerTemplateParams {
  sessionKey?: string;
  deletedAt?: string;
}

interface ReembedOwnerTemplateParams {
  sessionKey?: string;
  /** Retained enrollment source audio; empty => no retained source (stale path). */
  sources: EnrollmentAudioSourceInput[];
  minSpeechMs?: number;
}

export interface EmbeddedEnrollmentSources {
  sources: VoiceprintEnrollmentSource[];
  model: VoiceprintModelInfo;
}

export interface StoredOwnerTemplate {
  templateRef: string;
  filePath: string;
  sourceCount: number;
  ownerEmbeddingCount: number;
}

interface ScoreTurnsParams {
  sessionKey?: string;
  turns: VoiceprintScoreTurnInput[];
  consent?: Partial<VoiceprintConsentSnapshot>;
  qualityThresholds?: Partial<VoiceprintAudioQualityThresholds>;
  templateLearningReviewed?: boolean;
  eventId?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface VoiceprintAudioArtifactRegisterParams {
  sessionKey?: string;
  audioArtifactId: string;
  mediaId: string;
  sampleRate?: number;
  recordingStartMs?: number;
  recordingEndMs?: number;
  route?: string;
  registeredAt?: string;
}

interface VoiceprintScoreTurnInput {
  sessionKey?: string;
  transcriptItemId: string;
  role: "user" | "assistant";
  text?: string;
  startMs: number;
  endMs: number;
  audioArtifactId?: string;
  audioPath?: string;
  route?: string;
  /** OPTIONAL client-computed (on-device) embedding for this turn. */
  sampleEmbedding?: number[];
  /** Model+version that produced `sampleEmbedding`; must match the owner template. */
  sampleEmbeddingModel?: VoiceprintModelInfo;
  /**
   * A8 replay resistance: single-use liveness nonce from
   * identity.voiceprint.request_embedding_challenge. REQUIRED (and verified +
   * consumed) whenever a `sampleEmbedding` is accepted under
   * `acceptClientEmbeddings`.
   */
  nonce?: string;
}

function parseScoreTurnsParams(params: unknown): ScoreTurnsParams {
  const p = params as {
    sessionKey?: unknown;
    turns?: unknown;
    consent?: unknown;
    qualityThresholds?: unknown;
    templateLearningReviewed?: unknown;
    eventId?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  } | undefined;
  if (!p || !Array.isArray(p.turns)) {
    throw new MethodError("INVALID_REQUEST", "turns must be an array.");
  }

  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    turns: p.turns.map(parseScoreTurnInput),
    consent: objectOrUndefined(p.consent) as Partial<VoiceprintConsentSnapshot> | undefined,
    qualityThresholds: objectOrUndefined(p.qualityThresholds) as Partial<VoiceprintAudioQualityThresholds> | undefined,
    templateLearningReviewed:
      typeof p.templateLearningReviewed === "boolean" ? p.templateLearningReviewed : undefined,
    eventId: typeof p.eventId === "string" ? p.eventId : undefined,
    createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : undefined,
  };
}

function parseScoreTurnInput(value: unknown): VoiceprintScoreTurnInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MethodError("INVALID_REQUEST", "turn must be an object.");
  }
  const turn = value as Record<string, unknown>;
  const transcriptItemId = requiredString(turn.transcriptItemId, "turn.transcriptItemId");
  const role = requiredString(turn.role, "turn.role");
  if (!["user", "assistant"].includes(role)) {
    throw new MethodError("INVALID_REQUEST", "turn.role is invalid.");
  }

  return {
    sessionKey: typeof turn.sessionKey === "string" ? turn.sessionKey : undefined,
    transcriptItemId,
    role: role as VoiceprintScoreTurnInput["role"],
    text: typeof turn.text === "string" ? turn.text : undefined,
    startMs: requiredFiniteNumber(turn.startMs, "turn.startMs"),
    endMs: requiredFiniteNumber(turn.endMs, "turn.endMs"),
    audioArtifactId: optionalString(turn.audioArtifactId),
    audioPath: optionalString(turn.audioPath),
    route: optionalString(turn.route),
    sampleEmbedding: parseOptionalClientEmbedding(turn.sampleEmbedding),
    sampleEmbeddingModel: parseOptionalClientEmbeddingModel(
      turn.sampleEmbeddingModel ?? turn.sample_embedding_model,
    ),
    nonce: optionalString(turn.nonce),
  };
}

function parseOptionalClientEmbedding(value: unknown): number[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new MethodError("INVALID_REQUEST", "turn.sampleEmbedding must be an array of numbers.");
  }
  // Shape validation only here; usability/dimension/model checks happen in the
  // scoring core so a malformed vector cannot manufacture a spurious accept.
  return value.map((item, index) => {
    if (typeof item !== "number") {
      throw new MethodError(
        "INVALID_REQUEST",
        `turn.sampleEmbedding[${index}] must be a number.`,
      );
    }
    return item;
  });
}

function parseOptionalClientEmbeddingModel(value: unknown): VoiceprintModelInfo | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MethodError("INVALID_REQUEST", "turn.sampleEmbeddingModel must be an object.");
  }
  const model = value as Record<string, unknown>;
  const provider = requiredString(model.provider, "turn.sampleEmbeddingModel.provider");
  if (!(VOICEPRINT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new MethodError("INVALID_REQUEST", "turn.sampleEmbeddingModel.provider is invalid.");
  }
  return {
    provider: provider as VoiceprintModelInfo["provider"],
    modelId: requiredString(
      model.modelId ?? model.model_id,
      "turn.sampleEmbeddingModel.modelId",
    ),
    version: optionalString(model.version),
    notes: optionalString(model.notes),
  };
}

function parseRequestEmbeddingChallengeParams(params: unknown): { sessionKey?: string } {
  const p = objectOrUndefined(params);
  return {
    sessionKey: typeof p?.sessionKey === "string" ? p.sessionKey : undefined,
  };
}

function parseAudioArtifactRegisterParams(params: unknown): VoiceprintAudioArtifactRegisterParams {
  const p = params as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new MethodError("INVALID_REQUEST", "params required.");
  }
  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    audioArtifactId: requiredString(p.audioArtifactId, "audioArtifactId"),
    mediaId: requiredString(p.mediaId ?? p.media_id, "mediaId"),
    sampleRate: optionalPositiveFiniteNumber(p.sampleRate ?? p.sample_rate, "sampleRate"),
    recordingStartMs: optionalNonNegativeFiniteNumber(
      p.recordingStartMs ?? p.recording_start_ms,
      "recordingStartMs",
    ),
    recordingEndMs: optionalNonNegativeFiniteNumber(
      p.recordingEndMs ?? p.recording_end_ms,
      "recordingEndMs",
    ),
    route: optionalString(p.route),
    registeredAt: typeof p.registeredAt === "string" ? p.registeredAt : undefined,
  };
}

/**
 * Resolve the enrollment voiced-speech floor for an RPC.
 *
 * The client may RAISE the biometric floor but never lower it: the server-side
 * `DEFAULT_OWNER_VOICEPRINT_ENROLLMENT_MIN_SPEECH_MS` (30s) is a hard minimum, so a
 * client passing `{minSpeechMs: 0}` cannot enroll the owner from an arbitrarily short
 * clip. Returns `undefined` when the client did not supply a value so the assessment /
 * artifact builder apply the default themselves (keeping a single source of truth).
 */
function clampEnrollmentMinSpeechMs(minSpeechMs: number | undefined): number | undefined {
  if (minSpeechMs === undefined) {
    return undefined;
  }
  return Math.max(DEFAULT_OWNER_VOICEPRINT_ENROLLMENT_MIN_SPEECH_MS, minSpeechMs);
}

function parseEnrollOwnerParams(params: unknown): EnrollOwnerParams {
  const p = objectOrUndefined(params);
  if (!p || !Array.isArray(p.sources)) {
    throw new MethodError("INVALID_REQUEST", "sources must be an array.");
  }
  if (p.sources.length === 0) {
    throw new MethodError("INVALID_REQUEST", "enroll_owner requires at least one source.");
  }
  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    sources: p.sources.map(parseEnrollmentAudioSourceInput),
    consent: objectOrUndefined(p.consent) as Partial<VoiceprintConsentSnapshot> | undefined,
    minSpeechMs: clampEnrollmentMinSpeechMs(
      optionalNonNegativeFiniteNumber(p.minSpeechMs ?? p.min_speech_ms, "minSpeechMs"),
    ),
  };
}

function parseReembedOwnerTemplateParams(params: unknown): ReembedOwnerTemplateParams {
  const p = objectOrUndefined(params);
  // `sources` is OPTIONAL: omitting it (or passing an empty array) means no retained
  // enrollment source audio is available, which drives the stale/needs_reenrollment
  // path. When present it must be a non-empty array of enrollment audio sources.
  const rawSources = p?.sources;
  let sources: EnrollmentAudioSourceInput[] = [];
  if (rawSources !== undefined && rawSources !== null) {
    if (!Array.isArray(rawSources)) {
      throw new MethodError("INVALID_REQUEST", "sources must be an array.");
    }
    sources = rawSources.map(parseEnrollmentAudioSourceInput);
  }
  return {
    sessionKey: typeof p?.sessionKey === "string" ? p.sessionKey : undefined,
    sources,
    minSpeechMs: clampEnrollmentMinSpeechMs(
      optionalNonNegativeFiniteNumber(p?.minSpeechMs ?? p?.min_speech_ms, "minSpeechMs"),
    ),
  };
}

function parseAddEnrollmentClipParams(params: unknown): AddEnrollmentClipParams {
  const p = objectOrUndefined(params);
  if (!p) {
    throw new MethodError("INVALID_REQUEST", "params required.");
  }
  const rawSource = p.source ?? p.clip;
  if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
    throw new MethodError("INVALID_REQUEST", "source must be an object.");
  }
  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    source: parseEnrollmentAudioSourceInput(rawSource),
    consent: objectOrUndefined(p.consent) as Partial<VoiceprintConsentSnapshot> | undefined,
    minSpeechMs: clampEnrollmentMinSpeechMs(
      optionalNonNegativeFiniteNumber(p.minSpeechMs ?? p.min_speech_ms, "minSpeechMs"),
    ),
  };
}

function parseDeleteOwnerTemplateParams(params: unknown): DeleteOwnerTemplateParams {
  const p = objectOrUndefined(params);
  return {
    sessionKey: typeof p?.sessionKey === "string" ? p.sessionKey : undefined,
    deletedAt: typeof p?.deletedAt === "string" ? p.deletedAt : undefined,
  };
}

function parseEnrollmentAudioSourceInput(value: unknown): EnrollmentAudioSourceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MethodError("INVALID_REQUEST", "enrollment source must be an object.");
  }
  const source = value as Record<string, unknown>;
  const audioArtifactId = optionalString(source.audioArtifactId ?? source.audio_artifact_id);
  const audioPath = optionalString(source.audioPath ?? source.audio_path);
  if (!audioArtifactId && !audioPath) {
    throw new MethodError(
      "INVALID_REQUEST",
      "enrollment source requires audioArtifactId or audioPath.",
    );
  }
  const startMs = optionalNonNegativeFiniteNumber(source.startMs ?? source.start_ms, "startMs");
  const endMs = optionalNonNegativeFiniteNumber(source.endMs ?? source.end_ms, "endMs");
  if ((startMs === undefined) !== (endMs === undefined)) {
    throw new MethodError("INVALID_REQUEST", "enrollment source requires both startMs and endMs.");
  }
  if (startMs !== undefined && endMs !== undefined && endMs <= startMs) {
    throw new MethodError("INVALID_REQUEST", "enrollment source endMs must be greater than startMs.");
  }
  return {
    audioArtifactId,
    audioPath,
    startMs,
    endMs,
    route: optionalString(source.route),
  };
}

/**
 * SHARED SCORING SEAM — the whole `identity.voiceprint.score_turns` pipeline
 * (plan build -> sidecar run -> storage bundles -> audit -> A7 telemetry),
 * extracted BEHAVIOR-PRESERVINGLY from the RPC handler so the WS1 auto-scorer
 * (gateway/voiceprint-auto-score.ts) reuses it verbatim instead of duplicating
 * any scoring logic. Audit + telemetry come free via this reuse.
 *
 * FAIL-CLOSED boundary for the whole scoring path. Any throw below (bad audio
 * path, corrupt owner template, storage fault) is converted to a typed
 * MethodError by `voiceprintMethodError` and audited as an error — it NEVER
 * escapes as an unhandled crash and NEVER yields an owner-resolving result.
 * Sidecar/embedding faults degrade to a structured `error`/`skipped` run
 * (see runAndStoreLiveVoiceprintScoringPlan), not a false-accept.
 */
async function scoreVoiceprintTurnsForSession(args: {
  sessionKey: string;
  input: ScoreTurnsParams;
  scoring: VoiceprintLiveScoringConfig;
  storage: VoiceprintStorageAdapter;
  audioArtifacts: VoiceprintAudioArtifactStore;
  liveness: VoiceprintLivenessChallengeStore;
  lifecycle: VoiceprintLifecycle;
  /** Log-line label only; defaults to the RPC name so handler logs are unchanged. */
  logLabel?: string;
}): Promise<VoiceprintScoreTurnsResult> {
  const { sessionKey, input, scoring, storage, audioArtifacts, liveness, lifecycle } = args;
  const logLabel = args.logLabel ?? "identity.voiceprint.score_turns";
  const started = Date.now();

  try {
    const turns = await buildScorePlanTurns({
      sessionKey,
      input,
      scoring,
      audioArtifacts,
      liveness,
      lifecycle,
    });
    const { run, storage: storageResult } = await runAndStoreLiveVoiceprintScoringPlan({
      storage,
      sidecar: scoring.sidecar,
      turns,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    log.info(logLabel, {
      session_key: sessionKey,
      status: run.status,
      turns: turns.length,
      queued: run.plan.queued.length,
      skipped: run.plan.skipped.length,
      patches: run.patches.length,
      storage_bundle_id: run.storageBundle?.id,
      duration_ms: Date.now() - started,
    });
    emitVoiceprintAudit(lifecycle, {
      subjectKey: sessionKey,
      op: "score",
      outcome: run.status === "error" ? "error" : "ok",
      counts: { turns: turns.length, patches: run.patches.length },
    });
    // A7 privacy-safe scoring-decision telemetry: one record per SCORED turn
    // (decision + scalar score + threshold + model), and a distinct no-score
    // "error" record when the whole batch degraded. Never emits a score on the
    // skip/error path. Inert unless a recording sink is configured (default OFF).
    emitVoiceprintScoreTelemetry(lifecycle, sessionKey, run);
    return serializeScoreTurnsResult({
      sessionKey,
      turns: turns.length,
      run,
      storage: storageResult,
    });
  } catch (error) {
    emitVoiceprintAudit(lifecycle, {
      subjectKey: sessionKey,
      op: "score",
      outcome: "error",
    });
    const methodError = voiceprintMethodError(error);
    // A fault thrown BEFORE a run object exists (e.g. a batch-integrity/security
    // guard that throws rather than degrading to run.status === "error") would
    // otherwise record an audit error but ZERO telemetry — asymmetric with the
    // in-band error run that emits a scoreless `error` record. Emit one here too so
    // the error-visibility story is symmetric. Never a score on the error path.
    emitVoiceprintScoreTelemetryError(lifecycle, sessionKey, methodError.code);
    throw methodError;
  }
}

async function buildScorePlanTurns(input: {
  sessionKey: string;
  input: ScoreTurnsParams;
  scoring: VoiceprintLiveScoringConfig;
  audioArtifacts: VoiceprintAudioArtifactStore;
  liveness: VoiceprintLivenessChallengeStore;
  lifecycle: VoiceprintLifecycle;
}): Promise<LiveVoiceprintPlanItemInput[]> {
  const turns: LiveVoiceprintPlanItemInput[] = [];
  const policy = resolveScoreTurnsPolicy(
    input.scoring,
    input.input,
    input.lifecycle,
    input.sessionKey,
  );
  for (const turn of input.input.turns) {
    if (turn.sessionKey !== undefined && turn.sessionKey !== input.sessionKey) {
      throw new MethodError(
        "FORBIDDEN",
        "Voiceprint score turn sessionKey does not match the bound connection.",
      );
    }
  }

  let needsOwnerTemplate = false;
  for (const turn of input.input.turns) {
    const resolvedArtifact = resolveLiveTurnAudioArtifact({
      sessionKey: input.sessionKey,
      audioArtifactId: turn.audioArtifactId,
      startMs: turn.startMs,
      endMs: turn.endMs,
      audioArtifacts: input.audioArtifacts,
      allowedAudioRoots: input.scoring.allowedAudioRoots,
    });
    let audioPath = turn.audioPath;
    let requestStartMs: number | undefined = turn.startMs;
    let requestEndMs: number | undefined = turn.endMs;
    if (resolvedArtifact) {
      audioPath = resolvedArtifact.audioPath;
      if (resolvedArtifact.source === "store") {
        // Registered artifact carries a segment-relative window; keep the prior
        // coalescing so this path is byte-for-byte unchanged.
        requestStartMs = resolvedArtifact.requestStartMs ?? turn.startMs;
        requestEndMs = resolvedArtifact.requestEndMs ?? turn.endMs;
      } else {
        // Segmented live resolution computed a SEGMENT-RELATIVE (padded) window.
        // It must be passed through verbatim: leaving it undefined would let the
        // queue's `?? turn.startMs` fallback re-slice the 3s segment file by
        // FULL-RECORDING offsets — beyond the file for every segment after the
        // first, yielding empty audio ("segment too short" from the sidecar).
        requestStartMs = resolvedArtifact.requestStartMs;
        requestEndMs = resolvedArtifact.requestEndMs;
      }
    }
    // A turn is scored from its client-supplied embedding ONLY when the gateway
    // is explicitly opted in AND the turn actually carries one. Otherwise the
    // client vector is ignored for direct scoring and the turn keeps the audio
    // path (or is skipped if it has no usable audio).
    const useClientEmbedding =
      input.scoring.acceptClientEmbeddings === true && turn.sampleEmbedding !== undefined;

    // A turn is only scored from its client embedding when the opt-in is on, the
    // turn carries a vector, AND it is a consentful `user` turn with a usable
    // audio artifact reference. Compute that eligibility up front so the A8
    // liveness nonce is consumed ONLY on the path that actually trusts the
    // vector (see the gate below).
    const scoresClientEmbedding =
      useClientEmbedding &&
      turn.role === "user" &&
      Boolean(turn.audioArtifactId) &&
      Boolean(audioPath) &&
      voiceprintConsentAllowsProcessing(policy.consent);

    // A8 replay-resistance gate. When this turn will actually be scored from a
    // client embedding, the submission MUST present a fresh, single-use,
    // session-bound liveness nonce that we verify + consume BEFORE the vector is
    // trusted. Any nonce failure (missing / unknown / expired / wrong session /
    // already used) rejects the turn — we DO NOT fall through to accepting the
    // vector and we DO NOT silently score it. Consuming here makes an identical
    // resubmission fail (the nonce is burned). We intentionally consume ONLY when
    // `scoresClientEmbedding` (not merely when a vector is present) so a turn that
    // carries a vector+nonce but is ineligible (wrong role / missing artifact /
    // consent denied) does NOT burn a fresh nonce it can never spend. This is
    // ONLY replay resistance, not capture-binding (see liveness-nonce.ts HONESTY).
    if (scoresClientEmbedding) {
      // A5 PRODUCTION GUARD: a client-supplied embedding tagged with the
      // non-discriminative reference model must never score a real user under the
      // guard. Reject before the nonce is consumed so an ineligible submission does
      // not burn a fresh nonce.
      assertDiscriminativeVoiceprintModel(
        input.scoring.requireDiscriminativeModel,
        turn.sampleEmbeddingModel,
        "Voiceprint client embedding",
        "score it",
      );
      assertClientEmbeddingLivenessNonce({
        sessionKey: input.sessionKey,
        nonce: turn.nonce,
        liveness: input.liveness,
      });
    }

    const planTurn: LiveVoiceprintPlanItemInput = {
      sessionKey: input.sessionKey,
      transcriptItemId: turn.transcriptItemId,
      role: turn.role,
      text: turn.text,
      startMs: turn.startMs,
      endMs: turn.endMs,
      audioArtifactId: turn.audioArtifactId,
      route: turn.route,
      audioPath,
      requestStartMs,
      requestEndMs,
      targetSampleRate: input.scoring.targetSampleRate,
      timeoutMs: input.scoring.timeoutMs,
      ownerEmbeddings: [],
      thresholds: input.scoring.thresholds,
      expectedModel: input.scoring.expectedModel,
      consent: policy.consent,
      qualityThresholds: policy.qualityThresholds,
      templateLearningReviewed: policy.templateLearningReviewed,
      eventId: input.input.eventId,
      createdAt: input.input.createdAt,
      updatedAt: input.input.updatedAt,
      // A3 AS-Norm: OPT-IN, default OFF. Only set when config resolved an
      // enabled cohort; otherwise undefined => raw-cosine scoring is unchanged.
      asNorm: input.scoring.asNorm
        ? {
          cohort: input.scoring.asNorm.cohort,
          thresholds: input.scoring.asNorm.normalizedThresholds,
          ...(input.scoring.asNorm.topN !== undefined ? { topN: input.scoring.asNorm.topN } : {}),
        }
        : undefined,
    };

    if (scoresClientEmbedding) {
      // On-device path: score the client embedding directly. We DO NOT read or
      // slice the biometric audio here — the server never sees it. The audio
      // artifact reference (audioArtifactId + registered audioPath) is still
      // required to build the job, but the file is never read. A device-attested
      // quality lets the shared scoring path run without server-side samples.
      planTurn.acceptClientEmbeddings = true;
      planTurn.sampleEmbedding = turn.sampleEmbedding;
      planTurn.sampleEmbeddingModel = turn.sampleEmbeddingModel;
      planTurn.quality = deviceAttestedVoiceprintQuality();
      needsOwnerTemplate = true;
    } else if (
      turn.role === "user" &&
      turn.audioArtifactId &&
      audioPath &&
      voiceprintConsentAllowsProcessing(policy.consent)
    ) {
      const allowedAudioPath = resolveAllowedAudioPath(
        audioPath,
        input.scoring.allowedAudioRoots,
      );
      planTurn.audioPath = allowedAudioPath;
      const audio = sliceWavAudio(await readWavFile(allowedAudioPath), requestStartMs, requestEndMs);
      planTurn.samples = audio.samples;
      planTurn.sampleRate = audio.sampleRate;
      needsOwnerTemplate = true;
    }

    turns.push(planTurn);
  }

  if (needsOwnerTemplate) {
    const ownerTemplate = resolveOwnerVoiceprintTemplate(input.scoring);
    for (const turn of turns) {
      turn.ownerTemplateRef = ownerTemplate.ownerTemplateRef;
      turn.ownerEmbeddings = ownerTemplate.ownerEmbeddings;
      // Model-match (requirement 3) MUST be enforced even when config
      // `expected_model` is unset — for BOTH the client-embedding path AND the
      // ordinary audio-sidecar path. Cosine is only meaningful when the sample
      // and the owner template came from the same model+version, so the
      // sidecar's ACTUAL returned model (checked in
      // scoreLiveVoiceprintScoringJobResponse) must equal the model the owner
      // template was enrolled with. The owner template itself carries that
      // model, so derive the expected model from it. Config `expected_model`,
      // when present, takes precedence (and is already cross-checked against the
      // template model in resolveOwnerVoiceprintTemplate). When the owner
      // template has no model tag (inline ownerEmbeddings source), this stays
      // whatever `expected_model` resolved to.
      turn.expectedModel =
        input.scoring.expectedModel ?? ownerTemplate.ownerTemplateModel ?? turn.expectedModel;
      // A5 PRODUCTION GUARD: propagate the discriminative-model requirement onto
      // the turn so the sidecar's returned per-turn model is re-validated at
      // score time (the config env is only the DECLARED backend, not proof of
      // the model the sidecar actually emitted).
      turn.requireDiscriminativeModel = input.scoring.requireDiscriminativeModel;
    }
  }

  return turns;
}

/**
 * A8 replay-resistance gate for a client-supplied embedding. A missing nonce is
 * rejected up front with a clear reason; otherwise the nonce is verified AND
 * consumed (single-use) against the session. Any failure throws so the turn is
 * rejected — never scored from the untrusted vector.
 */
function assertClientEmbeddingLivenessNonce(input: {
  sessionKey: string;
  nonce: string | undefined;
  liveness: VoiceprintLivenessChallengeStore;
}): void {
  const nonce = input.nonce?.trim();
  if (!nonce) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint client embedding requires a liveness nonce from identity.voiceprint.request_embedding_challenge (replay resistance).",
    );
  }
  const outcome = input.liveness.verifyAndConsume(input.sessionKey, nonce);
  if (!outcome.ok) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      livenessRejectionMessage(outcome.reason),
    );
  }
}

function livenessRejectionMessage(reason: VoiceprintLivenessRejectionReason): string {
  switch (reason) {
    case "unknown_nonce":
      return "Voiceprint client embedding liveness nonce is unknown (never issued or already evicted).";
    case "expired":
      return "Voiceprint client embedding liveness nonce has expired; request a fresh challenge.";
    case "wrong_session":
      return "Voiceprint client embedding liveness nonce was issued for a different session.";
    case "already_used":
      return "Voiceprint client embedding liveness nonce has already been used (replay rejected).";
  }
}

async function runAndStoreLiveVoiceprintScoringPlan(input: {
  storage: VoiceprintStorageAdapter;
  sidecar: EmbeddingSidecarCommand;
  turns: readonly LiveVoiceprintPlanItemInput[];
  createdAt?: string;
  updatedAt?: string;
}): Promise<{
  run: LiveVoiceprintScoringPlanRun;
  storage: VoiceprintStorageApplyResult | null;
}> {
  const plan = buildLiveVoiceprintScoringPlan({ turns: input.turns });
  const initialBundle = bundleForStates(plan.states, input.updatedAt ?? input.createdAt);
  const initialStorage = initialBundle ? await input.storage.applyBundle(initialBundle) : null;

  if (plan.jobContexts.length === 0) {
    // No sidecar jobs. If any turns were scored from a client embedding, still
    // build their patches WITHOUT spawning the sidecar; otherwise nothing to do.
    if (plan.clientScored.length === 0) {
      return {
        run: {
          version: 1,
          status: plan.status === "empty" ? "empty" : "skipped",
          plan,
          batch: null,
          patches: [],
          states: plan.states,
          storageBundle: initialBundle,
        },
        storage: initialStorage,
      };
    }
    const clientBatch = clientOnlyGuardedBatchResult(plan);
    const currentStates = currentTranscriptStatesForPlan(
      requireVoiceprintStorageSnapshot(input.storage),
      plan,
      input.createdAt,
    );
    const patches = buildVoiceprintTranscriptIdentityStatePatches({
      batch: clientBatch,
      existingStates: currentStates,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      staleUpdateHandling: "ignore",
    });
    const states = mergeVoiceprintStatePatches(currentStates, patches);
    const finalBundle = bundleForPatches(patches, input.updatedAt ?? input.createdAt);
    const finalStorage = finalBundle ? await input.storage.applyBundle(finalBundle) : initialStorage;
    return {
      run: {
        version: 1,
        status: statusForGuardedRun(plan, clientBatch.status, patches),
        plan,
        batch: clientBatch,
        patches,
        states,
        storageBundle: finalBundle ?? initialBundle,
      },
      storage: finalStorage,
    };
  }

  let batch: Awaited<ReturnType<typeof runLiveVoiceprintScoringJobs>>;
  try {
    batch = mergeClientScoredIntoGuardedBatch(
      await runLiveVoiceprintScoringJobs({
        sidecar: input.sidecar,
        jobs: plan.jobContexts,
      }),
      plan,
    );
  } catch (error) {
    // FAIL-CLOSED: a sidecar fault degrades this batch to a structured `error`
    // run instead of throwing. Every sidecar-bound turn is marked errored (never
    // resolved), so no speaker is falsely accepted on a scoring failure.
    const message = errorMessage(error);
    const currentStates = currentTranscriptStatesForPlan(
      requireVoiceprintStorageSnapshot(input.storage),
      plan,
      input.createdAt,
    );
    // Client-embedding-scored turns do not depend on the sidecar, so resolve
    // them from clientScored even though the sidecar failed; only the
    // sidecar-bound scoring states are marked errored.
    const erroredStates = markCurrentVoiceprintScoringStatesErrored({
      plan,
      states: currentStates,
      message,
      updatedAt: input.updatedAt,
    });
    const states =
      plan.clientScored.length > 0
        ? mergeVoiceprintStatePatches(
            erroredStates,
            buildVoiceprintTranscriptIdentityStatePatches({
              batch: clientOnlyGuardedBatchResult(plan),
              existingStates: currentStates,
              createdAt: input.createdAt,
              updatedAt: input.updatedAt,
              staleUpdateHandling: "ignore",
            }),
          )
        : erroredStates;
    const finalBundle = bundleForChangedStates(states, currentStates, input.updatedAt ?? input.createdAt);
    const finalStorage = finalBundle ? await input.storage.applyBundle(finalBundle) : initialStorage;
    return {
      run: {
        version: 1,
        status: "error",
        plan,
        batch: null,
        patches: [],
        states,
        storageBundle: finalBundle ?? initialBundle,
        error: {
          code: "sidecar_failed",
          message,
        },
      },
      storage: finalStorage,
    };
  }

  const currentStates = currentTranscriptStatesForPlan(
    requireVoiceprintStorageSnapshot(input.storage),
    plan,
    input.createdAt,
  );
  const patches = buildVoiceprintTranscriptIdentityStatePatches({
    batch,
    existingStates: currentStates,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    staleUpdateHandling: "ignore",
  });
  const states = mergeVoiceprintStatePatches(currentStates, patches);
  const finalBundle = bundleForPatches(patches, input.updatedAt ?? input.createdAt);
  const finalStorage = finalBundle ? await input.storage.applyBundle(finalBundle) : initialStorage;

  return {
    run: {
      version: 1,
      status: statusForGuardedRun(plan, batch.status, patches),
      plan,
      batch,
      patches,
      states,
      storageBundle: finalBundle ?? initialBundle,
    },
    storage: finalStorage,
  };
}

function clientOnlyGuardedBatchResult(
  plan: LiveVoiceprintScoringPlan,
): LiveVoiceprintScoringBatchResult {
  return {
    status: "scored",
    request: null,
    model: plan.clientScored[0]?.response.model,
    results: [...plan.clientScored],
    skipped: [],
  };
}

function mergeClientScoredIntoGuardedBatch(
  batch: LiveVoiceprintScoringBatchResult,
  plan: LiveVoiceprintScoringPlan,
): LiveVoiceprintScoringBatchResult {
  if (plan.clientScored.length === 0) {
    return batch;
  }
  return {
    ...batch,
    results: [...batch.results, ...plan.clientScored],
  };
}

function requireVoiceprintStorageSnapshot(storage: VoiceprintStorageAdapter): VoiceprintStorageSnapshot {
  if (!storage.snapshot) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint score_turns requires storage snapshot support for stale result guards.",
    );
  }
  return storage.snapshot();
}

function currentTranscriptStatesForPlan(
  snapshot: VoiceprintStorageSnapshot,
  plan: LiveVoiceprintScoringPlan,
  createdAt?: string,
): VoiceprintTranscriptIdentityState[] {
  const currentByJoin = new Map(
    snapshot.transcriptIdentityStates.map((state) => [transcriptJoinKey(state), state] as const),
  );
  return plan.states.map((state) => {
    const current = currentByJoin.get(transcriptJoinKey(state));
    if (current) {
      return current;
    }
    return buildVoiceprintTranscriptIdentityState({
      sessionKey: state.sessionKey,
      transcriptItemId: state.transcriptItemId,
      lifecycle: "not_applicable",
      createdAt,
    });
  });
}

function mergeVoiceprintStatePatches(
  states: readonly VoiceprintTranscriptIdentityState[],
  patches: readonly VoiceprintTranscriptIdentityStatePatch[],
): VoiceprintTranscriptIdentityState[] {
  const byJoin = new Map(states.map((state) => [transcriptJoinKey(state), state] as const));
  for (const patch of patches) {
    byJoin.set(transcriptJoinKey(patch), patch.state);
  }
  return [...byJoin.values()];
}

function markCurrentVoiceprintScoringStatesErrored(input: {
  plan: LiveVoiceprintScoringPlan;
  states: readonly VoiceprintTranscriptIdentityState[];
  message: string;
  updatedAt?: string;
}): VoiceprintTranscriptIdentityState[] {
  const activeJobs = new Map(
    input.plan.queued.map((queued) => [transcriptJoinKey(queued.state), queued.job] as const),
  );
  return input.states.map((state) => {
    const job = activeJobs.get(transcriptJoinKey(state));
    if (
      !job ||
      state.lifecycle !== "scoring" ||
      state.jobId !== job.id ||
      state.requestId !== job.embeddingRequest.id
    ) {
      return state;
    }
    return markVoiceprintTranscriptStateError({
      state,
      code: "sidecar_failed",
      message: input.message,
      updatedAt: input.updatedAt,
    });
  });
}

function bundleForStates(
  states: readonly VoiceprintTranscriptIdentityState[],
  createdAt?: string,
): VoiceprintStorageBundle | null {
  if (states.length === 0) {
    return null;
  }
  return buildVoiceprintStorageBundle({ states, createdAt });
}

function bundleForPatches(
  patches: readonly VoiceprintTranscriptIdentityStatePatch[],
  createdAt?: string,
): VoiceprintStorageBundle | null {
  if (patches.length === 0) {
    return null;
  }
  return buildVoiceprintStorageBundle({
    states: patches.map((patch) => patch.state),
    patches,
    createdAt,
  });
}

function bundleForChangedStates(
  states: readonly VoiceprintTranscriptIdentityState[],
  previous: readonly VoiceprintTranscriptIdentityState[],
  createdAt?: string,
): VoiceprintStorageBundle | null {
  const previousByJoin = new Map(previous.map((state) => [transcriptJoinKey(state), state] as const));
  const changed = states.filter((state) => {
    const prior = previousByJoin.get(transcriptJoinKey(state));
    return !prior || JSON.stringify(prior) !== JSON.stringify(state);
  });
  return bundleForStates(changed, createdAt);
}

function statusForGuardedRun(
  plan: LiveVoiceprintScoringPlan,
  batchStatus: "scored" | "partial" | "skipped",
  patches: readonly VoiceprintTranscriptIdentityStatePatch[],
): LiveVoiceprintScoringPlanRunStatus {
  if (patches.length === 0 && plan.jobContexts.length > 0) {
    return "skipped";
  }
  if (batchStatus === "skipped") {
    return plan.skipped.length > 0 ? "partial" : "skipped";
  }
  if (plan.skipped.length > 0 || batchStatus === "partial" || patches.length < plan.jobContexts.length) {
    return "partial";
  }
  return "scored";
}

function transcriptJoinKey(input: { sessionKey: string; transcriptItemId: string }): string {
  return JSON.stringify([input.sessionKey, input.transcriptItemId]);
}

/**
 * FAIL-CLOSED wrapper for the two owner-template load/extract steps. Runs `load`
 * and relabels any RAW fault (decrypt failure, corrupt JSON, no usable embeddings)
 * as a typed FAILED_PRECONDITION so the RPC refuses to score rather than falling
 * through to a resolve. A MethodError thrown by an intentional guard is re-thrown
 * unchanged so its specific code/message survives.
 */
function useOwnerTemplate<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof MethodError) {
      throw error;
    }
    throw new MethodError(
      "FAILED_PRECONDITION",
      `Voiceprint live scorer owner template is not usable: ${errorMessage(error)}`,
    );
  }
}

function resolveOwnerVoiceprintTemplate(scoring: VoiceprintLiveScoringConfig): {
  ownerEmbeddings: number[][];
  ownerTemplateRef?: string;
  ownerTemplateModel?: VoiceprintModelInfo;
} {
  const sourceCount = [
    scoring.ownerTemplateArtifact,
    scoring.ownerTemplateFile,
    scoring.ownerTemplateFileSource,
    scoring.ownerEmbeddings?.length ? scoring.ownerEmbeddings : undefined,
  ].filter(Boolean).length;
  if (sourceCount > 1) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint live scorer must configure exactly one owner template source.",
    );
  }

  if (
    scoring.ownerTemplateArtifact ||
    scoring.ownerTemplateFile ||
    scoring.ownerTemplateFileSource
  ) {
    // FAIL-CLOSED: a template that cannot be loaded/decrypted (corrupt file, wrong
    // key, missing ref) must never fall through to a score. `useOwnerTemplate`
    // relabels any raw fault as a typed FAILED_PRECONDITION so the RPC refuses
    // rather than resolving an owner. (Genuine typed guards below re-throw as-is.)
    const artifact = useOwnerTemplate(() => {
      const fileRef = scoring.ownerTemplateFile
        ?? (scoring.ownerTemplateFileSource
          ? voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource)
          : undefined);
      return scoring.ownerTemplateArtifact
        ?? readEncryptedVoiceprintTemplateArtifact(fileRef!);
    });

    const templateModel = artifact.template.model;
    // A5 PRODUCTION GUARD: refuse to score against a reference-tagged owner template
    // when the guard is on — the reference backend is non-discriminative, so any
    // "score" it produces is meaningless for a real user.
    assertDiscriminativeVoiceprintModel(
      scoring.requireDiscriminativeModel,
      templateModel,
      "Voiceprint owner template",
      "score it (re-enroll with a real discriminative model)",
    );
    // A5 MODEL-VERSION MISMATCH: cosine between the owner template and a turn is only
    // meaningful when both were produced by the same model+version. When the scoring
    // model (config expected_model) differs from the STORED template model, the
    // template is incomparable: fail with a clear needs_reenrollment instead of a
    // silent mismatched score. (A backfill re-embed is available separately via
    // identity.voiceprint.reembed_owner_template.)
    const mismatch = classifyVoiceprintModelMismatch(scoring.expectedModel, templateModel);
    if (mismatch.kind === "mismatch") {
      throw new MethodError(
        "FAILED_PRECONDITION",
        `needs_reenrollment: voiceprint owner template model ${formatVoiceprintModel(mismatch.templateModel)} does not match the current scorer model ${formatVoiceprintModel(mismatch.scoringModel)}; the template is incomparable. Re-embed the owner template with the current model or re-enroll.`,
      );
    }

    // Same FAIL-CLOSED relabeling for the embedding-extraction step: a template
    // that parses but has no usable owner embeddings must refuse, not resolve.
    return useOwnerTemplate(() => ({
      ownerEmbeddings: ownerEmbeddingsFromVoiceprintTemplateArtifact(artifact),
      ownerTemplateRef: ownerTemplateRefForArtifact(scoring, artifact),
      ownerTemplateModel: templateModel,
    }));
  }

  if (scoring.ownerEmbeddings?.length) {
    // NOTE (A5): this inline ownerEmbeddings source carries NO model tag, so it is
    // exempt from the reference/model-mismatch guards above by design. It is NOT
    // reachable from operator config (resolveVoiceprintLiveScoringConfigFromConfig
    // only ever populates ownerTemplateFileSource, never ownerEmbeddings) — it
    // exists solely for programmatic registerVoiceprintMethods wiring in
    // tests/embedders. If a future config path ever populates ownerEmbeddings,
    // route it through a model-tagged template so the guard applies.
    return {
      ownerEmbeddings: scoring.ownerEmbeddings,
      ownerTemplateRef: scoring.ownerTemplateRef,
    };
  }

  throw new MethodError(
    "FAILED_PRECONDITION",
    "Voiceprint live scorer requires an owner voice template or owner embeddings.",
  );
}

// ── Enrollment helpers ─────────────────────────────────────────────────────

/**
 * The owner enrollment RPCs require a file-backed encrypted template source so
 * enroll -> score wiring goes through the same store. Ad-hoc `ownerEmbeddings` /
 * inline `ownerTemplateArtifact` scoring configs have no place to persist an
 * enrollment, so they are rejected here (this is intentional: enrollment is only
 * meaningful against the durable encrypted store).
 */
function requireEnrollmentScoringConfig(
  scoring: VoiceprintLiveScoringConfig | undefined,
): VoiceprintLiveScoringConfig & { ownerTemplateFileSource: VoiceprintTemplateFileSource } {
  if (!scoring) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint enrollment is not configured on this gateway.",
    );
  }
  if (!scoring.ownerTemplateFileSource) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint enrollment requires a file-backed encrypted owner template store (voiceprint.live_scoring.owner_template).",
    );
  }
  return scoring as VoiceprintLiveScoringConfig & {
    ownerTemplateFileSource: VoiceprintTemplateFileSource;
  };
}

/** Enrollment is a biometric capture: consent must allow capture + biometric. */
function assertEnrollmentConsent(
  scoring: VoiceprintLiveScoringConfig,
  clientConsent: Partial<VoiceprintConsentSnapshot> | undefined,
  lifecycle: VoiceprintLifecycle,
  subjectKey: string,
): void {
  // The persisted ledger can only FURTHER-RESTRICT (never widen): fold the
  // config+inline consent, then AND it with the persisted effective consent when
  // enforcement is enabled. When enforcement is off, the ledger is inert here.
  const consent = restrictVoiceprintConsentWithLedger(
    scoring.consent,
    clientConsent,
    lifecycle,
    subjectKey,
  );
  if (!voiceprintConsentAllowsProcessing(consent)) {
    throw new MethodError(
      "FORBIDDEN",
      `Voiceprint enrollment requires capture and biometric consent (${consent.reason ?? "consent_denied"}).`,
    );
  }
}

/**
 * Run the enrollment consent gate and audit its outcome, DISTINGUISHING a real
 * consent denial (a typed `FORBIDDEN` MethodError) from a persisted-ledger store
 * fault (a raw Error carrying an on-disk path from a corrupt/tampered ledger).
 *
 * A denial is audited `rejected`/`consent_denied` and re-thrown untouched. A store
 * fault is audited `error`/`consent_store_unavailable` (NOT `consent_denied`, which
 * would falsely record the subject as denied) and re-thrown as the SANITIZED
 * lifecycle MethodError so the caller never sees the raw path-leaking message.
 */
function assertEnrollmentConsentAudited(
  scoring: VoiceprintLiveScoringConfig,
  clientConsent: Partial<VoiceprintConsentSnapshot> | undefined,
  lifecycle: VoiceprintLifecycle,
  subjectKey: string,
): void {
  try {
    assertEnrollmentConsent(scoring, clientConsent, lifecycle, subjectKey);
  } catch (error) {
    if (error instanceof MethodError) {
      emitVoiceprintAudit(lifecycle, {
        subjectKey,
        op: "enroll",
        outcome: "rejected",
        reason: "consent_denied",
      });
      throw error;
    }
    // Not a denial: the persisted ledger read itself faulted (corrupt/unreadable).
    emitVoiceprintAudit(lifecycle, {
      subjectKey,
      op: "enroll",
      outcome: "error",
      reason: "consent_store_unavailable",
    });
    throw voiceprintLifecycleMethodError(error);
  }
}

/**
 * Restrict-only merge of config consent, inline consent, AND (when enforcement is
 * on) the persisted ledger's effective consent. The persisted ledger NEVER widens
 * — a subject with no persisted grant, or a withdrawn subject, cannot process even
 * if config+inline would allow it. When `enforceConsentLedger` is false, the
 * ledger is ignored (existing behavior).
 */
function restrictVoiceprintConsentWithLedger(
  serverConsent: Partial<VoiceprintConsentSnapshot> | undefined,
  clientConsent: Partial<VoiceprintConsentSnapshot> | undefined,
  lifecycle: VoiceprintLifecycle,
  subjectKey: string,
): VoiceprintConsentSnapshot {
  const base = restrictVoiceprintConsent(serverConsent, clientConsent);
  if (!lifecycle.enforceConsentLedger) {
    return base;
  }
  // A file-backed ledger's `effective()` can throw a raw path-leaking Error when
  // the store is corrupt/unreadable. Re-type it so downstream handler classifiers
  // treat it as a sanitized server storage fault, never a client bad-request or a
  // consent denial. (Fail-closed is preserved: the throw propagates, it never
  // widens consent.)
  let effective: ReturnType<typeof lifecycle.consentLedger.effective>;
  try {
    effective = lifecycle.consentLedger.effective(subjectKey);
  } catch (error) {
    throw new VoiceprintConsentLedgerStoreError(errorMessage(error));
  }
  return restrictVoiceprintConsent(base, {
    captureAllowed: effective.scopes.capture && effective.active,
    biometricAllowed: effective.scopes.biometric && effective.active,
    memoryPromotionAllowed: effective.scopes.memoryPromotion && effective.active,
    exportAllowed: effective.scopes.export && effective.active,
    reason: effective.active ? undefined : "no_persisted_voiceprint_consent",
  });
}

// ── A4 lifecycle helpers ────────────────────────────────────────────────────

interface VoiceprintSubjectPurgeOutcome {
  templateRemoved: boolean;
  templateRef?: string;
  storageRemoved: VoiceprintStorageCounts;
}

/**
 * The right-to-erasure primitive shared by withdraw_consent and purge_expired:
 * (1) delete the encrypted owner template (idempotent, reuses deleteOwnerTemplate),
 * (2) purge ALL derived voiceprint storage states/bundles for the subject,
 * (3) evict the in-memory realtime turn tracker (raw-audio pointers, speech-window
 *     timing, transcript-identity joins), the session-keyed audio-artifact cache
 *     (raw-audio file references), and the WS1 auto-score state (evidence verdict,
 *     pending piggyback buffer of derived identity states, turn queue, in-flight
 *     batch) for the subject. After this runs, no owner template resolves, no
 *     derived state remains, and no in-memory biometric-derived artifact is left
 *     resident. Idempotent: re-running on an already-purged subject is a no-op
 *     with zero counts.
 */
async function purgeVoiceprintSubject(input: {
  sessionKey: string;
  scoring?: VoiceprintLiveScoringConfig;
  storage: VoiceprintStorageAdapter;
  realtime: VoiceprintRealtimeSessionStore;
  audioArtifacts: VoiceprintAudioArtifactStore;
  /** WS1 auto-scorer (present only when `auto_score_finalized` is on). */
  autoScorer?: VoiceprintAutoScorer;
  deletedAt: string;
}): Promise<VoiceprintSubjectPurgeOutcome> {
  // WS1: drop the subject's auto-score state FIRST — evidence verdict, the
  // pendingScoredStates piggyback buffer (derived-biometric records), the turn
  // queue, and the in-flight marker. Resetting BEFORE the storage purge means an
  // already-running batch that persists a bundle between here and `purgeSubject`
  // is still erased below, and the drain loop's map-identity guard drops its
  // late results instead of resurrecting evidence/piggyback state. Residual
  // narrow race (accepted): a batch whose `purgeSubject` write starts AFTER ours
  // finishes can leave one post-purge bundle; re-running the purge (idempotent)
  // reconciles it.
  input.autoScorer?.reset(input.sessionKey);

  let templateRemoved = false;
  let templateRef: string | undefined;
  if (input.scoring?.ownerTemplateFileSource) {
    const removed = deleteOwnerTemplate(
      input.scoring as VoiceprintLiveScoringConfig & {
        ownerTemplateFileSource: VoiceprintTemplateFileSource;
      },
      input.deletedAt,
    );
    templateRemoved = removed.removed;
    templateRef = removed.templateRef;
  }

  let storageRemoved: VoiceprintStorageCounts = {
    transcriptIdentityStates: 0,
    speakerTurnTags: 0,
    identitySignals: 0,
    transcriptSpeakerAnnotations: 0,
    eventParticipations: 0,
  };
  if (input.storage.purgeSubject) {
    const purge = await input.storage.purgeSubject(input.sessionKey);
    storageRemoved = purge.removed;
  }

  // Evict in-memory biometric-derived artifacts for the subject: the realtime
  // turn tracker (audioByWindow / audioByTranscript / speechWindows — raw-audio
  // pointers, speech-window timing, transcript-identity join) and the session-keyed
  // audio-artifact cache (raw-audio file references). Without this, withdrawal
  // leaves these resident for the whole session lifetime.
  input.realtime.reset(input.sessionKey);
  input.audioArtifacts.reset?.(input.sessionKey);

  return { templateRemoved, templateRef, storageRemoved };
}

function flattenPurgeCounts(counts: VoiceprintStorageCounts): Record<string, number> {
  return {
    statesCleared: counts.transcriptIdentityStates,
    speakerTurnTagsCleared: counts.speakerTurnTags,
    identitySignalsCleared: counts.identitySignals,
    annotationsCleared: counts.transcriptSpeakerAnnotations,
    eventParticipationsCleared: counts.eventParticipations,
  };
}

/**
 * Emit one metadata-only audit record. The record is scanned for secrets by the
 * audit store's `append` (assertVoiceprintAuditRecordHasNoSecrets) before it is
 * persisted; a bad record throws rather than leaking. Audit failures are isolated
 * so a lifecycle store hiccup never takes down the primary operation.
 */
/**
 * A7 — emit privacy-safe scoring-decision telemetry for a completed score run.
 *
 * One telemetry record per SCORED turn carries the scalar score + decision +
 * threshold + model. The `sessionRef` is an OPAQUE hash of the sessionKey (never the
 * raw key, which could be PII). When the whole batch degraded to an `error` run, we
 * emit a single distinct `error` record with NO score/decision (the constraint: do
 * not emit a score on the failure/skip path). The sink guards every record against
 * embedding/audio/key leaks; the default no-op sink records nothing (telemetry OFF).
 */
function emitVoiceprintScoreTelemetry(
  lifecycle: VoiceprintLifecycle,
  sessionKey: string,
  run: LiveVoiceprintScoringPlanRun,
): void {
  const sink = lifecycle.scoreTelemetry;
  if (!sink.enabled) {
    // OFF by default: skip building any record so scoring stays byte-for-byte
    // unchanged. (The no-op sink would drop records anyway; this avoids the work.)
    return;
  }
  const sessionRef = hashVoiceprintSessionRef(sessionKey);
  const at = new Date().toISOString();
  try {
    if (run.status === "error") {
      sink.record({
        version: 1,
        op: "score",
        at,
        outcome: "error",
        sessionRef,
        ...(run.error?.code !== undefined ? { reason: run.error.code } : {}),
      });
      return;
    }
    for (const result of run.batch?.results ?? []) {
      const score = result.result.score;
      const model = result.response.model;
      sink.record({
        version: 1,
        op: "score",
        at,
        outcome: "scored",
        sessionRef,
        decision: score.decision,
        score: score.similarity,
        thresholdUsed: score.thresholdUsed,
        ...(model?.provider !== undefined ? { modelProvider: model.provider } : {}),
        ...(model?.modelId !== undefined ? { modelId: model.modelId } : {}),
        ...(model?.version !== undefined ? { modelVersion: model.version } : {}),
      });
    }
    // A turn can be dropped WITHIN a successful/partial run (consent filter, missing
    // audio, unusable client/sidecar embedding). Those turns are never scored, so we
    // emit a scoreless `skipped` record (reason only, no score/decision) rather than
    // dropping them silently — otherwise `outcomeCounts.skipped` is always 0 in real
    // telemetry and decision/skip drift is under-reported. This preserves the
    // "never a bogus score on the skip path" rule (no score field is set).
    for (const skipped of run.plan.skipped) {
      sink.record({
        version: 1,
        op: "score",
        at,
        outcome: "skipped",
        sessionRef,
        reason: skipped.reason,
      });
    }
    for (const rejected of run.plan.clientRejected) {
      sink.record({
        version: 1,
        op: "score",
        at,
        outcome: "skipped",
        sessionRef,
        reason: rejected.reason,
      });
    }
    for (const skipped of run.batch?.skipped ?? []) {
      sink.record({
        version: 1,
        op: "score",
        at,
        outcome: "skipped",
        sessionRef,
        reason: skipped.reason,
      });
    }
  } catch (error) {
    log.warn("identity.voiceprint.score_telemetry_failed", {
      session_key: sessionKey,
      error: errorMessage(error),
    });
  }
}

/**
 * Emit a single scoreless `error` telemetry record for a score_turns fault that
 * THREW before a run object was produced (so `emitVoiceprintScoreTelemetry` never
 * ran). `reason` is the sanitized MethodError code — a stable non-biometric class
 * string, never a raw path/message. Failure-isolated and inert unless a recording
 * sink is configured (default OFF); never emits a score.
 */
function emitVoiceprintScoreTelemetryError(
  lifecycle: VoiceprintLifecycle,
  sessionKey: string,
  reason: string,
): void {
  const sink = lifecycle.scoreTelemetry;
  if (!sink.enabled) {
    return;
  }
  try {
    sink.record({
      version: 1,
      op: "score",
      at: new Date().toISOString(),
      outcome: "error",
      sessionRef: hashVoiceprintSessionRef(sessionKey),
      reason,
    });
  } catch (error) {
    log.warn("identity.voiceprint.score_telemetry_failed", {
      session_key: sessionKey,
      error: errorMessage(error),
    });
  }
}

function emitVoiceprintAudit(
  lifecycle: VoiceprintLifecycle,
  entry: {
    subjectKey: string;
    op: VoiceprintAuditOp;
    outcome: VoiceprintAuditRecord["outcome"];
    counts?: Record<string, number>;
    templateRef?: string;
    reason?: string;
    at?: string;
  },
): void {
  try {
    lifecycle.auditLog.append({
      version: 1,
      subjectKey: entry.subjectKey,
      op: entry.op,
      at: entry.at ?? new Date().toISOString(),
      outcome: entry.outcome,
      ...(entry.counts !== undefined ? { counts: entry.counts } : {}),
      ...(entry.templateRef !== undefined ? { templateRef: entry.templateRef } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    });
  } catch (error) {
    log.warn("identity.voiceprint.audit_append_failed", {
      subject_key: entry.subjectKey,
      op: entry.op,
      error: errorMessage(error),
    });
  }
}

function serializeEffectiveConsent(effective: VoiceprintEffectiveConsent): {
  subjectKey: string;
  active: boolean;
  scopes: VoiceprintEffectiveConsent["scopes"];
  grantedAt?: string;
  withdrawnAt?: string;
} {
  return {
    subjectKey: effective.subjectKey,
    active: effective.active,
    scopes: effective.scopes,
    ...(effective.grantedAt !== undefined ? { grantedAt: effective.grantedAt } : {}),
    ...(effective.withdrawnAt !== undefined ? { withdrawnAt: effective.withdrawnAt } : {}),
  };
}

interface RecordConsentParams {
  sessionKey?: string;
  scopes: VoiceprintConsentScope[];
  grantedAt?: string;
  now?: string;
  reason?: string;
}

function parseRecordConsentParams(params: unknown): RecordConsentParams {
  const p = objectOrUndefined(params);
  if (!p || !Array.isArray(p.scopes)) {
    throw new MethodError("INVALID_REQUEST", "record_consent requires a scopes array.");
  }
  const validScopes: VoiceprintConsentScope[] = ["capture", "biometric", "memoryPromotion", "export"];
  const scopes = p.scopes.map((scope) => {
    if (typeof scope !== "string" || !validScopes.includes(scope as VoiceprintConsentScope)) {
      throw new MethodError("INVALID_REQUEST", `record_consent scope is invalid: ${String(scope)}.`);
    }
    return scope as VoiceprintConsentScope;
  });
  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    scopes,
    grantedAt: optionalIsoTimeParam(p.grantedAt ?? p.granted_at, "grantedAt"),
    now: optionalIsoTimeParam(p.now, "now"),
    reason: optionalString(p.reason),
  };
}

interface WithdrawConsentParams {
  sessionKey?: string;
  now?: string;
  reason?: string;
}

function parseWithdrawConsentParams(params: unknown): WithdrawConsentParams {
  const p = objectOrUndefined(params);
  return {
    sessionKey: typeof p?.sessionKey === "string" ? p.sessionKey : undefined,
    now: optionalIsoTimeParam(p?.now, "now"),
    reason: optionalString(p?.reason),
  };
}

interface PurgeExpiredParams {
  nowMs?: number;
  retentionMs?: number;
}

function parsePurgeExpiredParams(params: unknown): PurgeExpiredParams {
  const p = objectOrUndefined(params);
  return {
    nowMs: optionalNonNegativeFiniteNumber(p?.nowMs ?? p?.now_ms, "nowMs"),
    retentionMs: optionalPositiveFiniteNumber(p?.retentionMs ?? p?.retention_ms, "retentionMs"),
  };
}

function parseSessionOnlyParams(params: unknown): { sessionKey?: string } {
  const p = objectOrUndefined(params);
  return {
    sessionKey: typeof p?.sessionKey === "string" ? p.sessionKey : undefined,
  };
}

interface BridgeMemoryCandidateParams {
  records: VoiceprintTurnRecords;
  consent?: Partial<VoiceprintConsentSnapshot>;
  thresholds?: Partial<VoiceprintThresholds>;
  createdAt?: string;
}

function parseBridgeMemoryCandidateParams(params: unknown): BridgeMemoryCandidateParams {
  const p = objectOrUndefined(params);
  if (!p) {
    throw new MethodError("INVALID_REQUEST", "bridge_memory_candidate requires an object body.");
  }
  const records = objectOrUndefined(p.records);
  if (
    !records ||
    !objectOrUndefined(records.speakerTurnTag) ||
    !objectOrUndefined(records.identitySignal) ||
    !objectOrUndefined(records.transcriptSpeakerAnnotation)
  ) {
    throw new MethodError(
      "INVALID_REQUEST",
      "bridge_memory_candidate requires records.speakerTurnTag, records.identitySignal, and records.transcriptSpeakerAnnotation.",
    );
  }
  const consent = objectOrUndefined(p.consent);
  const thresholds = objectOrUndefined(p.thresholds);
  return {
    // The bridge is fail-closed and defensively reads every field, so we forward the
    // structurally-shaped records without re-deriving them; a malformed inner field
    // degrades to a quarantined candidate rather than a throw.
    records: p.records as VoiceprintTurnRecords,
    ...(consent !== undefined ? { consent: consent as Partial<VoiceprintConsentSnapshot> } : {}),
    ...(thresholds !== undefined
      ? { thresholds: thresholds as Partial<VoiceprintThresholds> }
      : {}),
    createdAt: optionalIsoTimeParam(p.createdAt, "createdAt"),
  };
}

function optionalIsoTimeParam(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new MethodError("INVALID_REQUEST", `${field} must be an ISO timestamp.`);
  }
  return value;
}

function serializeEnrollmentSuccess(
  sessionKey: string,
  assessment: VoiceprintEnrollmentAssessment,
  stored: StoredOwnerTemplate,
): {
  ok: true;
  sessionKey: string;
  status: "accepted";
  templateRef: string;
  speechMs: number;
  sourceCount: number;
  ownerEmbeddingCount: number;
  quality: VoiceprintEnrollmentAssessment["quality"];
} {
  return {
    ok: true,
    sessionKey,
    status: "accepted",
    templateRef: stored.templateRef,
    speechMs: assessment.speechMs,
    sourceCount: assessment.sourceCount,
    ownerEmbeddingCount: stored.ownerEmbeddingCount,
    quality: assessment.quality,
  };
}

function serializeEnrollmentRejection(
  sessionKey: string,
  assessment: VoiceprintEnrollmentAssessment,
): {
  ok: false;
  sessionKey: string;
  status: "rejected";
  reasons: string[];
  speechMs: number;
  sourceCount: number;
} {
  return {
    ok: false,
    sessionKey,
    status: "rejected",
    reasons: assessment.reasons,
    speechMs: assessment.speechMs,
    sourceCount: assessment.sourceCount,
  };
}

function ownerTemplateRefForArtifact(
  scoring: VoiceprintLiveScoringConfig,
  artifact: VoiceprintTemplateArtifact,
): string {
  if (scoring.ownerTemplateRef && scoring.ownerTemplateRef !== artifact.template.id) {
    throw new Error("Voiceprint ownerTemplateRef does not match owner template id.");
  }
  return artifact.template.id;
}

function resolveScoreTurnsPolicy(
  scoring: VoiceprintLiveScoringConfig,
  input: ScoreTurnsParams,
  lifecycle: VoiceprintLifecycle,
  subjectKey: string,
): {
  consent: VoiceprintConsentSnapshot;
  qualityThresholds: VoiceprintAudioQualityThresholds;
  templateLearningReviewed: boolean;
} {
  return {
    consent: restrictVoiceprintConsentWithLedger(
      scoring.consent,
      input.consent,
      lifecycle,
      subjectKey,
    ),
    qualityThresholds: restrictVoiceprintQualityThresholds(
      scoring.qualityThresholds,
      input.qualityThresholds,
    ),
    templateLearningReviewed:
      scoring.templateLearningReviewed === true && input.templateLearningReviewed !== false,
  };
}

function restrictVoiceprintConsent(
  serverConsent?: Partial<VoiceprintConsentSnapshot>,
  clientConsent?: Partial<VoiceprintConsentSnapshot>,
): VoiceprintConsentSnapshot {
  const base = resolveVoiceprintConsent(serverConsent);
  const captureAllowed = base.captureAllowed && clientConsent?.captureAllowed !== false;
  const biometricAllowed = base.biometricAllowed && clientConsent?.biometricAllowed !== false;
  const memoryPromotionAllowed =
    base.memoryPromotionAllowed && clientConsent?.memoryPromotionAllowed !== false;
  const exportAllowed = base.exportAllowed && clientConsent?.exportAllowed !== false;
  const templateLearningAllowed =
    base.templateLearningAllowed === true && clientConsent?.templateLearningAllowed !== false;

  const restricted: VoiceprintConsentSnapshot = {
    captureAllowed,
    biometricAllowed,
    memoryPromotionAllowed,
    exportAllowed,
    templateLearningAllowed,
  };
  if (!base.captureAllowed || !base.biometricAllowed) {
    restricted.reason = base.reason ?? "server_voiceprint_consent_denied";
  } else if (!captureAllowed || !biometricAllowed) {
    restricted.reason = clientConsent?.reason ?? "client_restricted_voiceprint_consent";
  } else if (base.reason) {
    restricted.reason = base.reason;
  }
  return resolveVoiceprintConsent(restricted);
}

function restrictVoiceprintQualityThresholds(
  serverThresholds?: Partial<VoiceprintAudioQualityThresholds>,
  clientThresholds?: Partial<VoiceprintAudioQualityThresholds>,
): VoiceprintAudioQualityThresholds {
  const base = {
    ...DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS,
    ...serverThresholds,
  };
  validateVoiceprintQualityThresholds(base, "scoring.qualityThresholds");

  const minDurationMs = stricterMinimumThreshold(base, clientThresholds, "minDurationMs");
  const minRms = stricterMinimumThreshold(base, clientThresholds, "minRms");
  return {
    minDurationMs,
    targetDurationMs: Math.max(
      minDurationMs,
      stricterMinimumThreshold(base, clientThresholds, "targetDurationMs"),
    ),
    minRms,
    targetRms: Math.max(minRms, stricterMinimumThreshold(base, clientThresholds, "targetRms")),
    minPeak: stricterMinimumThreshold(base, clientThresholds, "minPeak"),
    minDynamicRange: stricterMinimumThreshold(base, clientThresholds, "minDynamicRange"),
    maxClippingRatio: stricterMaximumThreshold(base, clientThresholds, "maxClippingRatio"),
    clippingAmplitude: stricterMaximumThreshold(base, clientThresholds, "clippingAmplitude"),
    maxAbsDcOffset: stricterMaximumThreshold(base, clientThresholds, "maxAbsDcOffset"),
  };
}

function stricterMinimumThreshold<K extends keyof VoiceprintAudioQualityThresholds>(
  base: VoiceprintAudioQualityThresholds,
  client: Partial<VoiceprintAudioQualityThresholds> | undefined,
  key: K,
): number {
  const clientValue = optionalNonNegativeFiniteNumber(client?.[key], `qualityThresholds.${key}`);
  return clientValue === undefined ? base[key] : Math.max(base[key], clientValue);
}

function stricterMaximumThreshold<K extends keyof VoiceprintAudioQualityThresholds>(
  base: VoiceprintAudioQualityThresholds,
  client: Partial<VoiceprintAudioQualityThresholds> | undefined,
  key: K,
): number {
  const clientValue = optionalNonNegativeFiniteNumber(client?.[key], `qualityThresholds.${key}`);
  return clientValue === undefined ? base[key] : Math.min(base[key], clientValue);
}

function serializeScoreTurnsResult(input: {
  sessionKey: string;
  turns: number;
  run: LiveVoiceprintScoringPlanRun;
  storage: VoiceprintStorageApplyResult | null;
}): VoiceprintScoreTurnsResult {
  return {
    ok: true,
    sessionKey: input.sessionKey,
    status: input.run.status,
    turns: input.turns,
    queued: input.run.plan.queued.length,
    skipped: input.run.plan.skipped.length,
    patches: input.run.patches.length,
    storageBundleId: input.run.storageBundle?.id,
    storage: input.storage,
    states: input.run.states,
    error: input.run.error,
  };
}

function resolveRealtimeVoiceprintAudioArtifactEvent(input: {
  sessionKey: string;
  event: LiveVoiceRealtimeEvent;
  audioArtifacts: VoiceprintAudioArtifactStore;
  allowedAudioRoots?: readonly string[];
}): LiveVoiceRealtimeEvent {
  if (input.event.type !== "live_recording.audio_artifact") {
    return input.event;
  }
  const event = { ...input.event } as Record<string, unknown>;
  const audioArtifactId = optionalString(
    event.audio_artifact_id ?? event.audioArtifactId ?? event.artifact_id ?? event.artifactId,
  );
  if (!audioArtifactId) {
    return input.event;
  }

  const registered = input.audioArtifacts.resolve({
    sessionKey: input.sessionKey,
    audioArtifactId,
  });
  if (registered) {
    event.audio_artifact_id = registered.audioArtifactId;
    event.audioArtifactId = registered.audioArtifactId;
    event.audio_path = registered.audioPath;
    event.audioPath = registered.audioPath;
    if (registered.sampleRate !== undefined) {
      event.sample_rate = registered.sampleRate;
      event.sampleRate = registered.sampleRate;
    }
    if (registered.route !== undefined) {
      event.route = registered.route;
    }
    return event as LiveVoiceRealtimeEvent;
  }

  const rawPath = optionalString(event.audio_path ?? event.audioPath ?? event.path);
  if (rawPath && input.allowedAudioRoots?.length) {
    try {
      const allowedPath = resolveAllowedAudioPath(rawPath, input.allowedAudioRoots);
      event.audio_path = allowedPath;
      event.audioPath = allowedPath;
      return event as LiveVoiceRealtimeEvent;
    } catch {
      delete event.audio_path;
      delete event.audioPath;
      delete event.path;
      return event as LiveVoiceRealtimeEvent;
    }
  }
  return input.event;
}

function normalizeVoiceprintAudioArtifactRegistration(
  registration: VoiceprintAudioArtifactRegistration,
): VoiceprintAudioArtifactRegistration {
  const sessionKey = registration.sessionKey.trim();
  const audioArtifactId = registration.audioArtifactId.trim();
  const mediaId = registration.mediaId.trim();
  const audioPath = registration.audioPath.trim();
  if (!sessionKey) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact requires sessionKey.");
  }
  if (!audioArtifactId) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact requires audioArtifactId.");
  }
  if (!VOICEPRINT_MEDIA_ID_REGEX.test(mediaId)) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact mediaId is invalid.");
  }
  if (!audioPath) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact requires audioPath.");
  }
  if (
    registration.sampleRate !== undefined &&
    (!Number.isFinite(registration.sampleRate) || registration.sampleRate <= 0)
  ) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact sampleRate must be positive.");
  }
  const hasStart = registration.recordingStartMs !== undefined;
  const hasEnd = registration.recordingEndMs !== undefined;
  if (hasStart !== hasEnd) {
    throw new MethodError(
      "INVALID_REQUEST",
      "Voiceprint audio artifact segment bounds require recordingStartMs and recordingEndMs.",
    );
  }
  if (
    registration.recordingStartMs !== undefined &&
    (!Number.isFinite(registration.recordingStartMs) || registration.recordingStartMs < 0)
  ) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact recordingStartMs must be non-negative.");
  }
  if (
    registration.recordingEndMs !== undefined &&
    (!Number.isFinite(registration.recordingEndMs) || registration.recordingEndMs < 0)
  ) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact recordingEndMs must be non-negative.");
  }
  if (
    registration.recordingStartMs !== undefined &&
    registration.recordingEndMs !== undefined &&
    registration.recordingEndMs <= registration.recordingStartMs
  ) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact recordingEndMs must be greater than recordingStartMs.");
  }
  const registeredAt = registration.registeredAt.trim();
  if (!registeredAt || Number.isNaN(Date.parse(registeredAt))) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint audio artifact registeredAt must be an ISO timestamp.");
  }
  return {
    sessionKey,
    audioArtifactId,
    mediaId,
    audioPath,
    sampleRate: registration.sampleRate,
    recordingStartMs: registration.recordingStartMs,
    recordingEndMs: registration.recordingEndMs,
    route: registration.route?.trim() || undefined,
    registeredAt,
  };
}

function resolveVoiceprintAudioArtifactRegistration(
  registrations: readonly VoiceprintAudioArtifactRegistration[],
  turn: { startMs?: number; endMs?: number },
): VoiceprintAudioArtifactResolution | undefined {
  if (registrations.length === 0) {
    return undefined;
  }
  if (turn.startMs === undefined || turn.endMs === undefined) {
    return registrations.length === 1 ? { ...registrations[0]! } : undefined;
  }
  if (
    !Number.isFinite(turn.startMs) ||
    !Number.isFinite(turn.endMs) ||
    turn.startMs < 0 ||
    turn.endMs <= turn.startMs
  ) {
    return undefined;
  }

  const fullRecording = registrations.filter(
    (item) => item.recordingStartMs === undefined && item.recordingEndMs === undefined,
  );
  const coveringSegments = registrations.filter((item) =>
    item.recordingStartMs !== undefined &&
    item.recordingEndMs !== undefined &&
    item.recordingStartMs <= turn.startMs! &&
    item.recordingEndMs >= turn.endMs!,
  );
  const candidates = coveringSegments.length > 0 ? coveringSegments : fullRecording;
  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        "Voiceprint audio artifact has ambiguous segments for the requested turn window.",
      );
    }
    return undefined;
  }

  const selected = candidates[0]!;
  if (selected.recordingStartMs === undefined) {
    return {
      ...selected,
      requestStartMs: turn.startMs,
      requestEndMs: turn.endMs,
    };
  }
  return {
    ...selected,
    requestStartMs: turn.startMs - selected.recordingStartMs,
    requestEndMs: turn.endMs - selected.recordingStartMs,
  };
}

function voiceprintAudioArtifactStoreKey(input: {
  sessionKey: string;
  audioArtifactId: string;
}): string {
  return `${input.sessionKey.trim()}\u0000${input.audioArtifactId.trim()}`;
}

function parseApplyBundleParams(params: unknown): VoiceprintStorageBundle {
  const p = params as { bundle?: unknown } | undefined;
  if (!p || !p.bundle || typeof p.bundle !== "object" || Array.isArray(p.bundle)) {
    throw new MethodError("INVALID_REQUEST", "bundle is required.");
  }
  return p.bundle as VoiceprintStorageBundle;
}

function parseRealtimeEventParams(params: unknown): {
  sessionKey?: string;
  event: LiveVoiceRealtimeEvent;
  includeMissingAudio?: boolean;
  provider?: LiveVoiceRealtimeProviderHint;
} {
  const p = params as {
    sessionKey?: unknown;
    event?: unknown;
    includeMissingAudio?: unknown;
    provider?: unknown;
  } | undefined;
  if (!p || !p.event || typeof p.event !== "object" || Array.isArray(p.event)) {
    throw new MethodError("INVALID_REQUEST", "event is required.");
  }
  const event = p.event as Partial<LiveVoiceRealtimeEvent>;
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new MethodError("INVALID_REQUEST", "event.type is required.");
  }
  // OPTIONAL provider hint. Accept it from the params or from the event body
  // (`event.provider`). Defaults to `auto` downstream, so no required param is
  // added and existing callers are unchanged.
  const provider =
    (typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : undefined) ??
    (typeof (event as Record<string, unknown>).provider === "string" &&
    ((event as Record<string, unknown>).provider as string).trim()
      ? ((event as Record<string, unknown>).provider as string).trim()
      : undefined);
  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    event: event as LiveVoiceRealtimeEvent,
    includeMissingAudio: p.includeMissingAudio === true,
    provider,
  };
}

function parseRealtimeResetParams(params: unknown): { sessionKey?: string } {
  const p = params as { sessionKey?: unknown } | undefined;
  return {
    sessionKey: typeof p?.sessionKey === "string" ? p.sessionKey : undefined,
  };
}

function sessionKeyForVoiceprintRequest(
  conn: GatewayConnection,
  requestedSessionKey: string | undefined,
): string {
  if (!conn.sessionKey) {
    throw new MethodError(
      "FORBIDDEN",
      "Unbound connection: bind a session before applying voiceprint identity updates.",
    );
  }
  if (requestedSessionKey !== undefined && requestedSessionKey !== conn.sessionKey) {
    throw new MethodError(
      "FORBIDDEN",
      "Voiceprint request sessionKey does not match the bound connection.",
    );
  }
  return conn.sessionKey;
}

function assertVoiceprintSessionAccess(conn: GatewayConnection, sessionKey: string): void {
  if (!conn.sessionKey) {
    throw new MethodError(
      "FORBIDDEN",
      "Unbound connection: bind a session before applying voiceprint identity updates.",
    );
  }
  if (conn.sessionKey !== sessionKey) {
    throw new MethodError(
      "FORBIDDEN",
      "Voiceprint storage bundle sessionKey does not match the bound connection.",
    );
  }
}

function voiceprintMethodError(error: unknown): MethodError {
  if (error instanceof MethodError) {
    return error;
  }
  if (error instanceof VoiceprintStoragePersistenceError) {
    return new MethodError("INTERNAL_ERROR", error.message);
  }
  // A corrupt/unreadable persisted consent ledger is a SERVER storage fault, not a
  // client bad-request. Report it as a retryable INTERNAL_ERROR with a SANITIZED
  // message (never the raw ledger path) — mirrors voiceprintLifecycleMethodError so
  // score_turns does not mislabel a server fault as INVALID_REQUEST and leak paths.
  if (error instanceof VoiceprintConsentLedgerStoreError) {
    return new MethodError(
      "INTERNAL_ERROR",
      "Voiceprint lifecycle store is unavailable or corrupt.",
    );
  }
  // A sidecar/host fault (spawn ENOENT, timeout, non-zero exit, output overflow,
  // unparseable output) is a transient SERVER/infrastructure failure, not a
  // client-request fault. Report it as INTERNAL_ERROR so client retry/backoff
  // engages, instead of INVALID_REQUEST which would tell the caller (wrongly) that
  // it sent a bad request and defeat retry.
  if (error instanceof VoiceprintSidecarError) {
    return new MethodError("INTERNAL_ERROR", error.message);
  }
  return new MethodError("INVALID_REQUEST", errorMessage(error));
}

// Consent-ledger / audit-log reads and writes touch a file-backed store whose
// loaders throw bare `Error`s (corrupt/tampered/partially-written file, fs faults
// with an on-disk path in the message). Those are INTERNAL storage faults, not
// client-request faults: map them to a typed INTERNAL_ERROR with a SANITIZED
// message so the caller never sees a raw INTERNAL_ERROR that leaks the on-disk
// path or internal parse detail. A MethodError raised deliberately (e.g. a bad
// request the handler already classified) is passed through untouched.
function voiceprintLifecycleMethodError(error: unknown): MethodError {
  if (error instanceof MethodError) {
    return error;
  }
  return new MethodError(
    "INTERNAL_ERROR",
    "Voiceprint lifecycle store is unavailable or corrupt.",
  );
}

function loadVoiceprintStorageSnapshot(filePath: string): VoiceprintStorageSnapshot {
  if (!existsSync(filePath)) {
    return emptyVoiceprintStorageSnapshot();
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<VoiceprintStorageFile>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      throw new Error("file version must be 1");
    }
    return assertVoiceprintStorageSnapshot(parsed.snapshot);
  } catch (error) {
    throw new VoiceprintStoragePersistenceError(
      `Invalid voiceprint storage file at ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function writeVoiceprintStorageSnapshot(
  filePath: string,
  snapshot: VoiceprintStorageSnapshot,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const file: VoiceprintStorageFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    snapshot,
  };
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf-8",
      mode: VOICEPRINT_STORAGE_FILE_MODE,
    });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, VOICEPRINT_STORAGE_FILE_MODE);
    } catch {
      // Non-fatal on platforms that do not support chmod.
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup after a failed atomic write.
    }
    throw new VoiceprintStoragePersistenceError(
      `Failed to write voiceprint storage file at ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function assertVoiceprintStorageSnapshot(value: unknown): VoiceprintStorageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("snapshot must be an object");
  }

  const snapshot = value as Partial<VoiceprintStorageSnapshot>;
  assertArray(snapshot.transcriptIdentityStates, "transcriptIdentityStates");
  assertArray(snapshot.speakerTurnTags, "speakerTurnTags");
  assertArray(snapshot.identitySignals, "identitySignals");
  assertArray(snapshot.transcriptSpeakerAnnotations, "transcriptSpeakerAnnotations");
  assertArray(snapshot.eventParticipations, "eventParticipations");

  return snapshot as VoiceprintStorageSnapshot;
}

function assertArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`snapshot.${field} must be an array`);
  }
}
