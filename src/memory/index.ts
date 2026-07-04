// =============================================================================
// Memory Index
//
// Core memory search engine. Manages:
// - SQLite database with FTS5 + optional vector embeddings
// - File sync (incremental, hash-based change detection)
// - Hybrid search (vector cosine similarity + BM25 keyword)
// - Temporal decay + MMR diversity re-ranking
// - File watcher integration (lazy sync on next search)
//
// Matches a proven MemoryIndexManager architecture.
// =============================================================================

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { createSubsystemLogger } from "../logging/index.js";
import { getConfigDir } from "../storage/config.js";
import { createSchema, setMeta, getMeta } from "./schema.js";
import { chunkMarkdown, hashText } from "./chunker.js";
import {
  detectEmbeddingProvider,
  getCachedEmbeddings,
  setCachedEmbeddings,
  type EmbeddingProvider,
} from "./embeddings.js";
import { mergeHybridResults, applyTemporalDecay, applyMMR, type HybridResult } from "./hybrid.js";
import { createMemoryWatcher, type MemoryWatcher } from "./watcher.js";
import { extractSessionText } from "./session-extract.js";
import { extractMemoryAppendJsonlText } from "./append-jsonl-extract.js";
import { isRealPathInsideRoot } from "./path-security.js";
import {
  type SearchResult,
  type SearchConfig,
  type ChunkRow,
  type MemoryChunk,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_CHUNK_CONFIG,
  SNIPPET_MAX_CHARS,
} from "./types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const log = createSubsystemLogger("memory/index");

function defaultDbPath(): string {
  return join(getConfigDir(), "state", "memory.db");
}

function defaultWorkspacePath(): string {
  return join(getConfigDir(), "workspace");
}

/** Result of a sync pass. */
interface SyncStats {
  indexed: number;
  skipped: number;
  removed: number;
}

/**
 * A changed file, read + chunked + embedded in the async prepare phase, ready
 * to be written synchronously in the flush transaction. `chunks: []` marks an
 * empty/tracked-only file (refresh the files row, write no chunks).
 */
interface FilePlan {
  file: WorkspaceFile;
  chunks: MemoryChunk[];
  embeddings: number[][] | null;
  model: string;
}

// -----------------------------------------------------------------------------
// Memory Index
// -----------------------------------------------------------------------------

export class MemoryIndex {
  private db: Database;
  private provider: EmbeddingProvider | null;
  private openaiApiKey?: string;
  private workspacePath: string;
  private sessionsPath: string | null;
  private sessionIndexWindowMs: number;
  private dirty = true; // Start dirty to trigger initial sync
  private lastSyncAt = 0; // Timestamp of last sync (for stale session expiry)
  private watcher: MemoryWatcher | null = null;
  private config: SearchConfig;
  private chunkConfig: typeof DEFAULT_CHUNK_CONFIG;
  /** In-flight sync, so concurrent callers coalesce instead of colliding. */
  private syncInFlight: Promise<SyncStats> | null = null;
  /** True when an explicit embeddingProvider was injected (skip env re-detect). */
  private providerOverride = false;

  constructor(options?: {
    dbPath?: string;
    workspacePath?: string;
    /** Path to sessions directory (e.g., ~/.hawky/sessions). Null disables session indexing. */
    sessionsPath?: string | null;
    /** Number of days of sessions to index (default: 30). */
    sessionIndexWindowDays?: number;
    config?: Partial<SearchConfig>;
    chunkConfig?: Partial<typeof DEFAULT_CHUNK_CONFIG>;
    enableWatcher?: boolean;
    /** OpenAI API key from config (fallback if OPENAI_API_KEY env not set) */
    openaiApiKey?: string;
    /**
     * Inject an embedding provider directly (for tests). When set (including
     * `null` to force FTS-only), the env/config re-detection is skipped so the
     * injected provider is authoritative.
     */
    embeddingProvider?: EmbeddingProvider | null;
  }) {
    const dbPath = options?.dbPath ?? defaultDbPath();
    this.workspacePath = options?.workspacePath ?? defaultWorkspacePath();
    this.sessionsPath = options?.sessionsPath ?? null;
    this.sessionIndexWindowMs = (options?.sessionIndexWindowDays ?? 30) * 86_400_000;
    this.config = { ...DEFAULT_SEARCH_CONFIG, ...options?.config };
    this.chunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...options?.chunkConfig };

    // Ensure DB directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    // Open database
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    createSchema(this.db);

    // Detect embedding provider (env var → config key → FTS-only), unless one
    // was injected explicitly (tests).
    this.openaiApiKey = options?.openaiApiKey;
    if (options?.embeddingProvider !== undefined) {
      this.provider = options.embeddingProvider;
      this.providerOverride = true;
    } else {
      this.provider = detectEmbeddingProvider(this.openaiApiKey);
    }

    // Check if full reindex needed (model/config changed)
    this.checkReindexNeeded();

    // Mark dirty on creation so the first search triggers a full sync.
    // Without this, newly created files aren't indexed until the watcher fires.
    this.dirty = true;

    // Start file watcher
    if (options?.enableWatcher !== false) {
      this.startWatcher();
    }
  }

  /** Mark index as dirty (files changed). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Whether an embedding provider is configured. */
  hasEmbeddingProvider(): boolean {
    return this.provider !== null;
  }

  /** Whether a sessions path is configured. */
  hasSessionsPath(): boolean {
    return this.sessionsPath !== null;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Sync workspace files to the index. Only re-indexes changed files.
   *
   * Concurrent callers coalesce onto a single in-flight sync. Previously two
   * overlapping syncs (e.g. from the gateway's concurrent searches) each ran
   * `BEGIN`, and the second threw "cannot start a transaction within a
   * transaction" — which rolled back the first and dropped memory search to its
   * grep fallback. Coalescing also avoids paying the embedding API twice.
   */
  async sync(): Promise<SyncStats> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this._doSync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async _doSync(): Promise<SyncStats> {
    const files = this.listWorkspaceFiles();
    const activePaths = new Set(files.map((f) => f.relPath));
    let skipped = 0;

    // Phase 1 — prepare (async: read files + embed over the network). NO write
    // transaction is open here, so the SQLite write lock is never held across
    // network I/O and concurrent DB access can't collide with an open BEGIN.
    const plans: FilePlan[] = [];
    for (const file of files) {
      const existing = this.db.query("SELECT hash FROM files WHERE path = ?").get(file.relPath) as
        | { hash: string }
        | null;
      if (existing?.hash === file.hash) {
        skipped++;
        continue;
      }
      plans.push(await this.prepareFile(file));
    }

    // Phase 2 — flush (synchronous, atomic). No `await` inside, so the event
    // loop cannot switch mid-transaction. `db.transaction()` handles
    // BEGIN/COMMIT/ROLLBACK (matches src/gateway/adapters/slack-directory.ts).
    const model = this.provider?.model ?? "fts-only";
    const flush = this.db.transaction((): number => {
      for (const plan of plans) this.flushFile(plan);

      // Remove stale entries (files that no longer exist on disk).
      const allPaths = (
        this.db.query("SELECT path FROM files").all() as Array<{ path: string }>
      ).map((r) => r.path);
      let removed = 0;
      for (const path of allPaths) {
        if (!activePaths.has(path)) {
          this.removeFile(path);
          removed++;
        }
      }

      setMeta(this.db, "model", model);
      setMeta(this.db, "provider", this.provider?.id ?? "none");
      setMeta(this.db, "chunkTokens", String(this.chunkConfig.tokens));
      setMeta(this.db, "chunkOverlap", String(this.chunkConfig.overlap));
      return removed;
    });
    const removed = flush();

    this.dirty = false;
    this.lastSyncAt = Date.now();
    return { indexed: plans.length, skipped, removed };
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /** Metadata about the last search (for observability). */
  lastSearchMeta: SearchMeta | null = null;

  /** Search memory with hybrid BM25 + vector matching. */
  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number },
  ): Promise<SearchResult[]> {
    // Re-check embedding provider on every search (cheap — just reads env/config).
    // If user added OPENAI_API_KEY mid-session, we pick it up and trigger reindex.
    // Skipped when a provider was injected explicitly (tests).
    if (!this.providerOverride) {
      const newProvider = detectEmbeddingProvider(this.openaiApiKey);
      const currentModel = newProvider?.model ?? "fts-only";
      const previousModel = this.provider?.model ?? "fts-only";
      if (currentModel !== previousModel) {
        this.provider = newProvider;
        this.checkReindexNeeded(); // Clears DB + sets dirty if model changed
      }
    }

    const meta: SearchMeta = {
      synced: false,
      syncStats: null,
      searchMode: "fts-only",
      ftsResults: 0,
      vectorResults: 0,
      totalChunks: 0,
      embeddingProvider: this.provider?.id ?? null,
      embeddingModel: this.provider?.model ?? null,
    };

    // Time-based re-sync: if sessions are indexed and last sync was >24h ago,
    // mark dirty to expire sessions that have aged past the 30-day window.
    if (this.sessionsPath && this.lastSyncAt > 0 && Date.now() - this.lastSyncAt > 86_400_000) {
      this.dirty = true;
    }

    // Lazy sync if dirty
    if (this.dirty) {
      const stats = await this.sync();
      meta.synced = true;
      meta.syncStats = stats;
    }

    // Count total chunks in index
    const countRow = this.db.query("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    meta.totalChunks = countRow.cnt;

    const maxResults = options?.maxResults ?? this.config.maxResults;
    const minScore = options?.minScore ?? this.config.minScore;
    const candidateLimit = maxResults * 4; // Fetch more for reranking

    // FTS (BM25) search
    const keywordResults = this.searchKeyword(query, candidateLimit);
    meta.ftsResults = keywordResults.length;

    // Vector search (if embeddings available)
    let vectorResults: HybridResult[] = [];
    if (this.provider) {
      try {
        vectorResults = await this.searchVector(query, candidateLimit);
        meta.vectorResults = vectorResults.length;
        meta.searchMode = "hybrid";
      } catch (err) {
        log.warn("vector search failed, falling back to FTS-only", {
          error: err instanceof Error ? err.message : String(err),
        });
        meta.searchMode = "fts-only (vector failed)";
      }
    }

    this.lastSearchMeta = meta;

    // Merge
    let results: SearchResult[];
    if (vectorResults.length > 0) {
      results = mergeHybridResults(
        vectorResults,
        keywordResults,
        this.config.vectorWeight,
        this.config.textWeight,
      );
    } else {
      // FTS-only mode — normalize scores within the result set.
      // BM25 rank magnitude is corpus-dependent (tiny corpus → ranks near zero),
      // so raw scores can fall below minScore even for valid matches.
      // Normalization ensures ranking is preserved regardless of corpus size.
      // This only applies in FTS-only mode; in hybrid mode, raw BM25 scores
      // participate in the weighted merge with vector scores (no distortion).
      const maxText = Math.max(...keywordResults.map((r) => r.textScore));
      results = keywordResults.map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: maxText > 0 ? r.textScore / maxText : r.textScore,
        snippet: r.snippet,
        source: r.source,
      }));
    }

    // Apply the relevance threshold before temporal decay. Decay should affect
    // ranking of dated daily logs, not discard exact keyword matches solely
    // because the entry is old.
    results = results.filter((r) => r.score >= minScore);

    // Apply temporal decay
    if (this.config.temporalDecay.enabled) {
      results = applyTemporalDecay(results, this.config.temporalDecay.halfLifeDays);
      results.sort((a, b) => b.score - a.score);
    }

    // Apply MMR diversity
    if (this.config.mmr.enabled && results.length > 1) {
      results = applyMMR(results, this.config.mmr.lambda);
    }

    // Filter out expired session results at query time (exact cutoff enforcement).
    // Only stat-checks matched session files, not all indexed sessions.
    if (this.sessionsPath) {
      const cutoff = Date.now() - this.sessionIndexWindowMs;
      results = results.filter((r) => {
        if (r.source !== "sessions") return true;
        try {
          const absPath = join(this.sessionsPath!, r.path.slice("sessions/".length));
          return statSync(absPath).mtimeMs >= cutoff;
        } catch {
          return false; // File deleted — exclude
        }
      });
    }

    return results.slice(0, maxResults);
  }

  /** Close database and watcher. */
  close(): void {
    this.watcher?.close();
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // FTS (BM25) Search
  // ---------------------------------------------------------------------------

  private searchKeyword(query: string, limit: number): HybridResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    try {
      const rows = this.db
        .query(
          `SELECT id, path, source, start_line, end_line, text,
                  bm25(chunks_fts) AS rank
             FROM chunks_fts
            WHERE chunks_fts MATCH ?
            ORDER BY rank ASC
            LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{
        id: string;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        rank: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
        source: row.source as "memory" | "sessions",
        vectorScore: 0,
        textScore: bm25RankToScore(row.rank),
      }));
    } catch (err) {
      log.warn("FTS keyword search failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Vector Search (in-memory cosine similarity)
  // ---------------------------------------------------------------------------

  private async searchVector(query: string, limit: number): Promise<HybridResult[]> {
    if (!this.provider) return [];

    // Embed the query
    const [queryVec] = await this.provider.embed([query]);
    if (!queryVec || queryVec.length === 0) return [];

    // TODO: This loads ALL chunk embeddings into memory and computes cosine similarity
    // in JS. Acceptable for typical workspaces (~hundreds of chunks), but for very large
    // workspaces (thousands of daily logs), consider pagination or pre-filtering by FTS
    // candidates. Long-term: switch to sqlite-vec when Bun supports loadExtension().
    // Load all chunks with embeddings
    const model = this.provider.model;
    const rows = this.db
      .query("SELECT id, path, source, start_line, end_line, text, embedding FROM chunks WHERE model = ?")
      .all(model) as ChunkRow[];

    // Compute cosine similarity
    const scored = rows
      .map((row) => {
        let embedding: number[];
        try {
          embedding = JSON.parse(row.embedding);
        } catch {
          return null;
        }
        if (!embedding || embedding.length === 0) return null;

        const score = cosineSimilarity(queryVec, embedding);
        if (!Number.isFinite(score)) return null;

        return {
          id: row.id,
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
          source: row.source as "memory" | "sessions",
          vectorScore: score,
          textScore: 0,
        };
      })
      .filter((r): r is HybridResult => r !== null);

    return scored.sort((a, b) => b.vectorScore - a.vectorScore).slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  /**
   * Phase 1: read + chunk + embed a changed file, WITHOUT touching the write
   * transaction. All network/file I/O (extractSessionText, provider.embed via
   * embedChunks) happens here; the returned plan is flushed synchronously later.
   */
  private async prepareFile(file: WorkspaceFile): Promise<FilePlan> {
    const model = this.provider?.model ?? "fts-only";

    let text: string;
    if (file.source === "sessions") {
      const result = await extractSessionText(file.absPath);
      // Track the file even if empty (prevents re-indexing on every sync).
      if (result.messageCount === 0) return { file, chunks: [], embeddings: null, model };
      text = result.text;
    } else if (file.relPath.startsWith("memory/") && file.relPath.endsWith(".jsonl")) {
      const result = extractMemoryAppendJsonlText(file.absPath);
      // Track the file even if empty/malformed so unchanged files are skipped.
      if (result.entryCount === 0) return { file, chunks: [], embeddings: null, model };
      text = result.text;
    } else {
      text = readFileSync(file.absPath, "utf-8");
    }

    const chunks = chunkMarkdown(text, this.chunkConfig);
    const embeddings = await this.embedChunks(file, chunks, model);
    return { file, chunks, embeddings, model };
  }

  /**
   * Phase 2: write a prepared file to the DB. SYNCHRONOUS — no `await` — so it
   * is safe to run inside `db.transaction()`. Empty plans (chunks: []) still
   * refresh the files-table row so an unchanged file is skipped next sync.
   */
  private flushFile(plan: FilePlan): void {
    const { file, chunks, embeddings, model } = plan;
    const now = Date.now();

    this.removeFile(file.relPath);

    const insertChunk = this.db.query(
      "INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertFts = this.db.query(
      "INSERT INTO chunks_fts (id, path, source, model, start_line, end_line, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const id = `${file.relPath}:${chunk.startLine}-${chunk.endLine}:${i}`;
      const embeddingJson = embeddings?.[i] ? JSON.stringify(embeddings[i]) : "[]";

      insertChunk.run(id, file.relPath, file.source, chunk.startLine, chunk.endLine, chunk.hash, model, chunk.text, embeddingJson, now);
      insertFts.run(id, file.relPath, file.source, model, chunk.startLine, chunk.endLine, chunk.text);
    }

    this.db.run(
      "INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      [file.relPath, file.source, file.hash, file.mtime, file.size],
    );
  }

  private async embedChunks(
    file: WorkspaceFile,
    chunks: MemoryChunk[],
    model: string,
  ): Promise<number[][] | null> {
    if (!this.provider || chunks.length === 0) return null;

    const hashes = chunks.map((c) => c.hash);
    const cached = getCachedEmbeddings(this.db, this.provider.id, model, hashes);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    const embeddings = new Array<number[] | null>(chunks.length).fill(null);
    for (let i = 0; i < chunks.length; i++) {
      const cachedEmb = cached.get(chunks[i].hash);
      if (cachedEmb) {
        embeddings[i] = cachedEmb;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(chunks[i].text);
      }
    }

    if (uncachedTexts.length === 0) {
      return embeddings as number[][];
    }

    try {
      const newEmbeddings = await this.provider.embed(uncachedTexts);
      const cacheEntries: Array<{ hash: string; embedding: number[] }> = [];
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        embeddings[idx] = newEmbeddings[j];
        cacheEntries.push({ hash: chunks[idx].hash, embedding: newEmbeddings[j] });
      }
      setCachedEmbeddings(this.db, this.provider.id, model, cacheEntries);
      return embeddings as number[][];
    } catch (err) {
      log.warn("embedding generation failed, indexing without vectors", {
        file: file.relPath,
        chunks: uncachedTexts.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Drop all indexed chunks for a session file given its absolute path.
   * Used by session rewind to ensure memory_search can't return text from
   * turns the user just discarded. The indexer will re-index the file on
   * its next sync cycle (mtime+size changes from the rewrite act as the
   * change signal), this just prevents a stale-read window in between.
   *
   * No-op if the path isn't under the configured sessions dir or hasn't
   * been indexed yet.
   */
  invalidateAbsPath(absPath: string): void {
    if (!this.sessionsPath) return;
    // Match the scanSessionFiles convention: "sessions/" + path-relative-to-root
    const prefix = this.sessionsPath.endsWith("/") ? this.sessionsPath : this.sessionsPath + "/";
    if (!absPath.startsWith(prefix)) return;
    const relPath = `sessions/${absPath.slice(prefix.length)}`;
    this.removeFile(relPath);
  }

  private removeFile(relPath: string): void {
    // Get chunk IDs for FTS deletion
    const chunkIds = (
      this.db.query("SELECT id FROM chunks WHERE path = ?").all(relPath) as Array<{ id: string }>
    ).map((r) => r.id);

    for (const id of chunkIds) {
      this.db.run("DELETE FROM chunks_fts WHERE id = ?", [id]);
    }
    this.db.run("DELETE FROM chunks WHERE path = ?", [relPath]);
    this.db.run("DELETE FROM files WHERE path = ?", [relPath]);
  }

  // ---------------------------------------------------------------------------
  // File Discovery
  // ---------------------------------------------------------------------------

  private listWorkspaceFiles(): WorkspaceFile[] {
    const files: WorkspaceFile[] = [];
    const wsPath = this.workspacePath;

    if (!existsSync(wsPath)) {
      // Workspace absent — still scan sessions if configured
      if (this.sessionsPath && existsSync(this.sessionsPath)) {
        const cutoff = Date.now() - this.sessionIndexWindowMs;
        this.scanSessionFiles(this.sessionsPath, this.sessionsPath, cutoff, files);
      }
      return files;
    }

    // Root .md files
    try {
      for (const entry of readdirSync(wsPath)) {
        if (entry.endsWith(".md")) {
          const absPath = join(wsPath, entry);
          try {
            if (!isRealPathInsideRoot(wsPath, absPath)) continue;
            const stat = statSync(absPath);
            if (stat.isFile()) {
              const content = readFileSync(absPath, "utf-8");
              files.push({
                relPath: entry,
                absPath,
                hash: hashText(content),
                mtime: stat.mtimeMs,
                size: stat.size,
                source: "memory",
              });
            }
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip */ }

    // memory/ directory
    const memDir = join(wsPath, "memory");
    if (existsSync(memDir)) {
      this.scanMemoryFiles(memDir, memDir, files);
    }

    // Session JSONL files (recent, within window)
    if (this.sessionsPath && existsSync(this.sessionsPath)) {
      const cutoff = Date.now() - this.sessionIndexWindowMs;
      this.scanSessionFiles(this.sessionsPath, this.sessionsPath, cutoff, files);
    }

    return files;
  }

  private scanMemoryFiles(dir: string, rootDir: string, out: WorkspaceFile[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = join(dir, entry);
      try {
        if (!isRealPathInsideRoot(this.workspacePath, absPath)) continue;
        const stat = statSync(absPath);
        if (stat.isDirectory()) {
          this.scanMemoryFiles(absPath, rootDir, out);
          continue;
        }
        if (!stat.isFile() || (!entry.endsWith(".md") && !entry.endsWith(".jsonl"))) {
          continue;
        }

        const relFromRoot = absPath.slice(rootDir.length + 1);
        const hash = entry.endsWith(".jsonl")
          ? hashText(`${stat.mtimeMs}:${stat.size}`)
          : hashText(readFileSync(absPath, "utf-8"));
        out.push({
          relPath: `memory/${relFromRoot}`,
          absPath,
          hash,
          mtime: stat.mtimeMs,
          size: stat.size,
          source: "memory",
        });
      } catch { /* skip unreadable */ }
    }
  }

  /**
   * Recursively scan a directory for .jsonl session files modified within the window.
   * Uses mtime+size as hash (sessions are append-only, so this is a reliable change proxy).
   */
  private scanSessionFiles(
    dir: string,
    rootDir: string,
    cutoffMs: number,
    out: WorkspaceFile[],
  ): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip metadata files
      if (entry === "meta.json" || entry === ".last-session" || entry.endsWith(".bak")) continue;

      const absPath = join(dir, entry);
      try {
        if (!isRealPathInsideRoot(rootDir, absPath)) continue;
        const stat = statSync(absPath);

        if (stat.isDirectory()) {
          this.scanSessionFiles(absPath, rootDir, cutoffMs, out);
        } else if (entry.endsWith(".jsonl") && stat.mtimeMs >= cutoffMs) {
          // Relative path from sessions root, prefixed with "sessions/"
          const relFromRoot = absPath.slice(rootDir.length + 1); // e.g., "tui/main.jsonl"
          out.push({
            relPath: `sessions/${relFromRoot}`,
            absPath,
            // Append-only files: mtime+size is a perfect change proxy
            hash: hashText(`${stat.mtimeMs}:${stat.size}`),
            mtime: stat.mtimeMs,
            size: stat.size,
            source: "sessions",
          });
        }
      } catch { /* skip unreadable */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Reindex Check
  // ---------------------------------------------------------------------------

  private checkReindexNeeded(): void {
    const savedModel = getMeta(this.db, "model");
    const savedTokens = getMeta(this.db, "chunkTokens");
    const savedOverlap = getMeta(this.db, "chunkOverlap");
    const currentModel = this.provider?.model ?? "fts-only";

    if (
      savedModel !== currentModel ||
      savedTokens !== String(this.chunkConfig.tokens) ||
      savedOverlap !== String(this.chunkConfig.overlap)
    ) {
      // Model or config changed — clear everything for full reindex
      this.db.run("DELETE FROM chunks");
      this.db.run("DELETE FROM chunks_fts");
      this.db.run("DELETE FROM files");
      this.dirty = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Watcher
  // ---------------------------------------------------------------------------

  private startWatcher(): void {
    const wsPath = this.workspacePath;
    const sessionsPath = this.sessionsPath;

    // chokidar v4+ dropped glob support, so `wsPath/*.md` no longer matches
    // anything. Watch the containing directories and filter changed paths down
    // to the files listWorkspaceFiles() would actually index.
    const watchDirs: string[] = [];
    if (existsSync(wsPath)) {
      watchDirs.push(wsPath); // covers root *.md and the memory/ subtree
    }
    if (sessionsPath && existsSync(sessionsPath)) {
      watchDirs.push(sessionsPath);
    }

    if (watchDirs.length === 0) return;

    const memDir = join(wsPath, "memory");
    const isInside = (dir: string, p: string): boolean =>
      p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

    const shouldReindex = (p: string): boolean => {
      // Session JSONL files (recursive)
      if (sessionsPath && isInside(sessionsPath, p)) return p.endsWith(".jsonl");
      // memory/ subtree: indexed .md and .jsonl (recursive)
      if (isInside(memDir, p)) return p.endsWith(".md") || p.endsWith(".jsonl");
      // Workspace root: top-level .md files only (not nested)
      if (dirname(p) === wsPath) return p.endsWith(".md");
      return false;
    };

    this.watcher = createMemoryWatcher(watchDirs, () => {
      this.dirty = true;
    }, shouldReindex);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface WorkspaceFile {
  relPath: string;
  absPath: string;
  hash: string;
  mtime: number;
  size: number;
  source: "memory" | "sessions";
}

/** Build FTS5 MATCH query from raw search text. */
function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  // Quote each token and AND them together
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" AND ");
}

/** Convert BM25 rank to [0, 1] score. More negative rank = more relevant = higher score. */
function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// -----------------------------------------------------------------------------
// Search Metadata (for observability)
// -----------------------------------------------------------------------------

export interface SearchMeta {
  /** Whether sync was triggered before this search */
  synced: boolean;
  /** Sync stats (if synced) */
  syncStats: { indexed: number; skipped: number; removed: number } | null;
  /** Search mode used */
  searchMode: string;
  /** Number of FTS/BM25 candidate results */
  ftsResults: number;
  /** Number of vector candidate results */
  vectorResults: number;
  /** Total chunks in the index */
  totalChunks: number;
  /** Embedding provider used (null = FTS-only) */
  embeddingProvider: string | null;
  /** Embedding model used */
  embeddingModel: string | null;
}

// Export for testing
export { buildFtsQuery, bm25RankToScore, cosineSimilarity };
