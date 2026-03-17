// =============================================================================
// Hybrid Search Merge
//
// Combines vector similarity + BM25 keyword results.
// Implements temporal decay and MMR diversity re-ranking.
// Matches a proven hybrid.ts algorithm.
// =============================================================================

import type { SearchResult } from "./types.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HybridResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  source: "memory" | "sessions";
  vectorScore: number;
  textScore: number;
}

// -----------------------------------------------------------------------------
// Hybrid Merge
// -----------------------------------------------------------------------------

/**
 * Merge vector + keyword results with weighted scoring.
 * score = vectorWeight * vecScore + textWeight * bm25Score
 */
export function mergeHybridResults(
  vector: HybridResult[],
  keyword: HybridResult[],
  vectorWeight: number,
  textWeight: number,
): SearchResult[] {
  const byId = new Map<string, HybridResult>();

  for (const r of vector) {
    byId.set(r.id, { ...r });
  }

  for (const r of keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet.length > existing.snippet.length) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, { ...r, vectorScore: 0 });
    }
  }

  return Array.from(byId.values())
    .map((entry) => ({
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: vectorWeight * entry.vectorScore + textWeight * entry.textScore,
      snippet: entry.snippet,
      source: entry.source,
    }))
    .sort((a, b) => b.score - a.score);
}

// -----------------------------------------------------------------------------
// Temporal Decay
// -----------------------------------------------------------------------------

// Anchored pattern: only matches memory/YYYY-MM-DD.md paths (not session paths or arbitrary dates)
const MEMORY_DATE_PATTERN = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;

/**
 * Parse a validated UTC date from path components. Returns null for invalid dates.
 */
function parsePathDate(year: string, month: string, day: string): Date | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const timestamp = Date.UTC(y, m - 1, d);
  const parsed = new Date(timestamp);
  // Validate: Date constructor normalizes invalid dates (month 13 → next year)
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    return null;
  }
  return parsed;
}

/**
 * Apply temporal decay: recent entries score higher.
 * score_decayed = score * exp(-ln(2) * ageDays / halfLifeDays)
 *
 * Only applies to dated memory files (memory/YYYY-MM-DD.md).
 * Non-dated files (MEMORY.md, SOUL.md), session files, and files with
 * invalid dates are evergreen — no decay applied.
 */
export function applyTemporalDecay(
  results: SearchResult[],
  halfLifeDays: number,
  nowMs = Date.now(),
): SearchResult[] {
  if (halfLifeDays <= 0) return results;
  const lambda = Math.LN2 / halfLifeDays;
  const nowDays = nowMs / (1000 * 60 * 60 * 24);

  return results.map((r) => {
    const match = r.path.match(MEMORY_DATE_PATTERN);
    if (!match) return r; // Evergreen or session file — no decay

    const fileDate = parsePathDate(match[1], match[2], match[3]);
    if (!fileDate) return r; // Invalid date — treat as evergreen

    const fileDays = fileDate.getTime() / (1000 * 60 * 60 * 24);
    const ageDays = Math.max(0, nowDays - fileDays);
    const multiplier = Math.exp(-lambda * ageDays);

    return { ...r, score: r.score * multiplier };
  });
}

// -----------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance)
// -----------------------------------------------------------------------------

/**
 * MMR re-ranking: balance relevance with diversity.
 * Avoids returning 6 results from the same paragraph.
 *
 * Uses Jaccard similarity on token sets.
 * λ=0.7 means 70% relevance, 30% diversity.
 */
export function applyMMR(
  results: SearchResult[],
  lambda: number,
): SearchResult[] {
  if (results.length <= 1) return results;
  const clampedLambda = Math.max(0, Math.min(1, lambda));

  // Tokenize all results (supports Latin + CJK)
  const tokens = new Map<number, Set<string>>();
  results.forEach((r, i) => {
    tokens.set(i, tokenize(r.snippet));
  });

  // Normalize scores to [0, 1]
  const maxScore = Math.max(...results.map((r) => r.score));
  const minScore = Math.min(...results.map((r) => r.score));
  const range = maxScore - minScore;
  const normalizeScore = (s: number) => (range === 0 ? 1 : (s - minScore) / range);

  const selected: SearchResult[] = [];
  const selectedIndices: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (const idx of remaining) {
      const relevance = normalizeScore(results[idx].score);

      let maxSim = 0;
      for (const selIdx of selectedIndices) {
        maxSim = Math.max(maxSim, jaccardSimilarity(tokens.get(idx)!, tokens.get(selIdx)!));
      }

      const mmrScore = clampedLambda * relevance - (1 - clampedLambda) * maxSim;
      // Tiebreaker: prefer higher original score
      if (mmrScore > bestMMR || (mmrScore === bestMMR && results[idx].score > (bestIdx >= 0 ? results[bestIdx].score : -Infinity))) {
        bestMMR = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(results[bestIdx]);
      selectedIndices.push(bestIdx);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }

  return selected;
}

/** Tokenize text for Jaccard similarity. Handles Latin + CJK characters. */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  // Latin/numeric tokens
  for (const m of lower.matchAll(/[\p{L}\p{N}_]+/gu)) {
    tokens.add(m[0]);
  }
  // CJK unigrams (Chinese, Japanese kanji, Korean hangul)
  for (const m of lower.matchAll(/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu)) {
    tokens.add(m[0]);
  }
  return tokens;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }

  return intersection / (a.size + b.size - intersection);
}
