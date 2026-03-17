// =============================================================================
// Memory Search Database Schema
//
// SQLite tables for memory indexing:
// - meta: key-value store for tracking index state
// - files: file metadata for change detection
// - chunks: indexed content units with embeddings
// - chunks_fts: FTS5 virtual table for BM25 keyword search
// - embedding_cache: avoid re-embedding unchanged text
// =============================================================================

import { Database } from "bun:sqlite";

export function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source)`);

  // FTS5 virtual table for BM25 keyword search
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      id UNINDEXED,
      path UNINDEXED,
      source UNINDEXED,
      model UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, hash)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated ON embedding_cache(updated_at)`);
}

/** Set a meta value. */
export function setMeta(db: Database, key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
}

/** Get a meta value. */
export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}
