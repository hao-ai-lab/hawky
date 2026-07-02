// =============================================================================
// Media Chunk Video Tests (M0 Slice 3, v2)
//
// Tests for video/mp4 uploads via the ffmpeg fMP4 writer.
//
// The entire file is skipped if ffmpeg is not available on the system so CI
// on machines without ffmpeg does not fail.
//
// Test strategy:
//   1. Generate a tiny fMP4 fixture via ffmpeg in beforeAll (testsrc, 1s, 160x120).
//   2. Split it into 3 base64 chunks + final:true and send to media.chunk.upload.
//   3. Assert the .mp4 output has fMP4 magic bytes ("ftyp" at offset 4).
//   4. Assert sidecar has sha256 + final_iso after final.
//   5. Assert video upload is rejected with "ffmpeg-not-available" when ffmpeg
//      is stubbed out (separate describe block that resets the availability cache).
//   6. Out-of-order chunk delivery (seq 1,2,0,3,final) — assert output is valid.
// =============================================================================

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { resetMediaWriters } from "../src/gateway/media-writer.js";
import { resetVideoWriters, resetFfmpegCheck, setFfmpegPath } from "../src/gateway/media-writer-video.js";
import { registerMediaMethods } from "../src/gateway/media-methods.js";
import { getBus } from "../src/bus/index.js";
import type { MediaFinalizedEvent } from "../src/bus/events.js";
import type { RequestFrame, ResponseFrame } from "../src/gateway/protocol.js";

// =============================================================================
// Helpers
// =============================================================================

async function hasFFmpeg(): Promise<boolean> {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getTestPort(): number {
  return 28000 + Math.floor(Math.random() * 4000);
}

async function connectWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WS connect failed")));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
  return ws;
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<ResponseFrame> {
  const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame: RequestFrame = { type: "req", id: reqId, method, params };
  ws.send(JSON.stringify(frame));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for response to ${method}`)),
      15000, // longer timeout for video — ffmpeg takes a bit
    );
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === reqId) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data as ResponseFrame);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/**
 * Generate a tiny fMP4 fixture using ffmpeg's testsrc.
 * Returns the raw bytes of the fragmented MP4.
 *
 * fMP4 with empty_moov requires a seekable output, so we write to a temp
 * file rather than stdout (pipe is not seekable).
 */
function generateFmp4Fixture(): Buffer {
  const tmpDir = mkdtempSync(join(tmpdir(), "hawky-fmp4-fixture-"));
  const outPath = join(tmpDir, "fixture.mp4");

  try {
    const result = spawnSync(
      "ffmpeg",
      [
        "-f", "lavfi",
        "-i", "testsrc=duration=1:size=160x120:rate=10",
        // testsrc outputs rgb24; libx264 baseline requires yuv420p
        "-vf", "format=yuv420p",
        "-c:v", "libx264",
        "-profile:v", "baseline",
        "-level", "3.0",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "-y",
        outPath,
      ],
      { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
    );

    if (result.status !== 0) {
      throw new Error(
        `ffmpeg fixture generation failed (exit ${result.status}): ${result.stderr?.toString("utf-8").slice(-300)}`,
      );
    }

    return readFileSync(outPath);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

// =============================================================================
// Main test suite (skipped if ffmpeg unavailable)
// =============================================================================

describe("media.chunk.upload — video/mp4", () => {
  let ffmpegPresent = false;
  let fixture: Buffer;

  beforeAll(async () => {
    ffmpegPresent = await hasFFmpeg();
    if (!ffmpegPresent) return;
    fixture = generateFmp4Fixture();
  });

  describe("when ffmpeg is available", () => {
    let server: GatewayServer;
    let port: number;
    let ws: WebSocket;
    let mediaRoot: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
      if (!ffmpegPresent) return;

      mediaRoot = mkdtempSync(join(tmpdir(), "hawky-video-test-"));
      originalEnv = process.env.HAWKY_MEDIA_ROOT;
      process.env.HAWKY_MEDIA_ROOT = mediaRoot;

      resetMediaWriters();
      resetVideoWriters();
      resetFfmpegCheck();
      resetGatewayState();

      server = new GatewayServer(null);
      registerMediaMethods(server);

      port = getTestPort();
      server.start(port);

      ws = await connectWs(port);

      const res = await sendRequest(ws, "connect", {
        version: "test-1.0",
        platform: "test",
      });
      expect(res.ok).toBe(true);
    });

    afterEach(async () => {
      if (!ffmpegPresent) return;

      ws?.close();
      await server?.stop(500);
      resetVideoWriters();
      resetMediaWriters();
      resetFfmpegCheck();
      resetGatewayState();

      if (originalEnv === undefined) {
        delete process.env.HAWKY_MEDIA_ROOT;
      } else {
        process.env.HAWKY_MEDIA_ROOT = originalEnv;
      }

      try { rmSync(mediaRoot, { recursive: true, force: true }); } catch { /* ok */ }
    });

    test("3 chunks + final produces a valid fMP4 file with sha256 sidecar", async () => {
      if (!ffmpegPresent) {
        console.log("SKIP: ffmpeg not available");
        return;
      }

      const mediaId = `test-video-${Date.now()}`;
      const finalizedEvents: MediaFinalizedEvent[] = [];
      const unsub = getBus().subscribe<MediaFinalizedEvent>("media.finalized", (event) => {
        finalizedEvents.push(event);
      });

      // Split fixture into 3 roughly equal chunks
      const total = fixture.length;
      const chunkSize = Math.ceil(total / 3);
      const chunks = [
        fixture.slice(0, chunkSize),
        fixture.slice(chunkSize, chunkSize * 2),
        fixture.slice(chunkSize * 2),
      ];

      // Send chunk 0
      const r0 = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 0,
        bytes: chunks[0].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 0,
        final: false,
      });
      expect(r0.ok).toBe(true);
      expect((r0.payload as { ok: boolean }).ok).toBe(true);

      // Send chunk 1
      const r1 = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 1,
        bytes: chunks[1].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 33_000_000,
        final: false,
      });
      expect(r1.ok).toBe(true);

      // Send chunk 2 with final:true
      const r2 = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 2,
        bytes: chunks[2].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 66_000_000,
        final: true,
      });
      expect(r2.ok).toBe(true);

      // finalizeVideoWriter awaits ffmpeg exit before returning, so by the
      // time r2.ok === true the file is already on disk. A small yield is
      // enough for any lingering fs flushes.
      await new Promise((r) => setTimeout(r, 200));

      // Find the .mp4 in the media dir
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(mediaRoot, today);
      expect(existsSync(dayDir)).toBe(true);

      const mp4Path = join(dayDir, `${mediaId}.mp4`);
      const sidecarPath = join(dayDir, `${mediaId}.json`);

      expect(existsSync(mp4Path)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);

      // -----------------------------------------------------------------------
      // Validate MP4 magic bytes — offset 4..8 should be "ftyp" (ISO base media)
      // -----------------------------------------------------------------------
      const mp4Buf = readFileSync(mp4Path);
      expect(mp4Buf.length).toBeGreaterThan(8);
      const boxType = mp4Buf.slice(4, 8).toString("ascii");
      expect(boxType).toBe("ftyp");

      // -----------------------------------------------------------------------
      // Validate sidecar
      // -----------------------------------------------------------------------
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));

      expect(sidecar.mime).toBe("video/mp4");
      expect(typeof sidecar.captured_start_iso).toBe("string");
      expect(sidecar.locked).toBe(false);

      // sha256 must be present and 64 hex chars
      expect(typeof sidecar.sha256).toBe("string");
      expect(sidecar.sha256).toHaveLength(64);

      // final_iso must be present
      expect(typeof sidecar.final_iso).toBe("string");

      unsub();
      expect(finalizedEvents).toHaveLength(1);
      expect(finalizedEvents[0]!.media_id).toBe(mediaId);
      expect(finalizedEvents[0]!.kind).toBe("cam");
      expect(finalizedEvents[0]!.path).toBe(mp4Path);
      expect(finalizedEvents[0]!.sidecar_path).toBe(sidecarPath);
      expect(finalizedEvents[0]!.mime).toBe("video/mp4");
      expect(finalizedEvents[0]!.sha256).toBe(sidecar.sha256);
    });

    test("sidecar has duration_ms after final (ffprobe present)", async () => {
      if (!ffmpegPresent) return;

      let ffprobePresent = false;
      try {
        execFileSync("ffprobe", ["-version"], { stdio: "pipe" });
        ffprobePresent = true;
      } catch { /* skip */ }

      if (!ffprobePresent) {
        console.log("SKIP: ffprobe not available — skipping duration_ms check");
        return;
      }

      const mediaId = `test-video-dur-${Date.now()}`;
      const chunkSize = Math.ceil(fixture.length / 3);

      for (let seq = 0; seq < 3; seq++) {
        const start = seq * chunkSize;
        const chunk = fixture.slice(start, start + chunkSize);
        await sendRequest(ws, "media.chunk.upload", {
          media_id: mediaId,
          seq,
          bytes: chunk.toString("base64"),
          mime: "video/mp4",
          captured_at_ns: seq * 33_000_000,
          final: seq === 2,
        });
      }

      // finalizeVideoWriter awaits ffprobe before returning, so the sidecar is
      // already written when the final:true response comes back. A short yield
      // is enough for any lingering fs flushes.
      await new Promise((r) => setTimeout(r, 200));

      const today = new Date().toISOString().slice(0, 10);
      const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);
      expect(existsSync(sidecarPath)).toBe(true);

      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      expect(typeof sidecar.duration_ms).toBe("number");
      expect(sidecar.duration_ms).toBeGreaterThan(0);
    }, 20_000);

    test("seq gap is tolerated — sidecar records seq_gaps", async () => {
      if (!ffmpegPresent) return;

      const mediaId = `test-video-gap-${Date.now()}`;
      const half = Math.floor(fixture.length / 2);

      // Send seq 0
      await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 0,
        bytes: fixture.slice(0, half).toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 0,
        final: false,
      });

      // Skip seq 1, send seq 2 with final:true
      const r = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 2,
        bytes: fixture.slice(half).toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 66_000_000,
        final: true,
      });
      expect(r.ok).toBe(true);

      // finalizeVideoWriter awaits ffmpeg exit before returning, so the sidecar
      // is already written when the WS response comes back.
      await new Promise((r) => setTimeout(r, 200));

      const today = new Date().toISOString().slice(0, 10);
      const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);
      expect(existsSync(sidecarPath)).toBe(true);

      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      expect(Array.isArray(sidecar.seq_gaps)).toBe(true);
      expect(sidecar.seq_gaps.length).toBeGreaterThan(0);
    }, 20_000);

    test("out-of-order delivery (seq 1,2,0,3,final) — output .mp4 is valid and complete", async () => {
      if (!ffmpegPresent) {
        console.log("SKIP: ffmpeg not available");
        return;
      }

      const mediaId = `test-video-ooo-${Date.now()}`;

      // Split fixture into 4 roughly equal chunks
      const total = fixture.length;
      const chunkSize = Math.ceil(total / 4);
      const chunks = [
        fixture.slice(0, chunkSize),           // seq 0 — init segment
        fixture.slice(chunkSize, chunkSize * 2), // seq 1
        fixture.slice(chunkSize * 2, chunkSize * 3), // seq 2
        fixture.slice(chunkSize * 3),            // seq 3
      ];

      // Send out-of-order: 1, 2, 0, 3, then final
      // Server must buffer 1 and 2, wait for 0, then drain 0→1→2, then 3
      await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 1,
        bytes: chunks[1].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 33_000_000,
        final: false,
      });

      await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 2,
        bytes: chunks[2].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 66_000_000,
        final: false,
      });

      // seq=0 arrives — server should now spawn ffmpeg and drain 0→1→2
      await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 0,
        bytes: chunks[0].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 0,
        final: false,
      });

      // seq=3 with final:true
      const rFinal = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 3,
        bytes: chunks[3].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 99_000_000,
        final: true,
      });
      expect(rFinal.ok).toBe(true);

      await new Promise((r) => setTimeout(r, 500));

      const today = new Date().toISOString().slice(0, 10);
      const mp4Path = join(mediaRoot, today, `${mediaId}.mp4`);
      const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);

      // File must exist
      expect(existsSync(mp4Path)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);

      // Validate fMP4 magic bytes
      const mp4Buf = readFileSync(mp4Path);
      expect(mp4Buf.length).toBeGreaterThan(8);
      const boxType = mp4Buf.slice(4, 8).toString("ascii");
      expect(boxType).toBe("ftyp");

      // Sidecar must have sha256 and final_iso
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      expect(typeof sidecar.sha256).toBe("string");
      expect(sidecar.sha256).toHaveLength(64);
      expect(typeof sidecar.final_iso).toBe("string");

      // No seq_gaps — all 4 chunks arrived, just out of order
      expect(sidecar.seq_gaps).toBeUndefined();
    });

    test("rejects duplicate and regressing seq without recording stale gaps", async () => {
      if (!ffmpegPresent) {
        console.log("SKIP: ffmpeg not available");
        return;
      }

      const mediaId = `test-video-replay-${Date.now()}`;
      const chunkSize = Math.ceil(fixture.length / 3);
      const chunks = [
        fixture.slice(0, chunkSize),
        fixture.slice(chunkSize, chunkSize * 2),
        fixture.slice(chunkSize * 2),
      ];

      const r1 = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 1,
        bytes: chunks[1].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 33_000_000,
        final: false,
      });
      expect(r1.ok).toBe(true);

      const rDuplicateBuffered = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 1,
        bytes: chunks[1].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 33_000_000,
        final: false,
      });
      expect(rDuplicateBuffered.ok).toBe(false);
      expect((rDuplicateBuffered.error as { code: string }).code).toBe("INVALID_REQUEST");

      const r0 = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 0,
        bytes: chunks[0].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 0,
        final: false,
      });
      expect(r0.ok).toBe(true);

      const rRegressing = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 1,
        bytes: chunks[1].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 33_000_000,
        final: false,
      });
      expect(rRegressing.ok).toBe(false);
      expect((rRegressing.error as { code: string }).code).toBe("INVALID_REQUEST");

      const r2 = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 2,
        bytes: chunks[2].toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 66_000_000,
        final: true,
      });
      expect(r2.ok).toBe(true);

      await new Promise((r) => setTimeout(r, 200));

      const today = new Date().toISOString().slice(0, 10);
      const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);
      expect(existsSync(sidecarPath)).toBe(true);

      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      expect(sidecar.seq_gaps).toBeUndefined();
    });
  });

  // =============================================================================
  // ffmpeg-unavailable rejection test (always runs — stubs out ffmpeg)
  // =============================================================================

  describe("when ffmpeg is unavailable", () => {
    let server: GatewayServer;
    let port: number;
    let ws: WebSocket;
    let mediaRoot: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
      mediaRoot = mkdtempSync(join(tmpdir(), "hawky-video-noavail-test-"));
      originalEnv = process.env.HAWKY_MEDIA_ROOT;
      process.env.HAWKY_MEDIA_ROOT = mediaRoot;

      // Point ffmpeg at a non-existent binary so checkFfmpeg() returns false
      setFfmpegPath("/nonexistent/ffmpeg-stub-9999");

      resetMediaWriters();
      resetVideoWriters();
      resetGatewayState();

      server = new GatewayServer(null);
      registerMediaMethods(server);

      port = getTestPort();
      server.start(port);

      ws = await connectWs(port);
      const res = await sendRequest(ws, "connect", {
        version: "test-1.0",
        platform: "test",
      });
      expect(res.ok).toBe(true);
    });

    afterEach(async () => {
      ws?.close();
      await server?.stop(500);
      resetVideoWriters();
      resetMediaWriters();
      resetFfmpegCheck();
      resetGatewayState();

      if (originalEnv === undefined) {
        delete process.env.HAWKY_MEDIA_ROOT;
      } else {
        process.env.HAWKY_MEDIA_ROOT = originalEnv;
      }

      try { rmSync(mediaRoot, { recursive: true, force: true }); } catch { /* ok */ }
    });

    test("video upload returns UNSUPPORTED_OPERATION with ffmpeg-not-available", async () => {
      const res = await sendRequest(ws, "media.chunk.upload", {
        media_id: "test-noav-1",
        seq: 0,
        bytes: Buffer.alloc(64).toString("base64"),
        mime: "video/mp4",
        captured_at_ns: 0,
      });

      expect(res.ok).toBe(false);
      expect((res.error as { code: string }).code).toBe("UNSUPPORTED_OPERATION");
      expect((res.error as { message: string }).message).toContain("ffmpeg-not-available");
    });

    test("audio uploads still work when ffmpeg is unavailable", async () => {
      // 16-bit PCM sine bytes
      const buf = Buffer.alloc(3200);
      for (let i = 0; i < 1600; i++) {
        buf.writeInt16LE(Math.round(Math.sin(i / 100) * 8000), i * 2);
      }

      const res = await sendRequest(ws, "media.chunk.upload", {
        media_id: "test-noav-audio-1",
        seq: 0,
        bytes: buf.toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: 0,
        final: true,
      });

      expect(res.ok).toBe(true);
      expect((res.payload as { ok: boolean }).ok).toBe(true);
    });
  });
});
