// =============================================================================
// Streaming WAV Writer for Media Chunk Upload (M0 Slice 0)
//
// Implements append-friendly WAV file writing with placeholder headers so
// mid-recording reads are valid. On first chunk, creates the WAV file with a
// 44-byte header using placeholder max-u32 sizes. On subsequent chunks,
// appends raw PCM bytes. On final:true, patches the RIFF and data sizes.
//
// On-disk layout:
//   ~/.hawky/workspace/media/<YYYY-MM-DD>/<media_id>.wav
//   ~/.hawky/workspace/media/<YYYY-MM-DD>/<media_id>.json  (sidecar)
// =============================================================================

import { existsSync, mkdirSync, statSync } from "node:fs";
import { open, writeFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/index.js";
import { getNodeId } from "../storage/node-id.js";
import { MethodError } from "./methods.js";
import { getBus } from "../bus/index.js";
import type { MediaFinalizedEvent, MediaLiveChunkEvent } from "../bus/events.js";
import { resolveMediaRoot } from "./media-root.js";

const log = createSubsystemLogger("gateway/media-writer");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const WAV_HEADER_SIZE = 44;
// Placeholder sizes in WAV header: max u32 so mid-recording reads are valid.
// Both RIFF size (offset 4) and data chunk size (offset 40) use this value.
const WAV_PLACEHOLDER_SIZE = 0xffffffff;

// Default PCM format: 16-bit mono 16 kHz
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS_PER_SAMPLE = 16;

// Cumulative cap per media_id. Sized at ~1 GB, which is roughly 5 hours of
// 48 kHz mono PCM16 (or ~9 hours at 16 kHz). The per-chunk cap in
// media-methods.ts protects against a single oversized frame; this cap
// protects against a slow leak of valid sub-cap chunks under one media_id
// (buggy / hostile client looping forever).
const DEFAULT_MAX_TOTAL_BYTES = 1_000_000_000;
let MAX_TOTAL_BYTES = DEFAULT_MAX_TOTAL_BYTES;

/**
 * Test-only override for the cumulative cap. Pushing 1 GB of fake PCM
 * through the RPC just to assert the threshold is impractical, so tests
 * lower the cap to a workable size and restore it in `afterEach`.
 */
export function __setMaxTotalBytesForTesting(n: number | null): void {
  MAX_TOTAL_BYTES = n ?? DEFAULT_MAX_TOTAL_BYTES;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface MediaChunkParams {
  media_id: string;
  seq: number;
  bytes: string; // base64-encoded PCM bytes
  mime: string;
  captured_at_ns: number;
  final?: boolean;
}

interface WriterState {
  handle: FileHandle;
  filePath: string;
  sidecarPath: string;
  /** Last seq successfully written. -1 before any data chunk has been appended. */
  lastWrittenSeq: number;
  /** Next seq we expect; advances only after a successful write. */
  expectedSeq: number;
  seqGaps: [number, number][];
  capturedStartIso: string;
  mime: string;
  sampleRate: number;
  /**
   * Unix-ms timestamp of the last successful append (or initWriter). The
   * stale-writer reaper uses this to identify abandoned recordings from
   * clients that died mid-stream — otherwise the fd + state leaks forever.
   */
  lastActivityAt: number;
  /**
   * Per-chunk capture timing, accumulated in arrival order. Each entry
   * pairs the accepted `seq` with the client-supplied `captured_at_ns`.
   * Needed by downstream consumers (e.g. transcription) to align audio
   * samples with whatever the client was doing when it captured them.
   */
  chunks: Array<{ seq: number; captured_at_ns: number }>;
  /**
   * Cumulative count of PCM bytes accepted under this media_id. Compared
   * against MAX_TOTAL_BYTES on every append so a slow leak of valid
   * sub-cap chunks can't grow an unbounded recording.
   */
  totalBytes: number;
}

interface MediaSidecar {
  mime: string;
  captured_start_iso: string;
  locked: boolean;
  seq_gaps?: [number, number][];
  duration_ms?: number;
  sha256?: string;
  final_iso?: string;
  /** Per-chunk timing (seq + captured_at_ns) in arrival order. */
  chunks?: Array<{ seq: number; captured_at_ns: number }>;
}

// -----------------------------------------------------------------------------
// WAV header builder
// -----------------------------------------------------------------------------

/**
 * Build a 44-byte PCM WAV header.
 * Uses 0xFFFFFFFF as placeholder sizes so the file reads as valid mid-recording.
 */
function buildWavHeader(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  riffSize = WAV_PLACEHOLDER_SIZE,
  dataSize = WAV_PLACEHOLDER_SIZE,
): Buffer {
  const buf = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  // RIFF chunk descriptor
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(riffSize, 4);
  buf.write("WAVE", 8, "ascii");

  // fmt sub-chunk
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);          // PCM sub-chunk size
  buf.writeUInt16LE(1, 20);           // AudioFormat = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  return buf;
}

// -----------------------------------------------------------------------------
// Sample rate parsing from MIME
// -----------------------------------------------------------------------------

/**
 * Parse sample rate from mime string, e.g. "audio/pcm16;rate=24000" → 24000.
 * Falls back to DEFAULT_SAMPLE_RATE if not found.
 */
function parseSampleRate(mime: string): number {
  const match = /rate=(\d+)/i.exec(mime);
  if (match) {
    const rate = parseInt(match[1], 10);
    if (!isNaN(rate) && rate > 0) return rate;
  }
  return DEFAULT_SAMPLE_RATE;
}

// -----------------------------------------------------------------------------
// Writer state registry + stale-writer reaper
//
// Motivation: clients die mid-stream (tab closes, network drops, process
// OOM). Without a reaper, their WriterState — including an open FileHandle —
// stays in `writers` forever. Over time that leaks fds (hitting the OS
// ulimit) and leaves abandoned zero-byte `.wav` files lying around.
//
// Design: stamp `lastActivityAt` on every successful init/append, then a
// periodic sweep reaps entries idle > STALE_MS. The sweep auto-starts on
// first writer and stops when `writers` drains, so the idle gateway pays
// no timer cost.
// -----------------------------------------------------------------------------

const writers = new Map<string, WriterState>();

/**
 * How long a writer may sit idle before the reaper treats it as abandoned.
 * Chosen at 2× a conservative upper bound on inter-chunk gap — clients
 * chunk every ~100-500 ms in steady state; a 60 s silence strongly
 * implies the client is gone (network drop, tab close, process crash).
 */
const STALE_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweeperRunning(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void reapStaleWriters(Date.now()).catch((err) => {
      log.warn("reapStaleWriters threw", { err: String(err) });
    });
  }, SWEEP_INTERVAL_MS);
  // unref so the reaper doesn't keep the process alive on its own — the
  // gateway owning process decides the lifetime.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  log.debug("stale-writer sweeper started", { intervalMs: SWEEP_INTERVAL_MS, staleMs: STALE_MS });
}

function stopSweeperIfIdle(): void {
  if (sweepTimer && writers.size === 0) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    log.debug("stale-writer sweeper stopped (no writers)");
  }
}

/**
 * Reap writers that haven't seen activity for more than STALE_MS. Exposed
 * for tests so they can drive the sweep deterministically without waiting
 * on wall-clock time.
 *
 * @param now  Unix ms used as the comparison point. Tests pass a value far
 *             in the future; production passes Date.now().
 * @returns    media_ids of the writers that were torn down.
 */
export async function reapStaleWriters(now: number): Promise<string[]> {
  const reaped: string[] = [];
  for (const [media_id, state] of writers) {
    if (now - state.lastActivityAt > STALE_MS) {
      log.warn("reaping stale writer", {
        media_id,
        filePath: state.filePath,
        idleMs: now - state.lastActivityAt,
      });
      await destroyWriter(media_id, state);
      reaped.push(media_id);
    }
  }
  stopSweeperIfIdle();
  return reaped;
}

/** Test/diagnostic accessor — how many writers are currently in-flight. */
export function getActiveWriterCount(): number {
  return writers.size;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Handle a single media chunk upload. Creates/appends WAV file and sidecar.
 * Returns { ok: true } on success. On seq gap, logs warning but continues.
 */
export async function handleMediaChunk(params: MediaChunkParams): Promise<{ ok: true }> {
  const { media_id, seq, bytes, mime, captured_at_ns, final } = params;

  const existing = writers.get(media_id);

  if (!existing) {
    // First chunk — set up the file
    await initWriter(media_id, seq, bytes, mime, captured_at_ns);
  } else {
    // Subsequent chunks
    await appendChunk(media_id, existing, seq, bytes, captured_at_ns);
  }

  if (final) {
    await finalizeWriter(media_id);
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

async function initWriter(
  media_id: string,
  seq: number,
  bytes: string,
  mime: string,
  captured_at_ns: number,
): Promise<void> {
  // The RPC contract documents seq as "monotonic from 0". Anything else as
  // a first chunk either means the client dropped the initial frames (in
  // which case the safer move is to reject so it retries from 0) or is a
  // malformed request. Accepting a non-zero start and recording a leading
  // gap would also work but commits us to a larger invariant surface
  // (`seq_gaps[0]` silently encoding a missing preamble). Reject for now;
  // revisit if a legitimate client needs this.
  if (seq !== 0) {
    throw new MethodError(
      "INVALID_REQUEST",
      `first chunk for media_id "${media_id}" must have seq=0, got ${seq}`,
    );
  }

  const mediaRoot = resolveMediaRoot();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = join(mediaRoot, today);

  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${media_id}.wav`);
  const sidecarPath = join(dir, `${media_id}.json`);
  const capturedStartIso = new Date().toISOString();
  const sampleRate = parseSampleRate(mime);

  log.info("opening WAV file", { media_id, filePath, sampleRate });

  // Open with "wx" — fail if the file already exists. Without this, a
  // retry / race / literal-id-reuse silently overwrites a finalized
  // recording and regenerates the sha256 against the new content, which
  // makes the sidecar lie about what was originally captured.
  // wx collision is checked within today's UTC folder; clients use UUID
  // media_ids so cross-day reuse doesn't happen in practice.
  let handle: FileHandle;
  try {
    handle = await open(filePath, "wx");
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      throw new MethodError(
        "ALREADY_EXISTS",
        `media_id "${media_id}" already has a recording on disk`,
      );
    }
    throw err;
  }

  // Write 44-byte WAV header with placeholder sizes. Fsync once here so a
  // crash mid-recording still produces a file with a readable header (the
  // placeholder sizes keep mid-recording reads valid). We skip the per-chunk
  // fsync — durability is only required at finalize.
  const header = buildWavHeader(
    sampleRate,
    DEFAULT_CHANNELS,
    DEFAULT_BITS_PER_SAMPLE,
    WAV_PLACEHOLDER_SIZE - WAV_HEADER_SIZE + 8, // standard placeholder: 0xFFFFFFFF - 36
    WAV_PLACEHOLDER_SIZE,
  );
  await handle.write(header);
  await handle.sync();

  const state: WriterState = {
    handle,
    filePath,
    sidecarPath,
    lastWrittenSeq: -1,
    expectedSeq: seq,
    seqGaps: [],
    capturedStartIso,
    mime,
    sampleRate,
    lastActivityAt: Date.now(),
    chunks: [],
    totalBytes: 0,
  };

  writers.set(media_id, state);
  ensureSweeperRunning();

  // Write initial sidecar
  const sidecar: MediaSidecar = {
    mime,
    captured_start_iso: capturedStartIso,
    locked: false,
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");

  // Append the first chunk's data. If this throws (e.g. disk full mid-way),
  // tear down the partially-initialized writer so the next call starts fresh
  // rather than inheriting an advanced expectedSeq over a zero-byte file.
  try {
    await appendChunk(media_id, state, seq, bytes, captured_at_ns);
  } catch (err) {
    await destroyWriter(media_id, state);
    throw err;
  }
}

async function appendChunk(
  media_id: string,
  state: WriterState,
  seq: number,
  bytes: string,
  captured_at_ns: number,
): Promise<void> {
  // Reject duplicates and out-of-order arrivals. The RPC contract promises
  // seq is monotonic from 0 — a seq we've already written would corrupt the
  // file (PCM bytes appended in arrival order, not seq order), and a seq
  // that regresses expectedSeq produces a nonsensical gap record like
  // `[expectedSeq, seq-1]`. If the client genuinely needs to backfill, it
  // must finalize + start a new media_id.
  if (seq <= state.lastWrittenSeq) {
    throw new MethodError(
      "INVALID_REQUEST",
      `seq ${seq} is not greater than last written seq ${state.lastWrittenSeq}`,
    );
  }

  // Forward gap — client dropped chunks [expectedSeq, seq-1]. Record it in
  // the sidecar so downstream consumers can see the discontinuity, but keep
  // writing: the PCM on disk stays gap-free and the timing of the missing
  // samples is recoverable from `seq_gaps` + sample rate.
  if (seq > state.expectedSeq) {
    log.warn("seq gap detected", {
      media_id,
      expected: state.expectedSeq,
      got: seq,
    });
    state.seqGaps.push([state.expectedSeq, seq - 1]);
  }

  const pcm = Buffer.from(bytes, "base64");

  // Cumulative cap check. The per-chunk cap upstream blocks one giant frame;
  // this catches a slow leak of valid sub-cap chunks under one media_id.
  // Reject before the write — and tear down the writer so the partial
  // recording on disk doesn't linger. The client must restart with a
  // fresh media_id rather than retry under this one.
  if (state.totalBytes + pcm.length > MAX_TOTAL_BYTES) {
    await destroyWriter(media_id, state);
    throw new MethodError(
      "MEDIA_TOO_LARGE",
      `media_id "${media_id}" would exceed cumulative cap of ${MAX_TOTAL_BYTES} bytes`,
    );
  }

  // Stamp activity BEFORE the await so an in-flight slow write isn't reaped
  // mid-syscall by a concurrent sweep tick. The reaper compares
  // `now - lastActivityAt`, so a stale stamp from before the await would
  // race the sweep when a single write takes longer than STALE_MS (rare
  // but possible on a contended disk or slow NFS mount).
  state.lastActivityAt = Date.now();

  // Write and advance state only on success. No per-chunk `fsync` — on a
  // crash the OS may lose the trailing tens of ms of audio, which is fine
  // since the placeholder header still makes the file readable up to
  // whatever the OS did flush. Durability is required only at finalize.
  // If the write itself throws, tear down the writer so a retry starts
  // from seq=0 over a clean file.
  try {
    await state.handle.write(pcm);
  } catch (err) {
    await destroyWriter(media_id, state);
    throw err;
  }

  state.lastWrittenSeq = seq;
  state.expectedSeq = seq + 1;
  state.totalBytes += pcm.length;
  state.chunks.push({ seq, captured_at_ns });
}

/**
 * Tear down a writer on fatal I/O failure: close the handle (best-effort),
 * unlink the partial file + sidecar, drop the registry entry. Leaves the
 * caller free to retry with seq=0 and a fresh file.
 */
async function destroyWriter(media_id: string, state: WriterState): Promise<void> {
  try { await state.handle.close(); } catch { /* handle may already be dead */ }
  try { await unlink(state.filePath); } catch { /* file may not exist */ }
  try { await unlink(state.sidecarPath); } catch { /* sidecar may not exist */ }
  writers.delete(media_id);
  stopSweeperIfIdle();
  log.warn("writer torn down after I/O failure", { media_id, filePath: state.filePath });
}

async function finalizeWriter(media_id: string): Promise<void> {
  const state = writers.get(media_id);
  if (!state) {
    log.warn("finalizeWriter called for unknown media_id", { media_id });
    return;
  }

  const { handle, filePath, sidecarPath, capturedStartIso, mime, sampleRate, seqGaps, chunks } = state;

  // Get file size to patch header sizes
  const fileSize = statSync(filePath).size;
  const riffSize = fileSize - 8;       // RIFF size = file size - 8 (RIFF chunk header)
  const dataSize = fileSize - WAV_HEADER_SIZE; // data size = file size - 44 (WAV header)

  // Patch RIFF size at offset 4
  const riffBuf = Buffer.alloc(4);
  riffBuf.writeUInt32LE(riffSize, 0);
  await handle.write(riffBuf, 0, 4, 4);

  // Patch data size at offset 40
  const dataBuf = Buffer.alloc(4);
  dataBuf.writeUInt32LE(dataSize, 0);
  await handle.write(dataBuf, 0, 4, 40);

  // Single durability barrier at finalize — covers every byte we wrote
  // since the header fsync, including the patched sizes above.
  await handle.sync();
  await handle.close();
  writers.delete(media_id);
  stopSweeperIfIdle();

  log.info("finalized WAV", { media_id, filePath, fileSize, riffSize, dataSize });

  // Compose the final sha256 over the finalized on-disk bytes so the
  // sidecar value matches what a downstream consumer would compute with
  // `shasum -a 256`. We rebuild the 44-byte final header here (the
  // patched RIFF/data sizes differ from the placeholders we wrote on
  // open) and stream the file body from disk so a multi-hour recording
  // doesn't have to slurp ~100 MB+ into memory.
  const finalHeader = buildWavHeader(
    sampleRate,
    DEFAULT_CHANNELS,
    DEFAULT_BITS_PER_SAMPLE,
    riffSize,
    dataSize,
  );
  const sha256 = await computeSha256(filePath, finalHeader);

  // Compute duration. bytesPerSecond drives both the duration math and the
  // sub-half-second skip check below, so derive it once.
  const pcmBytes = fileSize - WAV_HEADER_SIZE;
  const bytesPerSecond = (sampleRate * DEFAULT_CHANNELS * DEFAULT_BITS_PER_SAMPLE) / 8;
  const duration_ms = Math.round((pcmBytes / bytesPerSecond) * 1000);

  const finalIso = new Date().toISOString();

  // Update sidecar
  const sidecar: MediaSidecar = {
    mime,
    captured_start_iso: capturedStartIso,
    locked: false,
    duration_ms,
    sha256,
    final_iso: finalIso,
    ...(seqGaps.length > 0 ? { seq_gaps: seqGaps } : {}),
    ...(chunks.length > 0 ? { chunks } : {}),
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");

  log.info("sidecar updated", { media_id, duration_ms, sha256 });

  // Publish media.finalized on the in-process bus so consumers
  // (asr-pipeline, future processors — wired in subsequent PRs) can act on
  // finalized captures. Producers never know about consumers; one bad
  // handler does not kill siblings (bus catches per-handler errors).
  if (pcmBytes < bytesPerSecond * 0.5) {
    log.info("skipping bus publish: empty/sub-half-second WAV", { media_id, pcmBytes });
    return;
  }
  try {
    const kind: MediaFinalizedEvent["kind"] = mime.startsWith("audio/pcm") ? "mic" : "cam";
    const event: MediaFinalizedEvent = {
      media_id,
      kind,
      path: filePath,
      sidecar_path: sidecarPath,
      duration_ms,
      sha256,
      mime,
      node_id: getNodeId(),
      captured_start_iso: capturedStartIso,
    };
    getBus().publish("media.finalized", event);
  } catch (err) {
    log.warn("bus publish failed (non-fatal)", {
      media_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stream-hash `filePath`: seed with the 44-byte finalized header, then feed
 * the remaining file body in bounded-size chunks. Avoids pulling the whole
 * WAV into memory (a 60-minute recording is ~115 MB at 16 kHz; larger at
 * 48 kHz) just to compute its sha256.
 */
async function computeSha256(filePath: string, finalHeader: Buffer): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256").update(finalHeader);
  return new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath, { start: WAV_HEADER_SIZE });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// -----------------------------------------------------------------------------
// Teardown helper (for testing)
// -----------------------------------------------------------------------------

export async function resetMediaWriters(): Promise<void> {
  for (const [, state] of writers) {
    try { await state.handle.close(); } catch { /* ok */ }
  }
  writers.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  liveSeqCounters.clear();
}

// =============================================================================
// Live-chunk writer (priority-stream contract v1)
//
// Self-contained per-chunk writes. Each chunk is one JPEG frame or one PCM16
// audio buffer; no finalize, no concatenation. Server-assigned monotonic seq
// per (session_key, media_kind). See research/priority-stream-contract.md.
// =============================================================================

export type LiveMediaKind = "frame" | "audio_chunk";

export interface LiveChunkParams {
  session_key: string;
  media_kind: LiveMediaKind;
  bytes: string;            // base64 body
  ts_captured_ns?: number;
  device_id?: string;
}

// PCM16 mono 16 kHz — matches contract. bytes/sec = 16000 * 2 = 32000.
const LIVE_AUDIO_SAMPLE_RATE = 16000;
const LIVE_AUDIO_BYTES_PER_SECOND =
  (LIVE_AUDIO_SAMPLE_RATE * DEFAULT_CHANNELS * DEFAULT_BITS_PER_SAMPLE) / 8;

const SESSION_KEY_MAX = 128;
const SESSION_KEY_RE = /^[A-Za-z0-9:_-]+$/;

// In-memory monotonic counter keyed by `${session_key}\u0000${media_kind}`.
// Survives for the lifetime of the gateway process; a restart resets seq to 0
// (acceptable — iOS treats each session as a fresh live stream).
const liveSeqCounters = new Map<string, number>();

function liveCounterKey(session_key: string, media_kind: LiveMediaKind): string {
  return `${session_key}\u0000${media_kind}`;
}

function nextLiveSeq(session_key: string, media_kind: LiveMediaKind): number {
  const k = liveCounterKey(session_key, media_kind);
  const next = (liveSeqCounters.get(k) ?? 0);
  liveSeqCounters.set(k, next + 1);
  return next;
}

export function validateSessionKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("session_key must be a non-empty string");
  }
  if (raw.length > SESSION_KEY_MAX) {
    throw new Error(`session_key exceeds ${SESSION_KEY_MAX} chars`);
  }
  if (!SESSION_KEY_RE.test(raw)) {
    throw new Error("session_key must match [A-Za-z0-9:_-]+");
  }
  return raw;
}

/**
 * Handle one live chunk upload. Writes file to
 * `<mediaRoot>/<YYYY-MM-DD>/live/<session_key>/<seq>.<ext>` and publishes
 * `media.live.chunk` on the bus. Returns the assigned seq so the caller can
 * echo it back to the client for observability.
 */
export async function handleLiveChunk(
  params: LiveChunkParams,
): Promise<{ ok: true; seq: number; file_path: string }> {
  const session_key = validateSessionKey(params.session_key);
  const media_kind = params.media_kind;
  if (media_kind !== "frame" && media_kind !== "audio_chunk") {
    throw new Error(`unsupported media_kind: ${String(media_kind)}`);
  }
  if (typeof params.bytes !== "string") {
    throw new Error("bytes must be a base64 string");
  }

  const payload = Buffer.from(params.bytes, "base64");
  const seq = nextLiveSeq(session_key, media_kind);
  const paddedSeq = seq.toString().padStart(6, "0");
  const ext = media_kind === "frame" ? "jpg" : "pcm";

  const mediaRoot = resolveMediaRoot();
  const today = new Date().toISOString().slice(0, 10);
  const dir = join(mediaRoot, today, "live", session_key);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${paddedSeq}.${ext}`);
  // Atomic-ish: single writeFile call — Node's fs.writeFile uses open(O_CREAT|
  // O_WRONLY|O_TRUNC) + write + close. For small chunks this is fine; we accept
  // the same partial-write risk the archival WAV writer already accepts.
  await writeFile(filePath, payload);

  const size_bytes = payload.length;
  const duration_ms =
    media_kind === "audio_chunk"
      ? Math.round((size_bytes / LIVE_AUDIO_BYTES_PER_SECOND) * 1000)
      : undefined;

  log.debug("live chunk written", {
    session_key,
    media_kind,
    seq,
    size_bytes,
    file_path: filePath,
  });

  try {
    const event: MediaLiveChunkEvent = {
      session_key,
      media_kind,
      file_path: filePath,
      seq,
      size_bytes,
      ...(params.ts_captured_ns !== undefined ? { ts_captured_ns: params.ts_captured_ns } : {}),
      ...(params.device_id !== undefined ? { device_id: params.device_id } : {}),
      ...(duration_ms !== undefined ? { duration_ms } : {}),
    };
    getBus().publish("media.live.chunk", event);
  } catch (err) {
    // Bus failure must not break the RPC — the file is already on disk.
    log.warn("bus publish failed (non-fatal)", {
      session_key,
      media_kind,
      seq,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: true, seq, file_path: filePath };
}
