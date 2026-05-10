// =============================================================================
// Unit tests for src/consumers/asr/deadletter.ts.
//
// Write/list/load/delete round-trip, skip-bad-files robustness. No exported
// replay helper (the replay logic lives in src/cli/asr-replay.ts) — covered in
// asr-replay.test.ts instead. Noting here for clarity.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeDeadLetter,
  listDeadLetters,
  loadDeadLetter,
  deleteDeadLetter,
  getDeadLetterDir,
  type DeadLetterEntry,
} from "../../src/consumers/asr/deadletter.js";

let workDir: string;
let deadletterDir: string;
let prevDeadletterDir: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-deadletter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  deadletterDir = join(workDir, "dl");
  mkdirSync(deadletterDir, { recursive: true });
  prevDeadletterDir = process.env.HAWKY_ASR_DEADLETTER_DIR;
  process.env.HAWKY_ASR_DEADLETTER_DIR = deadletterDir;
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

function mkEntry(media_id: string, overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    media_id,
    wav_path: `/tmp/${media_id}.wav`,
    mime: "audio/wav",
    backend: "mock",
    attempts: 3,
    last_error: "boom",
    ts_iso: new Date().toISOString(),
    ...overrides,
  };
}

describe("deadletter — env override", () => {
  test("getDeadLetterDir respects HAWKY_ASR_DEADLETTER_DIR", () => {
    expect(getDeadLetterDir()).toBe(deadletterDir);
  });
});

describe("deadletter — round-trip", () => {
  test("write → list → load produces matching entry with full schema", async () => {
    const entry = mkEntry("c-1");
    await writeDeadLetter(entry);

    const listed = listDeadLetters();
    expect(listed.length).toBe(1);
    expect(listed[0]).toEqual(entry);

    const loaded = loadDeadLetter("c-1");
    expect(loaded).toEqual(entry);

    // Schema keys.
    const keys = Object.keys(loaded!).sort();
    expect(keys).toEqual(
      ["attempts", "backend", "last_error", "media_id", "mime", "ts_iso", "wav_path"].sort(),
    );
  });

  test("delete removes file and subsequent load returns null", async () => {
    await writeDeadLetter(mkEntry("c-2"));
    expect(loadDeadLetter("c-2")).not.toBeNull();
    const deleted = deleteDeadLetter("c-2");
    expect(deleted).toBe(true);
    expect(loadDeadLetter("c-2")).toBeNull();
    // Second delete returns false (file gone).
    expect(deleteDeadLetter("c-2")).toBe(false);
  });
});

describe("deadletter — robustness", () => {
  test("list() skips non-JSON files", async () => {
    await writeDeadLetter(mkEntry("c-good"));
    writeFileSync(join(deadletterDir, "note.txt"), "not json", "utf-8");
    writeFileSync(join(deadletterDir, "stash"), "stray", "utf-8");
    const listed = listDeadLetters();
    expect(listed.length).toBe(1);
    expect(listed[0].media_id).toBe("c-good");
  });

  test("list() skips corrupt JSON files without crashing", async () => {
    await writeDeadLetter(mkEntry("c-ok"));
    writeFileSync(join(deadletterDir, "broken.json"), "{ not valid json", "utf-8");
    const listed = listDeadLetters();
    expect(listed.length).toBe(1);
    expect(listed[0].media_id).toBe("c-ok");
  });

  test("list() returns [] when dir doesn't exist", () => {
    rmSync(deadletterDir, { recursive: true, force: true });
    expect(listDeadLetters()).toEqual([]);
  });

  test("write creates dir if missing", async () => {
    rmSync(deadletterDir, { recursive: true, force: true });
    await writeDeadLetter(mkEntry("c-fresh"));
    expect(existsSync(deadletterDir)).toBe(true);
    const files = readdirSync(deadletterDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
  });

  test("sanitizes unsafe media_id when picking path", async () => {
    await writeDeadLetter(mkEntry("weird/../id"));
    const files = readdirSync(deadletterDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    // No path-separator chars in filename (dots are allowed and harmless
    // since the file is always resolved under the deadletter dir).
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain("\\");
  });
});
