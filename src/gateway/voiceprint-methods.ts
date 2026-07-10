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
  buildVoiceprintConsentGrant,
  buildVoiceprintConsentWithdrawal,
  effectiveConsentAllowsProcessing,
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
} from "../identity/voiceprint/index.js";
import type { EmbeddingSidecarCommand } from "../identity/voiceprint/index.js";

const log = createSubsystemLogger("gateway/voiceprint-methods");
const VOICEPRINT_STORAGE_FILE_MODE = 0o600;
const VOICEPRINT_MEDIA_ID_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

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

type VoiceprintConfigSection = NonNullable<HawkyConfig["voiceprint"]>;
type VoiceprintLiveScoringConfigSection = NonNullable<VoiceprintConfigSection["live_scoring"]>;
type ConfiguredVoiceprintSidecar = VoiceprintLiveScoringConfigSection["sidecar"];
type ConfiguredOwnerTemplateSource = VoiceprintLiveScoringConfigSection["owner_template"];
type ConfiguredVoiceprintConsent = VoiceprintLiveScoringConfigSection["consent"];
type ConfiguredVoiceprintModel = VoiceprintLiveScoringConfigSection["expected_model"];
type ConfiguredVoiceprintThresholds = VoiceprintLiveScoringConfigSection["thresholds"];
type ConfiguredVoiceprintQualityThresholds =
  VoiceprintLiveScoringConfigSection["quality_thresholds"];

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

export function resolveVoiceprintLiveScoringConfigFromConfig(
  config: HawkyConfig,
): VoiceprintLiveScoringConfig | undefined {
  const raw = config.voiceprint?.live_scoring;
  if (!raw?.enabled) {
    return undefined;
  }

  const requireDiscriminativeModel = optionalBoolean(raw.require_discriminative_model) ?? false;
  const sidecar = resolveConfiguredVoiceprintSidecar(raw.sidecar, raw.dev_reference_backend === true);
  const ownerTemplate = resolveConfiguredOwnerTemplateSource(raw.owner_template);
  const allowedAudioRoots = resolveConfiguredAudioRoots(raw.allowed_audio_roots);
  const consent = resolveConfiguredVoiceprintConsent(raw.consent);
  const expectedModel = resolveConfiguredVoiceprintModel(raw.expected_model);

  // A5 PRODUCTION GUARD: with `require_discriminative_model`, a config that would
  // score real turns with the NON-DISCRIMINATIVE reference backend is rejected at
  // resolve/registration time. This is fail-fast: dev_reference_backend, a sidecar
  // env selecting VOICEPRINT_BACKEND=reference, or a reference-tagged expected_model
  // all mean the reference model could reach real users, which the guard forbids.
  if (requireDiscriminativeModel) {
    assertDiscriminativeVoiceprintConfig({
      devReferenceBackend: raw.dev_reference_backend === true,
      sidecar,
      expectedModel,
    });
  }

  // A5 MODEL INTEGRITY PIN: resolve (and eagerly verify) the pinned model hash so a
  // swapped/corrupt model fails at startup rather than silently scoring later.
  const modelIntegrityPin = resolveConfiguredModelIntegrityPin(
    raw.model_sha256,
    raw.model_path,
    sidecar,
  );

  return {
    sidecar,
    ownerTemplateFileSource: ownerTemplate,
    allowedAudioRoots,
    consent,
    requireDiscriminativeModel,
    ...(modelIntegrityPin ? { modelIntegrityPin } : {}),
    expectedModel,
    thresholds: resolveConfiguredVoiceprintThresholds(raw.thresholds),
    qualityThresholds: resolveConfiguredVoiceprintQualityThresholds(raw.quality_thresholds),
    targetSampleRate: optionalPositiveNumber(raw.target_sample_rate, "voiceprint.live_scoring.target_sample_rate"),
    timeoutMs: optionalPositiveNumber(raw.timeout_ms, "voiceprint.live_scoring.timeout_ms"),
    // TRUST BOUNDARY opt-in, default false: only when true will a client-supplied
    // per-turn embedding be scored directly against the owner template (no sidecar,
    // no biometric audio). See identity/voiceprint/live-client-embedding.ts.
    acceptClientEmbeddings:
      optionalBoolean(raw.accept_client_embeddings) ?? false,
    livenessNonceTtlMs: optionalPositiveNumber(
      raw.liveness_nonce_ttl_ms,
      "voiceprint.live_scoring.liveness_nonce_ttl_ms",
    ),
    // A3 AS-Norm: OPT-IN, default OFF. Only resolved when `as_norm.enabled` is
    // true AND a cohort is provided; otherwise undefined => raw-cosine scoring.
    // The resolved expected_model is passed so the cohort model can be pinned to
    // it at config load (see resolveConfiguredVoiceprintAsNorm).
    asNorm: resolveConfiguredVoiceprintAsNorm(
      raw.as_norm,
      expectedModel,
    ),
  };
}

/**
 * A5 PRODUCTION GUARD assertion. Fail fast (at config-resolve/registration time)
 * when `require_discriminative_model` is on but the resolved config would let the
 * NON-DISCRIMINATIVE reference backend score real turns. Three distinct footguns
 * are closed here:
 *   - dev_reference_backend: true          (points the sidecar at the reference backend)
 *   - sidecar env VOICEPRINT_BACKEND=reference (or unset -> reference default)
 *   - expected_model tagged reference/reference-fbank-v0
 */
export function assertDiscriminativeVoiceprintConfig(input: {
  devReferenceBackend: boolean;
  sidecar: EmbeddingSidecarCommand;
  expectedModel: VoiceprintModelInfo | undefined;
}): void {
  if (input.devReferenceBackend) {
    throw new Error(
      "voiceprint.live_scoring.require_discriminative_model is true but dev_reference_backend is also true: the non-discriminative reference backend must never score real users in production.",
    );
  }
  if (sidecarEnvSelectsReferenceBackend(input.sidecar.env)) {
    throw new Error(
      "voiceprint.live_scoring.require_discriminative_model is true but the sidecar env selects VOICEPRINT_BACKEND=reference (or leaves it unset, which defaults to the reference backend): configure the onnx backend with a real model.",
    );
  }
  if (isReferenceVoiceprintModel(input.expectedModel)) {
    throw new Error(
      `voiceprint.live_scoring.require_discriminative_model is true but expected_model is the reference tag (${REFERENCE_VOICEPRINT_PROVIDER}/${REFERENCE_VOICEPRINT_MODEL_ID}): the reference backend is non-discriminative and must not score real users.`,
    );
  }
}

/**
 * A5 PRODUCTION GUARD assertion at the SCORING boundary (per-RPC, per-turn). The
 * config-time {@link assertDiscriminativeVoiceprintConfig} closes the resolved-config
 * footguns; this closes the runtime ones — a stored owner template, a re-embed result,
 * or a client-supplied vector that is nonetheless tagged with the non-discriminative
 * reference model. When the guard is on and `model` is reference-tagged, refuse with a
 * clear `FAILED_PRECONDITION` (never a meaningless "score"). `action` names what is being
 * refused ("score it" / "store it") so the message stays specific to the call site.
 */
function assertDiscriminativeVoiceprintModel(
  requireDiscriminativeModel: boolean | undefined,
  model: VoiceprintModelInfo | undefined,
  subject: string,
  action: string,
): void {
  if (requireDiscriminativeModel && isReferenceVoiceprintModel(model)) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      `${subject} is tagged with the non-discriminative reference model ${formatVoiceprintModel(model!)}; require_discriminative_model refuses to ${action}.`,
    );
  }
}

/**
 * Resolve (and eagerly verify) the A5 model integrity pin. The model file path
 * comes from config `model_path`, falling back to the sidecar env `VOICEPRINT_MODEL`.
 * When `model_sha256` is set, the file is hashed here so a swapped/corrupt model
 * fails at config load. Returns undefined when no pin is configured.
 */
function resolveConfiguredModelIntegrityPin(
  modelSha256: unknown,
  modelPath: unknown,
  sidecar: EmbeddingSidecarCommand,
): VoiceprintModelIntegrityPin | undefined {
  const sha256 = optionalConfigString(modelSha256);
  if (!sha256) {
    if (optionalConfigString(modelPath)) {
      throw new Error(
        "voiceprint.live_scoring.model_path is set but model_sha256 is not; pin the model hash to enable integrity verification.",
      );
    }
    return undefined;
  }
  const resolvedPath =
    optionalConfigPath(modelPath) ?? optionalConfigString(sidecar.env?.VOICEPRINT_MODEL);
  if (!resolvedPath) {
    throw new Error(
      "voiceprint.live_scoring.model_sha256 is set but no model file is resolvable (set model_path or the sidecar env VOICEPRINT_MODEL).",
    );
  }
  const pin: VoiceprintModelIntegrityPin = { modelPath: resolvedPath, sha256 };
  // Fail fast at config load so an operator provisions a known-good model before
  // the gateway accepts scoring traffic.
  assertVoiceprintModelIntegrity(pin);
  return pin;
}

type ConfiguredVoiceprintAsNorm = VoiceprintLiveScoringConfigSection["as_norm"];

function resolveConfiguredVoiceprintAsNorm(
  asNorm: ConfiguredVoiceprintAsNorm,
  expectedModel: VoiceprintModelInfo | undefined,
): VoiceprintLiveScoringConfig["asNorm"] {
  if (asNorm === undefined) {
    return undefined;
  }
  if (!asNorm || typeof asNorm !== "object") {
    throw new Error("voiceprint.live_scoring.as_norm must be an object.");
  }
  // Default OFF: an explicit `enabled: true` is required to activate AS-Norm.
  if (asNorm.enabled !== true) {
    return undefined;
  }

  // MODEL PINNING. AS-Norm cohort cosines are only comparable to owner<->sample
  // cosines when both are produced by the same model+version. The runtime check
  // only compares the cohort model against the *sample* (sidecar) model, so
  // without a pinned expected_model a cohort tagged model X could silently
  // normalize a model-Y owner template. Require expected_model whenever AS-Norm
  // is enabled and pin the cohort model to it, closing the chain
  // cohort == expected == owner-template (expected is separately checked against
  // the template model at scoring time).
  if (!expectedModel) {
    throw new Error(
      "voiceprint.live_scoring.expected_model is required when as_norm.enabled is true (the AS-Norm cohort must be pinned to the owner-template model).",
    );
  }

  const cohortModel = resolveConfiguredVoiceprintAsNormCohortModel(asNorm.cohort_model);
  if (!sameVoiceprintModel(cohortModel, expectedModel)) {
    throw new Error(
      "voiceprint.live_scoring.as_norm.cohort_model does not match voiceprint.live_scoring.expected_model; the cohort must be embedded with the same model as the owner template.",
    );
  }
  const embeddings = resolveConfiguredVoiceprintAsNormEmbeddings(asNorm, cohortModel);

  const normalizedThresholds = resolveConfiguredVoiceprintAsNormThresholds(
    asNorm.normalized_thresholds,
  );
  if (!normalizedThresholds) {
    throw new Error(
      "voiceprint.live_scoring.as_norm.normalized_thresholds is required when as_norm.enabled is true (the AS-Norm output is a z-score-like scale and must NOT reuse the raw cosine thresholds).",
    );
  }

  const topN = optionalPositiveNumber(
    asNorm.top_n ?? asNorm.topN,
    "voiceprint.live_scoring.as_norm.top_n",
  );

  return {
    cohort: { model: cohortModel, embeddings },
    normalizedThresholds,
    ...(topN !== undefined ? { topN } : {}),
  };
}

function resolveConfiguredVoiceprintAsNormCohortModel(
  model: NonNullable<ConfiguredVoiceprintAsNorm>["cohort_model"],
): VoiceprintModelInfo {
  if (!model || typeof model !== "object") {
    throw new Error("voiceprint.live_scoring.as_norm.cohort_model is required when as_norm.enabled is true.");
  }
  const provider = configString(model.provider, "voiceprint.live_scoring.as_norm.cohort_model.provider");
  if (!["external-json", "signal-baseline", "speechbrain", "wespeaker", "picovoice", "sherpa-onnx", "reference", "custom"].includes(provider)) {
    throw new Error("voiceprint.live_scoring.as_norm.cohort_model.provider is invalid.");
  }
  return {
    provider: provider as VoiceprintModelInfo["provider"],
    modelId: configString(
      model.model_id ?? model.modelId,
      "voiceprint.live_scoring.as_norm.cohort_model.model_id",
    ),
    version: optionalConfigString(model.version),
    notes: optionalConfigString(model.notes),
  };
}

function resolveConfiguredVoiceprintAsNormEmbeddings(
  asNorm: NonNullable<ConfiguredVoiceprintAsNorm>,
  cohortModel: VoiceprintModelInfo,
): number[][] {
  if (Array.isArray(asNorm.cohort_embeddings) && asNorm.cohort_embeddings.length > 0) {
    return validateCohortEmbeddingList(
      asNorm.cohort_embeddings,
      "voiceprint.live_scoring.as_norm.cohort_embeddings",
    );
  }
  if (asNorm.cohort_file) {
    const filePath = configPath(asNorm.cohort_file, "voiceprint.live_scoring.as_norm.cohort_file");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `voiceprint.live_scoring.as_norm.cohort_file could not be read as JSON (${filePath}): ${errorMessage(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("voiceprint.live_scoring.as_norm.cohort_file must contain a JSON object.");
    }
    const file = parsed as { model?: unknown; embeddings?: unknown };
    // The file MAY carry its own model tag; if it does, it must match the
    // configured cohort model so a mislabeled cohort file is rejected loudly.
    if (file.model !== undefined) {
      const fileModel = resolveConfiguredVoiceprintAsNormCohortModel(
        file.model as NonNullable<ConfiguredVoiceprintAsNorm>["cohort_model"],
      );
      if (!sameVoiceprintModel(fileModel, cohortModel)) {
        throw new Error(
          "voiceprint.live_scoring.as_norm.cohort_file model does not match as_norm.cohort_model.",
        );
      }
    }
    return validateCohortEmbeddingList(
      file.embeddings,
      "voiceprint.live_scoring.as_norm.cohort_file.embeddings",
    );
  }
  throw new Error(
    "voiceprint.live_scoring.as_norm requires cohort_embeddings or cohort_file when as_norm.enabled is true.",
  );
}

function validateCohortEmbeddingList(value: unknown, field: string): number[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of embedding vectors.`);
  }
  let expectedDim: number | undefined;
  return value.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty numeric vector.`);
    }
    // Intra-cohort dimension consistency is knowable at config load. A mixed-
    // dimension cohort is guaranteed to hard-throw inside validateVoiceprintCohort
    // at scoring time — after config load has succeeded — which would take down an
    // entire live scoring batch per session. Reject it loudly here so the failure
    // surfaces at startup instead of as a runtime availability outage.
    if (expectedDim === undefined) {
      expectedDim = vector.length;
    } else if (vector.length !== expectedDim) {
      throw new Error(
        `${field}[${index}] has dimension ${vector.length}; every cohort vector must share the same dimension (expected ${expectedDim}).`,
      );
    }
    return vector.map((component, componentIndex) => {
      if (typeof component !== "number" || !Number.isFinite(component)) {
        throw new Error(`${field}[${index}][${componentIndex}] must be a finite number.`);
      }
      return component;
    });
  });
}

function resolveConfiguredVoiceprintAsNormThresholds(
  thresholds: NonNullable<ConfiguredVoiceprintAsNorm>["normalized_thresholds"],
): VoiceprintThresholds | undefined {
  if (thresholds === undefined) {
    return undefined;
  }
  if (!thresholds || typeof thresholds !== "object") {
    throw new Error("voiceprint.live_scoring.as_norm.normalized_thresholds must be an object.");
  }
  const ownerAccept = optionalNumber(
    thresholds.owner_accept ?? thresholds.ownerAccept,
    "voiceprint.live_scoring.as_norm.normalized_thresholds.owner_accept",
  );
  const ownerPossible = optionalNumber(
    thresholds.owner_possible ?? thresholds.ownerPossible,
    "voiceprint.live_scoring.as_norm.normalized_thresholds.owner_possible",
  );
  if (ownerAccept === undefined || ownerPossible === undefined) {
    throw new Error(
      "voiceprint.live_scoring.as_norm.normalized_thresholds requires both owner_accept and owner_possible.",
    );
  }
  // The normalized score is a z-score-like scale, so the raw-cosine threshold
  // validator (which clamps to [ -1, 1 ]-ish ranges) does NOT apply. We only
  // require accept >= possible and both finite.
  if (!(ownerAccept >= ownerPossible)) {
    throw new Error(
      "voiceprint.live_scoring.as_norm.normalized_thresholds.owner_accept must be >= owner_possible.",
    );
  }
  return { ownerAccept, ownerPossible };
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
): void {
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
      });
      log.info("identity.voiceprint.realtime_event", {
        session_key: sessionKey,
        event_type: input.event.type,
        event_status: result.event.status,
        finalized_turns: result.finalizedTurns.length,
      });
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
    const started = Date.now();

    // FAIL-CLOSED boundary for the whole scoring path. Any throw below (bad audio
    // path, corrupt owner template, storage fault) is converted to a typed
    // MethodError by `voiceprintMethodError` and audited as an error — it NEVER
    // escapes as an unhandled crash and NEVER yields an owner-resolving result.
    // Sidecar/embedding faults degrade to a structured `error`/`skipped` run
    // (see runAndStoreLiveVoiceprintScoringPlan), not a false-accept.
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
      log.info("identity.voiceprint.score_turns", {
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
      throw voiceprintMethodError(error);
    }
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

  // ── A4 biometric consent + retention + audit lifecycle ───────────────────
  registerVoiceprintLifecycleMethods(server, {
    scoring,
    storage,
    realtime,
    audioArtifacts,
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
    lifecycle: VoiceprintLifecycle;
  },
): void {
  const { scoring, storage, realtime, audioArtifacts, lifecycle } = deps;

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
}

interface EnrollmentAudioSourceInput {
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

interface EmbeddedEnrollmentSources {
  sources: VoiceprintEnrollmentSource[];
  model: VoiceprintModelInfo;
}

interface StoredOwnerTemplate {
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
  const validProviders = [
    "external-json",
    "signal-baseline",
    "speechbrain",
    "wespeaker",
    "picovoice",
    "sherpa-onnx",
    "reference",
    "custom",
  ];
  if (!validProviders.includes(provider)) {
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
    const registeredArtifact = turn.audioArtifactId
      ? input.audioArtifacts.resolve({
        sessionKey: input.sessionKey,
        audioArtifactId: turn.audioArtifactId,
        startMs: turn.startMs,
        endMs: turn.endMs,
      })
      : undefined;
    const audioPath = registeredArtifact?.audioPath ?? turn.audioPath;
    const requestStartMs = registeredArtifact?.requestStartMs ?? turn.startMs;
    const requestEndMs = registeredArtifact?.requestEndMs ?? turn.endMs;
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

/**
 * Resolve each enrollment audio source to its allowed path (registered artifact
 * or client audioPath under allowedAudioRoots), run the sidecar to get an
 * embedding + measured speechMs, and quality-gate the clip with
 * `assessVoiceprintAudioQuality`. A clip whose quality assessment does not allow
 * enrollment (templateLearning use) is carried into the assessment as
 * `qualityStatus: "rejected"` so `assessVoiceprintEnrollment` rejects it — the
 * template is only built from clips that clear quality AND clear 30s total voiced
 * speech.
 */
async function embedEnrollmentSources(input: {
  sessionKey: string;
  sources: readonly EnrollmentAudioSourceInput[];
  scoring: VoiceprintLiveScoringConfig;
  audioArtifacts: VoiceprintAudioArtifactStore;
}): Promise<EmbeddedEnrollmentSources> {
  if (input.sources.length === 0) {
    throw new MethodError("INVALID_REQUEST", "Voiceprint enrollment requires at least one audio source.");
  }

  const embedded: VoiceprintEnrollmentSource[] = [];
  let model: VoiceprintModelInfo | undefined;
  const seenArtifactIds = new Set<string>();

  for (const [index, source] of input.sources.entries()) {
    const registered = source.audioArtifactId
      ? input.audioArtifacts.resolve({
          sessionKey: input.sessionKey,
          audioArtifactId: source.audioArtifactId,
          startMs: source.startMs,
          endMs: source.endMs,
        })
      : undefined;
    const rawAudioPath = registered?.audioPath ?? source.audioPath;
    if (!rawAudioPath) {
      throw new MethodError(
        "INVALID_REQUEST",
        `Voiceprint enrollment source at index ${index} requires a registered audioArtifactId or audioPath.`,
      );
    }
    const audioPath = resolveAllowedAudioPath(rawAudioPath, input.scoring.allowedAudioRoots);
    const requestStartMs = registered?.requestStartMs ?? source.startMs;
    const requestEndMs = registered?.requestEndMs ?? source.endMs;

    // artifactId identifies the enrollment source; must be unique + stable.
    const artifactId = source.audioArtifactId ?? `enroll_${index}_${audioPath}`;
    if (seenArtifactIds.has(artifactId)) {
      throw new MethodError(
        "INVALID_REQUEST",
        `Duplicate voiceprint enrollment audio source: ${artifactId}.`,
      );
    }
    seenArtifactIds.add(artifactId);

    // Quality-gate on the ACTUAL server-side audio (never a client attestation).
    const audio = sliceWavAudio(await readWavFile(audioPath), requestStartMs, requestEndMs);
    const quality = assessVoiceprintAudioQuality(
      audio.samples,
      audio.sampleRate,
      input.scoring.qualityThresholds,
    );
    const qualityStatus: VoiceprintAudioQualityStatus = quality.allowedUses.templateLearning
      ? quality.status
      : "rejected";

    // Embed via the sidecar. speechMs from the sidecar (if reported) is the voiced
    // duration used for the 30s total; fall back to the clip duration otherwise.
    const response = await runEmbeddingSidecar({
      sidecar: input.scoring.sidecar,
      request: buildEmbeddingBatchRequest([
        {
          id: `enroll-${index}`,
          audioPath,
          startMs: requestStartMs,
          endMs: requestEndMs,
          targetSampleRate: input.scoring.targetSampleRate,
          route: source.route ?? registered?.route,
        },
      ]),
    });
    const item = firstEmbeddingResponse(response.responses, `enroll-${index}`);
    model ??= item.model;
    if (!sameVoiceprintModel(model, item.model)) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        `Voiceprint enrollment clips produced inconsistent models (${formatVoiceprintModel(model)} vs ${formatVoiceprintModel(item.model)}).`,
      );
    }

    embedded.push({
      artifactId,
      embedding: item.embedding,
      speechMs: enrollmentSpeechMs(item, audio.durationMs),
      route: source.route ?? (registered?.route as VoiceprintEnrollmentSource["route"]),
      qualityStatus,
    });
  }

  if (!model) {
    throw new MethodError("FAILED_PRECONDITION", "Voiceprint enrollment produced no embedding model.");
  }
  // A5 GUARD: refuse up front if the sidecar actually EMITTED a reference model
  // while require_discriminative_model is on (e.g. a wrapper/misconfigured sidecar
  // whose declared env is non-reference). Without this, enrollment would report
  // success and persist a reference-tagged template that resolveOwnerVoiceprintTemplate
  // always rejects at score time, leaving the owner stored-but-unresolvable. This
  // mirrors the re-embed guard so every enrollment path fails fast at capture.
  assertDiscriminativeVoiceprintModel(
    input.scoring.requireDiscriminativeModel,
    model,
    "Voiceprint enrollment result",
    "store it",
  );
  // Reject up front if the sidecar's model does not match the scorer's expected
  // model. Otherwise enrollment would report success while storing a template
  // that resolveOwnerVoiceprintTemplate always rejects at score time (its guard
  // at the score-plan resolver), leaving the owner stored-but-unresolvable.
  if (input.scoring.expectedModel && !sameVoiceprintModel(model, input.scoring.expectedModel)) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      `Voiceprint enrollment model ${formatVoiceprintModel(model)} does not match expected scorer model ${formatVoiceprintModel(input.scoring.expectedModel)}.`,
    );
  }
  return { sources: embedded, model };
}

function firstEmbeddingResponse(
  responses: readonly VoiceprintEmbeddingResponse[],
  id: string,
): VoiceprintEmbeddingResponse {
  const found = responses.find((response) => response.id === id) ?? responses[0];
  if (!found) {
    throw new MethodError("FAILED_PRECONDITION", "Voiceprint enrollment sidecar returned no embedding.");
  }
  return found;
}

function enrollmentSpeechMs(
  response: VoiceprintEmbeddingResponse,
  fallbackDurationMs: number,
): number {
  const speechMs = response.audio?.speechMs;
  if (typeof speechMs === "number" && Number.isFinite(speechMs) && speechMs >= 0) {
    return speechMs;
  }
  return Math.max(0, fallbackDurationMs);
}

/**
 * Build the encrypted owner-template artifact from quality-passed sources and write
 * it to the SAME file `score_turns` resolves. The key file is created on first
 * enrollment only when the config opted in (`create_key_if_missing`).
 */
function writeOwnerTemplateFromSources(input: {
  scoring: VoiceprintLiveScoringConfig & { ownerTemplateFileSource: VoiceprintTemplateFileSource };
  model: VoiceprintModelInfo;
  sources: readonly VoiceprintEnrollmentSource[];
  minSpeechMs?: number;
  createdAt?: string;
}): StoredOwnerTemplate {
  const fileRef = voiceprintTemplateFileRefFromSource(input.scoring.ownerTemplateFileSource);
  const storage: VoiceprintTemplateStorageRef = {
    templateUri: `local-voiceprint://owner/${fileRef.filePath}`,
    encrypted: true,
    localOnly: true,
    keyRef: fileRef.key.keyRef,
  };
  const artifact = buildVoiceprintTemplateArtifact({
    model: input.model,
    sources: input.sources,
    storage,
    thresholds: input.scoring.thresholds,
    createdAt: input.createdAt,
    minSpeechMs: input.minSpeechMs,
  });
  writeEncryptedVoiceprintTemplateArtifact({
    filePath: fileRef.filePath,
    artifact,
    key: fileRef.key,
  });
  return {
    templateRef: artifact.template.id,
    filePath: fileRef.filePath,
    sourceCount: artifact.template.enrollment.sourceCount,
    ownerEmbeddingCount: ownerEmbeddingsFromVoiceprintTemplateArtifact(artifact).length,
  };
}

/** Read the existing owner artifact + reconstruct its per-clip enrollment sources. */
function readOwnerTemplateArtifactForEnrollment(
  scoring: VoiceprintLiveScoringConfig & { ownerTemplateFileSource: VoiceprintTemplateFileSource },
): { artifact: VoiceprintTemplateArtifact; sources: VoiceprintEnrollmentSource[] } {
  const fileRef = voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource);
  if (!existsSync(fileRef.filePath)) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint owner template does not exist; enroll an owner before adding a clip.",
    );
  }
  const artifact = readEncryptedVoiceprintTemplateArtifact(fileRef);
  if (artifact.template.deletedAt) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint owner template has been deleted; enroll an owner before adding a clip.",
    );
  }
  // The encrypted artifact stores a single centroid over all enrolled clips (the
  // per-clip vectors are intentionally NOT retained — biometric minimization). To
  // grow the multi-clip enrollment we carry the existing centroid forward as one
  // synthetic prior source (with its recorded speechMs) and append the new clip.
  const priorSpeechMs = artifact.template.enrollment.speechMs;
  const perPriorSpeechMs =
    artifact.template.enrollment.sourceCount > 0
      ? priorSpeechMs / artifact.template.enrollment.sourceCount
      : priorSpeechMs;
  const sources: VoiceprintEnrollmentSource[] = [
    {
      artifactId: `owner_prior_${artifact.template.id}`,
      embedding: artifact.centroid.slice(),
      speechMs: perPriorSpeechMs,
      // The stored template only kept its enrollment "quality" grade (good/marginal);
      // both are enrollment-eligible (only "rejected" blocks), so carry the prior
      // forward with a non-rejected audio-quality status of the matching grade.
      qualityStatus:
        artifact.template.enrollment.quality === "good" ? "accepted" : "marginal",
    },
  ];
  return { artifact, sources };
}

/** Tombstone + remove the owner template file. Idempotent. */
function deleteOwnerTemplate(
  scoring: VoiceprintLiveScoringConfig & { ownerTemplateFileSource: VoiceprintTemplateFileSource },
  deletedAt?: string,
): { removed: boolean; templateRef?: string } {
  const source = scoring.ownerTemplateFileSource;
  // Deletion only needs the template file path — it never reads the encrypted
  // contents to erase them. Resolve that path WITHOUT touching the encryption key so
  // erasure works even when the key file is missing/corrupt (right-to-erasure and
  // idempotency must not depend on a decryptable store). If the template file never
  // existed, the ciphertext is already gone — but we still crypto-shred the key
  // below so a stale key never survives to decrypt any un-erased copy/backup.
  if (!existsSync(source.filePath)) {
    unlinkOwnerTemplateKey(source.keyPath);
    return { removed: false };
  }
  let templateRef: string | undefined;
  try {
    // Best-effort: if the key is present and the store is readable, tombstone-validate
    // the template (the withdrawal primitive later phases build on) to recover its id
    // for the audit log. We do not persist the tombstone since the file is then removed.
    const fileRef = voiceprintTemplateFileRefFromSource({ ...source, createKeyIfMissing: false });
    const artifact = readEncryptedVoiceprintTemplateArtifact(fileRef);
    tombstoneVoiceprintTemplate(artifact.template, deletedAt);
    templateRef = artifact.template.id;
  } catch {
    // Even an unreadable/corrupt store — or one whose key file is gone — must be
    // removable so the owner cannot be resolved afterward; fall through to unlink.
  }
  unlinkSync(source.filePath);
  // Crypto-shred: remove the AES-256-GCM key file too. Deleting the ciphertext while
  // retaining its decryption key is an incomplete erasure — if any un-erased copy of
  // the ciphertext survived elsewhere, the retained key would be the missing link. It
  // is also reused on re-enrollment, so a post-withdrawal re-enroll must not silently
  // rebind to the old key. Best-effort; tolerate a missing/already-removed key file.
  unlinkOwnerTemplateKey(source.keyPath);
  return { removed: true, templateRef };
}

/** Best-effort unlink of the owner-template AES key file, tolerating ENOENT. */
function unlinkOwnerTemplateKey(keyPath: string): void {
  try {
    unlinkSync(keyPath);
  } catch {
    // Missing/already-removed key file (ENOENT) or an unremovable one must never
    // fail erasure — the ciphertext has already been unlinked at this point.
  }
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
 *     timing, transcript-identity joins) and the session-keyed audio-artifact cache
 *     (raw-audio file references) for the subject. After this runs, no owner template
 *     resolves, no derived state remains, and no in-memory biometric-derived artifact
 *     is left resident. Idempotent: re-running on an already-purged subject is a
 *     no-op with zero counts.
 */
async function purgeVoiceprintSubject(input: {
  sessionKey: string;
  scoring?: VoiceprintLiveScoringConfig;
  storage: VoiceprintStorageAdapter;
  realtime: VoiceprintRealtimeSessionStore;
  audioArtifacts: VoiceprintAudioArtifactStore;
  deletedAt: string;
}): Promise<VoiceprintSubjectPurgeOutcome> {
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

function resolveConfiguredVoiceprintSidecar(
  sidecar: ConfiguredVoiceprintSidecar,
  devReferenceBackend: boolean,
): EmbeddingSidecarCommand {
  // Local/dev opt-in: with `dev_reference_backend: true` and no explicit sidecar
  // command, default to the bundled Python reference backend. It is deterministic
  // and dependency-free but NON-DISCRIMINATIVE — never real identity, dev only.
  const commandProvided = Boolean(
    sidecar && typeof sidecar === "object" && typeof sidecar.command === "string" && sidecar.command.trim(),
  );
  if (devReferenceBackend && !commandProvided) {
    return buildReferenceBackendSidecar(sidecar);
  }
  if (!sidecar || typeof sidecar !== "object") {
    throw new Error("voiceprint.live_scoring.sidecar is required when voiceprint live scoring is enabled.");
  }
  const command = configString(sidecar.command, "voiceprint.live_scoring.sidecar.command");
  const args = optionalStringArray(sidecar.args, "voiceprint.live_scoring.sidecar.args");
  const env = optionalStringRecord(sidecar.env, "voiceprint.live_scoring.sidecar.env");
  return {
    command,
    args,
    cwd: optionalConfigPath(sidecar.cwd),
    env,
    timeoutMs: optionalPositiveNumber(sidecar.timeout_ms, "voiceprint.live_scoring.sidecar.timeout_ms"),
    maxStdoutBytes: optionalPositiveNumber(
      sidecar.max_stdout_bytes,
      "voiceprint.live_scoring.sidecar.max_stdout_bytes",
    ),
    maxStderrBytes: optionalPositiveNumber(
      sidecar.max_stderr_bytes,
      "voiceprint.live_scoring.sidecar.max_stderr_bytes",
    ),
  };
}

function buildReferenceBackendSidecar(
  sidecar: ConfiguredVoiceprintSidecar,
): EmbeddingSidecarCommand {
  const embedScript = defaultVoiceprintReferenceEmbedScript();
  if (!existsSync(embedScript)) {
    throw new Error(
      `voiceprint.live_scoring.dev_reference_backend is set but the bundled sidecar was not found at ${embedScript}.`,
    );
  }
  const overrideEnv = sidecar && typeof sidecar === "object"
    ? optionalStringRecord(sidecar.env, "voiceprint.live_scoring.sidecar.env")
    : undefined;
  const configuredCommand = sidecar && typeof sidecar === "object"
    ? optionalConfigString(sidecar.command)
    : undefined;
  const command = configuredCommand ?? process.env.VOICEPRINT_PYTHON ?? "python3";
  return {
    command,
    args: [embedScript],
    cwd: sidecar && typeof sidecar === "object" ? optionalConfigPath(sidecar.cwd) : undefined,
    env: { VOICEPRINT_BACKEND: "reference", ...overrideEnv },
    timeoutMs: sidecar && typeof sidecar === "object"
      ? optionalPositiveNumber(sidecar.timeout_ms, "voiceprint.live_scoring.sidecar.timeout_ms")
      : undefined,
    maxStdoutBytes: sidecar && typeof sidecar === "object"
      ? optionalPositiveNumber(sidecar.max_stdout_bytes, "voiceprint.live_scoring.sidecar.max_stdout_bytes")
      : undefined,
    maxStderrBytes: sidecar && typeof sidecar === "object"
      ? optionalPositiveNumber(sidecar.max_stderr_bytes, "voiceprint.live_scoring.sidecar.max_stderr_bytes")
      : undefined,
  };
}

/** Absolute path to the bundled Python reference embedding sidecar. */
export function defaultVoiceprintReferenceEmbedScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/gateway/voiceprint-methods.ts -> repo services/voiceprint/embed.py
  return resolve(here, "..", "..", "services", "voiceprint", "embed.py");
}

function resolveConfiguredOwnerTemplateSource(
  ownerTemplate: ConfiguredOwnerTemplateSource,
): VoiceprintTemplateFileSource {
  if (!ownerTemplate || typeof ownerTemplate !== "object") {
    throw new Error(
      "voiceprint.live_scoring.owner_template is required when voiceprint live scoring is enabled.",
    );
  }
  const filePath = optionalConfigPath(ownerTemplate.file_path)
    ?? join(getConfigDir(), "state", "voiceprint", "owner-template.enc.json");
  const keyPath = optionalConfigPath(ownerTemplate.key_path)
    ?? join(getConfigDir(), "state", "voiceprint", "owner-template.key.json");
  const keyRef = optionalConfigString(ownerTemplate.key_ref);
  if (ownerTemplate.create_key_if_missing === true && !keyRef) {
    throw new Error(
      "voiceprint.live_scoring.owner_template.key_ref is required when create_key_if_missing is true.",
    );
  }
  return {
    filePath,
    keyPath,
    keyRef,
    createKeyIfMissing: ownerTemplate.create_key_if_missing === true,
  };
}

function resolveConfiguredAudioRoots(roots: readonly string[] | undefined): string[] {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(
      "voiceprint.live_scoring.allowed_audio_roots must include at least one local audio root.",
    );
  }
  const resolved = roots.map((root, index) =>
    configPath(root, `voiceprint.live_scoring.allowed_audio_roots[${index}]`),
  );
  if (new Set(resolved).size !== resolved.length) {
    throw new Error("voiceprint.live_scoring.allowed_audio_roots contains duplicates.");
  }
  return resolved;
}

function resolveConfiguredVoiceprintConsent(
  consent: ConfiguredVoiceprintConsent,
): VoiceprintConsentSnapshot {
  if (!consent || typeof consent !== "object") {
    throw new Error("voiceprint.live_scoring.consent is required when voiceprint live scoring is enabled.");
  }
  return resolveVoiceprintConsent({
    captureAllowed: configBoolean(
      consent.capture_allowed,
      "voiceprint.live_scoring.consent.capture_allowed",
    ),
    biometricAllowed: configBoolean(
      consent.biometric_allowed,
      "voiceprint.live_scoring.consent.biometric_allowed",
    ),
    memoryPromotionAllowed: optionalBoolean(consent.memory_promotion_allowed)
      ?? false,
    templateLearningAllowed: optionalBoolean(consent.template_learning_allowed)
      ?? false,
    exportAllowed: optionalBoolean(consent.export_allowed) ?? false,
    reason: optionalConfigString(consent.reason),
  });
}

function resolveConfiguredVoiceprintModel(
  model: ConfiguredVoiceprintModel,
): VoiceprintModelInfo | undefined {
  if (model === undefined) {
    return undefined;
  }
  if (!model || typeof model !== "object") {
    throw new Error("voiceprint.live_scoring.expected_model must be an object.");
  }
  const provider = configString(model.provider, "voiceprint.live_scoring.expected_model.provider");
  if (!["external-json", "signal-baseline", "speechbrain", "wespeaker", "picovoice", "sherpa-onnx", "reference", "custom"].includes(provider)) {
    throw new Error("voiceprint.live_scoring.expected_model.provider is invalid.");
  }
  return {
    provider: provider as VoiceprintModelInfo["provider"],
    modelId: configString(
      model.model_id ?? model.modelId,
      "voiceprint.live_scoring.expected_model.model_id",
    ),
    version: optionalConfigString(model.version),
    notes: optionalConfigString(model.notes),
  };
}

function resolveConfiguredVoiceprintThresholds(
  thresholds: ConfiguredVoiceprintThresholds,
): VoiceprintThresholds | undefined {
  if (thresholds === undefined) {
    return undefined;
  }
  if (!thresholds || typeof thresholds !== "object") {
    throw new Error("voiceprint.live_scoring.thresholds must be an object.");
  }
  const resolved: Partial<VoiceprintThresholds> = {};
  const ownerAccept = optionalNumber(
    thresholds.owner_accept ?? thresholds.ownerAccept,
    "voiceprint.live_scoring.thresholds.owner_accept",
  );
  const ownerPossible = optionalNumber(
    thresholds.owner_possible ?? thresholds.ownerPossible,
    "voiceprint.live_scoring.thresholds.owner_possible",
  );
  if (ownerAccept !== undefined) {
    resolved.ownerAccept = ownerAccept;
  }
  if (ownerPossible !== undefined) {
    resolved.ownerPossible = ownerPossible;
  }
  return resolveVoiceprintThresholds(resolved);
}

function resolveConfiguredVoiceprintQualityThresholds(
  thresholds: ConfiguredVoiceprintQualityThresholds,
): Partial<VoiceprintAudioQualityThresholds> | undefined {
  if (thresholds === undefined) {
    return undefined;
  }
  if (!thresholds || typeof thresholds !== "object") {
    throw new Error("voiceprint.live_scoring.quality_thresholds must be an object.");
  }
  const resolved: Partial<VoiceprintAudioQualityThresholds> = {
    minDurationMs: optionalNumber(
      thresholds.min_duration_ms ?? thresholds.minDurationMs,
      "voiceprint.live_scoring.quality_thresholds.min_duration_ms",
    ),
    targetDurationMs: optionalNumber(
      thresholds.target_duration_ms ?? thresholds.targetDurationMs,
      "voiceprint.live_scoring.quality_thresholds.target_duration_ms",
    ),
    minRms: optionalNumber(
      thresholds.min_rms ?? thresholds.minRms,
      "voiceprint.live_scoring.quality_thresholds.min_rms",
    ),
    targetRms: optionalNumber(
      thresholds.target_rms ?? thresholds.targetRms,
      "voiceprint.live_scoring.quality_thresholds.target_rms",
    ),
    minPeak: optionalNumber(
      thresholds.min_peak ?? thresholds.minPeak,
      "voiceprint.live_scoring.quality_thresholds.min_peak",
    ),
    minDynamicRange: optionalNumber(
      thresholds.min_dynamic_range ?? thresholds.minDynamicRange,
      "voiceprint.live_scoring.quality_thresholds.min_dynamic_range",
    ),
    maxClippingRatio: optionalNumber(
      thresholds.max_clipping_ratio ?? thresholds.maxClippingRatio,
      "voiceprint.live_scoring.quality_thresholds.max_clipping_ratio",
    ),
    clippingAmplitude: optionalNumber(
      thresholds.clipping_amplitude ?? thresholds.clippingAmplitude,
      "voiceprint.live_scoring.quality_thresholds.clipping_amplitude",
    ),
    maxAbsDcOffset: optionalNumber(
      thresholds.max_abs_dc_offset ?? thresholds.maxAbsDcOffset,
      "voiceprint.live_scoring.quality_thresholds.max_abs_dc_offset",
    ),
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined) {
      delete resolved[key as keyof VoiceprintAudioQualityThresholds];
    }
  }
  validateVoiceprintQualityThresholds(
    { ...DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS, ...resolved },
    "voiceprint.live_scoring.quality_thresholds",
  );
  return resolved;
}

function configString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalConfigString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string.");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function configBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("Expected a boolean.");
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, field: string): number | undefined {
  const number = optionalNumber(value, field);
  if (number !== undefined && number <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return number;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item, index) => configString(item, `${field}[${index}]`));
}

function optionalStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim()) {
      throw new Error(`${field} contains an empty key.`);
    }
    out[key] = configString(item, `${field}.${key}`);
  }
  return out;
}

function configPath(value: unknown, field: string): string {
  return resolveConfigPath(configString(value, field));
}

function optionalConfigPath(value: unknown): string | undefined {
  const path = optionalConfigString(value);
  return path ? resolveConfigPath(path) : undefined;
}

function resolveConfigPath(path: string): string {
  return isAbsolute(path) ? path : resolve(getConfigDir(), path);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MethodError("INVALID_REQUEST", `${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MethodError("INVALID_REQUEST", `${field} must be a finite number.`);
  }
  return value;
}

function optionalNonNegativeFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MethodError("INVALID_REQUEST", `${field} must be a non-negative finite number.`);
  }
  return value;
}

function optionalPositiveFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new MethodError("INVALID_REQUEST", `${field} must be a positive finite number.`);
  }
  return value;
}

function validateVoiceprintQualityThresholds(
  thresholds: VoiceprintAudioQualityThresholds,
  field: string,
): void {
  for (const [key, value] of Object.entries(thresholds)) {
    optionalNonNegativeFiniteNumber(value, `${field}.${key}`);
  }
  if (thresholds.targetDurationMs < thresholds.minDurationMs) {
    throw new MethodError(
      "INVALID_REQUEST",
      `${field}.targetDurationMs must be greater than or equal to minDurationMs.`,
    );
  }
  if (thresholds.targetRms < thresholds.minRms) {
    throw new MethodError(
      "INVALID_REQUEST",
      `${field}.targetRms must be greater than or equal to minRms.`,
    );
  }
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MethodError("INVALID_REQUEST", "Expected an object.");
  }
  return value as Record<string, unknown>;
}

function resolveAllowedAudioPath(
  audioPath: string,
  allowedRoots: readonly string[] | undefined,
): string {
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint live scorer requires configured audio roots before reading audio artifacts.",
    );
  }

  const resolvedPath = realpathSync(resolve(audioPath));
  for (const root of allowedRoots) {
    const trimmedRoot = root.trim();
    if (!trimmedRoot) {
      continue;
    }
    const resolvedRoot = realpathSync(resolve(trimmedRoot));
    const relativePath = relative(resolvedRoot, resolvedPath);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
      return resolvedPath;
    }
  }

  throw new MethodError(
    "FORBIDDEN",
    "Voiceprint audioPath is outside the configured audio roots.",
  );
}

function resolveVoiceprintMediaArtifactPath(input: {
  mediaId: string;
  allowedAudioRoots: readonly string[];
}): { audioPath: string; sidecarPath: string; sampleRate?: number } {
  const mediaId = input.mediaId.trim();
  if (!VOICEPRINT_MEDIA_ID_REGEX.test(mediaId)) {
    throw new MethodError(
      "INVALID_REQUEST",
      "mediaId must match /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.",
    );
  }

  const matches: Array<{ audioPath: string; sidecarPath: string; sampleRate?: number }> = [];
  for (const root of input.allowedAudioRoots) {
    for (const candidate of voiceprintMediaPathCandidates(root, mediaId)) {
      if (!existsSync(candidate.audioPath) || !existsSync(candidate.sidecarPath)) {
        continue;
      }
      const audioPath = resolveAllowedAudioPath(candidate.audioPath, input.allowedAudioRoots);
      const sidecarPath = resolveAllowedAudioPath(candidate.sidecarPath, input.allowedAudioRoots);
      const sidecar = readVoiceprintMediaSidecar(sidecarPath);
      if (!sidecar.final_iso) {
        continue;
      }
      if (typeof sidecar.mime === "string" && !sidecar.mime.startsWith("audio/")) {
        continue;
      }
      matches.push({
        audioPath,
        sidecarPath,
        sampleRate: sampleRateFromMime(sidecar.mime),
      });
    }
  }

  const unique = new Map(matches.map((match) => [match.audioPath, match]));
  if (unique.size === 0) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      `Voiceprint media artifact is not finalized or not found: ${mediaId}.`,
    );
  }
  if (unique.size > 1) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      `Voiceprint media artifact is ambiguous across configured audio roots: ${mediaId}.`,
    );
  }
  return [...unique.values()][0]!;
}

function voiceprintMediaPathCandidates(
  root: string,
  mediaId: string,
): Array<{ audioPath: string; sidecarPath: string }> {
  const candidates = [
    {
      audioPath: join(root, `${mediaId}.wav`),
      sidecarPath: join(root, `${mediaId}.json`),
    },
  ];
  const rootPath = resolve(root);
  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = join(rootPath, entry.name);
    candidates.push({
      audioPath: join(child, `${mediaId}.wav`),
      sidecarPath: join(child, `${mediaId}.json`),
    });
  }
  return candidates;
}

function readVoiceprintMediaSidecar(sidecarPath: string): Record<string, unknown> {
  try {
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
      return {};
    }
    return sidecar as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sampleRateFromMime(mime: unknown): number | undefined {
  if (typeof mime !== "string") {
    return undefined;
  }
  const match = /(?:^|;)rate=(\d+)(?:;|$)/.exec(mime);
  if (!match) {
    return undefined;
  }
  const sampleRate = Number(match[1]);
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined;
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
} {
  const p = params as {
    sessionKey?: unknown;
    event?: unknown;
    includeMissingAudio?: unknown;
  } | undefined;
  if (!p || !p.event || typeof p.event !== "object" || Array.isArray(p.event)) {
    throw new MethodError("INVALID_REQUEST", "event is required.");
  }
  const event = p.event as Partial<LiveVoiceRealtimeEvent>;
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new MethodError("INVALID_REQUEST", "event.type is required.");
  }
  return {
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    event: event as LiveVoiceRealtimeEvent,
    includeMissingAudio: p.includeMissingAudio === true,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
