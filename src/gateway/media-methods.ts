// =============================================================================
// Media RPC Method Handlers (M0 Slice 0 + Slice 3)
//
// Registers the media.chunk.upload RPC method on the gateway. Dispatches to
// the audio WAV writer (Slice 0) or the video fMP4 writer (Slice 3) based on
// the mime family of the incoming chunk.
//
// Audio (mime starts with "audio/"): WAV writer — see media-writer.ts
// Video (mime starts with "video/"): fMP4 writer via ffmpeg — see media-writer-video.ts
//
// Deferred (later slices):
//   - media.get, media.list, media.delete
// =============================================================================

import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import {
  handleMediaChunk,
  handleLiveChunk,
  type MediaChunkParams,
  type LiveMediaKind,
} from "./media-writer.js";
import { handleVideoChunk, checkFfmpeg } from "./media-writer-video.js";
import { MEDIA_ID_REGEX } from "./media-id.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/media-methods");

// -----------------------------------------------------------------------------
// Ingress validation constants
// -----------------------------------------------------------------------------

/**
 * Allow-list for `media_id`. Prevents path traversal (`../..`), absolute
 * paths, and shell-unsafe characters from reaching the filesystem layer,
 * which composes the on-disk path as `<root>/<date>/<media_id>.wav`.
 *
 * First character must be alphanumeric or `_`/`-` — this rejects pure-dot
 * ids (`.`, `..`) and ids that would otherwise be leading-dot hidden files
 * even though every character technically lives in the allow-list set.
 * Subsequent characters may include `.` to accommodate UUIDs and clients
 * that embed track markers (e.g. `c-<ts>.mic`). Total length 1-64.
 *
 * Shared with vision-methods via media-id.ts so the two surfaces can't drift.
 */

/**
 * Per-chunk size cap, measured against the decoded PCM length. 2 MB gives
 * ~2× headroom over the worst-case legitimate chunk we expect today:
 *   - 48 kHz mono PCM16 = 96 KB/s → a 10-second reconnect backfill is
 *     ~960 KB. Normal steady-state chunks are <100 KB.
 * The ~2× margin absorbs bursty reconnects without letting a single RPC
 * commit gigabytes of memory/disk during `Buffer.from(bytes, "base64")`.
 *
 * Base64 inflates raw bytes by ~33%, so the incoming string length is up
 * to ~2.7 MB. We check the string length first (cheap) to reject before
 * allocating the decoded buffer.
 */
const MAX_CHUNK_RAW_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BASE64_LEN = Math.ceil(MAX_CHUNK_RAW_BYTES * 4 / 3) + 4;

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerMediaMethods(server: GatewayServer): void {
  // Log ffmpeg availability at registration time (not a hard failure — audio still works).
  const ffmpegReady = checkFfmpeg();
  if (!ffmpegReady) {
    log.warn("ffmpeg not available at startup — video/mp4 uploads will be rejected");
  }

  // ---------------------------------------------------------------------------
  // media.chunk.upload
  //
  // Receives a single media chunk from iOS and writes it to disk:
  //   - mime starts with "audio/" → streaming WAV writer (Slice 0)
  //   - mime starts with "video/" → fMP4 writer via ffmpeg (Slice 3)
  //
  // Auth: enforced by the gateway's handshake wrapper, NOT inside this
  // handler. See GatewayServer.handleConnect in src/gateway/server.ts — any
  // connection without a valid device token is rejected before "connect"
  // completes, so a message reaching this handler is already authenticated.
  // The `_conn` parameter is intentionally unused here (hence the leading
  // underscore); if we ever need to bind behavior to the authenticated
  // device identity we'll read from `_conn` directly.
  //
  // Params:
  //   media_id       string    — client-generated UUID (reuse capture_id)
  //   seq            number    — monotonic from 0
  //   bytes          string    — base64-encoded PCM or video bytes
  //   mime           string    — "audio/pcm16;rate=16000" | "audio/pcm16" | "video/mp4"
  //   captured_at_ns number    — monotonic ns since capture_start
  //   final?         boolean   — if true, finalize file and close writer
  //
  // Returns: { ok: true }
  // ---------------------------------------------------------------------------
  server.registerMethod("media.chunk.upload", async (_conn, params) => {
    const p = params as Record<string, unknown> | undefined;
    if (!p) throw new MethodError("INVALID_REQUEST", "params required");

    // -------------------------------------------------------------------------
    // Optional live-chunk branch (priority-stream contract v1).
    //
    // If media_kind is "frame" or "audio_chunk", route to the live-chunk
    // writer. Archival uploads (media_kind absent or "segment") fall through
    // to the audio/video file writers below.
    // -------------------------------------------------------------------------
    const rawKind = p.media_kind;
    if (rawKind !== undefined && rawKind !== null && rawKind !== "segment") {
      if (rawKind !== "frame" && rawKind !== "audio_chunk") {
        throw new MethodError(
          "INVALID_REQUEST",
          "media_kind must be one of 'segment' | 'frame' | 'audio_chunk'",
        );
      }
      if (typeof p.session_key !== "string") {
        throw new MethodError("INVALID_REQUEST", "session_key is required for live media_kind");
      }
      if (typeof p.bytes !== "string") {
        throw new MethodError("INVALID_REQUEST", "bytes must be a base64 string");
      }
      if (p.bytes.length > MAX_CHUNK_BASE64_LEN) {
        throw new MethodError(
          "INVALID_REQUEST",
          `chunk too large (${p.bytes.length} base64 chars). Max ${MAX_CHUNK_RAW_BYTES / 1024 / 1024} MB raw per chunk.`,
        );
      }
      if (
        p.ts_captured_ns !== undefined &&
        (typeof p.ts_captured_ns !== "number" || !Number.isFinite(p.ts_captured_ns))
      ) {
        throw new MethodError("INVALID_REQUEST", "ts_captured_ns must be a finite number");
      }
      if (p.device_id !== undefined && typeof p.device_id !== "string") {
        throw new MethodError("INVALID_REQUEST", "device_id must be a string");
      }

      try {
        const result = await handleLiveChunk({
          session_key: p.session_key,
          media_kind: rawKind as LiveMediaKind,
          bytes: p.bytes,
          ts_captured_ns:
            typeof p.ts_captured_ns === "number" ? p.ts_captured_ns : undefined,
          device_id: typeof p.device_id === "string" ? p.device_id : undefined,
        });
        log.debug("media.chunk.upload live", {
          session_key: p.session_key,
          media_kind: rawKind,
          seq: result.seq,
          bytes_len: p.bytes.length,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new MethodError("INVALID_REQUEST", msg);
      }
    }

    // Validate required fields.
    //
    // media_id flows into a filesystem path (`<root>/<date>/<media_id>.wav`),
    // so it must match a conservative allow-list — a string like "../secrets"
    // would otherwise write outside the media root.
    if (typeof p.media_id !== "string" || !MEDIA_ID_REGEX.test(p.media_id)) {
      throw new MethodError(
        "INVALID_REQUEST",
        `media_id must match /${MEDIA_ID_REGEX.source}/`,
      );
    }
    if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq < 0) {
      throw new MethodError("INVALID_REQUEST", "seq must be a non-negative integer");
    }
    if (typeof p.bytes !== "string") {
      throw new MethodError("INVALID_REQUEST", "bytes must be a base64 string");
    }
    // Size cap on the base64 string — cheap to check, rejects before we
    // allocate the decoded buffer. See MAX_CHUNK_RAW_BYTES rationale above.
    if (p.bytes.length > MAX_CHUNK_BASE64_LEN) {
      throw new MethodError(
        "INVALID_REQUEST",
        `chunk too large (${p.bytes.length} base64 chars). Max ${MAX_CHUNK_RAW_BYTES / 1024 / 1024} MB raw per chunk.`,
      );
    }
    if (typeof p.mime !== "string" || !p.mime.trim()) {
      throw new MethodError("INVALID_REQUEST", "mime must be a non-empty string");
    }
    if (typeof p.captured_at_ns !== "number") {
      throw new MethodError("INVALID_REQUEST", "captured_at_ns must be a number");
    }

    const mime = p.mime as string;

    log.debug("media.chunk.upload", {
      media_id: p.media_id,
      seq: p.seq,
      mime,
      bytes_len: (p.bytes as string).length,
      final: p.final === true,
    });

    // Dispatch by mime family
    if (mime.startsWith("video/")) {
      // Slice 3: fMP4 writer via ffmpeg
      try {
        return await handleVideoChunk({
          media_id: p.media_id as string,
          seq: p.seq as number,
          bytes: p.bytes as string,
          mime,
          captured_at_ns: p.captured_at_ns as number,
          final: p.final === true,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ffmpeg-not-available") {
          throw new MethodError("UNSUPPORTED_OPERATION", "ffmpeg-not-available");
        }
        throw err;
      }
    }

    // Default: audio branch (Slice 0) — WAV writer
    const chunk: MediaChunkParams = {
      media_id: p.media_id as string,
      seq: p.seq as number,
      bytes: p.bytes as string,
      mime,
      captured_at_ns: p.captured_at_ns as number,
      final: p.final === true,
    };

    return handleMediaChunk(chunk);
  });
}
