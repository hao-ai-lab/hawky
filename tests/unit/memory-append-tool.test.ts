// =============================================================================
// memory.append tool — unit tests.
//
// Scope:
//   - missing category / text → error
//   - invalid category (spaces, slashes) → error
//   - happy path writes a JSONL line
//   - category directory is created on first write
//   - multiple appends produce N lines
//   - ts_iso override is respected
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeMemoryAppend } from "../../src/tools/memory_append.js";
import { setWorkspaceDir } from "../../src/storage/workspace.js";
import type { ToolContext } from "../../src/agent/types.js";

function makeCtx(sessionId = "voice:test-node"): ToolContext {
  return {
    session_id: sessionId,
    working_directory: process.cwd(),
    abort_signal: new AbortController().signal,
    emit: () => {},
  };
}

let workDir: string;
let workspaceDir: string;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-memappend-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  workspaceDir = join(workDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  setWorkspaceDir(workspaceDir);
});

afterEach(() => {
  // Restore default workspace dir
  setWorkspaceDir(join(process.env.HOME || "/tmp", ".hawky", "workspace"));
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("memory.append tool", () => {
  test("missing category returns error", async () => {
    const result = await executeMemoryAppend(
      { category: "", text: "hi" },
      makeCtx(),
    );
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("category");
  });

  test("missing text returns error", async () => {
    const result = await executeMemoryAppend(
      { category: "daily-log", text: "  " },
      makeCtx(),
    );
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("text");
  });

  test("invalid category (spaces) returns error", async () => {
    const result = await executeMemoryAppend(
      { category: "daily log", text: "x" },
      makeCtx(),
    );
    expect(result.type).toBe("error");
    expect((result as any).content).toContain("Invalid category");
  });

  test("invalid category (slash, path traversal) returns error", async () => {
    const result = await executeMemoryAppend(
      { category: "../evil", text: "x" },
      makeCtx(),
    );
    expect(result.type).toBe("error");
  });

  test("happy path writes JSONL line, creates category dir", async () => {
    const result = await executeMemoryAppend(
      { category: "daily-log", text: "first entry" },
      makeCtx("voice:abc123"),
    );
    expect(result.type).toBe("text");

    const expectedFile = join(
      workspaceDir,
      "memory",
      "daily-log",
      `${todayIso()}.jsonl`,
    );
    expect(existsSync(expectedFile)).toBe(true);
    const lines = readFileSync(expectedFile, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.category).toBe("daily-log");
    expect(obj.text).toBe("first entry");
    expect(obj.source_session).toBe("voice:abc123");
    expect(typeof obj.ts_iso).toBe("string");
    // ts_iso should parse as a date
    expect(Number.isFinite(new Date(obj.ts_iso).getTime())).toBe(true);
  });

  test("multiple appends produce N lines in same file", async () => {
    await executeMemoryAppend(
      { category: "observations", text: "one" },
      makeCtx(),
    );
    await executeMemoryAppend(
      { category: "observations", text: "two" },
      makeCtx(),
    );
    await executeMemoryAppend(
      { category: "observations", text: "three" },
      makeCtx(),
    );

    const file = join(
      workspaceDir,
      "memory",
      "observations",
      `${todayIso()}.jsonl`,
    );
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).text).toBe("one");
    expect(JSON.parse(lines[2]).text).toBe("three");
  });

  test("ts_iso override is respected", async () => {
    const pinned = "2026-04-01T12:34:56.000Z";
    await executeMemoryAppend(
      { category: "daily-log", text: "backdated", ts_iso: pinned },
      makeCtx(),
    );

    const file = join(
      workspaceDir,
      "memory",
      "daily-log",
      `${todayIso()}.jsonl`,
    );
    const line = readFileSync(file, "utf-8").split("\n").filter(Boolean)[0];
    expect(JSON.parse(line).ts_iso).toBe(pinned);
  });
});
