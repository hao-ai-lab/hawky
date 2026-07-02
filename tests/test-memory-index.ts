// =============================================================================
// Memory Index Tests
//
// Tests for the hybrid BM25 + vector search engine:
// schema, chunking, indexing, FTS search, hybrid merge, temporal decay, MMR.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createSchema } from "../src/memory/schema.js";
import { chunkMarkdown, hashText } from "../src/memory/chunker.js";
import { MemoryIndex, buildFtsQuery, bm25RankToScore, cosineSimilarity } from "../src/memory/index.js";
import { mergeHybridResults, applyTemporalDecay, applyMMR } from "../src/memory/hybrid.js";
import { resetConfigDir, setConfigDir } from "../src/storage/config.js";
import type { SearchResult } from "../src/memory/types.js";

// =============================================================================
// Helpers
// =============================================================================

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-memidx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeWorkspace(files: Record<string, string>): string {
  const wsDir = join(tempDir, "workspace");
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(join(wsDir, "memory"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(wsDir, name);
    mkdirSync(join(wsDir, name.includes("/") ? name.split("/").slice(0, -1).join("/") : ""), { recursive: true });
    writeFileSync(filePath, content);
  }
  return wsDir;
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  resetConfigDir();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
// Schema
// =============================================================================

describe("Schema", () => {
  test("creates all tables", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("meta");
    expect(names).toContain("files");
    expect(names).toContain("chunks");
    expect(names).toContain("embedding_cache");
    db.close();
  });

  test("creates FTS5 virtual table", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.some((t) => t.name === "chunks_fts")).toBe(true);
    db.close();
  });

  test("idempotent — re-run doesn't error", () => {
    const db = new Database(":memory:");
    createSchema(db);
    createSchema(db); // Should not throw
    db.close();
  });
});

// =============================================================================
// Chunker
// =============================================================================

describe("Chunker", () => {
  test("short text produces single chunk", () => {
    const chunks = chunkMarkdown("hello world");
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe("hello world");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  test("multi-line text within limit produces single chunk", () => {
    const text = "line 1\nline 2\nline 3";
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });

  test("long text produces multiple chunks", () => {
    const text = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: some content here that fills up space`).join("\n");
    const chunks = chunkMarkdown(text, { tokens: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunks have correct line numbers", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join("\n");
    const chunks = chunkMarkdown(text, { tokens: 20, overlap: 5 });

    // First chunk starts at line 1
    expect(chunks[0].startLine).toBe(1);
    // Last chunk ends at last line
    expect(chunks[chunks.length - 1].endLine).toBe(50);
  });

  test("overlap carries text from previous chunk", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: content`).join("\n");
    const chunks = chunkMarkdown(text, { tokens: 30, overlap: 10 });

    if (chunks.length >= 2) {
      // Second chunk should include some lines from the end of first chunk
      const firstEnd = chunks[0].endLine;
      const secondStart = chunks[1].startLine;
      expect(secondStart).toBeLessThanOrEqual(firstEnd);
    }
  });

  test("empty text produces empty array", () => {
    expect(chunkMarkdown("").length).toBe(0);
    expect(chunkMarkdown("   ").length).toBe(0);
    expect(chunkMarkdown("\n\n").length).toBe(0);
  });

  test("hash is computed for each chunk", () => {
    const chunks = chunkMarkdown("hello\nworld");
    expect(chunks[0].hash).toBeTruthy();
    expect(chunks[0].hash.length).toBe(16);
  });

  test("different text produces different hashes", () => {
    expect(hashText("hello")).not.toBe(hashText("world"));
  });

  test("same text produces same hash", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
  });
});

// =============================================================================
// FTS Query Building
// =============================================================================

describe("buildFtsQuery", () => {
  test("builds AND query from words", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
  });

  test("returns null for empty input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
  });

  test("handles special characters", () => {
    expect(buildFtsQuery("user's data")).toBe('"user" AND "s" AND "data"');
  });

  test("strips quotes from tokens", () => {
    const result = buildFtsQuery('find "this"');
    expect(result).not.toContain('""');
  });
});

// =============================================================================
// BM25 Score Conversion
// =============================================================================

describe("bm25RankToScore", () => {
  test("more negative rank = more relevant = higher score", () => {
    // FTS5 returns negative ranks: more negative = more relevant
    expect(bm25RankToScore(-10)).toBeGreaterThan(bm25RankToScore(-2));
    expect(bm25RankToScore(-2)).toBeGreaterThan(bm25RankToScore(-0.5));
  });

  test("score is between 0 and 1", () => {
    expect(bm25RankToScore(-10)).toBeLessThanOrEqual(1);
    expect(bm25RankToScore(-10)).toBeGreaterThan(0);
    expect(bm25RankToScore(-0.1)).toBeGreaterThan(0);
    expect(bm25RankToScore(-0.1)).toBeLessThanOrEqual(1);
  });

  test("highly relevant results score well above minScore threshold", () => {
    // rank=-10 should score ~0.909, not 0.091
    expect(bm25RankToScore(-10)).toBeGreaterThan(0.8);
    // rank=-2 should score ~0.667, not 0.333
    expect(bm25RankToScore(-2)).toBeGreaterThan(0.5);
  });

  test("non-finite rank produces near-zero score", () => {
    expect(bm25RankToScore(NaN)).toBeLessThan(0.01);
    expect(bm25RankToScore(Infinity)).toBeLessThan(0.01);
  });
});

// =============================================================================
// Cosine Similarity
// =============================================================================

describe("cosineSimilarity", () => {
  test("identical vectors = 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });

  test("orthogonal vectors = 0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  test("opposite vectors = -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  test("empty vectors = 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// =============================================================================
// Hybrid Merge
// =============================================================================

describe("Hybrid merge", () => {
  test("combines vector and text scores", () => {
    const vec = [{ id: "a", path: "f.md", startLine: 1, endLine: 2, snippet: "hello", source: "memory" as const, vectorScore: 0.9, textScore: 0 }];
    const kw = [{ id: "a", path: "f.md", startLine: 1, endLine: 2, snippet: "hello", source: "memory" as const, vectorScore: 0, textScore: 0.8 }];
    const results = mergeHybridResults(vec, kw, 0.7, 0.3);
    expect(results.length).toBe(1);
    expect(results[0].score).toBeCloseTo(0.7 * 0.9 + 0.3 * 0.8, 5);
  });

  test("includes results from both sources", () => {
    const vec = [{ id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "vec", source: "memory" as const, vectorScore: 0.9, textScore: 0 }];
    const kw = [{ id: "b", path: "b.md", startLine: 1, endLine: 1, snippet: "kw", source: "memory" as const, vectorScore: 0, textScore: 0.8 }];
    const results = mergeHybridResults(vec, kw, 0.7, 0.3);
    expect(results.length).toBe(2);
  });

  test("sorted by score descending", () => {
    const vec = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "low", source: "memory" as const, vectorScore: 0.3, textScore: 0 },
      { id: "b", path: "b.md", startLine: 1, endLine: 1, snippet: "high", source: "memory" as const, vectorScore: 0.9, textScore: 0 },
    ];
    const results = mergeHybridResults(vec, [], 0.7, 0.3);
    expect(results[0].snippet).toBe("high");
  });
});

// =============================================================================
// Temporal Decay
// =============================================================================

describe("Temporal decay", () => {
  test("recent files score higher than old files", () => {
    const now = Date.now();
    const results: SearchResult[] = [
      { path: "memory/2026-03-19.md", startLine: 1, endLine: 1, score: 1.0, snippet: "today", source: "memory" },
      { path: "memory/2025-01-01.md", startLine: 1, endLine: 1, score: 1.0, snippet: "old", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30, now);
    expect(decayed[0].score).toBeGreaterThan(decayed[1].score);
  });

  test("non-dated files are not decayed", () => {
    const results: SearchResult[] = [
      { path: "MEMORY.md", startLine: 1, endLine: 1, score: 1.0, snippet: "evergreen", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30);
    expect(decayed[0].score).toBe(1.0);
  });

  test("halfLife=30 means 50% at 30 days", () => {
    const now = new Date("2026-03-19").getTime();
    const results: SearchResult[] = [
      { path: "memory/2026-02-17.md", startLine: 1, endLine: 1, score: 1.0, snippet: "30 days ago", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30, now);
    expect(decayed[0].score).toBeCloseTo(0.5, 1);
  });
});

// =============================================================================
// MMR
// =============================================================================

describe("MMR", () => {
  test("reduces duplicate snippets", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "the quick brown fox jumps", source: "memory" },
      { path: "a.md", startLine: 2, endLine: 2, score: 0.95, snippet: "the quick brown fox leaps", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.9, snippet: "completely different topic here", source: "memory" },
    ];
    const mmr = applyMMR(results, 0.7);
    // The diverse result should be ranked higher than the near-duplicate
    expect(mmr.length).toBe(3);
    // First should be highest score
    expect(mmr[0].snippet).toContain("fox jumps");
  });

  test("single result returned unchanged", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "only one", source: "memory" },
    ];
    expect(applyMMR(results, 0.7)).toEqual(results);
  });

  test("empty results returned unchanged", () => {
    expect(applyMMR([], 0.7)).toEqual([]);
  });
});

// =============================================================================
// MemoryIndex — Integration
// =============================================================================

describe("MemoryIndex — sync and FTS search", () => {
  test("uses the configured Hawky root for default DB and workspace paths", () => {
    const hawkyRoot = join(tempDir, "hawky-home");
    const workspaceDir = join(hawkyRoot, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    setConfigDir(hawkyRoot);

    const index = new MemoryIndex({ enableWatcher: false });

    try {
      expect(existsSync(join(hawkyRoot, "state", "memory.db"))).toBe(true);
      expect(index["workspacePath"]).toBe(workspaceDir);
    } finally {
      index.close();
    }
  });

  test("indexes workspace files and searches with FTS", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "# Memory\n\nFavorite color: blue\nFavorite food: pizza\n",
      "memory/2026-03-19.md": "# 2026-03-19\n\nMet with Alice about project X\nDiscussed timeline\n",
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const stats = await index.sync();
      expect(stats.indexed).toBe(2);
      expect(stats.skipped).toBe(0);

      // FTS search
      const results = await index.search("blue");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe("MEMORY.md");
      expect(results[0].snippet).toContain("blue");
    } finally {
      index.close();
    }
  });

  test("skips memory symlinks that escape the workspace", async () => {
    const wsDir = makeWorkspace({});
    const outside = join(tempDir, "outside.md");
    writeFileSync(outside, "outside-search-secret", "utf-8");
    symlinkSync(outside, join(wsDir, "memory", "linked.md"));

    const index = new MemoryIndex({
      dbPath: join(tempDir, "test.db"),
      workspacePath: wsDir,
      enableWatcher: false,
    });

    try {
      await index.sync();
      const results = await index.search("outside-search-secret");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("incremental sync skips unchanged files", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "Some content here",
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const stats1 = await index.sync();
      expect(stats1.indexed).toBe(1);

      // Sync again without changes
      index.markDirty();
      const stats2 = await index.sync();
      expect(stats2.indexed).toBe(0);
      expect(stats2.skipped).toBe(1);
    } finally {
      index.close();
    }
  });

  test("re-indexes when file content changes", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "Original content",
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      await index.sync();

      // Search original
      let results = await index.search("Original");
      expect(results.length).toBeGreaterThan(0);

      // Modify file
      writeFileSync(join(wsDir, "MEMORY.md"), "Updated new content");
      index.markDirty();
      await index.sync();

      // Search new content
      results = await index.search("Updated");
      expect(results.length).toBeGreaterThan(0);

      // Old content should not be found
      results = await index.search("Original");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("removes deleted files from index", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "Keep this",
      "memory/2026-03-18.md": "Delete this later",
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      await index.sync();
      let results = await index.search("Delete");
      expect(results.length).toBeGreaterThan(0);

      // Delete file
      rmSync(join(wsDir, "memory", "2026-03-18.md"));
      index.markDirty();
      await index.sync();

      results = await index.search("Delete");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("search returns empty for no matches", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "hello world",
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const results = await index.search("xyznonsense");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("search respects maxResults", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Match item ${i + 1}`).join("\n");
    const wsDir = makeWorkspace({
      "MEMORY.md": lines,
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const results = await index.search("Match item", { maxResults: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    } finally {
      index.close();
    }
  });

  test("searches across multiple files", async () => {
    const wsDir = makeWorkspace({
      "MEMORY.md": "TypeScript is great",
      "memory/2026-03-19.md": "TypeScript migration discussed",
    });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const results = await index.search("TypeScript");
      expect(results.length).toBe(2);
      const paths = results.map((r) => r.path);
      expect(paths).toContain("MEMORY.md");
      expect(paths).toContain("memory/2026-03-19.md");
    } finally {
      index.close();
    }
  });
});

// =============================================================================
// MemoryIndex — empty workspace
// =============================================================================

describe("MemoryIndex — edge cases", () => {
  test("empty workspace returns no results", async () => {
    const wsDir = join(tempDir, "empty-ws");
    mkdirSync(wsDir, { recursive: true });

    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const results = await index.search("anything");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });

  test("nonexistent workspace doesn't crash", async () => {
    const wsDir = join(tempDir, "nonexistent");
    const dbPath = join(tempDir, "test.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const results = await index.search("anything");
      expect(results.length).toBe(0);
    } finally {
      index.close();
    }
  });
});

// =============================================================================
// Performance
// =============================================================================

describe("Performance", () => {
  test("indexing 50 files completes in <2s", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      files[`memory/note-${i}.md`] = `# Note ${i}\n\nSome content for note number ${i}. This has multiple lines.\nLine 2 of note ${i}.\nLine 3 with more words.`;
    }
    const wsDir = makeWorkspace(files);

    const dbPath = join(tempDir, "perf.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      const start = Date.now();
      await index.sync();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    } finally {
      index.close();
    }
  });

  test("FTS search completes in <100ms", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      files[`memory/note-${i}.md`] = `# Note ${i}\n\nContent about topic ${i}. Important details here.\n`;
    }
    const wsDir = makeWorkspace(files);

    const dbPath = join(tempDir, "perf.db");
    const index = new MemoryIndex({ dbPath, workspacePath: wsDir, enableWatcher: false });

    try {
      await index.sync();
      const start = Date.now();
      await index.search("Important details");
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    } finally {
      index.close();
    }
  });
});

// =============================================================================
// Comprehensive correctness tests (audit-driven)
// =============================================================================

describe("BM25 correctness", () => {
  test("more negative FTS5 rank = higher score (monotonicity)", () => {
    // FTS5 returns negative ranks; more negative = more relevant
    const scores = [-0.1, -0.5, -1, -2, -5, -10, -50].map(bm25RankToScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  test("score is always in (0, 1] for negative ranks", () => {
    for (const rank of [-0.001, -0.1, -1, -10, -100, -10000]) {
      const s = bm25RankToScore(rank);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("highly relevant result (rank=-10) scores above 0.9", () => {
    expect(bm25RankToScore(-10)).toBeGreaterThan(0.9);
  });

  test("weakly relevant result (rank=-0.1) scores below 0.15", () => {
    expect(bm25RankToScore(-0.1)).toBeLessThan(0.15);
  });

  test("NaN and Infinity produce near-zero score", () => {
    expect(bm25RankToScore(NaN)).toBeLessThan(0.01);
    expect(bm25RankToScore(Infinity)).toBeLessThan(0.01);
    expect(bm25RankToScore(-Infinity)).toBeLessThan(0.01);
  });

  test("rank=0 returns 1.0 (perfect match boundary)", () => {
    expect(bm25RankToScore(0)).toBe(1);
  });
});

describe("Temporal decay correctness", () => {
  test("session files are NOT decayed", () => {
    const results: SearchResult[] = [
      { path: "sessions/tui/main.jsonl", startLine: 1, endLine: 1, score: 1.0, snippet: "session", source: "sessions" },
    ];
    const decayed = applyTemporalDecay(results, 30);
    expect(decayed[0].score).toBe(1.0); // No decay applied
  });

  test("paths with dates outside memory/ are NOT decayed", () => {
    const results: SearchResult[] = [
      { path: "sessions/2026-04-12/chat.jsonl", startLine: 1, endLine: 1, score: 1.0, snippet: "a", source: "sessions" },
      { path: "notes-2026-04-12.md", startLine: 1, endLine: 1, score: 1.0, snippet: "b", source: "memory" },
      { path: "2026-04-12.md", startLine: 1, endLine: 1, score: 1.0, snippet: "c", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30);
    for (const r of decayed) {
      expect(r.score).toBe(1.0); // None matched the anchored pattern
    }
  });

  test("only memory/YYYY-MM-DD.md paths are decayed", () => {
    const now = new Date("2026-04-13").getTime();
    const results: SearchResult[] = [
      { path: "memory/2026-03-13.md", startLine: 1, endLine: 1, score: 1.0, snippet: "old", source: "memory" },
      { path: "MEMORY.md", startLine: 1, endLine: 1, score: 1.0, snippet: "evergreen", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30, now);
    expect(decayed[0].score).toBeCloseTo(0.5, 1); // 30 days old, half-life=30
    expect(decayed[1].score).toBe(1.0); // Evergreen
  });

  test("invalid dates are NOT decayed (no NaN scores)", () => {
    const results: SearchResult[] = [
      { path: "memory/2026-13-45.md", startLine: 1, endLine: 1, score: 1.0, snippet: "invalid", source: "memory" },
      { path: "memory/2026-02-30.md", startLine: 1, endLine: 1, score: 1.0, snippet: "feb30", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30);
    for (const r of decayed) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBe(1.0); // Invalid dates treated as evergreen
    }
  });

  test("future-dated files are NOT penalized", () => {
    const now = new Date("2026-04-13").getTime();
    const results: SearchResult[] = [
      { path: "memory/2026-05-01.md", startLine: 1, endLine: 1, score: 1.0, snippet: "future", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 30, now);
    expect(decayed[0].score).toBe(1.0); // ageDays clamped to 0
  });

  test("halfLifeDays=0 returns results unchanged", () => {
    const results: SearchResult[] = [
      { path: "memory/2020-01-01.md", startLine: 1, endLine: 1, score: 1.0, snippet: "ancient", source: "memory" },
    ];
    const decayed = applyTemporalDecay(results, 0);
    expect(decayed[0].score).toBe(1.0);
  });
});

describe("MMR correctness", () => {
  test("diverse result ranked above near-duplicate when scores are close", () => {
    // Scores must be close enough that diversity penalty overcomes relevance gap
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "the quick brown fox jumps over the lazy dog", source: "memory" },
      { path: "a.md", startLine: 5, endLine: 5, score: 0.92, snippet: "the quick brown fox leaps over the lazy dog", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.90, snippet: "quantum computing uses qubits for parallel processing", source: "memory" },
    ];
    const mmr = applyMMR(results, 0.5); // λ=0.5: equal weight relevance/diversity
    expect(mmr[0].snippet).toContain("jumps"); // Highest score first
    expect(mmr[1].snippet).toContain("quantum"); // Diverse > near-duplicate
    expect(mmr[2].snippet).toContain("leaps"); // Near-duplicate last
  });

  test("lambda=1 gives pure relevance ranking (no diversity)", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "same words here", source: "memory" },
      { path: "a.md", startLine: 2, endLine: 2, score: 0.9, snippet: "same words here", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.5, snippet: "different content", source: "memory" },
    ];
    const mmr = applyMMR(results, 1.0);
    // With lambda=1, similarity penalty is 0 — pure score ordering
    expect(mmr[0].score).toBe(1.0);
    expect(mmr[1].score).toBe(0.9);
    expect(mmr[2].score).toBe(0.5);
  });

  test("lambda=0 gives pure diversity (no relevance)", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "same words identical", source: "memory" },
      { path: "a.md", startLine: 2, endLine: 2, score: 0.9, snippet: "same words identical", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.1, snippet: "unique topic here", source: "memory" },
    ];
    const mmr = applyMMR(results, 0.0);
    // After first pick, identical snippets are maximally penalized
    // Second pick should be the unique one despite low score
    expect(mmr[1].snippet).toContain("unique");
  });

  test("all identical scores uses tiebreaker", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 0.5, snippet: "alpha content here", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.5, snippet: "beta content here", source: "memory" },
      { path: "c.md", startLine: 1, endLine: 1, score: 0.5, snippet: "gamma content here", source: "memory" },
    ];
    const mmr = applyMMR(results, 0.7);
    expect(mmr.length).toBe(3);
  });

  test("CJK text is tokenized for diversity", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "今天天气很好心情也好", source: "memory" },
      { path: "a.md", startLine: 2, endLine: 2, score: 0.95, snippet: "今天天气很好出去走走", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.92, snippet: "量子计算使用量子比特", source: "memory" },
    ];
    const mmr = applyMMR(results, 0.5); // λ=0.5: balance relevance/diversity
    // CJK tokens should detect overlap between first two results
    // Third result (different topic) should rank above the near-duplicate
    expect(mmr[1].snippet).toContain("量子");
  });

  test("lambda out of range is clamped", () => {
    const results: SearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 1, score: 1.0, snippet: "first", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 1, score: 0.5, snippet: "second", source: "memory" },
    ];
    // Should not crash with invalid lambda
    expect(applyMMR(results, -5).length).toBe(2);
    expect(applyMMR(results, 10).length).toBe(2);
  });
});

describe("Hybrid merge correctness", () => {
  test("score = vectorWeight * vecScore + textWeight * textScore", () => {
    const vector = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "text", source: "memory" as const, vectorScore: 0.8, textScore: 0 },
    ];
    const keyword = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "text", source: "memory" as const, vectorScore: 0, textScore: 0.6 },
    ];
    const merged = mergeHybridResults(vector, keyword, 0.7, 0.3);
    expect(merged[0].score).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.6, 5);
  });

  test("vector-only result gets zero text score", () => {
    const vector = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "text", source: "memory" as const, vectorScore: 0.9, textScore: 0 },
    ];
    const merged = mergeHybridResults(vector, [], 0.7, 0.3);
    expect(merged[0].score).toBeCloseTo(0.7 * 0.9, 5);
  });

  test("keyword-only result gets zero vector score", () => {
    const keyword = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "text", source: "memory" as const, vectorScore: 0, textScore: 0.8 },
    ];
    const merged = mergeHybridResults([], keyword, 0.7, 0.3);
    expect(merged[0].score).toBeCloseTo(0.3 * 0.8, 5);
  });

  test("results sorted by score descending", () => {
    const vector = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, snippet: "low", source: "memory" as const, vectorScore: 0.3, textScore: 0 },
      { id: "b", path: "b.md", startLine: 1, endLine: 1, snippet: "high", source: "memory" as const, vectorScore: 0.9, textScore: 0 },
    ];
    const merged = mergeHybridResults(vector, [], 0.7, 0.3);
    expect(merged[0].snippet).toBe("high");
    expect(merged[1].snippet).toBe("low");
  });
});
