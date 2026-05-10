// =============================================================================
// Unit tests for src/consumers/asr/backends/whisper-api.ts.
//
// Uses a global fetch mock (restored in afterEach) + a tmp wav file. Verifies
// the multipart form fields, the verbose_json → Transcript mapping, and HTTP
// error behavior. The backend throws on any non-2xx — it does NOT currently
// distinguish retryable vs non-retryable error classes, so we assert that
// actual behavior (message includes the status code) rather than pretending
// it does.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WhisperAPIBackend, DEFAULT_WHISPER_API_CONFIG } from "../../src/consumers/asr/backends/whisper-api.js";

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
  form: FormData;
  fields: Record<string, string | File>;
  signal: AbortSignal | undefined;
}

let captured: CapturedCall | null = null;

function installFetchMock(fn: (call: CapturedCall) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const form = init?.body as FormData;
    const fields: Record<string, string | File> = {};
    if (form && typeof form.entries === "function") {
      for (const [k, v] of form.entries()) {
        fields[k] = v as any;
      }
    }
    const authHeader = init?.headers?.Authorization ?? init?.headers?.authorization ?? null;
    const call: CapturedCall = {
      url,
      method,
      authHeader,
      form,
      fields,
      signal: init?.signal,
    };
    captured = call;
    return await fn(call);
  }) as any;
}

beforeEach(() => {
  workDir = join(tmpdir(), `hawky-whisper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(workDir, { recursive: true });
  wavPath = join(workDir, "c-1.wav");
  writeFileSync(wavPath, Buffer.alloc(128, 0));

  prevKey = process.env.DEEPINFRA_API_KEY;
  process.env.DEEPINFRA_API_KEY = "test-key";

  origFetch = globalThis.fetch;
  captured = null;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (prevKey === undefined) delete process.env.DEEPINFRA_API_KEY;
  else process.env.DEEPINFRA_API_KEY = prevKey;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("WhisperAPIBackend — request shape", () => {
  test("POSTs multipart/form-data with file, model, response_format=verbose_json", async () => {
    installFetchMock(() =>
      new Response(JSON.stringify({ segments: [], language: "en" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const backend = new WhisperAPIBackend();
    await backend.transcribeFile(wavPath, { media_id: "c-1" });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(DEFAULT_WHISPER_API_CONFIG.endpoint);
    expect(captured!.method).toBe("POST");
    expect(captured!.authHeader).toBe("Bearer test-key");
    expect(captured!.fields.model).toBe(DEFAULT_WHISPER_API_CONFIG.model);
    expect(captured!.fields.response_format).toBe("verbose_json");
    // `file` may be a File (when browsers/Bun wrap the Blob) or a Blob-ish
    // entry with a `.name`. Bun's BunFile reports its absolute path as the
    // name and FormData.append's filename override isn't always honored,
    // so assert only that the filename ENDS with our wav basename — the
    // important contract is that the multipart part carries a recognizable
    // filename, not the exact path-vs-basename shape.
    const fileField = captured!.fields.file as any;
    expect(fileField).toBeDefined();
    expect(typeof fileField.name).toBe("string");
    expect(fileField.name.endsWith("c-1.wav")).toBe(true);
  });

  test("passes optional language field when lang opt provided", async () => {
    installFetchMock(() =>
      new Response(JSON.stringify({ segments: [] }), { status: 200 }),
    );
    const backend = new WhisperAPIBackend();
    await backend.transcribeFile(wavPath, { media_id: "c-1", lang: "en" });
    expect(captured!.fields.language).toBe("en");
  });

  test("missing API key → constructor throws (fail-fast)", () => {
    // Matches AssemblyAI's fail-fast behavior so the failure policy never
    // burns its retry budget on a non-retryable missing-credential error
    // — the backend is unusable up-front, not on first call.
    delete process.env.DEEPINFRA_API_KEY;
    expect(() => new WhisperAPIBackend()).toThrow(/DEEPINFRA_API_KEY/);
  });
});

describe("WhisperAPIBackend — response mapping", () => {
  test("verbose_json → Transcript with ms-scaled segments and lang", async () => {
    installFetchMock(() =>
      new Response(
        JSON.stringify({
          language: "en",
          segments: [
            { start: 0, end: 1.5, text: "hello" },
            { start: 1.5, end: 3.0, text: " world" },
          ],
        }),
        { status: 200 },
      ),
    );
    const backend = new WhisperAPIBackend();
    const t = await backend.transcribeFile(wavPath, { media_id: "c-1" });
    expect(t.media_id).toBe("c-1");
    expect(t.lang).toBe("en");
    expect(t.backend).toBe("deepinfra-whisper");
    expect(t.segments).toEqual([
      { t0_ms: 0, t1_ms: 1500, text: "hello" },
      { t0_ms: 1500, t1_ms: 3000, text: "world" },
    ]);
  });

  test("fallback: empty segments + plain text → single synthetic segment", async () => {
    installFetchMock(() =>
      new Response(
        JSON.stringify({ text: "one shot", segments: [] }),
        { status: 200 },
      ),
    );
    const backend = new WhisperAPIBackend();
    const t = await backend.transcribeFile(wavPath, { media_id: "c-1" });
    expect(t.segments.length).toBe(1);
    expect(t.segments[0].text).toBe("one shot");
  });

  test("unknown language defaults to 'unknown'", async () => {
    installFetchMock(() => new Response(JSON.stringify({ segments: [] }), { status: 200 }));
    const backend = new WhisperAPIBackend();
    const t = await backend.transcribeFile(wavPath, { media_id: "c-1" });
    expect(t.lang).toBe("unknown");
  });
});

describe("WhisperAPIBackend — HTTP errors", () => {
  test("4xx → throws with status code in message", async () => {
    installFetchMock(() => new Response("bad auth", { status: 401 }));
    const backend = new WhisperAPIBackend();
    await expect(
      backend.transcribeFile(wavPath, { media_id: "c-1" }),
    ).rejects.toThrow(/401/);
  });

  test("5xx → throws with status code in message", async () => {
    // NOTE: current implementation does not distinguish retryable vs
    // non-retryable — the outer failure-policy drives the retry decision.
    // We only assert the error surfaces the status.
    installFetchMock(() => new Response("oops", { status: 503 }));
    const backend = new WhisperAPIBackend();
    await expect(
      backend.transcribeFile(wavPath, { media_id: "c-1" }),
    ).rejects.toThrow(/503/);
  });
});

describe("WhisperAPIBackend — timeout", () => {
  test("timeout_ms aborts the fetch via AbortSignal", async () => {
    let abortSeen = false;
    installFetchMock(async (call) => {
      // Simulate a slow server that races with the abort signal.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 200);
        call.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          abortSeen = true;
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response("{}", { status: 200 });
    });
    const backend = new WhisperAPIBackend({
      ...DEFAULT_WHISPER_API_CONFIG,
      timeout_ms: 20,
    });
    await expect(
      backend.transcribeFile(wavPath, { media_id: "c-1" }),
    ).rejects.toThrow();
    expect(abortSeen).toBe(true);
  });
});
