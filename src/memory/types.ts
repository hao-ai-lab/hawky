// =============================================================================
// Memory Search Types
// =============================================================================

export interface MemoryChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
}

export interface ChunkRow {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  text: string;
  hash: string;
  model: string;
  embedding: string; // JSON array of numbers
}

export interface FileRow {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

export interface SearchConfig {
  maxResults: number;
  minScore: number;
  vectorWeight: number;
  textWeight: number;
  temporalDecay: { enabled: boolean; halfLifeDays: number };
  mmr: { enabled: boolean; lambda: number };
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  maxResults: 6,
  minScore: 0.1,
  vectorWeight: 0.7,
  textWeight: 0.3,
  temporalDecay: { enabled: true, halfLifeDays: 30 },
  mmr: { enabled: true, lambda: 0.7 },
};

export const DEFAULT_CHUNK_CONFIG = {
  tokens: 200,
  overlap: 40,
};

// Must be >= max chunk chars (tokens * 4) so the agent sees the full chunk.
export const SNIPPET_MAX_CHARS = 900;
