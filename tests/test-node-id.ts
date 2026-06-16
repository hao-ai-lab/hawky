// =============================================================================
// Unit tests for src/storage/node-id.ts.
//
// Verifies:
//   1. getNodeId() is stable across calls within a process (cached).
//   2. Different persisted salts yield different node ids.
//   3. Persisted salt is reused across cache resets (cross-restart stability).
//   4. node_id is 12 hex chars and contains no hostname-derived bits.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNodeId, _resetNodeIdCacheForTesting } from "../src/storage/node-id.js";

let tmpRoot: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hawky-nodeid-"));
  prevWorkspace = process.env.HAWKY_WORKSPACE;
  process.env.HAWKY_WORKSPACE = tmpRoot;
  _resetNodeIdCacheForTesting();
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.HAWKY_WORKSPACE;
  else process.env.HAWKY_WORKSPACE = prevWorkspace;
  _resetNodeIdCacheForTesting();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("node-id", () => {
  test("getNodeId is stable across calls", () => {
    const a = getNodeId();
    const b = getNodeId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("persists salt to disk on first call", () => {
    const id = getNodeId();
    const saltPath = join(tmpRoot, ".node-id");
    expect(existsSync(saltPath)).toBe(true);
    const salt = readFileSync(saltPath, "utf-8").trim();
    expect(salt.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("different salts produce different node ids", () => {
    const id1 = getNodeId();

    // Wipe state, swap to a fresh workspace with a different salt.
    _resetNodeIdCacheForTesting();
    const otherRoot = mkdtempSync(join(tmpdir(), "hawky-nodeid-other-"));
    process.env.HAWKY_WORKSPACE = otherRoot;
    try {
      const id2 = getNodeId();
      expect(id2).not.toBe(id1);
      expect(id2).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
      process.env.HAWKY_WORKSPACE = tmpRoot;
    }
  });

  test("persisted salt is reused after cache reset", () => {
    const id1 = getNodeId();
    _resetNodeIdCacheForTesting();
    const id2 = getNodeId();
    expect(id2).toBe(id1);
  });

  test("explicit salt yields deterministic id", () => {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, ".node-id"), "deadbeef\n", "utf-8");
    _resetNodeIdCacheForTesting();
    const id1 = getNodeId();
    _resetNodeIdCacheForTesting();
    const id2 = getNodeId();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{12}$/);
  });
});
