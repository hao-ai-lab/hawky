// =============================================================================
// Anti-lossy consolidation gate (#14, Phase A)
//
// Pure, LLM-free, IO-free helpers that decide whether a freshly-consolidated
// MEMORY.md is safe to write over the old one, or whether it looks lossy enough
// that we should keep the old file and stash the candidate as MEMORY.md.proposed.
//
// The gate is FAIL-CLOSED: an overwrite happens only when BOTH a length test AND
// a distinct-fact-count test pass (or the existing file is trivial). If either
// test trips, we refuse to overwrite. As a categorical backstop, a candidate
// that preserves ZERO facts can never overwrite a file that had any — that is
// total fact loss regardless of length or how few facts the old file held.
//
// Everything here is side-effect-free so it can be unit-tested without a
// provider or a filesystem.
// =============================================================================

/**
 * Files whose trimmed length is at or below this are "trivial" — the gate is
 * bypassed and a write is always allowed. Covers the empty/template MEMORY.md
 * (first-ever consolidation) so it is never falsely rejected.
 */
export const TRIVIAL_FILE_CHARS = 200;

/** Reject the candidate if its trimmed length is below this fraction of the old. */
export const MIN_LENGTH_RATIO = 0.5;

/** Reject the candidate if its distinct fact-line count drops below this fraction. */
export const MIN_FACT_RATIO = 0.5;

/**
 * Only apply the fact-ratio test when the old file had at least this many
 * distinct fact lines. Tiny fact sets are too noisy to gate on.
 */
export const MIN_FACTS_FOR_RATIO = 5;

/**
 * Matches a leading markdown bullet or ordered-list marker (an actual fact).
 * Beyond ASCII `-*+`, we accept the Unicode/CJK bullet glyphs that LLMs and CJK
 * users routinely emit (•, ◦, ▪, ‣, ·, ・, ●, …) — otherwise a legitimately
 * non-lossy consolidation that happens to use them would read as zero facts and
 * be falsely rejected.
 */
const LIST_MARKER = /^([-*+•◦▪▫‣⁃·・●○–—]\s+|\d+[.)]\s+)/;
/** Matches a leading markdown heading marker (structure, NOT a fact). */
const HEADING_MARKER = /^#{1,6}\s+/;

/**
 * Count DISTINCT non-trivial fact lines in a markdown blob.
 *
 * Only genuine list items (bullet or numbered) count as facts. Headings and
 * free prose are treated as structure/filler and are NOT counted — otherwise a
 * lossy rewrite that replaces real bullets with equal-count headings and
 * rambling paragraphs would falsely clear the fact-ratio gate. For each list
 * line: strip the marker, drop lines whose remaining text is shorter than 3
 * chars, then lowercase + collapse whitespace and dedupe. Returns the set size.
 *
 * This is a heuristic "distinct fact-line count" signal, not a semantic one.
 */
export function factLineCount(md: string): number {
  const seen = new Set<string>();
  for (const rawLine of md.split("\n")) {
    const trimmed = rawLine.trim();
    // Headings are structure, not facts — never count them.
    if (HEADING_MARKER.test(trimmed)) continue;
    // Only count actual list items; ignore free prose lines.
    if (!LIST_MARKER.test(trimmed)) continue;
    const stripped = trimmed.replace(LIST_MARKER, "").trim();
    if (stripped.length < 3) continue;
    const normalized = stripped.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized.length < 3) continue;
    seen.add(normalized);
  }
  return seen.size;
}

export interface GlobalWriteDecision {
  action: "write" | "propose";
  reason: string;
  oldLen: number;
  newLen: number;
  oldFacts: number;
  newFacts: number;
}

/**
 * Fail-closed gate deciding whether `candidate` may overwrite `existing`.
 *
 * - Empty/whitespace candidate -> 'propose' (defensive; caller also guards this).
 * - Candidate preserves zero facts while the existing had some -> 'propose'
 *   (total fact loss; checked before the trivial/ratio bypasses so a tiny or
 *   small-fact-set file can never be silently zeroed out).
 * - Trivial existing (<= TRIVIAL_FILE_CHARS trimmed) -> always 'write'.
 * - Otherwise 'write' only if the length test AND the fact test both pass.
 */
export function decideGlobalWrite(existing: string, candidate: string): GlobalWriteDecision {
  const oldTrim = existing.trim();
  const newTrim = candidate.trim();

  const oldLen = oldTrim.length;
  const newLen = newTrim.length;
  const oldFacts = factLineCount(oldTrim);
  const newFacts = factLineCount(candidate);

  if (newTrim === "") {
    return {
      action: "propose",
      reason: "candidate is empty",
      oldLen,
      newLen,
      oldFacts,
      newFacts,
    };
  }

  if (oldFacts > 0 && newFacts === 0) {
    return {
      action: "propose",
      reason: "candidate preserves no facts (total fact loss)",
      oldLen,
      newLen,
      oldFacts,
      newFacts,
    };
  }

  if (oldLen <= TRIVIAL_FILE_CHARS) {
    return {
      action: "write",
      reason: "existing trivial",
      oldLen,
      newLen,
      oldFacts,
      newFacts,
    };
  }

  const lengthOk = newLen >= oldLen * MIN_LENGTH_RATIO;
  const factOk = oldFacts < MIN_FACTS_FOR_RATIO ? true : newFacts >= oldFacts * MIN_FACT_RATIO;

  if (lengthOk && factOk) {
    return {
      action: "write",
      reason: "passed anti-lossy gate",
      oldLen,
      newLen,
      oldFacts,
      newFacts,
    };
  }

  const tripped: string[] = [];
  if (!lengthOk) tripped.push(`length ${newLen} < ${Math.round(oldLen * MIN_LENGTH_RATIO)} (${MIN_LENGTH_RATIO * 100}% of ${oldLen})`);
  if (!factOk) tripped.push(`facts ${newFacts} < ${Math.round(oldFacts * MIN_FACT_RATIO)} (${MIN_FACT_RATIO * 100}% of ${oldFacts})`);

  return {
    action: "propose",
    reason: `looks lossy: ${tripped.join("; ")}`,
    oldLen,
    newLen,
    oldFacts,
    newFacts,
  };
}

/**
 * Keep the TAIL (most-recent turns) of a long transcript. Returns `text`
 * unchanged when it fits; otherwise the last `maxChars` characters. Pure.
 */
export function sliceSessionTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}
