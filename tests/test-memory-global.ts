import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalMemoryIndex, resetGlobalMemoryIndex } from "../src/memory/global.js";

let tempDir: string | null = null;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-memory-global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDir = dir;
  return dir;
}

function makeWorkspace(root: string, name: string, content: string): string {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "MEMORY.md"), content, "utf-8");
  return workspace;
}

afterEach(() => {
  resetGlobalMemoryIndex();
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
});

describe("getGlobalMemoryIndex", () => {
  test("reuses the configured singleton when no new config is requested", () => {
    const root = makeTempDir();
    const workspace = makeWorkspace(root, "workspace", "Alpha project memory");
    const index = getGlobalMemoryIndex(workspace, undefined, join(root, "memory.db"));

    expect(getGlobalMemoryIndex()).toBe(index);
  });

  test("recreates the singleton when workspace or database config changes", async () => {
    const root = makeTempDir();
    const workspaceA = makeWorkspace(root, "workspace-a", "Alpha project memory");
    const workspaceB = makeWorkspace(root, "workspace-b", "Bravo project memory");

    const indexA = getGlobalMemoryIndex(workspaceA, undefined, join(root, "a.db"));
    expect(await indexA.search("Alpha")).toHaveLength(1);

    const indexB = getGlobalMemoryIndex(workspaceB, undefined, join(root, "b.db"));
    expect(indexB).not.toBe(indexA);
    expect(await indexB.search("Bravo")).toHaveLength(1);
    expect(await indexB.search("Alpha")).toHaveLength(0);
  });

  test("recreates the singleton when sessions indexing is added", () => {
    const root = makeTempDir();
    const workspace = makeWorkspace(root, "workspace", "Alpha project memory");
    const dbPath = join(root, "memory.db");

    const withoutSessions = getGlobalMemoryIndex(workspace, undefined, dbPath);
    const withSessions = getGlobalMemoryIndex(workspace, undefined, dbPath, join(root, "sessions"));

    expect(withSessions).not.toBe(withoutSessions);
  });
});
