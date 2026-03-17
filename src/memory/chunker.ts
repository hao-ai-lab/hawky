// =============================================================================
// Memory Chunker
//
// Splits markdown files into chunks for indexing.
// Matches a proven algorithm: line-based splitting with overlap.
//
// Default: 400 tokens (~1600 chars) per chunk, 80 tokens (~320 chars) overlap.
// =============================================================================

import { createHash } from "node:crypto";
import type { MemoryChunk } from "./types.js";
import { DEFAULT_CHUNK_CONFIG } from "./types.js";

/** Compute SHA-256 hash of text. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Split markdown content into chunks with line tracking and overlap.
 *
 * Matches a proven chunkMarkdown() algorithm:
 * - Line-based accumulation until maxChars exceeded
 * - Overlap carried from tail of previous chunk
 * - Long lines pre-split into segments
 * - Line numbers are 1-indexed
 */
export function chunkMarkdown(
  content: string,
  config = DEFAULT_CHUNK_CONFIG,
): MemoryChunk[] {
  if (!content.trim()) return [];
  const lines = content.split("\n");
  const maxChars = Math.max(32, config.tokens * 4);
  const overlapChars = Math.max(0, config.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((e) => e.line).join("\n");
    const startLine = current[0].lineNo;
    const endLine = current[current.length - 1].lineNo;
    chunks.push({ startLine, endLine, text, hash: hashText(text) });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: typeof current = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += current[i].line.length + 1;
      kept.unshift(current[i]);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    // Pre-split long lines
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }

    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }

  flush();
  return chunks;
}
