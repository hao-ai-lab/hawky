// =============================================================================
// Unit tests for src/consumers/asr/backends/index.ts — the backend factory.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createBackend, WhisperAPIBackend, AssemblyAIBackend } from "../../src/consumers/asr/backends/index.js";

const ENV_KEYS = ["DEEPINFRA_API_KEY", "ASSEMBLYAI_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = "test-key";
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("backend factory — createBackend", () => {
  test("'whisper-api' returns a WhisperAPIBackend instance when env key set", () => {
    const backend = createBackend({ backend: "whisper-api" });
    expect(backend).not.toBeNull();
    expect(backend).toBeInstanceOf(WhisperAPIBackend);
    expect(backend!.name).toBe("deepinfra-whisper");
  });

  test("'whisper-api' accepts overrides via whisper_api", () => {
    const backend = createBackend({
      backend: "whisper-api",
      whisper_api: { model: "custom/model" },
    });
    expect(backend).toBeInstanceOf(WhisperAPIBackend);
  });

  test("'whisper-api' returns null when DEEPINFRA_API_KEY is unset", () => {
    delete process.env.DEEPINFRA_API_KEY;
    expect(createBackend({ backend: "whisper-api" })).toBeNull();
  });

  test("'assemblyai' returns an AssemblyAIBackend instance when env key set", () => {
    const backend = createBackend({ backend: "assemblyai" });
    expect(backend).toBeInstanceOf(AssemblyAIBackend);
  });

  test("'assemblyai' returns null when ASSEMBLYAI_API_KEY is unset", () => {
    delete process.env.ASSEMBLYAI_API_KEY;
    expect(createBackend({ backend: "assemblyai" })).toBeNull();
  });

  test("'disabled' returns null (no-op)", () => {
    const backend = createBackend({ backend: "disabled" });
    expect(backend).toBeNull();
  });

  test("'whisper-cpp' throws 'not implemented'", () => {
    expect(() => createBackend({ backend: "whisper-cpp" })).toThrow(/not implemented/);
  });

  test("'deepgram' throws 'not implemented'", () => {
    expect(() => createBackend({ backend: "deepgram" })).toThrow(/not implemented/);
  });

  test("unknown backend name throws a clear error", () => {
    expect(() => createBackend({ backend: "bogus" as any })).toThrow(/unknown ASR backend/);
  });
});
