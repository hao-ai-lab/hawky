// =============================================================================
// STT consumer slice 0 — integration test.
//
// Wires up:
//   media-writer (finalize hook → media.finalized on bus)
//     → asr-pipeline (mock ASRBackend, no DeepInfra)
//       → asr.final on bus
//     → chat-poster (mocked sessions + server)
//       → user ChatMessage in per-node voice-memo session
//
// No network. No real Anthropic/LLM provider (chat-poster only writes to the
// session manager). No real gateway; the pipeline hangs off the shared bus.
//
// Note: PR-B drops the JSONL transcript event log; only the `.transcript.json`
// sidecar persists. The chat turn is derived from the in-memory AsrFinalEvent.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBus, resetBus } from "../../src/bus/index.js";
import type { MediaFinalizedEvent, AsrFinalEvent } from "../../src/bus/events.js";
import { registerAsrPipeline, emitTranscriptEvents } from "../../src/consumers/asr/pipeline.js";
import { registerChatPoster } from "../../src/consumers/chat-poster/index.js";
import { _resetNodeIdCache } from "../../src/consumers/chat-poster/session-resolver.js";
import { handleMediaChunk, resetMediaWriters } from "../../src/gateway/media-writer.js";
import type { ASRBackend, Transcript } from "../../src/consumers/asr/types.js";

// -----------------------------------------------------------------------------
// Mocks for AgentSessionManager + server (only the methods chat-poster calls)
// -----------------------------------------------------------------------------

interface MockMessage {
  role: "user" | "assistant";
  content: any[];
  timestamp?: string;
}

class MockSessionManager {
  appended: MockMessage[] = [];
  appendMessage(m: MockMessage): void {
    this.appended.push(m);
  }
}

class MockLoop {
  private history: MockMessage[] = [];
  getHistory(): MockMessage[] {
    return this.history;
  }
  setHistory(h: MockMessage[]): void {
    this.history = h;
  }
}

class MockSessions {
  sessions = new Map<string, { loop: MockLoop; sessionManager: MockSessionManager }>();
  getOrCreate(key: string) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { loop: new MockLoop(), sessionManager: new MockSessionManager() };
      this.sessions.set(key, s);
    }
    return s;
  }
}

class MockServer {
  events: Array<{ type: string; sessionKey?: string; event: string; payload: any }> = [];
  broadcastToSession(sessionKey: string, event: string, payload: any): void {
    this.events.push({ type: "session", sessionKey, event, payload });
  }
  broadcast(event: string, payload: any): void {
    this.events.push({ type: "all", event, payload });
  }
}

// -----------------------------------------------------------------------------
// Mock ASRBackend — no network. Returns two synthetic segments.
// -----------------------------------------------------------------------------

class MockBackend implements ASRBackend {
  name = "mock-whisper";
  capabilities = {
    batch: true,
    streaming: false,
    partials: false,
    diarization: false,
    langs: ["*"],
  };
  calls: string[] = [];
  async transcribeFile(wavPath: string, opts: { media_id: string }): Promise<Transcript> {
    this.calls.push(wavPath);
    return {
      media_id: opts.media_id,
      lang: "en",
      backend: this.name,
      model: "mock-1",
      segments: [
        { t0_ms: 0, t1_ms: 1500, text: "Hello" },
        { t0_ms: 1500, t1_ms: 3000, text: "world." },
      ],
    };
  }
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/** PCM silence payload: 3 seconds @ 16 kHz mono 16-bit = 96000 bytes. */
function makePcmSilenceBase64(): string {
  const bytes = 16000 * 2 * 3; // sampleRate * bytesPerSample * seconds
  return Buffer.alloc(bytes, 0).toString("base64");
}

function waitForBusEvent<T = unknown>(
  topic: string,
  predicate?: (event: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timeout waiting for ${topic}`));
    }, timeoutMs);
    const unsub = getBus().subscribe<T>(topic, (event) => {
      if (predicate && !predicate(event)) return;
      clearTimeout(timer);
      unsub();
      resolve(event);
    });
  });
}

// -----------------------------------------------------------------------------
// Environment setup — redirect media + workspace to a temp dir.
// -----------------------------------------------------------------------------

let workDir: string;
let mediaRoot: string;
let workspaceDir: string;
let prevMediaRoot: string | undefined;
let prevWorkspace: string | undefined;

beforeEach(() => {
  workDir = join(tmpdir(), `hawky-stt-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mediaRoot = join(workDir, "media");
  workspaceDir = join(workDir, "workspace");
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  prevMediaRoot = process.env.HAWKY_MEDIA_ROOT;
  prevWorkspace = process.env.HAWKY_WORKSPACE;
  process.env.HAWKY_MEDIA_ROOT = mediaRoot;
  process.env.HAWKY_WORKSPACE = workspaceDir;

  resetBus();
  resetMediaWriters();
  _resetNodeIdCache();
});

afterEach(() => {
  if (prevMediaRoot === undefined) delete process.env.HAWKY_MEDIA_ROOT;
  else process.env.HAWKY_MEDIA_ROOT = prevMediaRoot;
  if (prevWorkspace === undefined) delete process.env.HAWKY_WORKSPACE;
  else process.env.HAWKY_WORKSPACE = prevWorkspace;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// -----------------------------------------------------------------------------
// Test — end-to-end slice 0
// -----------------------------------------------------------------------------

describe("STT consumer slice 0", () => {
  test("3s wav → media.finalized → asr.final → chat turn posted", async () => {
    const backend = new MockBackend();
    const sessions = new MockSessions();
    const server = new MockServer();

    // Register the consumers on the shared bus.
    const unsubAsr = registerAsrPipeline({
      backend,
      config: {
        enabled: true,
        mode: "batch",
        failure_policy: "retry-then-dead-letter",
      },
    });
    const unsubChat = registerChatPoster({
      sessions: sessions as any,
      server: server as any,
      config: {
        enabled: true,
        session_id_override: "voice:test",
        prefix: "🎙 ",
        include_confidence: false,
        // Defaults would drop this short transcript on duration; relax here.
        silence_denylist: [],
        min_confidence: 0,
        min_duration_ms: 0,
        // Short debounce so the test's single event flushes promptly via the
        // inactivity timer instead of waiting the 5s default.
        debounce_ms: 5,
      },
    });

    try {
      // Observe the bus events.
      const finalizedP = waitForBusEvent<MediaFinalizedEvent>(
        "media.finalized",
        (e) => e.media_id === "c-test",
      );
      const asrFinalP = waitForBusEvent<AsrFinalEvent>(
        "asr.final",
        (e) => e.media_id === "c-test",
      );

      // Drive chunk upload → finalize.
      const pcm = makePcmSilenceBase64();
      await handleMediaChunk({
        media_id: "c-test",
        seq: 0,
        bytes: pcm,
        mime: "audio/pcm16;rate=16000",
        captured_at_ns: 0,
        final: true,
      });

      const mediaEvt = await finalizedP;
      expect(mediaEvt.media_id).toBe("c-test");
      expect(mediaEvt.kind).toBe("mic");
      expect(mediaEvt.mime).toBe("audio/pcm16;rate=16000");
      expect(mediaEvt.path.endsWith("c-test.wav")).toBe(true);

      const asrFinal = await asrFinalP;
      expect(asrFinal.media_id).toBe("c-test");
      expect(asrFinal.text).toBe("Hello world.");
      expect(asrFinal.segments.length).toBe(2);
      expect(asrFinal.backend).toBe("mock-whisper");

      // Give chat-poster a tick to process asr.final + debounce flush.
      await new Promise((r) => setTimeout(r, 60));

      // Verify the per-session side-effect: chat turn landed in the override session.
      const sess = sessions.sessions.get("voice:test");
      expect(sess).toBeDefined();
      expect(sess!.sessionManager.appended.length).toBe(1);
      const msg = sess!.sessionManager.appended[0];
      expect(msg.role).toBe("user");
      expect(msg.content[0].text).toBe("🎙 Hello world.");

      // And the server got a broadcast.
      const updated = server.events.find((e) => e.event === "session.updated");
      expect(updated).toBeDefined();
      expect(updated!.payload.sessionKey).toBe("voice:test");

      // And the mock backend was called with the finalized wav path.
      expect(backend.calls.length).toBe(1);
      expect(backend.calls[0].endsWith("c-test.wav")).toBe(true);

      // Sidecar transcript JSON should be written next to the WAV with the
      // same content as the asr.final event. Give the async write a tick.
      await new Promise((r) => setTimeout(r, 20));
      const sidecarPath = mediaEvt.path.replace(/\.wav$/, ".transcript.json");
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
      expect(sidecar.media_id).toBe(asrFinal.media_id);
      expect(sidecar.text).toBe(asrFinal.text);
      expect(sidecar.segments).toEqual(asrFinal.segments);
      expect(sidecar.backend).toBe(asrFinal.backend);
      expect(sidecar.lang).toBe(asrFinal.lang);
      expect(sidecar.wav_path).toBe(mediaEvt.path);
    } finally {
      unsubAsr();
      unsubChat();
    }
  });

  test("emitTranscriptEvents emits partials for N-1 segments + 1 final", async () => {
    const partials: number[] = [];
    const finals: number[] = [];
    const unsub1 = getBus().subscribe("asr.partial", (_e: any) => {
      if (_e.media_id === "c-p") partials.push(_e.segment_index);
    });
    const unsub2 = getBus().subscribe("asr.final", (_e: any) => {
      if (_e.media_id === "c-p") finals.push(1);
    });
    try {
      emitTranscriptEvents(
        {
          media_id: "c-p",
          lang: "en",
          backend: "m",
          model: "m",
          segments: [
            { t0_ms: 0, t1_ms: 100, text: "a" },
            { t0_ms: 100, t1_ms: 200, text: "b" },
            { t0_ms: 200, t1_ms: 300, text: "c" },
          ],
        },
        42,
        "node-1",
      );
      expect(partials).toEqual([0, 1]);
      expect(finals).toEqual([1]);
    } finally {
      unsub1();
      unsub2();
    }
  });
});
