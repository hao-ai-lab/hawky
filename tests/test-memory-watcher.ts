// =============================================================================
// Memory Watcher Tests
//
// Regression guard for #9 — createMemoryWatcher previously received glob paths
// (e.g. "<ws>/*.md") from startWatcher(). chokidar v4+ dropped glob support, so
// those paths matched nothing and the watcher never fired. These tests write
// real files under a watched directory and assert the debounced onDirty runs,
// and that the path filter suppresses irrelevant files.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryWatcher, makeIgnored, type MemoryWatcher } from "../src/memory/watcher.js";
import { MemoryIndex } from "../src/memory/index.js";

let tempDir: string;
let watcher: MemoryWatcher | null = null;

async function pollFor(fn: () => Promise<boolean>, timeoutMs = 5000, stepMs = 150): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

beforeEach(() => {
  tempDir = join(tmpdir(), `hawky-mem-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  watcher?.close();
  watcher = null;
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("createMemoryWatcher fires on real file changes", () => {
  test("writing a top-level .md triggers onDirty", async () => {
    let dirty = false;
    // Short debounce so the test stays fast.
    watcher = createMemoryWatcher([tempDir], () => { dirty = true; }, undefined, 50);

    // Let chokidar finish its initial scan before writing (ignoreInitial: true).
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(tempDir, "HAWKY.md"), "# root memory\n");

    expect(await waitFor(() => dirty)).toBe(true);
  });

  test("filter suppresses irrelevant files but allows .md", async () => {
    let dirty = false;
    const filter = (p: string) => p.endsWith(".md");
    watcher = createMemoryWatcher([tempDir], () => { dirty = true; }, filter, 50);

    await new Promise((r) => setTimeout(r, 400));
    // A non-.md write must NOT flip dirty.
    writeFileSync(join(tempDir, "scratch.txt"), "ignore me\n");
    await new Promise((r) => setTimeout(r, 600));
    expect(dirty).toBe(false);

    // A .md write in the same directory must flip it.
    writeFileSync(join(tempDir, "notes.md"), "index me\n");
    expect(await waitFor(() => dirty)).toBe(true);
  });

  // Regression: the old ignore was /node_modules/ (unanchored substring), which
  // pruned a file whose name merely contains "node_modules".
  test("a .md whose name contains an ignored word still fires", async () => {
    let dirty = false;
    const filter = (p: string) => p.endsWith(".md");
    watcher = createMemoryWatcher([tempDir], () => { dirty = true; }, filter, 50);

    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(tempDir, "node_modules-notes.md"), "still index me\n");
    expect(await waitFor(() => dirty)).toBe(true);
  });

  // A real vendored directory nested under the root must still be ignored.
  test("a file inside a real node_modules/ dir is ignored", async () => {
    let dirty = false;
    const filter = (p: string) => p.endsWith(".md");
    watcher = createMemoryWatcher([tempDir], () => { dirty = true; }, filter, 50);

    await new Promise((r) => setTimeout(r, 400));
    const nm = join(tempDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "dep.md"), "vendored\n");

    // Past the debounce window — must NOT have fired.
    await new Promise((r) => setTimeout(r, 600));
    expect(dirty).toBe(false);
  });
});

// End-to-end through the real MemoryIndex: exercises the startWatcher()
// `dirname(p) === wsPath` branch (root .md) that the unit tests above don't
// cover, and proves a live edit becomes searchable — the exact behavior #9
// silently lost.
describe("MemoryIndex reindexes a live-edited root .md", () => {
  test("a top-level .md written after startup becomes searchable", async () => {
    const dbPath = join(tempDir, "index.db");
    const wsPath = join(tempDir, "workspace");
    mkdirSync(wsPath, { recursive: true });

    const idx = new MemoryIndex({
      workspacePath: wsPath,
      dbPath,
      sessionsPath: null,
      enableWatcher: true,
    });
    try {
      // First search clears the startup dirty flag (initial sync).
      await idx.search("warmup");
      // Let chokidar finish its initial scan (ignoreInitial: true).
      await new Promise((r) => setTimeout(r, 500));

      const marker = `zqxmarker${Math.random().toString(36).slice(2)}`;
      writeFileSync(join(wsPath, "PROBE.md"), `# probe\n${marker} lives here\n`);

      // The watcher (1500ms debounce) must flip dirty so the next search syncs
      // and indexes the new file. Poll until the marker is retrievable.
      const found = await pollFor(async () => {
        const results = await idx.search(marker);
        return results.some((r) => JSON.stringify(r).includes(marker));
      }, 6000);
      expect(found).toBe(true);
    } finally {
      idx.close();
    }
  });
});

// chokidar hands the `ignored` predicate a forward-slash-normalized path on
// every platform, while the watch roots use the native separator. makeIgnored
// must compare both as POSIX paths so vendored-dir pruning still works on
// Windows (where roots contain `\`). These assertions cover the `\` shape.
describe("makeIgnored is separator-agnostic (Windows paths)", () => {
  test("ignores vendored segments and preserves roots for both / and \\ inputs", () => {
    const posix = makeIgnored(["/ws/memory"]);
    expect(posix("/ws/memory/2026-07-09.md")).toBe(false); // real memory file
    expect(posix("/ws/memory/node_modules/dep.md")).toBe(true); // vendored
    expect(posix("/ws/memory")).toBe(false); // the root itself
    expect(posix("/ws/memory/node_modules-notes.md")).toBe(false); // substring, not a segment

    // Windows-style root + the forward-slash path chokidar would pass.
    const win = makeIgnored(["C:\\ws\\memory"]);
    expect(win("C:/ws/memory/2026-07-09.md")).toBe(false);
    expect(win("C:/ws/memory/node_modules/dep.md")).toBe(true);
    expect(win("C:/ws/memory")).toBe(false);
  });
});
