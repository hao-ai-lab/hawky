// =============================================================================
// Unit tests for src/consumers/asr/transcript-store.ts.
//
// Covers round-trip, idempotent overwrite, missing-file null, corrupt JSON,
// and nested-dir auto-creation.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeTranscriptSidecar,
  readTranscriptSidecar,
  type TranscriptSidecar,
} from "../../src/consumers/asr/transcript-store.js";

let workDir: string;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-transcript-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function mkSidecar(overrides: Partial<TranscriptSidecar> = {}): TranscriptSidecar {
  return {
    media_id: "c-2026-04-21T06:55:39.086Z.mic",
    wav_path: join(workDir, "2026-04-21", "c-2026-04-21T06:55:39.086Z.mic.wav"),
    lang: "en",
    text: "Hello world this is a voice memo.",
    segments: [
      { t0_ms: 0, t1_ms: 1100, text: "Hello world this is a voice memo.", confidence: 0.95 },
    ],
    backend: "assemblyai",
    model: "universal-2",
    transcribe_wallclock_ms: 1547,
    media_duration_ms: 4200,
    completed_at_iso: "2026-04-21T07:35:12.441Z",
    ...overrides,
  };
}

describe("transcript-store — round-trip", () => {
  test("write then read returns the same shape", async () => {
    const s = mkSidecar();
    await writeTranscriptSidecar(s);
    const back = await readTranscriptSidecar(s.wav_path);
    expect(back).not.toBeNull();
    expect(back!).toEqual(s);
  });

  test("read returns null when sidecar is missing", async () => {
    const wavPath = join(workDir, "nope", "missing.wav");
    const result = await readTranscriptSidecar(wavPath);
    expect(result).toBeNull();
  });

  test("read throws on corrupt JSON", async () => {
    const dayDir = join(workDir, "2026-04-21");
    mkdirSync(dayDir, { recursive: true });
    const wavPath = join(dayDir, "broken.wav");
    const sidecarPath = join(dayDir, "broken.transcript.json");
    writeFileSync(sidecarPath, "{this is not json");
    await expect(readTranscriptSidecar(wavPath)).rejects.toThrow();
  });
});

describe("transcript-store — idempotency", () => {
  test("writing twice with same media_id overwrites the first", async () => {
    const first = mkSidecar({ text: "first pass", completed_at_iso: "2026-04-21T00:00:00.000Z" });
    await writeTranscriptSidecar(first);

    const second = mkSidecar({
      text: "second pass, replayed",
      completed_at_iso: "2026-04-21T01:00:00.000Z",
      backend: "whisper-api",
      model: "whisper-large-v3",
    });
    await writeTranscriptSidecar(second);

    const back = await readTranscriptSidecar(first.wav_path);
    expect(back).not.toBeNull();
    expect(back!.text).toBe("second pass, replayed");
    expect(back!.backend).toBe("whisper-api");
    expect(back!.model).toBe("whisper-large-v3");
    expect(back!.completed_at_iso).toBe("2026-04-21T01:00:00.000Z");
  });
});

describe("transcript-store — nested dir creation", () => {
  test("writes into a deep dir that does not exist yet", async () => {
    const deepDir = join(workDir, "deep", "nested", "2099-12-31");
    const wavPath = join(deepDir, "c-xyz.wav");
    const s = mkSidecar({ wav_path: wavPath, media_id: "c-xyz" });
    await writeTranscriptSidecar(s);
    expect(existsSync(join(deepDir, "c-xyz.transcript.json"))).toBe(true);
  });
});

describe("transcript-store — written content matches spec", () => {
  test("JSON keys are exactly the spec keys", async () => {
    const s = mkSidecar();
    await writeTranscriptSidecar(s);
    const raw = await readFile(
      s.wav_path.replace(/\.wav$/, ".transcript.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "backend",
        "completed_at_iso",
        "lang",
        "media_duration_ms",
        "media_id",
        "model",
        "segments",
        "text",
        "transcribe_wallclock_ms",
        "wav_path",
      ].sort(),
    );
  });
});
