// =============================================================================
// Embedding Provider
//
// Generates vector embeddings for text chunks.
// Default: OpenAI text-embedding-3-small (1536 dims).
// Falls back to null (FTS-only mode) when no API key available.
// Supports embedding cache to avoid redundant API calls.
// =============================================================================

import { Database } from "bun:sqlite";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface EmbeddingProvider {
  id: string;
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// -----------------------------------------------------------------------------
// OpenAI Embedding Provider
// -----------------------------------------------------------------------------

const OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_DIMS = 1536;
const BATCH_SIZE = 20;

export function createOpenAIEmbeddingProvider(apiKey: string): EmbeddingProvider {
  return {
    id: "openai",
    model: OPENAI_MODEL,
    dimensions: OPENAI_DIMS,

    async embed(texts: string[]): Promise<number[][]> {
      const allEmbeddings: number[][] = [];

      // Batch requests
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);

        // 30s timeout to avoid indefinite hangs
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        let response: Response;
        try {
          response = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL,
              input: batch,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`OpenAI embedding API error (${response.status}): ${text}`);
        }

        const json = (await response.json()) as {
          data?: Array<{ embedding?: number[]; index: number }>;
        };

        // Validate response structure
        if (!Array.isArray(json.data)) {
          throw new Error("OpenAI embedding API: missing data array in response");
        }
        if (json.data.length !== batch.length) {
          throw new Error(`OpenAI embedding API: expected ${batch.length} embeddings, got ${json.data.length}`);
        }

        // Sort by index to maintain order
        const sorted = json.data.sort((a, b) => a.index - b.index);
        for (const item of sorted) {
          if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
            throw new Error(`OpenAI embedding API: invalid embedding at index ${item.index}`);
          }
          allEmbeddings.push(item.embedding);
        }
      }

      return allEmbeddings;
    },
  };
}

// -----------------------------------------------------------------------------
// Embedding Cache
// -----------------------------------------------------------------------------

/**
 * Check cache for existing embeddings. Returns cached embeddings or null for misses.
 */
export function getCachedEmbeddings(
  db: Database,
  provider: string,
  model: string,
  hashes: string[],
): Map<string, number[]> {
  const cache = new Map<string, number[]>();
  if (hashes.length === 0) return cache;

  // Batch query with IN clause (avoids N+1 per-hash queries)
  const placeholders = hashes.map(() => "?").join(",");
  const rows = db.query(
    `SELECT hash, embedding FROM embedding_cache WHERE provider = ? AND model = ? AND hash IN (${placeholders})`,
  ).all(provider, model, ...hashes) as Array<{ hash: string; embedding: string }>;

  for (const row of rows) {
    try {
      cache.set(row.hash, JSON.parse(row.embedding));
    } catch {
      // Corrupted cache entry, skip
    }
  }

  return cache;
}

/**
 * Store embeddings in cache.
 */
export function setCachedEmbeddings(
  db: Database,
  provider: string,
  model: string,
  entries: Array<{ hash: string; embedding: number[] }>,
): void {
  const stmt = db.query(
    "INSERT OR REPLACE INTO embedding_cache (provider, model, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const now = Date.now();
  for (const entry of entries) {
    stmt.run(provider, model, entry.hash, JSON.stringify(entry.embedding), entry.embedding.length, now);
  }
}

// -----------------------------------------------------------------------------
// Provider Resolution
// -----------------------------------------------------------------------------

/**
 * Detect and create embedding provider based on available API keys.
 * Checks: OPENAI_API_KEY env var → config.api_keys.openai.
 * Returns null if no API key available (FTS-only mode).
 */
export function detectEmbeddingProvider(configOpenaiKey?: string): EmbeddingProvider | null {
  // Check environment variable first, then config
  const openaiKey = process.env.OPENAI_API_KEY || configOpenaiKey;
  if (openaiKey) {
    return createOpenAIEmbeddingProvider(openaiKey);
  }

  // No provider available — FTS-only mode
  return null;
}
