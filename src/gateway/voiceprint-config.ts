import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HawkyConfig } from "../agent/types.js";
import { MethodError } from "./methods.js";
import { getConfigDir } from "../storage/config.js";
import type { VoiceprintAutoScoreTuning } from "./voiceprint-auto-score.js";
import type { VoiceprintLiveScoringConfig } from "./voiceprint-methods.js";
import {
  configBoolean,
  configPath,
  configString,
  errorMessage,
  optionalBoolean,
  optionalConfigPath,
  optionalConfigString,
  optionalNumber,
  optionalPositiveNumber,
  optionalStringArray,
  optionalStringRecord,
  validateVoiceprintQualityThresholds,
} from "./voiceprint-param-utils.js";
import {
  assertVoiceprintModelIntegrity,
  DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS,
  formatVoiceprintModel,
  isReferenceVoiceprintModel,
  REFERENCE_VOICEPRINT_MODEL_ID,
  REFERENCE_VOICEPRINT_PROVIDER,
  resolveVoiceprintConsent,
  resolveVoiceprintThresholds,
  sameVoiceprintModel,
  sidecarEnvSelectsReferenceBackend,
  type EmbeddingSidecarCommand,
  type VoiceprintAudioQualityThresholds,
  type VoiceprintConsentSnapshot,
  type VoiceprintModelInfo,
  type VoiceprintModelIntegrityPin,
  type VoiceprintTemplateFileSource,
  type VoiceprintThresholds,
} from "../identity/voiceprint/index.js";

/**
 * Accepted voiceprint embedding provider identifiers. Mirrors the
 * `VoiceprintModelInfo["provider"]` union in identity/voiceprint/types.ts and is
 * the single allow-list every provider-string validation site references.
 */
export const VOICEPRINT_PROVIDERS = [
  "external-json",
  "signal-baseline",
  "speechbrain",
  "wespeaker",
  "picovoice",
  "sherpa-onnx",
  "reference",
  "custom",
] as const satisfies readonly VoiceprintModelInfo["provider"][];

type VoiceprintConfigSection = NonNullable<HawkyConfig["voiceprint"]>;
type VoiceprintLiveScoringConfigSection = NonNullable<VoiceprintConfigSection["live_scoring"]>;
type ConfiguredVoiceprintSidecar = VoiceprintLiveScoringConfigSection["sidecar"];
type ConfiguredOwnerTemplateSource = VoiceprintLiveScoringConfigSection["owner_template"];
type ConfiguredVoiceprintConsent = VoiceprintLiveScoringConfigSection["consent"];
type ConfiguredVoiceprintModel = VoiceprintLiveScoringConfigSection["expected_model"];
type ConfiguredVoiceprintThresholds = VoiceprintLiveScoringConfigSection["thresholds"];
type ConfiguredVoiceprintQualityThresholds =
  VoiceprintLiveScoringConfigSection["quality_thresholds"];

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
    // WS1 live owner recognition opt-in, default false: the gateway auto-scores
    // finalized realtime turns itself. False => realtime handlers byte-for-byte
    // unchanged (no auto-scorer is even constructed).
    autoScoreFinalized: optionalBoolean(raw.auto_score_finalized) ?? false,
    // WS1 auto-scorer tuning. Only the A2 evidence hysteresis is config-exposed
    // (controls how fast an owner identity establishes + broadcasts). Undefined
    // when unset => DEFAULT_SPEAKER_EVIDENCE_CONFIG (flipThreshold 3).
    autoScoreTuning: resolveVoiceprintAutoScoreTuning(raw.evidence),
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
export function assertDiscriminativeVoiceprintModel(
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
  if (!(VOICEPRINT_PROVIDERS as readonly string[]).includes(provider)) {
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

/**
 * Parse `voiceprint.live_scoring.evidence` into the auto-scorer's A2 hysteresis
 * overrides. Every field is optional; an absent block => undefined => the
 * reducer keeps DEFAULT_SPEAKER_EVIDENCE_CONFIG. `flip_threshold` is the number
 * of consecutive strong-owner turns needed to establish (and broadcast) an owner
 * identity — lower = faster push, higher = more anti-flap. Validation of ranges
 * / flip_threshold <= window_size happens in the reducer's resolveConfig.
 */
function resolveVoiceprintAutoScoreTuning(
  raw: unknown,
): VoiceprintAutoScoreTuning | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object") {
    throw new Error("voiceprint.live_scoring.evidence must be an object.");
  }
  const evidence = raw as Record<string, unknown>;
  const flipThreshold = optionalPositiveNumber(
    evidence.flip_threshold ?? evidence.flipThreshold,
    "voiceprint.live_scoring.evidence.flip_threshold",
  );
  const ownerFlipThreshold = optionalPositiveNumber(
    evidence.owner_flip_threshold ?? evidence.ownerFlipThreshold,
    "voiceprint.live_scoring.evidence.owner_flip_threshold",
  );
  const nonOwnerFlipThreshold = optionalPositiveNumber(
    evidence.non_owner_flip_threshold ?? evidence.nonOwnerFlipThreshold,
    "voiceprint.live_scoring.evidence.non_owner_flip_threshold",
  );
  const windowSize = optionalPositiveNumber(
    evidence.window_size ?? evidence.windowSize,
    "voiceprint.live_scoring.evidence.window_size",
  );
  const staleTimeoutMs = optionalPositiveNumber(
    evidence.stale_timeout_ms ?? evidence.staleTimeoutMs,
    "voiceprint.live_scoring.evidence.stale_timeout_ms",
  );
  const minTurnMs = optionalPositiveNumber(
    evidence.min_turn_ms ?? evidence.minTurnMs,
    "voiceprint.live_scoring.evidence.min_turn_ms",
  );
  // FAIL-FAST: the evidence reducer re-validates on every fold, and a fold-time
  // throw lands inside the auto-scorer's batch catch — every batch would log
  // "batch failed" and recognition would be silently dead. Surface a config
  // typo here, at load time, instead.
  for (const [name, value] of [
    ["flip_threshold", flipThreshold],
    ["owner_flip_threshold", ownerFlipThreshold],
    ["non_owner_flip_threshold", nonOwnerFlipThreshold],
    ["window_size", windowSize],
  ] as const) {
    if (value !== undefined && !Number.isInteger(value)) {
      throw new Error(`voiceprint.live_scoring.evidence.${name} must be a positive integer.`);
    }
  }
  const effectiveFlip = flipThreshold ?? 3;
  const effectiveWindow = windowSize ?? 5;
  if (effectiveFlip > effectiveWindow) {
    throw new Error(
      "voiceprint.live_scoring.evidence.flip_threshold must be <= window_size.",
    );
  }
  const config: NonNullable<VoiceprintAutoScoreTuning["evidenceConfig"]> = {};
  if (flipThreshold !== undefined) config.flipThreshold = flipThreshold;
  if (ownerFlipThreshold !== undefined) config.ownerFlipThreshold = ownerFlipThreshold;
  if (nonOwnerFlipThreshold !== undefined) config.nonOwnerFlipThreshold = nonOwnerFlipThreshold;
  if (windowSize !== undefined) config.windowSize = windowSize;
  if (staleTimeoutMs !== undefined) config.staleTimeoutMs = staleTimeoutMs;
  const tuning: VoiceprintAutoScoreTuning = {};
  if (Object.keys(config).length > 0) tuning.evidenceConfig = config;
  if (minTurnMs !== undefined) tuning.minEvidenceTurnMs = minTurnMs;
  if (Object.keys(tuning).length === 0) {
    return undefined;
  }
  return tuning;
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
  if (!(VOICEPRINT_PROVIDERS as readonly string[]).includes(provider)) {
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
