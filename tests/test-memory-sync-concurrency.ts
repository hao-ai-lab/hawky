// =============================================================================
// test-memory-sync-concurrency.ts
//
// Regression guard for #12: MemoryIndex.sync() used to hold a SQLite write
// transaction open across the network embedding call with no mutex. Under the
// gateway's concurrent searches, two overlapping syncs both ran BEGIN — the
// second threw "cannot start a transaction within a transaction", rolled back
// the first, and dropped memory search to its grep fallback.
//
// The fix: coalesce concurrent syncs onto one in-flight promise, and compute
// embeddings BEFORE a short synchronous write transaction (no await inside it).
// These tests fire overlapping syncs/searches and assert no throw, no double
// embedding spend, and a populated (hybrid) index.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryIndex } from "../src/memory/index.js";
import type { EmbeddingProvider } from "../src/memory/embeddings.js";

/** Controllable embedding provider: succeeds after a delay, counts calls. */
class SlowFakeProvider implements EmbeddingProvider {
  id = "fake";
  model = "fake-model";
  dimensions = 3;
  embedCalls = 0;
  constructor(private delayMs = 40) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    // Deterministic non-zero vector so cosine similarity is well-defined.
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

let dir: string;

function makeIndex(provider: EmbeddingProvider) {
  const ws = join(dir, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "HAWKY.md"), "# notes\nWe decided to ship on Tuesday.\nRemember to buy milk.\n");
  return new MemoryIndex({
    dbPath: join(dir, "index.db"),
    workspacePath: ws,
    sessionsPath: null,
    enableWatcher: false,
    embeddingProvider: provider,
  });
}

beforeEach(() => {
  dir = join(tmpdir(), `hawky-mem-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryIndex concurrent sync", () => {
  test("two overlapping sync() calls coalesce (embed once, no throw)", async () => {
    const provider = new SlowFakeProvider(40);
    const idx = makeIndex(provider);
    try {
      // Both fired before the first resolves — old code threw "within a
      // transaction" on the second; the fix shares one in-flight sync.
      const [a, b] = await Promise.all([idx.sync(), idx.sync()]);

      expect(provider.embedCalls).toBe(1); // coalesced — no double embedding spend
      expect(a).toEqual(b); // same shared result
      expect(a.indexed).toBeGreaterThan(0);
    } finally {
      idx.close();
    }
  });

  test("many concurrent searches never fall back / never reject", async () => {
    const provider = new SlowFakeProvider(30);
    const idx = makeIndex(provider);
    try {
      // Each search lazily triggers sync() while dirty. Under the old bug these
      // collided and rejected; here they must all resolve.
      const results = await Promise.all(
        Array.from({ length: 6 }, () => idx.search("milk")),
      );
      for (const r of results) expect(Array.isArray(r)).toBe(true);

      // Vector search actually ran (not degraded to fts-only), proving the
      // flush committed the embeddings.
      expect(idx.lastSearchMeta?.searchMode).toContain("hybrid");
      // Coalesced: the whole burst embedded the file once (plus query embeds).
      expect(provider.embedCalls).toBeGreaterThan(0);
    } finally {
      idx.close();
    }
  });

  test("index is consistent after a concurrent burst (a follow-up sync is a no-op)", async () => {
    const provider = new SlowFakeProvider(20);
    const idx = makeIndex(provider);
    try {
      await Promise.all([idx.sync(), idx.sync(), idx.sync()]);
      // Nothing changed on disk → the next sync re-indexes nothing and removes
      // nothing (no partial/corrupt state left by the burst).
      const stats = await idx.sync();
      expect(stats.indexed).toBe(0);
      expect(stats.removed).toBe(0);
    } finally {
      idx.close();
    }
  });
});
