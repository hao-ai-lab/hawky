// =============================================================================
// Unit tests for src/consumers/asr/pipeline.ts.
//
// Covers emitTranscriptEvents partial/final fan-out, failure-policy integration
// (fire-and-forget suppresses events), and disabled-mode short-circuit.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBus, resetBus } from "../../src/bus/index.js";
import type { MediaFinalizedEvent } from "../../src/bus/events.js";
import type { AsrPartialEvent, AsrFinalEvent } from "../../src/consumers/asr/events.js";
import {
  registerAsrPipeline,
  emitTranscriptEvents,
} from "../../src/consumers/asr/pipeline.js";
import type { ASRBackend, Transcript } from "../../src/consumers/asr/types.js";

// -----------------------------------------------------------------------------
// Env isolation
// -----------------------------------------------------------------------------

let workDir: string;
let prevDeadletterDir: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(workDir, { recursive: true });
  prevDeadletterDir = process.env.HAWKY_ASR_DEADLETTER_DIR;
  process.env.HAWKY_ASR_DEADLETTER_DIR = join(workDir, "dl");
  resetBus();
});

afterEach(() => {
  if (prevDeadletterDir === undefined) delete process.env.HAWKY_ASR_DEADLETTER_DIR;
  else process.env.HAWKY_ASR_DEADLETTER_DIR = prevDeadletterDir;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mkTranscript(media_id: string, segments: { t0_ms: number; t1_ms: number; text: string }[]): Transcript {
  return {
    media_id,
    lang: "en",
    backend: "mock",
    model: "m",
    segments,
  };
}

function mkFinalizedEvent(media_id: string, wav_path: string): MediaFinalizedEvent {
  return {
    media_id,
    kind: "mic",
    path: wav_path,
    sidecar_path: wav_path.replace(/\.wav$/, ".json"),
    duration_ms: 3000,
    sha256: "0".repeat(64),
    mime: "audio/wav",
    node_id: "node-x",
    captured_start_iso: "2026-04-21T07:35:12.441Z",
  };
}

class OkBackend implements ASRBackend {
  name = "mock";
  capabilities = { batch: true, streaming: false, partials: false, diarization: false, langs: ["*"] };
  constructor(private segments: { t0_ms: number; t1_ms: number; text: string }[]) {}
  async transcribeFile(_path: string, opts: { media_id: string }): Promise<Transcript> {
    return mkTranscript(opts.media_id, this.segments);
  }
}

class ThrowBackend implements ASRBackend {
  name = "mock";
  capabilities = { batch: true, streaming: false, partials: false, diarization: false, langs: ["*"] };
  async transcribeFile(): Promise<Transcript> {
    throw new Error("forced failure");
  }
}

// -----------------------------------------------------------------------------
// emitTranscriptEvents
// -----------------------------------------------------------------------------

describe("pipeline — emitTranscriptEvents", () => {
  test("3 segments → 2 partials + 1 final with concatenated text", () => {
    const partials: AsrPartialEvent[] = [];
    let final: AsrFinalEvent | null = null;
    getBus().subscribe<AsrPartialEvent>("asr.partial", (e) => {
      if (e.media_id === "c-a") partials.push(e);
    });
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-a") final = e;
    });
    emitTranscriptEvents(
      mkTranscript("c-a", [
        { t0_ms: 0, t1_ms: 100, text: "a" },
        { t0_ms: 100, t1_ms: 200, text: "b" },
        { t0_ms: 200, t1_ms: 300, text: "c" },
      ]),
      42,
      3000,
      "node-1",
      "2026-04-21T07:35:12.441Z",
    );
    expect(partials.length).toBe(2);
    expect(partials.map((p) => p.segment_index)).toEqual([0, 1]);
    expect(final).not.toBeNull();
    expect(final!.text).toBe("a b c");
    expect(final!.segments.length).toBe(3);
    expect(final!.node_id).toBe("node-1");
    expect(final!.transcribe_wallclock_ms).toBe(42);
    expect(final!.media_duration_ms).toBe(3000);
  });

  test("single segment → 0 partials + 1 final", () => {
    let partialCount = 0;
    let final: AsrFinalEvent | null = null;
    getBus().subscribe<AsrPartialEvent>("asr.partial", (e) => {
      if (e.media_id === "c-b") partialCount++;
    });
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-b") final = e;
    });
    emitTranscriptEvents(
      mkTranscript("c-b", [{ t0_ms: 0, t1_ms: 500, text: "solo" }]),
      10,
      3000,
      "node-1",
      "2026-04-21T07:35:12.441Z",
    );
    expect(partialCount).toBe(0);
    expect(final).not.toBeNull();
    expect(final!.text).toBe("solo");
  });

  test("zero segments → no partials, 1 final with empty text (documented behavior)", () => {
    let partialCount = 0;
    let final: AsrFinalEvent | null = null;
    getBus().subscribe<AsrPartialEvent>("asr.partial", (e) => {
      if (e.media_id === "c-c") partialCount++;
    });
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-c") final = e;
    });
    emitTranscriptEvents(
      mkTranscript("c-c", []),
      0,
      0,
      "node-1",
      "2026-04-21T07:35:12.441Z",
    );
    expect(partialCount).toBe(0);
    // Current behavior: a final still fires with empty text. Downstream
    // (chat-poster) filters empties.
    expect(final).not.toBeNull();
    expect(final!.text).toBe("");
    expect(final!.segments.length).toBe(0);
  });

  test("writes transcript sidecar before publishing final", async () => {
    const wavPath = join(workDir, "audio", "c-sidecar.wav");
    const sidecarPath = wavPath.replace(/\.wav$/, ".transcript.json");
    let sidecarAtFinal: unknown = null;

    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id !== "c-sidecar") return;
      if (existsSync(sidecarPath)) {
        sidecarAtFinal = JSON.parse(readFileSync(sidecarPath, "utf8"));
      }
    });

    await emitTranscriptEvents(
      mkTranscript("c-sidecar", [{ t0_ms: 0, t1_ms: 500, text: "persisted first" }]),
      17,
      3000,
      "node-1",
      "2026-04-21T07:35:12.441Z",
      wavPath,
    );

    expect(sidecarAtFinal).toMatchObject({
      media_id: "c-sidecar",
      wav_path: wavPath,
      text: "persisted first",
    });
  });
});

// -----------------------------------------------------------------------------
// registerAsrPipeline
// -----------------------------------------------------------------------------

describe("pipeline — mode:streaming guard", () => {
  test("throws when mode=streaming is paired with a batch-only backend", () => {
    // Previously the pipeline logged a warning and silently fell back to
    // batch, which meant flipping mode in config produced no behavior
    // change. Finding #13: make the mismatch a hard error so a future
    // streaming backend has to explicitly set `capabilities.streaming = true`
    // before the pipeline accepts the config.
    expect(() =>
      registerAsrPipeline({
        backend: new OkBackend([{ t0_ms: 0, t1_ms: 100, text: "x" }]),
        config: {
          enabled: true,
          mode: "streaming",
          failure_policy: "retry-then-dead-letter",
          retry: { max_attempts: 1, initial_ms: 1, multiplier: 1, jitter_ms: 0 },
        },
      }),
    ).toThrow(/streaming/i);
  });
});

describe("pipeline — registerAsrPipeline", () => {
  test("disabled config returns a no-op unsubscribe and does not subscribe", async () => {
    const backend = new OkBackend([{ t0_ms: 0, t1_ms: 10, text: "x" }]);
    const unsub = registerAsrPipeline({
      backend,
      config: { enabled: false, mode: "batch", failure_policy: "retry-then-dead-letter" },
    });
    let fired = 0;
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-off") fired++;
    });
    getBus().publish("media.finalized", mkFinalizedEvent("c-off", "/tmp/c-off.wav"));
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(0);
    unsub(); // no-op
  });

  test("backend throws → retry-then-dead-letter exhausts retries, no asr.* events fire", async () => {
    const unsub = registerAsrPipeline({
      backend: new ThrowBackend(),
      config: {
        enabled: true,
        mode: "batch",
        failure_policy: "retry-then-dead-letter",
        retry: { max_attempts: 1, initial_ms: 1, multiplier: 1, jitter_ms: 0 },
      },
    });
    let finals = 0;
    let partials = 0;
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-fail") finals++;
    });
    getBus().subscribe<AsrPartialEvent>("asr.partial", (e) => {
      if (e.media_id === "c-fail") partials++;
    });
    try {
      getBus().publish<MediaFinalizedEvent>(
        "media.finalized",
        mkFinalizedEvent("c-fail", "/tmp/c-fail.wav"),
      );
      // Give the async handler a chance to run + dead-letter to land.
      await new Promise((r) => setTimeout(r, 50));
      expect(finals).toBe(0);
      expect(partials).toBe(0);
    } finally {
      unsub();
    }
  });

  test("cam-kind finalized events are ignored", async () => {
    const backend = new OkBackend([{ t0_ms: 0, t1_ms: 10, text: "x" }]);
    const unsub = registerAsrPipeline({
      backend,
      config: { enabled: true, mode: "batch", failure_policy: "retry-then-dead-letter" },
    });
    let finals = 0;
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-cam") finals++;
    });
    try {
      const evt: MediaFinalizedEvent = { ...mkFinalizedEvent("c-cam", "/tmp/c-cam.mp4"), kind: "cam" };
      getBus().publish("media.finalized", evt);
      await new Promise((r) => setTimeout(r, 20));
      expect(finals).toBe(0);
    } finally {
      unsub();
    }
  });

  test("successful transcription emits partials + final on bus", async () => {
    const backend = new OkBackend([
      { t0_ms: 0, t1_ms: 500, text: "hi" },
      { t0_ms: 500, t1_ms: 1000, text: "there" },
    ]);
    const unsub = registerAsrPipeline({
      backend,
      config: { enabled: true, mode: "batch", failure_policy: "retry-then-dead-letter" },
    });
    const partials: AsrPartialEvent[] = [];
    let final: AsrFinalEvent | null = null;
    getBus().subscribe<AsrPartialEvent>("asr.partial", (e) => {
      if (e.media_id === "c-ok") partials.push(e);
    });
    getBus().subscribe<AsrFinalEvent>("asr.final", (e) => {
      if (e.media_id === "c-ok") final = e;
    });
    try {
      getBus().publish<MediaFinalizedEvent>(
        "media.finalized",
        mkFinalizedEvent("c-ok", "/tmp/c-ok.wav"),
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(partials.length).toBe(1);
      expect(final).not.toBeNull();
      expect(final!.text).toBe("hi there");
    } finally {
      unsub();
    }
  });
});
