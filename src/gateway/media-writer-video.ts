// =============================================================================
// Streaming fMP4 Video Writer for Media Chunk Upload (M0 Slice 3, v2)
//
// Implements append-friendly fragmented MP4 (fMP4) writing via an ffmpeg child
// process. On first chunk, spawns ffmpeg with stdin as the input pipe and the
// output file path as the destination. Subsequent chunks pipe bytes to ffmpeg
// stdin. On final:true, closes stdin, waits for ffmpeg to exit, then computes
// sha256 and updates the sidecar.
//
// ffmpeg invocation:
//   ffmpeg -y -f mp4 -i pipe:0 -c copy \
//     -movflags +frag_keyframe+empty_moov+default_base_moof \
//     <out>.mp4
//
// On-disk layout:
//   ~/.hawky/workspace/media/<YYYY-MM-DD>/<media_id>.mp4
//   ~/.hawky/workspace/media/<YYYY-MM-DD>/<media_id>.json  (sidecar)
//
// ffmpeg availability:
//   Checked once at module load via checkFfmpeg(). If unavailable, video
//   uploads are rejected with error code "ffmpeg-not-available".
//
// Init-segment ordering protection:
//   iOS AVAssetWriterDelegate can deliver chunks out-of-order under backpressure
//   or WS reconnect. Without seq=0 (the fMP4 init segment / moov box), ffmpeg
//   cannot parse subsequent moof+mdat fragments — seen as "could not find
//   corresponding trex" errors.
//
//   Fix: buffer chunks per media_id until seq=0 has arrived. Only start piping
//   to ffmpeg stdin once we have the init segment. After that, write chunks in
//   seq order. Buffer is capped at MAX_BUFFER_CHUNKS per media_id.
// =============================================================================

import { mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createSubsystemLogger } from "../logging/index.js";
import { getNodeId } from "../storage/node-id.js";
import { getBus } from "../bus/index.js";
import type { MediaFinalizedEvent } from "../bus/events.js";
import { resolveMediaRoot } from "./media-root.js";

const log = createSubsystemLogger("gateway/media-writer-video");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Maximum buffered chunks per media_id before seq=0 has arrived.
 * Clients that never send seq=0 within this window have their chunks dropped.
 */
const MAX_BUFFER_CHUNKS = 32;

// -----------------------------------------------------------------------------
// ffmpeg availability check
// -----------------------------------------------------------------------------

let ffmpegAvailable: boolean | null = null;
let ffmpegPath = "ffmpeg";

/**
 * Check whether ffmpeg is available. Result is cached after the first call.
 * Exported for tests.
 */
export function checkFfmpeg(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execFileSync(ffmpegPath, ["-version"], { stdio: "pipe" });
    ffmpegAvailable = true;
    log.info("ffmpeg available", { path: ffmpegPath });
  } catch {
    ffmpegAvailable = false;
    log.warn("ffmpeg not available — video uploads will be rejected", { path: ffmpegPath });
  }
  return ffmpegAvailable;
}

/**
 * Override ffmpeg path (for testing with a custom binary location).
 * Resets the cached availability check.
 */
export function setFfmpegPath(path: string): void {
  ffmpegPath = path;
  ffmpegAvailable = null;
}

/**
 * Reset the cached ffmpeg availability check (for testing).
 */
export function resetFfmpegCheck(): void {
  ffmpegAvailable = null;
  ffmpegPath = "ffmpeg";
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Per-media_id buffer for init-segment ordering protection.
 * Holds chunks until seq=0 arrives, then drains in order into ffmpeg stdin.
 */
interface ChunkBuffer {
  /** Raw decoded bytes keyed by seq number, buffered before/after ffmpeg start */
  bySeq: Map<number, Buffer>;
  /** true once seq=0 has been received and ffmpeg has been spawned */
  ffmpegStarted: boolean;
  /** the next seq we expect to pipe to ffmpeg stdin */
  nextExpectedSeq: number;
  /** ffmpeg child process — set once ffmpegStarted = true */
  ffmpegProcess: ChildProcess | null;
  /** Resolves when ffmpeg exits */
  exitPromise: Promise<number | null> | null;
}

interface VideoWriterState {
  filePath: string;
  sidecarPath: string;
  seqGaps: [number, number][];
  capturedStartIso: string;
  mime: string;
  buffer: ChunkBuffer;
}

interface MediaSidecar {
  mime: string;
  captured_start_iso: string;
  locked: boolean;
  seq_gaps?: [number, number][];
  duration_ms?: number;
  sha256?: string;
  final_iso?: string;
}

// -----------------------------------------------------------------------------
// Writer state registry
// -----------------------------------------------------------------------------

const videoWriters = new Map<string, VideoWriterState>();

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Handle a single video chunk upload.
 *
 * Buffers chunks until seq=0 arrives (init-segment ordering protection). Once
 * seq=0 is available, spawns ffmpeg and drains buffered chunks in order.
 * Closes stdin + finalizes on final:true.
 *
 * Throws an error with code "ffmpeg-not-available" if ffmpeg is not installed.
 */
export async function handleVideoChunk(params: {
  media_id: string;
  seq: number;
  bytes: string;
  mime: string;
  captured_at_ns: number;
  final?: boolean;
}): Promise<{ ok: true }> {
  const { media_id, seq, bytes, mime, final } = params;

  if (!checkFfmpeg()) {
    const err = new Error("ffmpeg is not available on this gateway — video uploads are not supported");
    (err as NodeJS.ErrnoException).code = "ffmpeg-not-available";
    throw err;
  }

  const data = Buffer.from(bytes, "base64");

  let state = videoWriters.get(media_id);

  if (!state) {
    state = await initWriterState(media_id, mime);
  }

  // Buffer the chunk and drain what we can
  await bufferChunk(state, media_id, seq, data);

  if (final) {
    await finalizeVideoWriter(media_id);
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Create a new VideoWriterState (filesystem dirs + sidecar) without starting ffmpeg yet. */
async function initWriterState(media_id: string, mime: string): Promise<VideoWriterState> {
  const mediaRoot = resolveMediaRoot();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = join(mediaRoot, today);

  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${media_id}.mp4`);
  const sidecarPath = join(dir, `${media_id}.json`);
  const capturedStartIso = new Date().toISOString();

  const buffer: ChunkBuffer = {
    bySeq: new Map(),
    ffmpegStarted: false,
    nextExpectedSeq: 0,
    ffmpegProcess: null,
    exitPromise: null,
  };

  const state: VideoWriterState = {
    filePath,
    sidecarPath,
    seqGaps: [],
    capturedStartIso,
    mime,
    buffer,
  };

  videoWriters.set(media_id, state);

  // Write initial sidecar
  const sidecar: MediaSidecar = {
    mime,
    captured_start_iso: capturedStartIso,
    locked: false,
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");

  log.info("created video writer state", { media_id, filePath });
  return state;
}

/**
 * Buffer a decoded chunk and attempt to drain into ffmpeg.
 * Enforces MAX_BUFFER_CHUNKS cap per media_id to prevent unbounded memory.
 */
async function bufferChunk(
  state: VideoWriterState,
  media_id: string,
  seq: number,
  data: Buffer,
): Promise<void> {
  const buf = state.buffer;

  // Cap enforcement: drop if buffer is full and seq=0 still hasn't arrived
  if (!buf.ffmpegStarted && buf.bySeq.size >= MAX_BUFFER_CHUNKS) {
    log.warn("video chunk buffer cap reached — dropping chunk", {
      media_id,
      seq,
      cap: MAX_BUFFER_CHUNKS,
    });
    return;
  }

  buf.bySeq.set(seq, data);

  // Try to start ffmpeg now that seq=0 has arrived
  if (!buf.ffmpegStarted && buf.bySeq.has(0)) {
    startFfmpeg(state, media_id);
  }

  // Drain in-order chunks into ffmpeg stdin
  if (buf.ffmpegStarted) {
    await drainBuffer(state, media_id);
  }
}

/** Spawn the ffmpeg process for this media_id (synchronous setup, async writes come from drainBuffer). */
function startFfmpeg(state: VideoWriterState, media_id: string): void {
  const buf = state.buffer;

  log.info("spawning ffmpeg for video", { media_id, filePath: state.filePath });

  // Spawn ffmpeg reading from stdin, writing fMP4 to file.
  // -f mp4 tells ffmpeg the input format is MP4 (fragmented segments from iOS).
  // -movflags +frag_keyframe+empty_moov+default_base_moof produces a live-growth
  // fMP4 output where each fragment is self-contained.
  const ffmpegProcess = spawn(
    ffmpegPath,
    [
      "-y",
      "-f", "mp4",
      "-i", "pipe:0",
      "-c", "copy",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      state.filePath,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Capture stderr for debugging
  const stderrChunks: Buffer[] = [];
  ffmpegProcess.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // Build an exit promise so we can await it during finalization
  const exitPromise = new Promise<number | null>((resolve) => {
    ffmpegProcess.on("exit", (code) => {
      resolve(code);
    });
    ffmpegProcess.on("error", (err) => {
      log.error("ffmpeg process error", { media_id, err: err.message });
      resolve(null);
    });
  });

  // Log ffmpeg stderr on exit for diagnostics
  ffmpegProcess.on("exit", (code) => {
    const stderr = Buffer.concat(stderrChunks).toString("utf-8");
    if (code !== 0) {
      log.warn("ffmpeg exited with non-zero code", { media_id, code, stderr: stderr.slice(-500) });
    } else {
      log.debug("ffmpeg exited cleanly", { media_id, code });
    }
  });

  buf.ffmpegProcess = ffmpegProcess;
  buf.exitPromise = exitPromise;
  buf.ffmpegStarted = true;
  buf.nextExpectedSeq = 0;
}

/**
 * Drain sequentially-ordered chunks from the buffer into ffmpeg stdin.
 * Advances nextExpectedSeq as each chunk is piped.
 * Records seq gaps in state.seqGaps when contiguous drain runs end.
 */
async function drainBuffer(state: VideoWriterState, media_id: string): Promise<void> {
  const buf = state.buffer;
  if (!buf.ffmpegProcess || !buf.ffmpegProcess.stdin) return;

  while (buf.bySeq.has(buf.nextExpectedSeq)) {
    const seq = buf.nextExpectedSeq;
    const chunk = buf.bySeq.get(seq)!;
    buf.bySeq.delete(seq);

    await writeChunkToStdin(buf.ffmpegProcess, media_id, chunk);

    buf.nextExpectedSeq = seq + 1;
  }
}

/** Write a single chunk buffer to ffmpeg stdin, respecting backpressure. */
async function writeChunkToStdin(
  ffmpegProcess: ChildProcess,
  media_id: string,
  data: Buffer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!ffmpegProcess.stdin) {
      reject(new Error(`ffmpeg stdin is not available for media_id=${media_id}`));
      return;
    }
    const ok = ffmpegProcess.stdin.write(data);
    if (ok) {
      resolve();
    } else {
      ffmpegProcess.stdin.once("drain", resolve);
    }
  });
}

async function finalizeVideoWriter(media_id: string): Promise<void> {
  const state = videoWriters.get(media_id);
  if (!state) {
    log.warn("finalizeVideoWriter called for unknown media_id", { media_id });
    return;
  }

  videoWriters.delete(media_id);

  const { filePath, sidecarPath, capturedStartIso, mime, buffer } = state;

  // If ffmpeg was never started (seq=0 never arrived), log and bail.
  if (!buffer.ffmpegStarted) {
    log.warn("finalizeVideoWriter: seq=0 never arrived — ffmpeg not spawned, sidecar incomplete", {
      media_id,
      buffered_seqs: [...buffer.bySeq.keys()],
    });
    return;
  }

  // Try to drain any remaining buffered chunks before closing
  await drainBuffer(state, media_id);

  // Record gaps: any remaining chunks in bySeq are unreachable (gap before them)
  if (buffer.bySeq.size > 0) {
    const seqs = [...buffer.bySeq.keys()].sort((a, b) => a - b);
    state.seqGaps.push([buffer.nextExpectedSeq, seqs[seqs.length - 1]]);
    log.warn("video finalize: un-drained buffered chunks (sequence gap)", {
      media_id,
      gap_start: buffer.nextExpectedSeq,
      undrained_seqs: seqs,
    });
  }

  const { ffmpegProcess, exitPromise } = buffer;

  // Close stdin to signal EOF to ffmpeg
  if (ffmpegProcess!.stdin) {
    ffmpegProcess!.stdin.end();
  }

  // Wait for ffmpeg to exit (with a timeout)
  const timeoutMs = 30_000;
  const exitCode = await Promise.race([
    exitPromise!,
    new Promise<number | null>((resolve) =>
      setTimeout(() => {
        log.warn("ffmpeg timed out, killing", { media_id });
        try { ffmpegProcess!.kill("SIGKILL"); } catch { /* ok */ }
        resolve(null);
      }, timeoutMs),
    ),
  ]);

  if (exitCode !== 0) {
    log.warn("ffmpeg exited non-zero during finalization", { media_id, exitCode });
  }

  log.info("finalized video", { media_id, filePath });

  // Compute SHA-256 of the completed file
  let sha256: string | undefined;
  let duration_ms: number | undefined;
  try {
    const fileBytes = await readFile(filePath);
    sha256 = createHash("sha256").update(fileBytes).digest("hex");

    // Attempt to get duration via ffprobe if available
    duration_ms = await probeDurationMs(filePath);
  } catch (err) {
    log.warn("failed to read output file for sha256/duration", { media_id, err: String(err) });
  }

  const finalIso = new Date().toISOString();

  // Update sidecar
  const sidecar: MediaSidecar = {
    mime,
    captured_start_iso: capturedStartIso,
    locked: false,
    final_iso: finalIso,
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(duration_ms !== undefined ? { duration_ms } : {}),
    ...(state.seqGaps.length > 0 ? { seq_gaps: state.seqGaps } : {}),
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");

  log.info("video sidecar updated", { media_id, sha256, duration_ms });

  if (!sha256) {
    log.warn("skipping media.finalized publish for video without sha256", { media_id });
    return;
  }

  try {
    const event: MediaFinalizedEvent = {
      media_id,
      kind: "cam",
      path: filePath,
      sidecar_path: sidecarPath,
      duration_ms: duration_ms ?? 0,
      sha256,
      mime,
      node_id: getNodeId(),
      captured_start_iso: capturedStartIso,
    };
    getBus().publish("media.finalized", event);
  } catch (err) {
    log.warn("video media.finalized publish failed (non-fatal)", {
      media_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// -----------------------------------------------------------------------------
// ffprobe duration helper
// -----------------------------------------------------------------------------

/**
 * Use ffprobe to get the duration of a media file in milliseconds.
 * Returns undefined if ffprobe is not available or fails.
 */
async function probeDurationMs(filePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = spawn(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    probe.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

    probe.on("exit", (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      try {
        const output = Buffer.concat(chunks).toString("utf-8");
        const json = JSON.parse(output) as { format?: { duration?: string } };
        const durationSec = parseFloat(json.format?.duration ?? "");
        if (isFinite(durationSec) && durationSec > 0) {
          resolve(Math.round(durationSec * 1000));
        } else {
          resolve(undefined);
        }
      } catch {
        resolve(undefined);
      }
    });

    probe.on("error", () => resolve(undefined));
  });
}

// -----------------------------------------------------------------------------
// Teardown helper (for testing)
// -----------------------------------------------------------------------------

export function resetVideoWriters(): void {
  for (const [, state] of videoWriters) {
    try {
      const proc = state.buffer.ffmpegProcess;
      if (proc) {
        if (proc.stdin) proc.stdin.end();
        proc.kill("SIGKILL");
      }
    } catch { /* ok */ }
  }
  videoWriters.clear();
}
