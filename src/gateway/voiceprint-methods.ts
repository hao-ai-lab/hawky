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
import type { GatewayConnection } from "./connection.js";
import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import type { HawkyConfig } from "../agent/types.js";
import {
  createVoiceprintRealtimeSessionStore,
  type VoiceprintRealtimeSessionStore,
} from "./voiceprint-realtime.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getConfigDir } from "../storage/config.js";
import {
  applyVoiceprintStorageBundle,
  buildLiveVoiceprintScoringPlan,
  buildVoiceprintStorageBundle,
  buildVoiceprintTranscriptIdentityState,
  buildVoiceprintTranscriptIdentityStatePatches,
  countVoiceprintStorageSnapshot,
  DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS,
  emptyVoiceprintStorageSnapshot,
  formatVoiceprintModel,
  ownerEmbeddingsFromVoiceprintTemplateArtifact,
  readWavFile,
  readEncryptedVoiceprintTemplateArtifact,
  resolveVoiceprintConsent,
  resolveVoiceprintThresholds,
  runLiveVoiceprintScoringJobs,
  sameVoiceprintModel,
  sliceWavAudio,
  voiceprintTemplateFileRefFromSource,
  voiceprintConsentAllowsProcessing,
  markVoiceprintTranscriptStateError,
  type VoiceprintStorageBundle,
  type VoiceprintStorageCounts,
  type VoiceprintStorageSnapshot,
  type LiveVoiceRealtimeEvent,
  type LiveVoiceprintPlanItemInput,
  type LiveVoiceprintScoringPlan,
  type LiveVoiceprintScoringPlanRun,
  type LiveVoiceprintScoringPlanRunStatus,
  type VoiceprintTranscriptIdentityStatePatch,
  type VoiceprintAudioQualityThresholds,
  type VoiceprintConsentSnapshot,
  type VoiceprintModelInfo,
  type VoiceprintTemplateArtifact,
  type VoiceprintTemplateFileRef,
  type VoiceprintTemplateFileSource,
  type VoiceprintThresholds,
  type VoiceprintTranscriptIdentityState,
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

export interface VoiceprintStorageAdapter {
  applyBundle(bundle: VoiceprintStorageBundle): Promise<VoiceprintStorageApplyResult> | VoiceprintStorageApplyResult;
  snapshot?(): VoiceprintStorageSnapshot;
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

  const sidecar = resolveConfiguredVoiceprintSidecar(raw.sidecar);
  const ownerTemplate = resolveConfiguredOwnerTemplateSource(raw.owner_template);
  const allowedAudioRoots = resolveConfiguredAudioRoots(raw.allowed_audio_roots);
  const consent = resolveConfiguredVoiceprintConsent(raw.consent);

  return {
    sidecar,
    ownerTemplateFileSource: ownerTemplate,
    allowedAudioRoots,
    consent,
    expectedModel: resolveConfiguredVoiceprintModel(raw.expected_model),
    thresholds: resolveConfiguredVoiceprintThresholds(raw.thresholds),
    qualityThresholds: resolveConfiguredVoiceprintQualityThresholds(raw.quality_thresholds),
    targetSampleRate: optionalPositiveNumber(raw.target_sample_rate, "voiceprint.live_scoring.target_sample_rate"),
    timeoutMs: optionalPositiveNumber(raw.timeout_ms, "voiceprint.live_scoring.timeout_ms"),
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
  };
}

export function registerVoiceprintMethods(
  server: GatewayServer,
  storage: VoiceprintStorageAdapter = createFileVoiceprintStorage(),
  realtime: VoiceprintRealtimeSessionStore = createVoiceprintRealtimeSessionStore(),
  scoring?: VoiceprintLiveScoringConfig,
  audioArtifacts: VoiceprintAudioArtifactStore = createInMemoryVoiceprintAudioArtifactStore(),
): void {
  server.registerMethod("identity.voiceprint.realtime_event", async (conn, params) => {
    const input = parseRealtimeEventParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    const event = resolveRealtimeVoiceprintAudioArtifactEvent({
      sessionKey,
      event: input.event,
      audioArtifacts,
      allowedAudioRoots: scoring?.allowedAudioRoots,
    });

    try {
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
      throw new MethodError("INVALID_REQUEST", errorMessage(error));
    }
  });

  server.registerMethod("identity.voiceprint.realtime_reset", (conn, params) => {
    const input = parseRealtimeResetParams(params);
    const sessionKey = sessionKeyForVoiceprintRequest(conn, input.sessionKey);
    audioArtifacts.reset?.(sessionKey);
    return realtime.reset(sessionKey);
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

    try {
      const turns = await buildScorePlanTurns({
        sessionKey,
        input,
        scoring,
        audioArtifacts,
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
      return serializeScoreTurnsResult({
        sessionKey,
        turns: turns.length,
        run,
        storage: storageResult,
      });
    } catch (error) {
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

async function buildScorePlanTurns(input: {
  sessionKey: string;
  input: ScoreTurnsParams;
  scoring: VoiceprintLiveScoringConfig;
  audioArtifacts: VoiceprintAudioArtifactStore;
}): Promise<LiveVoiceprintPlanItemInput[]> {
  const turns: LiveVoiceprintPlanItemInput[] = [];
  const policy = resolveScoreTurnsPolicy(input.scoring, input.input);
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
    };

    if (
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
    }
  }

  return turns;
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

  let batch: Awaited<ReturnType<typeof runLiveVoiceprintScoringJobs>>;
  try {
    batch = await runLiveVoiceprintScoringJobs({
      sidecar: input.sidecar,
      jobs: plan.jobContexts,
    });
  } catch (error) {
    const message = errorMessage(error);
    const currentStates = currentTranscriptStatesForPlan(
      requireVoiceprintStorageSnapshot(input.storage),
      plan,
      input.createdAt,
    );
    const states = markCurrentVoiceprintScoringStatesErrored({
      plan,
      states: currentStates,
      message,
      updatedAt: input.updatedAt,
    });
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

function resolveOwnerVoiceprintTemplate(scoring: VoiceprintLiveScoringConfig): {
  ownerEmbeddings: number[][];
  ownerTemplateRef?: string;
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
    let artifact: VoiceprintTemplateArtifact;
    try {
      const fileRef = scoring.ownerTemplateFile
        ?? (scoring.ownerTemplateFileSource
          ? voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource)
          : undefined);
      artifact = scoring.ownerTemplateArtifact
        ?? readEncryptedVoiceprintTemplateArtifact(fileRef!);
    } catch (error) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        `Voiceprint live scorer owner template is not usable: ${errorMessage(error)}`,
      );
    }

    const templateModel = artifact.template.model;
    if (scoring.expectedModel && !sameVoiceprintModel(templateModel, scoring.expectedModel)) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        `Voiceprint owner template model ${formatVoiceprintModel(templateModel)} does not match expected scorer model ${formatVoiceprintModel(scoring.expectedModel)}.`,
      );
    }

    try {
      const ownerTemplateRef = ownerTemplateRefForArtifact(scoring, artifact);
      return {
        ownerEmbeddings: ownerEmbeddingsFromVoiceprintTemplateArtifact(artifact),
        ownerTemplateRef,
      };
    } catch (error) {
      throw new MethodError(
        "FAILED_PRECONDITION",
        `Voiceprint live scorer owner template is not usable: ${errorMessage(error)}`,
      );
    }
  }

  if (scoring.ownerEmbeddings?.length) {
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
): {
  consent: VoiceprintConsentSnapshot;
  qualityThresholds: VoiceprintAudioQualityThresholds;
  templateLearningReviewed: boolean;
} {
  return {
    consent: restrictVoiceprintConsent(scoring.consent, input.consent),
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
): EmbeddingSidecarCommand {
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
  if (!["external-json", "signal-baseline", "speechbrain", "wespeaker", "picovoice", "custom"].includes(provider)) {
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
  return new MethodError("INVALID_REQUEST", errorMessage(error));
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
