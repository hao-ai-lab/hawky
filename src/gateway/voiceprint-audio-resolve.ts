import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MethodError } from "./methods.js";
import type { VoiceprintAudioArtifactStore } from "./voiceprint-methods.js";

/**
 * Shared media-id shape. A media id is a filesystem-safe base name (no path
 * separators, dots allowed after the first char) capped at 128 chars.
 */
export const VOICEPRINT_MEDIA_ID_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export function resolveAllowedAudioPath(
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

/**
 * Two-tier resolution of a live turn's audio to an on-disk WAV path.
 *
 * Tier 1 — the {@link VoiceprintAudioArtifactStore}, populated ONLY by the
 * explicit `identity.voiceprint.audio_artifact.register` RPC (enrollment, and
 * any client that registers). A registered artifact carries the SEGMENT-RELATIVE
 * request window (`requestStartMs`/`requestEndMs`) computed at registration time,
 * so the caller slices the WAV to the turn's sub-window exactly as before.
 *
 * Tier 2 (gateway-autonomous) — the live realtime path NEVER calls that RPC. iOS
 * streams `media.chunk.upload` segments whose `media_id` EQUALS the turn's
 * `audioArtifactId` (the WAV filename base, e.g. `live-<ts>.segNNN.mic`) and
 * lands them under an allowed root. Without this tier the store stays empty for
 * live sessions, every finalized turn resolves to nothing, and the auto-scorer
 * skips it ("audio never resolved") — so nothing is ever recognized. Here we
 * resolve the self-recorded segment directly. Each segment is a whole ~3s
 * VAD-aligned chunk that IS the turn's audio, so it is scored WHOLE
 * (`requestStartMs`/`requestEndMs` stay undefined): the turn's startMs/endMs are
 * offsets into the FULL recording, not this segment, and must NOT slice it.
 *
 * A not-yet-finalized / missing / ambiguous segment throws inside
 * {@link resolveVoiceprintMediaArtifactPath}; that (and a non-media-id
 * audioArtifactId, which fails the id regex) is caught and returned as
 * `undefined` — "not ready", so the auto-scorer retries and the score path skips
 * fail-safe rather than scoring a guess.
 */
export function resolveLiveTurnAudioArtifact(input: {
  sessionKey: string;
  audioArtifactId: string | undefined;
  startMs?: number;
  endMs?: number;
  audioArtifacts: VoiceprintAudioArtifactStore;
  allowedAudioRoots?: readonly string[];
}):
  | { audioPath: string; sampleRate?: number; requestStartMs?: number; requestEndMs?: number; source: "store" | "segment" }
  | undefined {
  const audioArtifactId = input.audioArtifactId?.trim();
  if (!audioArtifactId) {
    return undefined;
  }
  const registered = input.audioArtifacts.resolve({
    sessionKey: input.sessionKey,
    audioArtifactId,
    startMs: input.startMs,
    endMs: input.endMs,
  });
  if (registered) {
    return {
      audioPath: registered.audioPath,
      sampleRate: registered.sampleRate,
      requestStartMs: registered.requestStartMs,
      requestEndMs: registered.requestEndMs,
      source: "store",
    };
  }
  if (!input.allowedAudioRoots?.length) {
    return undefined;
  }
  // iOS suffixes its recording base id with the turn join id
  // (`<recordingBase>:<transcriptItemId|speechWindowId>`, see LiveSessionStore
  // voiceprintAudioArtifactEvent). Only the prefix before the first `:` names
  // media; `:` is not a legal media-id character, so the joined id can never
  // collide with a real media id.
  const mediaId = audioArtifactId.split(":", 1)[0]!;
  try {
    const resolved = resolveVoiceprintMediaArtifactPath({
      mediaId,
      allowedAudioRoots: input.allowedAudioRoots,
    });
    // A whole file named by the recording base is only usable when it IS the
    // full recording: the turn window is RECORDING-relative, so it is
    // file-relative here iff the file covers it. Return the window EXPLICITLY —
    // leaving it undefined would let the scoring queue's `?? turn.startMs`
    // fallback re-derive the same offsets against whatever file this is, which
    // is wrong for anything shorter than the full recording. A window beyond
    // the file's sidecar duration means this file is NOT the full recording
    // (e.g. an unrelated equally-named upload): fall through to the segmented
    // timeline instead of slicing air.
    const sidecar = readVoiceprintMediaSidecar(resolved.sidecarPath);
    const durationMs = typeof sidecar.duration_ms === "number" && Number.isFinite(sidecar.duration_ms)
      ? sidecar.duration_ms
      : undefined;
    if (
      input.startMs !== undefined && input.endMs !== undefined &&
      Number.isFinite(input.startMs) && Number.isFinite(input.endMs) &&
      input.startMs >= 0 && input.endMs > input.startMs &&
      durationMs !== undefined &&
      input.endMs <= durationMs + VOICEPRINT_SEGMENT_DRIFT_TOLERANCE_MS
    ) {
      return {
        audioPath: resolved.audioPath,
        sampleRate: resolved.sampleRate,
        requestStartMs: input.startMs,
        requestEndMs: Math.min(input.endMs, durationMs),
        source: "segment",
      };
    }
  } catch {
    // Fall through to segmented resolution below.
  }
  // The recording base is not a file: live ingest lands as sequential segments
  // (`<base>.segNNN.mic.wav`) under the media root while the phone's single
  // local WAV keeps the bare base name. The turn's startMs/endMs are
  // recording-aligned (stamped from the recording sink's audio offset), so map
  // the window onto the cumulative segment timeline and slice the best segment.
  const segmented = resolveVoiceprintSegmentedMediaArtifact({
    recordingBaseId: mediaId,
    startMs: input.startMs,
    endMs: input.endMs,
    allowedAudioRoots: input.allowedAudioRoots,
  });
  if (segmented) {
    return { ...segmented, source: "segment" };
  }
  return undefined;
}

const VOICEPRINT_SEGMENT_SUFFIX_REGEX = /^\.seg(\d{1,6})\.mic$/;

/**
 * Allowed drift (ms) between recording-aligned turn stamps (the phone's audio
 * frame counter) and the segment timeline (cumulative sidecar `duration_ms`).
 */
const VOICEPRINT_SEGMENT_DRIFT_TOLERANCE_MS = 250;

/** realpath that returns undefined instead of throwing (broken symlink, race). */
function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Map a recording-aligned turn window onto the finalized live segments of a
 * recording (`<base>.segNNN.mic.wav` + sidecars) and pick the segment with the
 * largest overlap, returning a segment-relative slice window.
 *
 * Returns `undefined` ("not ready yet") — so the auto-scorer retries and the
 * score path skips fail-safe — when the segment containing the END of the turn
 * has not been finalized: segments finalize on a short cadence, and scoring a
 * still-open window would silently truncate the turn audio. Segment start
 * offsets come from the cumulative sidecar `duration_ms` of the PRIOR segments
 * (contiguous from seg 0, the media writer's invariant); a gap in the segment
 * sequence aborts resolution rather than guessing offsets.
 */
/**
 * Collect the finalized `.segNNN.mic.wav` segments of a live recording across
 * the allowed roots (root + one directory level), keyed by segment index.
 * Duplicates reached via nested/overlapping roots dedupe by path/realpath; a
 * DIFFERENT file claiming the same index is ambiguous → undefined (refuse to
 * guess). Open (un-finalized), non-audio, and duration-less segments are
 * excluded. Shared by turn-window resolution and enroll-from-recording.
 */
export function collectFinalizedVoiceprintSegments(
  recordingBaseId: string,
  allowedAudioRoots: readonly string[],
): Map<number, { audioPath: string; realPath?: string; durationMs: number; sampleRate?: number }> | undefined {
  if (!VOICEPRINT_MEDIA_ID_REGEX.test(recordingBaseId)) {
    return undefined;
  }
  const prefix = `${recordingBaseId}`;
  const segments = new Map<number, { audioPath: string; realPath?: string; durationMs: number; sampleRate?: number }>();
  for (const root of allowedAudioRoots) {
    const dirs = [resolve(root)];
    try {
      for (const entry of readdirSync(resolve(root), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(join(resolve(root), entry.name));
        }
      }
    } catch {
      continue;
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith(".wav")) {
          continue;
        }
        const suffix = name.slice(prefix.length, -".wav".length);
        const match = VOICEPRINT_SEGMENT_SUFFIX_REGEX.exec(suffix);
        if (!match) {
          continue;
        }
        const index = Number.parseInt(match[1]!, 10);
        const audioPath = join(dir, name);
        const sidecarPath = join(dir, `${name.slice(0, -".wav".length)}.json`);
        if (!existsSync(sidecarPath)) {
          continue;
        }
        let sidecar: ReturnType<typeof readVoiceprintMediaSidecar>;
        try {
          sidecar = readVoiceprintMediaSidecar(sidecarPath);
        } catch {
          continue;
        }
        // Only FINALIZED audio segments participate; an open segment's duration
        // is still growing and would corrupt the cumulative timeline.
        if (!sidecar.final_iso) {
          continue;
        }
        if (typeof sidecar.mime === "string" && !sidecar.mime.startsWith("audio/")) {
          continue;
        }
        const durationMs = typeof sidecar.duration_ms === "number" && Number.isFinite(sidecar.duration_ms)
          ? sidecar.duration_ms
          : undefined;
        if (durationMs === undefined || durationMs <= 0) {
          continue;
        }
        const existing = segments.get(index);
        if (existing) {
          // The same physical file can be reached twice via nested/overlapping
          // allowed roots — that is a duplicate, not a conflict. Only a
          // DIFFERENT file claiming the same segment index is ambiguous.
          if (existing.audioPath === audioPath || existing.realPath === safeRealpath(audioPath)) {
            continue;
          }
          return undefined;
        }
        segments.set(index, {
          audioPath,
          realPath: safeRealpath(audioPath),
          durationMs,
          sampleRate: sampleRateFromMime(sidecar.mime),
        });
      }
    }
  }
  return segments;
}

function resolveVoiceprintSegmentedMediaArtifact(input: {
  recordingBaseId: string;
  startMs?: number;
  endMs?: number;
  allowedAudioRoots: readonly string[];
}): { audioPath: string; sampleRate?: number; requestStartMs?: number; requestEndMs?: number } | undefined {
  if (!VOICEPRINT_MEDIA_ID_REGEX.test(input.recordingBaseId)) {
    return undefined;
  }
  const startMs = input.startMs;
  const endMs = input.endMs;
  if (
    startMs === undefined || endMs === undefined ||
    !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
    startMs < 0 || endMs <= startMs
  ) {
    return undefined;
  }

  const segments = collectFinalizedVoiceprintSegments(
    input.recordingBaseId,
    input.allowedAudioRoots,
  );
  if (!segments || segments.size === 0) {
    return undefined;
  }

  // Build the cumulative timeline from seg 0; stop at the first gap.
  let best: { audioPath: string; sampleRate?: number; requestStartMs: number; requestEndMs: number; overlapMs: number } | undefined;
  let offsetMs = 0;
  let turnEndCovered = false;
  for (let index = 0; segments.has(index); index += 1) {
    const segment = segments.get(index)!;
    const segStart = offsetMs;
    const segEnd = offsetMs + segment.durationMs;
    offsetMs = segEnd;
    const overlapStart = Math.max(startMs, segStart);
    const overlapEnd = Math.min(endMs, segEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    // Tolerance absorbs ms-level drift between the phone's frame-counter turn
    // stamps and the sidecars' measured durations, so a session's FINAL turn
    // (whose endMs can land a hair past the last finalized segment) still
    // resolves instead of being dropped after the retry loop. A turn missing
    // MORE than the tolerance is genuinely un-uploaded audio → stay not-ready.
    if (endMs <= segEnd + VOICEPRINT_SEGMENT_DRIFT_TOLERANCE_MS) {
      turnEndCovered = true;
    }
    const overlapMs = overlapEnd - overlapStart;
    if (!best || overlapMs > best.overlapMs) {
      best = {
        audioPath: segment.audioPath,
        sampleRate: segment.sampleRate,
        requestStartMs: overlapStart - segStart,
        requestEndMs: overlapEnd - segStart,
        overlapMs,
      };
    }
  }
  // The tail of the turn is in a segment that has not finalized (or not
  // uploaded) yet — report "not ready" so the caller's retry loop waits for it
  // instead of scoring a truncated window.
  if (!best || !turnEndCovered) {
    return undefined;
  }
  // Return the EXACT overlap window. The speaker model embeds windows well
  // under a second (measured to 200ms), and padding the window with adjacent
  // audio measurably DILUTES the embedding (silence / assistant echo pull the
  // cosine below the owner threshold), so no minimum-length padding is applied.
  return {
    audioPath: best.audioPath,
    sampleRate: best.sampleRate,
    requestStartMs: best.requestStartMs,
    requestEndMs: best.requestEndMs,
  };
}

export function resolveVoiceprintMediaArtifactPath(input: {
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
