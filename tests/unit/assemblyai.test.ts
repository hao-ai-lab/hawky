// =============================================================================
// Unit tests for src/consumers/asr/backends/assemblyai.ts.
//
// Mocks globalThis.fetch with a queue-of-responses pattern: each test pushes
// handlers onto `fetchQueue` in the order the backend is expected to call
// (upload → submit → poll → poll → ...). Verifies:
//   * Authorization header = api key (no "Bearer " prefix).
//   * Happy path: two polls, completed response → single-segment Transcript.
//   * Polling status=error surfaces the `error` field.
//   * Upload HTTP 401 surfaces the status in the error message.
//   * Constructor throws when api_key_env var is missing.
//   * words:[] fallback → t0_ms=t1_ms=0 with the text intact.
//   * Short timeout_ms with always-processing polls → throws a timeout error.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AssemblyAIBackend,
  DEFAULT_ASSEMBLYAI_CONFIG,
} from "../../src/consumers/asr/backends/assemblyai.js";

// -----------------------------------------------------------------------------
// Tmp wav + env key + fetch mock
// -----------------------------------------------------------------------------

let workDir: string;
let wavPath: string;
let prevKey: string | undefined;
let origFetch: typeof globalThis.fetch;

interface CapturedCall {
  url: string;
  method: string;
  authHeader: string | null;
  contentType: string | null;
  bodyText: string | null;
  bodyBytes: number | null;
}

let captured: CapturedCall[] = [];
let fetchQueue: Array<(call: CapturedCall) => Response | Promise<Response>> = [];

function installFetchMock() {
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authHeader = headers.Authorization ?? headers.authorization ?? null;
    const contentType =
      headers["Content-Type"] ?? headers["content-type"] ?? null;
    let bodyText: string | null = null;
    let bodyBytes: number | null = null;
    const body = init?.body;
    if (typeof body === "string") {
      bodyText = body;
    } else if (body instanceof ArrayBuffer) {
      bodyBytes = body.byteLength;
    } else if (body && typeof body.byteLength === "number") {
      bodyBytes = body.byteLength;
    } else if (body && typeof body.size === "number") {
      // Blob / BunFile (streamed upload body) — report its declared size
      // so tests can still assert the upload payload matches the source WAV.
      bodyBytes = body.size;
    }
    const call: CapturedCall = {
      url,
      method,
      authHeader,
      contentType,
      bodyText,
      bodyBytes,
    };
    captured.push(call);
    const handler = fetchQueue.shift();
    if (!handler) {
      throw new Error(
        `unexpected fetch call #${captured.length}: ${method} ${url} (no handler queued)`,
      );
    }
    return await handler(call);
  }) as any;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-aai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(workDir, { recursive: true });
  wavPath = join(workDir, "c-1.wav");
  writeFileSync(wavPath, Buffer.alloc(256, 0));

  prevKey = process.env.ASSEMBLYAI_API_KEY;
  process.env.ASSEMBLYAI_API_KEY = "aai-test-key";

  origFetch = globalThis.fetch;
  captured = [];
  fetchQueue = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (prevKey === undefined) delete process.env.ASSEMBLYAI_API_KEY;
  else process.env.ASSEMBLYAI_API_KEY = prevKey;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("AssemblyAIBackend — happy path", () => {
  test("upload → submit → poll(processing) → poll(completed) → one segment", async () => {
    fetchQueue.push(() =>
      jsonResponse({ upload_url: "https://cdn.aai/x/abc" }),
    );
    fetchQueue.push(() => jsonResponse({ id: "tr_1", status: "queued" }));
    fetchQueue.push(() => jsonResponse({ id: "tr_1", status: "processing" }));
    fetchQueue.push(() =>
      jsonResponse({
        id: "tr_1",
        status: "completed",
        text: "hello world",
        confidence: 0.95,
        words: [
          { start: 0, end: 500, text: "hello", confidence: 0.96 },
          { start: 500, end: 1100, text: "world", confidence: 0.94 },
        ],
        language_code: "en",
      }),
    );

    const backend = new AssemblyAIBackend({
      poll_interval_ms: 1,
      timeout_ms: 5_000,
    });
    const t = await backend.transcribeFile(wavPath, { media_id: "c-1" });

    expect(t.media_id).toBe("c-1");
    expect(t.backend).toBe("assemblyai");
    expect(t.lang).toBe("en");
    expect(t.segments).toEqual([
      { t0_ms: 0, t1_ms: 1100, text: "hello world", confidence: 0.95 },
    ]);

    // Call shapes
    expect(captured.length).toBe(4);
    expect(captured[0].url).toBe(
      `${DEFAULT_ASSEMBLYAI_CONFIG.endpoint}/v2/upload`,
    );
    expect(captured[0].method).toBe("POST");
    expect(captured[0].contentType).toBe("application/octet-stream");
    expect(captured[0].bodyBytes).toBe(256);

    expect(captured[1].url).toBe(
      `${DEFAULT_ASSEMBLYAI_CONFIG.endpoint}/v2/transcript`,
    );
    expect(captured[1].method).toBe("POST");
    expect(captured[1].contentType).toBe("application/json");
    const submitBody = JSON.parse(captured[1].bodyText ?? "{}");
    expect(submitBody.audio_url).toBe("https://cdn.aai/x/abc");
    expect(submitBody.punctuate).toBe(true);
    expect(submitBody.format_text).toBe(true);

    expect(captured[2].method).toBe("GET");
    expect(captured[2].url).toBe(
      `${DEFAULT_ASSEMBLYAI_CONFIG.endpoint}/v2/transcript/tr_1`,
    );
    expect(captured[3].method).toBe("GET");
  });

  test("Authorization header is api key with no 'Bearer ' prefix", async () => {
    fetchQueue.push(() =>
      jsonResponse({ upload_url: "https://cdn.aai/y" }),
    );
    fetchQueue.push(() => jsonResponse({ id: "tr_2", status: "queued" }));
    fetchQueue.push(() =>
      jsonResponse({
        id: "tr_2",
        status: "completed",
        text: "",
        words: [],
      }),
    );

    const backend = new AssemblyAIBackend({ poll_interval_ms: 1 });
    await backend.transcribeFile(wavPath, { media_id: "c-1" });

    for (const call of captured) {
      expect(call.authHeader).toBe("aai-test-key");
      expect(call.authHeader?.startsWith("Bearer ")).toBe(false);
    }
  });
});

describe("AssemblyAIBackend — error branches", () => {
  test("poll returns status=error → throws with the `error` field", async () => {
    fetchQueue.push(() =>
      jsonResponse({ upload_url: "https://cdn.aai/z" }),
    );
    fetchQueue.push(() => jsonResponse({ id: "tr_3", status: "queued" }));
    fetchQueue.push(() =>
      jsonResponse({
        id: "tr_3",
        status: "error",
        error: "some reason",
      }),
    );
    const backend = new AssemblyAIBackend({ poll_interval_ms: 1 });
    await expect(
      backend.transcribeFile(wavPath, { media_id: "c-1" }),
    ).rejects.toThrow(/some reason/);
  });

  test("upload HTTP 401 → throws with 401 in message", async () => {
    fetchQueue.push(() => new Response("bad auth", { status: 401 }));
    const backend = new AssemblyAIBackend({ poll_interval_ms: 1 });
    await expect(
      backend.transcribeFile(wavPath, { media_id: "c-1" }),
    ).rejects.toThrow(/401/);
  });

  test("missing api_key_env → constructor throws (factory pre-checks env, direct construction is a programmer error)", async () => {
    delete process.env.ASSEMBLYAI_API_KEY;
    expect(() => new AssemblyAIBackend()).toThrow(/ASSEMBLYAI_API_KEY/);
  });
});

describe("AssemblyAIBackend — segment synthesis edge cases", () => {
  test("words:[] but text set → single segment with t0_ms=t1_ms=0", async () => {
    fetchQueue.push(() =>
      jsonResponse({ upload_url: "https://cdn.aai/w" }),
    );
    fetchQueue.push(() => jsonResponse({ id: "tr_4", status: "queued" }));
    fetchQueue.push(() =>
      jsonResponse({
        id: "tr_4",
        status: "completed",
        text: "hi",
        words: [],
      }),
    );
    const backend = new AssemblyAIBackend({ poll_interval_ms: 1 });
    const t = await backend.transcribeFile(wavPath, { media_id: "c-1" });
    expect(t.segments.length).toBe(1);
    expect(t.segments[0].t0_ms).toBe(0);
    expect(t.segments[0].t1_ms).toBe(0);
    expect(t.segments[0].text).toBe("hi");
  });
});

describe("AssemblyAIBackend — timeout", () => {
  test("poll never completes before timeout_ms → throws timeout error", async () => {
    fetchQueue.push(() =>
      jsonResponse({ upload_url: "https://cdn.aai/t" }),
    );
    fetchQueue.push(() => jsonResponse({ id: "tr_5", status: "queued" }));
    // Every subsequent poll returns "processing" — fill the queue with a
    // handler that re-pushes itself so we never exhaust.
    const stuck = (): Response =>
      jsonResponse({ id: "tr_5", status: "processing" });
    // Pre-seed a generous number of handlers so the mock never runs dry.
    for (let i = 0; i < 100; i++) {
      fetchQueue.push(() => {
        // Keep the queue populated ad infinitum.
        fetchQueue.push(() => stuck());
        return stuck();
      });
    }

    const backend = new AssemblyAIBackend({
      timeout_ms: 10,
      poll_interval_ms: 5,
    });
    await expect(
      backend.transcribeFile(wavPath, { media_id: "c-1" }),
    ).rejects.toThrow(/timed out/);
  });
});
