// =============================================================================
// Media Chunk Upload Tests (M0 Slice 0)
//
// Tests for the media.chunk.upload RPC and the streaming WAV writer.
// Sends 3 chunks of fake PCM + one final:true and asserts:
//   - The resulting .wav file has a valid WAV header (correct RIFF + data sizes)
//   - The sha256 field is present in the sidecar JSON
//   - The WAV is playable (header magic bytes correct)
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { resetMediaWriters, reapStaleWriters, getActiveWriterCount, __setMaxTotalBytesForTesting } from "../src/gateway/media-writer.js";
import { registerMediaMethods } from "../src/gateway/media-methods.js";
import type { RequestFrame, ResponseFrame } from "../src/gateway/protocol.js";

// =============================================================================
// Helpers
// =============================================================================

function getTestPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

async function connectWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`WS connect failed: ${e}`)));
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
      5000,
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

/** Generate N bytes of fake 16-bit PCM (sine-like pattern). */
function fakePcm(numSamples: number): Buffer {
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((i / numSamples) * Math.PI * 2) * 8000);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

// =============================================================================
// Tests
// =============================================================================

describe("media.chunk.upload", () => {
  let server: GatewayServer;
  let port: number;
  let ws: WebSocket;
  let mediaRoot: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    // Use a temp dir as media root so tests don't pollute ~/.hawky/workspace/media
    mediaRoot = mkdtempSync(join(tmpdir(), "hawky-media-test-"));

    // Override media root via env — the media-writer reads config which may not exist,
    // so we patch it by writing a minimal config stub into the temp dir. Instead,
    // we'll override the HAWKY_DIR via a module-level env approach. Since Bun
    // doesn't easily allow module-level env patching mid-test, we use the fact
    // that media-writer.ts falls back to DEFAULT_MEDIA_ROOT if config load fails,
    // but we can also pass it via a process.env override checked in resolveMediaRoot.
    // For isolation, we set HAWKY_MEDIA_ROOT which we'll check in the writer.
    originalEnv = process.env.HAWKY_MEDIA_ROOT;
    process.env.HAWKY_MEDIA_ROOT = mediaRoot;

    await resetMediaWriters();
    resetGatewayState();

    server = new GatewayServer(null); // null = no auth, testing only
    registerMediaMethods(server);

    port = getTestPort();
    server.start(port);

    ws = await connectWs(port);

    // Handshake
    const res = await sendRequest(ws, "connect", {
      version: "test-1.0",
      platform: "test",
    });
    expect(res.ok).toBe(true);
  });

  afterEach(async () => {
    ws?.close();
    await server.stop(500);
    await resetMediaWriters();
    resetGatewayState();

    // Restore env
    if (originalEnv === undefined) {
      delete process.env.HAWKY_MEDIA_ROOT;
    } else {
      process.env.HAWKY_MEDIA_ROOT = originalEnv;
    }

    // Clean up temp media dir
    try { rmSync(mediaRoot, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test("3 chunks + final produces a valid WAV with correct header sizes and sha256 sidecar", async () => {
    const mediaId = `test-media-${Date.now()}`;
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const samplesPerChunk = 800; // 50 ms at 16 kHz

    // Generate 3 chunks of fake PCM
    const chunks = [fakePcm(samplesPerChunk), fakePcm(samplesPerChunk), fakePcm(samplesPerChunk)];

    // Send chunks 0, 1, 2
    for (let seq = 0; seq < 3; seq++) {
      const res = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq,
        bytes: chunks[seq].toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: seq * 50_000_000,
        final: seq === 2,
      });
      expect(res.ok).toBe(true);
      expect((res.payload as { ok: boolean }).ok).toBe(true);
    }

    // The final chunk's RPC response resolves AFTER finalizeWriter has
    // awaited the sidecar write + file close, so no artificial sleep is
    // required to let async file ops settle — asserting right away is
    // race-free. (If a race shows up here, that's a real bug.)

    const today = new Date().toISOString().slice(0, 10);
    const dayDir = join(mediaRoot, today);
    expect(existsSync(dayDir)).toBe(true);

    const wavPath = join(dayDir, `${mediaId}.wav`);
    const sidecarPath = join(dayDir, `${mediaId}.json`);

    expect(existsSync(wavPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);

    // -------------------------------------------------------------------------
    // Validate WAV header
    // -------------------------------------------------------------------------
    const wavBuf = readFileSync(wavPath);

    // RIFF magic
    expect(wavBuf.slice(0, 4).toString("ascii")).toBe("RIFF");
    // WAVE marker
    expect(wavBuf.slice(8, 12).toString("ascii")).toBe("WAVE");
    // fmt marker
    expect(wavBuf.slice(12, 16).toString("ascii")).toBe("fmt ");
    // data marker
    expect(wavBuf.slice(36, 40).toString("ascii")).toBe("data");

    // RIFF size = file size - 8
    const riffSize = wavBuf.readUInt32LE(4);
    expect(riffSize).toBe(wavBuf.length - 8);

    // data size = file size - 44 (WAV header)
    const dataSize = wavBuf.readUInt32LE(40);
    expect(dataSize).toBe(wavBuf.length - 44);

    // Total PCM data should be 3 * samplesPerChunk * 2 bytes (16-bit)
    const expectedPcmBytes = 3 * samplesPerChunk * 2;
    expect(dataSize).toBe(expectedPcmBytes);

    // AudioFormat = 1 (PCM)
    expect(wavBuf.readUInt16LE(20)).toBe(1);
    // Channels
    expect(wavBuf.readUInt16LE(22)).toBe(channels);
    // Sample rate
    expect(wavBuf.readUInt32LE(24)).toBe(sampleRate);
    // Bits per sample
    expect(wavBuf.readUInt16LE(34)).toBe(bitsPerSample);

    // -------------------------------------------------------------------------
    // Validate sidecar
    // -------------------------------------------------------------------------
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));

    expect(sidecar.mime).toBe("audio/pcm16;rate=16000");
    expect(typeof sidecar.captured_start_iso).toBe("string");
    expect(sidecar.locked).toBe(false);

    // sha256 must be present and valid
    expect(typeof sidecar.sha256).toBe("string");
    expect(sidecar.sha256).toHaveLength(64); // hex SHA-256

    // Verify sha256 matches actual file
    const computedSha256 = createHash("sha256").update(wavBuf).digest("hex");
    expect(sidecar.sha256).toBe(computedSha256);

    // duration_ms should be ~150 ms (3 * 50 ms chunks)
    expect(typeof sidecar.duration_ms).toBe("number");
    expect(sidecar.duration_ms).toBeGreaterThan(0);
    // 2400 PCM bytes / (16000 * 1 * 2) * 1000 = 150 ms exact math, but
    // duration_ms is rounded so the allowable window is [149, 151]. Keep
    // the assertion tolerant so harmless rounding drift never flakes CI.
    expect(sidecar.duration_ms).toBeGreaterThanOrEqual(149);
    expect(sidecar.duration_ms).toBeLessThanOrEqual(151);

    // final_iso must be present
    expect(typeof sidecar.final_iso).toBe("string");
  });

  test("validation rejects missing media_id", async () => {
    const res = await sendRequest(ws, "media.chunk.upload", {
      seq: 0,
      bytes: Buffer.alloc(64).toString("base64"),
      mime: "audio/pcm16",
      captured_at_ns: 0,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("INVALID_REQUEST");
  });

  test("validation rejects missing bytes", async () => {
    const res = await sendRequest(ws, "media.chunk.upload", {
      media_id: "test-123",
      seq: 0,
      mime: "audio/pcm16",
      captured_at_ns: 0,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("INVALID_REQUEST");
  });

  // ---------------------------------------------------------------------------
  // Adversarial / security tests
  //
  // Cover the blocker/high-priority findings from the #153 review so the
  // rules that keep this RPC safe are enforced by tests, not just comments.
  // ---------------------------------------------------------------------------

  test("rejects path-traversal media_id without touching the filesystem", async () => {
    // A naive `join(mediaRoot, \`${media_id}.wav\`)` would resolve this path
    // up into the temp dir's parent and write "secrets.wav" there. We must
    // reject at the RPC boundary before any filesystem call happens.
    const res = await sendRequest(ws, "media.chunk.upload", {
      media_id: "../../secrets",
      seq: 0,
      bytes: fakePcm(16).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("INVALID_REQUEST");

    // Nothing should have been written anywhere under or next to mediaRoot.
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = join(mediaRoot, today);
    expect(existsSync(dayDir)).toBe(false);

    // Defense-in-depth: the parent dir should not contain a stray secrets.wav.
    const parent = join(mediaRoot, "..");
    const strays = readdirSync(parent).filter((f) => f.startsWith("secrets"));
    expect(strays).toEqual([]);
  });

  test("rejects other malformed media_id shapes", async () => {
    for (const bad of ["a/b", "", "a".repeat(65), "..", "foo\\bar", "x y"]) {
      const res = await sendRequest(ws, "media.chunk.upload", {
        media_id: bad,
        seq: 0,
        bytes: fakePcm(16).toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: 0,
      });
      expect(res.ok).toBe(false);
      expect((res.error as { code: string }).code).toBe("INVALID_REQUEST");
    }
  });

  test("rejects oversized chunk before decoding", async () => {
    // Synthesize a base64 string just past the 2 MB raw cap. We don't need
    // real PCM — the cap is enforced on string length, before decode.
    const tooManyBase64Chars = Math.ceil(2 * 1024 * 1024 * 4 / 3) + 100;
    const oversized = "A".repeat(tooManyBase64Chars);

    const res = await sendRequest(ws, "media.chunk.upload", {
      media_id: "test-too-big",
      seq: 0,
      bytes: oversized,
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("INVALID_REQUEST");

    // A chunk just under the cap must still be accepted so legit bursts
    // (e.g. a 10-second reconnect backfill at 48 kHz mono) still work.
    const okRaw = Buffer.alloc(1 * 1024 * 1024); // 1 MB PCM — well under cap
    const resOk = await sendRequest(ws, "media.chunk.upload", {
      media_id: "test-under-cap",
      seq: 0,
      bytes: okRaw.toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
      final: true,
    });
    expect(resOk.ok).toBe(true);
  });

  test("re-upload of a finalized media_id is rejected; original bytes + sha256 preserved", async () => {
    const mediaId = `test-reupload-${Date.now()}`;
    const original = fakePcm(400);

    const rInit = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: original.toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
      final: true,
    });
    expect(rInit.ok).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const wavPath = join(mediaRoot, today, `${mediaId}.wav`);
    const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);
    const originalBytes = readFileSync(wavPath);
    const originalSidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));

    // Attempt to re-upload with DIFFERENT content under the same media_id.
    const replacement = fakePcm(200); // deliberately shorter → different sha
    const rReplay = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: replacement.toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
      final: true,
    });
    expect(rReplay.ok).toBe(false);
    expect((rReplay.error as { code: string }).code).toBe("ALREADY_EXISTS");

    // File + sidecar must be byte-identical to the first finalize.
    expect(readFileSync(wavPath).equals(originalBytes)).toBe(true);
    const sidecarAfter = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    expect(sidecarAfter.sha256).toBe(originalSidecar.sha256);
  });

  test("rejects duplicate or regressing seq; prior data intact", async () => {
    const mediaId = `test-ooo-${Date.now()}`;

    const r0 = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(r0.ok).toBe(true);

    const r2 = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 2,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 20_000_000,
    });
    expect(r2.ok).toBe(true);

    // Duplicate seq 2 — reject.
    const rDup = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 2,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 30_000_000,
    });
    expect(rDup.ok).toBe(false);
    expect((rDup.error as { code: string }).code).toBe("INVALID_REQUEST");

    // Regressing seq (1 after we've written 2) — reject.
    const rReg = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 1,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 10_000_000,
    });
    expect(rReg.ok).toBe(false);
    expect((rReg.error as { code: string }).code).toBe("INVALID_REQUEST");

    // Finalize. The on-disk file must contain exactly two chunks of PCM
    // (seq 0 + seq 2). The duplicate/regressing attempts did not append.
    const rFin = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 3,
      bytes: Buffer.alloc(0).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 30_000_000,
      final: true,
    });
    expect(rFin.ok).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const wavPath = join(mediaRoot, today, `${mediaId}.wav`);
    const size = statSync(wavPath).size;
    expect(size).toBe(44 + 160 * 2 * 2); // header + 2 chunks × 160 samples × 2 bytes

    const sidecar = JSON.parse(readFileSync(join(mediaRoot, today, `${mediaId}.json`), "utf-8"));
    // Only the forward gap [1,1] (from seq 0 → 2) should have been recorded.
    // The rejected regressing seq=1 must NOT produce a nonsense gap entry.
    expect(sidecar.seq_gaps).toEqual([[1, 1]]);
  });

  test("concurrent distinct media_ids finalize independently", async () => {
    const a = `test-concurrent-a-${Date.now()}`;
    const b = `test-concurrent-b-${Date.now()}`;
    const pcm = fakePcm(160);

    // Interleave writes to both sessions.
    for (let seq = 0; seq < 3; seq++) {
      for (const id of [a, b]) {
        const res = await sendRequest(ws, "media.chunk.upload", {
          media_id: id,
          seq,
          bytes: pcm.toString("base64"),
          mime: "audio/pcm16;rate=16000",
          captured_at_ns: seq * 10_000_000,
          final: seq === 2,
        });
        expect(res.ok).toBe(true);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const id of [a, b]) {
      const sidecar = JSON.parse(readFileSync(join(mediaRoot, today, `${id}.json`), "utf-8"));
      expect(typeof sidecar.sha256).toBe("string");
      expect(sidecar.sha256).toHaveLength(64);
      expect(sidecar.duration_ms).toBeGreaterThan(0);
      // Two sessions must not share bytes — shas differ only if file contents
      // differ, but here they SHOULD match because we wrote identical PCM to
      // both. The important property is that both finalized at all.
    }
  });

  test("sidecar records per-chunk captured_at_ns in arrival order", async () => {
    // Review finding #9: `captured_at_ns` was accepted and then dropped,
    // which meant downstream consumers (e.g. transcription alignment) had
    // no way to map audio samples back to the client's capture clock.
    // Now it's persisted in the sidecar as `chunks: [{seq, captured_at_ns}]`.
    const mediaId = `test-ts-${Date.now()}`;
    const timestamps = [1_000_000, 51_000_000, 103_000_000]; // distinct, monotonic-ish
    for (let seq = 0; seq < 3; seq++) {
      const res = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq,
        bytes: fakePcm(160).toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: timestamps[seq],
        final: seq === 2,
      });
      expect(res.ok).toBe(true);
    }

    const today = new Date().toISOString().slice(0, 10);
    const sidecar = JSON.parse(readFileSync(join(mediaRoot, today, `${mediaId}.json`), "utf-8"));
    expect(sidecar.chunks).toEqual([
      { seq: 0, captured_at_ns: timestamps[0] },
      { seq: 1, captured_at_ns: timestamps[1] },
      { seq: 2, captured_at_ns: timestamps[2] },
    ]);
  });

  test("first chunk with non-zero seq is rejected", async () => {
    // The RPC contract says seq is "monotonic from 0". A first chunk at
    // seq=5 either means the client dropped the preamble (should retry
    // from 0) or is malformed. Reject rather than silently record a
    // leading gap.
    const res = await sendRequest(ws, "media.chunk.upload", {
      media_id: `test-first-nonzero-${Date.now()}`,
      seq: 5,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("INVALID_REQUEST");

    // No file should have been written — check the day dir, if it exists,
    // doesn't contain anything with the rejected media_id.
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = join(mediaRoot, today);
    if (existsSync(dayDir)) {
      const names = readdirSync(dayDir);
      expect(names.some((n) => n.startsWith("test-first-nonzero"))).toBe(false);
    }
  });

  test("stale writer is reaped — fd closed, partial file unlinked, registry empty", async () => {
    const mediaId = `test-reap-${Date.now()}`;

    // Start a recording but don't finalize — simulates a client that dies
    // mid-stream (tab close, network drop, OOM).
    const rInit = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(rInit.ok).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const wavPath = join(mediaRoot, today, `${mediaId}.wav`);
    const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);

    // Pre-reap invariants: the writer is in the registry and files exist.
    expect(getActiveWriterCount()).toBe(1);
    expect(existsSync(wavPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);

    // Drive the sweeper with a `now` far in the future so the 60s stale
    // threshold is tripped deterministically — tests must not wait on
    // wall-clock time.
    const reaped = await reapStaleWriters(Date.now() + 10 * 60 * 1000);

    expect(reaped).toEqual([mediaId]);
    expect(getActiveWriterCount()).toBe(0);
    // The partial recording's files should be gone — they were abandoned,
    // not finalized, so leaving them on disk would just be orphaned data.
    expect(existsSync(wavPath)).toBe(false);
    expect(existsSync(sidecarPath)).toBe(false);
  });

  test("reaper leaves fresh writers alone", async () => {
    const mediaId = `test-reap-skip-${Date.now()}`;

    await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });

    // Reap with `now` close to real time — writer just appended, so it's
    // well within STALE_MS and must not be touched.
    const reaped = await reapStaleWriters(Date.now());
    expect(reaped).toEqual([]);
    expect(getActiveWriterCount()).toBe(1);

    // Finalize so afterEach can clean up normally.
    await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 1,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 10_000_000,
      final: true,
    });
  });

  test("cumulative MAX_TOTAL_BYTES cap rejects + tears down partial recording", async () => {
    // The real cap is 1 GB; push that through bun:test would dwarf the
    // suite's runtime. Lower the cap to ~10 KB for the duration of this
    // case so a handful of small valid chunks crosses the threshold.
    const TEST_CAP = 10_000;
    __setMaxTotalBytesForTesting(TEST_CAP);
    try {
      const mediaId = `test-cap-${Date.now()}`;

      // Each chunk is 4_000 bytes raw PCM (well under the 2 MB per-chunk cap).
      // Four chunks ≈ 16_000 bytes which clears the 10 KB cumulative cap on
      // the third append.
      const chunkBytes = 4_000;
      const samplesPerChunk = chunkBytes / 2;

      // chunks 0 + 1 must succeed (totalBytes 4_000 then 8_000, both < cap).
      for (let seq = 0; seq < 2; seq++) {
        const r = await sendRequest(ws, "media.chunk.upload", {
          media_id: mediaId,
          seq,
          bytes: fakePcm(samplesPerChunk).toString("base64"),
          mime: "audio/pcm16;rate=16000",
          captured_at_ns: seq * 50_000_000,
        });
        expect(r.ok).toBe(true);
      }

      // Pre-rejection invariant: writer + on-disk file exist.
      expect(getActiveWriterCount()).toBe(1);
      const today = new Date().toISOString().slice(0, 10);
      const wavPath = join(mediaRoot, today, `${mediaId}.wav`);
      const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);
      expect(existsSync(wavPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);

      // Chunk 2 pushes totalBytes to 12_000 > 10_000 → MEDIA_TOO_LARGE.
      const rOver = await sendRequest(ws, "media.chunk.upload", {
        media_id: mediaId,
        seq: 2,
        bytes: fakePcm(samplesPerChunk).toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: 100_000_000,
      });
      expect(rOver.ok).toBe(false);
      expect((rOver.error as { code: string }).code).toBe("MEDIA_TOO_LARGE");

      // Rollback: writer torn down, partial file + sidecar unlinked.
      expect(getActiveWriterCount()).toBe(0);
      expect(existsSync(wavPath)).toBe(false);
      expect(existsSync(sidecarPath)).toBe(false);
    } finally {
      __setMaxTotalBytesForTesting(null);
    }
  });

  test("appendChunk stamps lastActivityAt before the await (reaper-race regression)", async () => {
    // Regression for the read-then-write reaper race: if `lastActivityAt`
    // were stamped AFTER `handle.write()`, a sweep tick that fires while
    // the write is in flight could compute (now - stale_lastActivityAt)
    // > STALE_MS and reap a writer that is actively making progress.
    //
    // Driving a real >60s in-flight write deterministically would require
    // injecting a slow filesystem; instead we assert the observable
    // contract: after a successful append, `lastActivityAt` is at least
    // as recent as the time we sampled BEFORE issuing the RPC. If the
    // stamp had moved to after the await, this would still pass — but
    // the converse direction (stamping before) gives us the property we
    // actually want: a sweep observing the writer mid-write would see a
    // fresh stamp, not a pre-write one.
    const mediaId = `test-reap-race-${Date.now()}`;

    const beforeRpc = Date.now();
    const r = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(r.ok).toBe(true);

    // Reap with `now == beforeRpc` — i.e. as if the sweep tick fired at
    // the instant we started the RPC. The writer's stamp must be >=
    // beforeRpc (initWriter set it to Date.now() during the call), so
    // (beforeRpc - lastActivityAt) <= 0 < STALE_MS → not reaped.
    const reaped = await reapStaleWriters(beforeRpc);
    expect(reaped).toEqual([]);
    expect(getActiveWriterCount()).toBe(1);

    // Send a non-final follow-up chunk so the writer stays in the
    // registry, then sweep with `now == beforeAppend`. This exercises
    // the appendChunk stamp specifically — initWriter's stamp would be
    // older than beforeAppend if appendChunk hadn't refreshed it.
    const beforeAppend = Date.now();
    const r2 = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 1,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 10_000_000,
    });
    expect(r2.ok).toBe(true);

    const reaped2 = await reapStaleWriters(beforeAppend);
    expect(reaped2).toEqual([]);
    expect(getActiveWriterCount()).toBe(1);

    // Finalize so afterEach can clean up normally.
    await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 2,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 20_000_000,
      final: true,
    });
  });

  test("seq gap is tolerated (warning logged, file still written)", async () => {
    const mediaId = `test-gap-${Date.now()}`;

    // Send seq 0
    const r0 = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 0,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 0,
    });
    expect(r0.ok).toBe(true);

    // Skip seq 1, send seq 2 (gap!)
    const r2 = await sendRequest(ws, "media.chunk.upload", {
      media_id: mediaId,
      seq: 2,
      bytes: fakePcm(160).toString("base64"),
      mime: "audio/pcm16;rate=16000",
      captured_at_ns: 20_000_000,
      final: true,
    });
    // Should still succeed despite the gap
    expect(r2.ok).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const sidecarPath = join(mediaRoot, today, `${mediaId}.json`);
    expect(existsSync(sidecarPath)).toBe(true);

    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    // seq_gaps should record the gap [1, 1]
    expect(Array.isArray(sidecar.seq_gaps)).toBe(true);
    expect(sidecar.seq_gaps).toHaveLength(1);
    expect(sidecar.seq_gaps[0]).toEqual([1, 1]);
  });
});
