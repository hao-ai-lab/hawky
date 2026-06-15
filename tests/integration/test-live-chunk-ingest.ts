// =============================================================================
// live-chunk ingest — integration test (Slice 1, priority-stream contract v1).
//
// Covers:
//   - media.chunk.upload with media_kind=frame writes <seq>.jpg under
//     <mediaRoot>/<YYYY-MM-DD>/live/<session_key>/ and publishes
//     `media.live.chunk` on the bus; seq monotonically increments across
//     3 calls.
//   - media.chunk.upload with media_kind=audio_chunk writes <seq>.pcm with an
//     independent counter (so frame seq 0 and audio seq 0 coexist).
//   - media.chunk.upload without media_kind (archival segment) still routes
//     to the existing WAV writer path — no live file, no bus event.
//   - Invalid / missing session_key for live chunks is rejected.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBus, resetBus } from "../../src/bus/index.js";
import type { MediaLiveChunkEvent } from "../../src/bus/events.js";
import { resetMediaWriters } from "../../src/gateway/media-writer.js";

// -----------------------------------------------------------------------------
// Minimal GatewayServer stub — just enough for registerMediaMethods().
// -----------------------------------------------------------------------------

type MethodHandler = (conn: unknown, params: unknown) => unknown | Promise<unknown>;

class StubServer {
  methods = new Map<string, MethodHandler>();
  registerMethod(name: string, handler: MethodHandler): void {
    this.methods.set(name, handler);
  }
  async call(name: string, params: unknown): Promise<unknown> {
    const h = this.methods.get(name);
    if (!h) throw new Error(`method ${name} not registered`);
    return await h({}, params);
  }
}

// -----------------------------------------------------------------------------
// Test scaffolding
// -----------------------------------------------------------------------------

let workDir: string;
let workspaceDir: string;
let mediaRoot: string;
let prevWorkspace: string | undefined;
let prevMediaRoot: string | undefined;
let prevConfigDir: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-live-chunk-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  workspaceDir = join(workDir, "workspace");
  mediaRoot = join(workspaceDir, "media");
  mkdirSync(mediaRoot, { recursive: true });

  prevWorkspace = process.env.HAWKY_WORKSPACE;
  prevMediaRoot = process.env.HAWKY_MEDIA_ROOT;
  prevConfigDir = process.env.HAWKY_CONFIG_DIR;
  process.env.HAWKY_WORKSPACE = workspaceDir;
  process.env.HAWKY_MEDIA_ROOT = mediaRoot;
  process.env.HAWKY_CONFIG_DIR = workDir;

  resetBus();
  resetMediaWriters();
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.HAWKY_WORKSPACE;
  else process.env.HAWKY_WORKSPACE = prevWorkspace;
  if (prevMediaRoot === undefined) delete process.env.HAWKY_MEDIA_ROOT;
  else process.env.HAWKY_MEDIA_ROOT = prevMediaRoot;
  if (prevConfigDir === undefined) delete process.env.HAWKY_CONFIG_DIR;
  else process.env.HAWKY_CONFIG_DIR = prevConfigDir;

  resetMediaWriters();
  resetBus();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Minimal JPEG magic header + EOI. Content doesn't matter — writer is oblivious. */
function jpegBytes(marker: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker, 0x00, 0xff, 0xd9]);
}

function pcmBytes(sample: number, count = 1600): Buffer {
  // 100 ms of PCM16 mono 16 kHz = 3200 bytes. Test uses configurable count.
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) buf.writeInt16LE(sample, i * 2);
  return buf;
}

async function buildServer(): Promise<StubServer> {
  const { registerMediaMethods } = await import("../../src/gateway/media-methods.js");
  const srv = new StubServer();
  registerMediaMethods(srv as any);
  return srv;
}

function collectBus(): { events: MediaLiveChunkEvent[]; unsub: () => void } {
  const events: MediaLiveChunkEvent[] = [];
  const unsub = getBus().subscribe<MediaLiveChunkEvent>(
    "media.live.chunk",
    (e) => { events.push(e); },
  );
  return { events, unsub };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("live-chunk ingest (priority-stream slice 1)", () => {
  test("frame chunks land at <date>/live/<session>/<seq>.jpg and seq increments", async () => {
    const srv = await buildServer();
    const { events, unsub } = collectBus();
    const session_key = "voice:device-a";

    try {
      for (let i = 0; i < 3; i++) {
        const frame = jpegBytes(0x10 + i);
        const result = (await srv.call("media.chunk.upload", {
          media_kind: "frame",
          session_key,
          bytes: frame.toString("base64"),
          ts_captured_ns: 1_000_000 * (i + 1),
          device_id: "device-a",
        })) as { ok: true; seq: number; file_path: string };

        expect(result.ok).toBe(true);
        expect(result.seq).toBe(i);

        const expectedPath = join(
          mediaRoot,
          today(),
          "live",
          session_key,
          `${String(i).padStart(6, "0")}.jpg`,
        );
        expect(result.file_path).toBe(expectedPath);
        expect(existsSync(expectedPath)).toBe(true);
        expect(readFileSync(expectedPath)).toEqual(frame);
      }

      // 3 bus events, each with monotonically increasing seq.
      expect(events.length).toBe(3);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(events[0].media_kind).toBe("frame");
      expect(events[0].session_key).toBe(session_key);
      expect(events[0].device_id).toBe("device-a");
      expect(events[0].ts_captured_ns).toBe(1_000_000);
      expect(events[0].size_bytes).toBe(jpegBytes(0x10).length);
      expect(events[0].duration_ms).toBeUndefined();
    } finally {
      unsub();
    }
  });

  test("audio_chunk uses an independent counter and writes .pcm with duration_ms", async () => {
    const srv = await buildServer();
    const { events, unsub } = collectBus();
    const session_key = "voice:device-b";

    try {
      // One frame first — asserts the counters are disjoint (audio seq still 0).
      await srv.call("media.chunk.upload", {
        media_kind: "frame",
        session_key,
        bytes: jpegBytes(0x20).toString("base64"),
      });

      for (let i = 0; i < 3; i++) {
        const audio = pcmBytes(100 + i, 1600); // 100 ms of PCM16 mono 16 kHz
        const result = (await srv.call("media.chunk.upload", {
          media_kind: "audio_chunk",
          session_key,
          bytes: audio.toString("base64"),
          ts_captured_ns: 2_000_000 * (i + 1),
        })) as { ok: true; seq: number; file_path: string };

        expect(result.seq).toBe(i);
        const expectedPath = join(
          mediaRoot,
          today(),
          "live",
          session_key,
          `${String(i).padStart(6, "0")}.pcm`,
        );
        expect(result.file_path).toBe(expectedPath);
        expect(existsSync(expectedPath)).toBe(true);
        expect(statSync(expectedPath).size).toBe(audio.length);
      }

      // 1 frame + 3 audio = 4 events total.
      expect(events.length).toBe(4);
      const audioEvents = events.filter((e) => e.media_kind === "audio_chunk");
      expect(audioEvents.length).toBe(3);
      expect(audioEvents.map((e) => e.seq)).toEqual([0, 1, 2]);
      // PCM16 16 kHz mono: 3200 bytes = 100 ms.
      expect(audioEvents[0].duration_ms).toBe(100);
      expect(audioEvents[0].size_bytes).toBe(3200);
    } finally {
      unsub();
    }
  });

  test("archival (media_kind absent) path unchanged — no live file, no bus event", async () => {
    const srv = await buildServer();
    const { events, unsub } = collectBus();

    try {
      const pcm = pcmBytes(42, 160); // 10 ms
      const result = (await srv.call("media.chunk.upload", {
        media_id: "cap-archival-1",
        seq: 0,
        bytes: pcm.toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: 123,
      })) as { ok: true };

      expect(result.ok).toBe(true);

      // Archival writer creates <date>/<media_id>.wav + sidecar, no live/ dir.
      const dayDir = join(mediaRoot, today());
      expect(existsSync(join(dayDir, "cap-archival-1.wav"))).toBe(true);
      expect(existsSync(join(dayDir, "live"))).toBe(false);

      // No live-chunk events fired.
      expect(events.length).toBe(0);

      // And the archival path is still the one with the full sidecar.
      const entries = readdirSync(dayDir);
      expect(entries).toContain("cap-archival-1.wav");
      expect(entries).toContain("cap-archival-1.json");
    } finally {
      unsub();
      resetMediaWriters(); // close the fd we just opened
    }
  });

  test("explicit media_kind=segment routes to archival path", async () => {
    const srv = await buildServer();
    try {
      const pcm = pcmBytes(7, 160);
      await srv.call("media.chunk.upload", {
        media_kind: "segment",
        media_id: "cap-seg-1",
        seq: 0,
        bytes: pcm.toString("base64"),
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: 0,
      });
      expect(existsSync(join(mediaRoot, today(), "cap-seg-1.wav"))).toBe(true);
      expect(existsSync(join(mediaRoot, today(), "live"))).toBe(false);
    } finally {
      resetMediaWriters();
    }
  });

  test("live chunk without session_key is rejected", async () => {
    const srv = await buildServer();
    await expect(
      srv.call("media.chunk.upload", {
        media_kind: "frame",
        bytes: jpegBytes(0x30).toString("base64"),
      }),
    ).rejects.toThrow(/session_key/);
  });

  test("live chunk with invalid session_key characters is rejected", async () => {
    const srv = await buildServer();
    await expect(
      srv.call("media.chunk.upload", {
        media_kind: "frame",
        session_key: "voice:device a", // space is not allowed
        bytes: jpegBytes(0x31).toString("base64"),
      }),
    ).rejects.toThrow(/session_key/);
  });

  test("live chunk with empty session_key is rejected", async () => {
    const srv = await buildServer();
    await expect(
      srv.call("media.chunk.upload", {
        media_kind: "frame",
        session_key: "",
        bytes: jpegBytes(0x32).toString("base64"),
      }),
    ).rejects.toThrow(/session_key/);
  });

  test("live chunk with session_key over 128 chars is rejected", async () => {
    const srv = await buildServer();
    const tooLong = "a".repeat(129);
    await expect(
      srv.call("media.chunk.upload", {
        media_kind: "frame",
        session_key: tooLong,
        bytes: jpegBytes(0x33).toString("base64"),
      }),
    ).rejects.toThrow(/session_key/);
  });

  test("unknown media_kind is rejected", async () => {
    const srv = await buildServer();
    await expect(
      srv.call("media.chunk.upload", {
        media_kind: "video_raw",
        session_key: "voice:x",
        bytes: jpegBytes(0x34).toString("base64"),
      }),
    ).rejects.toThrow(/media_kind/);
  });
});
