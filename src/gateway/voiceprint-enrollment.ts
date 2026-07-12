import { existsSync, unlinkSync } from "node:fs";
import { MethodError } from "./methods.js";
import {
  collectFinalizedVoiceprintSegments,
  resolveAllowedAudioPath,
} from "./voiceprint-audio-resolve.js";
import { assertDiscriminativeVoiceprintModel } from "./voiceprint-config.js";
import type {
  EmbeddedEnrollmentSources,
  EnrollmentAudioSourceInput,
  StoredOwnerTemplate,
  VoiceprintAudioArtifactStore,
  VoiceprintLiveScoringConfig,
} from "./voiceprint-methods.js";
import {
  assessVoiceprintAudioQuality,
  buildEmbeddingBatchRequest,
  buildVoiceprintTemplateArtifact,
  formatVoiceprintModel,
  ownerEmbeddingsFromVoiceprintTemplateArtifact,
  readEncryptedVoiceprintTemplateArtifact,
  readWavFile,
  runEmbeddingSidecar,
  sameVoiceprintModel,
  sliceWavAudio,
  tombstoneVoiceprintTemplate,
  voiceprintTemplateFileRefFromSource,
  writeEncryptedVoiceprintTemplateArtifact,
  type VoiceprintAudioQualityStatus,
  type VoiceprintEmbeddingResponse,
  type VoiceprintEnrollmentSource,
  type VoiceprintModelInfo,
  type VoiceprintTemplateArtifact,
  type VoiceprintTemplateFileSource,
  type VoiceprintTemplateStorageRef,
} from "../identity/voiceprint/index.js";

/**
 * Bound on enroll-from-recording template audio. Long conversations can carry
 * hundreds of segments; ~90s of quality-passing speech is well past the 30s
 * voiced floor and matches the manually-validated live-domain template
 * (~60s / 48 clips → owner 0.79-0.84 on a held-out session), so selection
 * stops there instead of embedding the entire recording.
 */
const ENROLL_FROM_RECORDING_MAX_MS = 90_000;

/**
 * Select the enrollment-usable segments of a live recording: finalized
 * `.segNNN.mic.wav` files under the allowed roots that clear the audio quality
 * gate for templateLearning, in timeline order, capped at
 * {@link ENROLL_FROM_RECORDING_MAX_MS} of audio.
 *
 * The quality gate here DROPS a failing segment rather than rejecting the
 * whole submission (unlike explicit-clip enrollment, where a bad clip rejects):
 * conversation audio legitimately contains silence, assistant-echo residue,
 * and noise-only segments — those are exactly what the gate exists to exclude
 * from a template, not a reason to fail the enrollment.
 */
export async function selectEnrollmentSegmentsFromRecording(input: {
  recordingBaseId: string;
  scoring: VoiceprintLiveScoringConfig;
}): Promise<{
  selected: Array<{ audioPath: string; durationMs: number }>;
  consideredCount: number;
  qualityRejectedCount: number;
  cappedCount: number;
  /**
   * Segments unreachable because the contiguous-from-zero timeline broke (a
   * missing/unfinalized index). Reported — never silently dropped — so
   * `considered === used + rejected + capped + afterGap` always reconciles.
   */
  afterGapCount: number;
}> {
  const roots = input.scoring.allowedAudioRoots ?? [];
  if (roots.length === 0) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      "Voiceprint enrollment from a recording requires configured audio roots.",
    );
  }
  const segments = collectFinalizedVoiceprintSegments(input.recordingBaseId, roots);
  if (!segments || segments.size === 0) {
    throw new MethodError(
      "FAILED_PRECONDITION",
      `No finalized recording segments found for: ${input.recordingBaseId}.`,
    );
  }

  const selected: Array<{ audioPath: string; durationMs: number }> = [];
  let qualityRejectedCount = 0;
  let cappedCount = 0;
  let reachedCount = 0;
  // Accumulated SEGMENT audio (sidecar duration_ms) — the selection budget.
  // The 30s VOICED floor is enforced separately downstream from the sidecar's
  // measured speechMs.
  let selectedMs = 0;
  // Timeline order (contiguous from seg 0) so the template reflects the
  // conversation start-to-finish rather than an arbitrary directory order.
  for (let index = 0; segments.has(index); index += 1) {
    reachedCount += 1;
    const segment = segments.get(index)!;
    if (selectedMs >= ENROLL_FROM_RECORDING_MAX_MS) {
      cappedCount += 1;
      continue;
    }
    const audioPath = resolveAllowedAudioPath(segment.audioPath, roots);
    const audio = await readWavFile(audioPath);
    const quality = assessVoiceprintAudioQuality(
      audio.samples,
      audio.sampleRate,
      input.scoring.qualityThresholds,
    );
    if (quality.status === "rejected" || !quality.allowedUses.templateLearning) {
      qualityRejectedCount += 1;
      continue;
    }
    selected.push({ audioPath, durationMs: segment.durationMs });
    selectedMs += segment.durationMs;
  }
  return {
    selected,
    consideredCount: segments.size,
    qualityRejectedCount,
    cappedCount,
    afterGapCount: segments.size - reachedCount,
  };
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
export async function embedEnrollmentSources(input: {
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
export function writeOwnerTemplateFromSources(input: {
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
export function readOwnerTemplateArtifactForEnrollment(
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
export function deleteOwnerTemplate(
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
