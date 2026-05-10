// =============================================================================
// Unit tests for src/consumers/chat-poster/session-resolver.ts.
//
// Covers the persisted salt file (.node-id), stable node-id caching across
// "restarts" (cache reset + new call), cross-workspace isolation, and
// session_id_override precedence.
//
// Resolver computes node_id = first 12 hex of sha256(getConfigDir() + salt).
// Different HAWKY_WORKSPACE → different on-disk salts → different node_ids.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getNodeId,
  getVoiceMemoSessionKey,
  _resetNodeIdCache,
} from "../../src/consumers/chat-poster/session-resolver.js";

let workDir: string;
let workspaceA: string;
let workspaceB: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `hawky-session-resolver-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  workspaceA = join(workDir, "ws-a");
  workspaceB = join(workDir, "ws-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  prevWorkspace = process.env.HAWKY_WORKSPACE;
  process.env.HAWKY_WORKSPACE = workspaceA;
  _resetNodeIdCache();
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.HAWKY_WORKSPACE;
  else process.env.HAWKY_WORKSPACE = prevWorkspace;
  _resetNodeIdCache();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("session-resolver — node id creation", () => {
  test("first call creates .node-id under HAWKY_WORKSPACE and returns 12-hex id", () => {
    const id = getNodeId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const saltFile = join(workspaceA, ".node-id");
    expect(existsSync(saltFile)).toBe(true);
    const salt = readFileSync(saltFile, "utf-8").trim();
    // Default salt is 16 random bytes → 32 hex chars.
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  test("second call reuses cached node id", () => {
    const a = getNodeId();
    const b = getNodeId();
    expect(b).toBe(a);
  });
});

describe("session-resolver — restart stability", () => {
  test("new resolver 'process' (cache reset, same workspace) → same node id", () => {
    const first = getNodeId();
    _resetNodeIdCache();
    const second = getNodeId();
    expect(second).toBe(first);
  });

  test("same pre-written salt → deterministic node id", () => {
    writeFileSync(join(workspaceA, ".node-id"), "deadbeef".repeat(4) + "\n", "utf-8");
    _resetNodeIdCache();
    const a = getNodeId();
    _resetNodeIdCache();
    const b = getNodeId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("session-resolver — workspace isolation", () => {
  test("different HAWKY_WORKSPACE → different salts → different node ids", () => {
    writeFileSync(join(workspaceA, ".node-id"), "a".repeat(32) + "\n", "utf-8");
    writeFileSync(join(workspaceB, ".node-id"), "b".repeat(32) + "\n", "utf-8");

    process.env.HAWKY_WORKSPACE = workspaceA;
    _resetNodeIdCache();
    const idA = getNodeId();

    process.env.HAWKY_WORKSPACE = workspaceB;
    _resetNodeIdCache();
    const idB = getNodeId();

    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^[0-9a-f]{12}$/);
    expect(idB).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("session-resolver — voice memo session key", () => {
  test("default key is voice:<node_id>", () => {
    const id = getNodeId();
    const key = getVoiceMemoSessionKey();
    expect(key).toBe(`voice:${id}`);
  });

  test("session_id_override takes precedence when set", () => {
    const key = getVoiceMemoSessionKey("voice:custom");
    expect(key).toBe("voice:custom");
  });

  test("null/empty override falls back to derived key", () => {
    const id = getNodeId();
    expect(getVoiceMemoSessionKey(null)).toBe(`voice:${id}`);
    expect(getVoiceMemoSessionKey("")).toBe(`voice:${id}`);
    expect(getVoiceMemoSessionKey("   ")).toBe(`voice:${id}`);
  });
});
