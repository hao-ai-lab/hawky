// =============================================================================
// Slack recipient matching (#533)
//
// Pure, client-free matching + ranking of a free-text query against a directory
// of Slack users and channels. Multi-strategy: exact handle/name, token-subset,
// substring, and pinyin (so Chinese ↔ romanized names resolve both ways, e.g.
// "邹欣凯"/"欣凯" ↔ "Jay (Xinkai) Zou"). Kept separate from the adapter so it's
// unit-testable and reusable by the directory graph (#535).
// =============================================================================

import { pinyin } from "pinyin-pro";

/** A resolvable Slack target — a user (→ DM) or a channel (→ post). */
export interface SlackRecipient {
  id: string;
  label: string;
  kind: "user" | "channel";
  handle?: string;
}

/** One directory entry to match against (user or channel). */
export interface SlackDirectoryEntry {
  id: string;
  kind: "user" | "channel";
  /** @handle (user name) or channel name. */
  handle?: string;
  /** Human label: real_name / display_name for users, channel name for channels. */
  label: string;
  /** Extra searchable names (real_name, display_name) for users. */
  aliases?: string[];
}

/** Lowercase + strip punctuation/parens to whitespace, collapse runs. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[()[\]{}<>.,/\\@#:_'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Toneless pinyin as a lowercased token list — each Chinese char → its syllable,
 *  ASCII words pass through. e.g. "邹欣凯" → ["zou","xin","kai"], "Jay Zou" →
 *  ["jay","zou"]. Used for both whole-string and per-token overlap matching. */
function pinyinTokens(s: string): string[] {
  try {
    return pinyin(s, { toneType: "none", type: "array" })
      .join(" ")
      .toLowerCase()
      .replace(/[()[\]{}<>.,/\\@#:_'"-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return normalize(s).split(" ").filter(Boolean);
  }
}

// Match rank — higher is better. Used to order candidates.
const RANK = {
  exactHandle: 100,
  exactName: 90,
  handlePrefix: 70,
  tokenSubset: 60,
  substring: 50,
  pinyin: 40,
} as const;

/**
 * Score one entry against a query. Returns the best (highest) matching strategy's
 * rank, or 0 if nothing matches. Channels get a tiny penalty so that, all else
 * equal, a person beats a same-named channel (callers can override by kind).
 */
export function scoreEntry(query: string, entry: SlackDirectoryEntry): number {
  const q = normalize(query);
  if (!q) return 0;
  const qTokens = q.split(" ").filter(Boolean);

  const names = [entry.label, entry.handle, ...(entry.aliases ?? [])].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  const handleNorm = entry.handle ? normalize(entry.handle) : "";

  let best = 0;
  const bump = (r: number) => { if (r > best) best = r; };

  for (const name of names) {
    const n = normalize(name);
    if (!n) continue;
    if (handleNorm && q === handleNorm) bump(RANK.exactHandle);
    if (q === n) bump(RANK.exactName);
    if (handleNorm && handleNorm.startsWith(q)) bump(RANK.handlePrefix);
    if (n.startsWith(q)) bump(RANK.handlePrefix);

    // token subset: every query token appears as a token of the name
    const nTokens = new Set(n.split(" ").filter(Boolean));
    if (qTokens.length > 0 && qTokens.every((t) => nTokens.has(t))) bump(RANK.tokenSubset);

    if (n.includes(q)) bump(RANK.substring);
  }

  // pinyin fallback — Chinese names romanize as syllables; matching the query's
  // pinyin against the romanized name handles both "欣凯"→"xinkai" (whole) and
  // "邹欣凯" vs given-name-first "Jay (Xinkai) Zou" (a contiguous syllable run of
  // the query — here "xinkai" — appears in the name). pinyin-pro romanizes ASCII
  // letter-by-letter, so compare the query pinyin against the name's NORMALIZED
  // text (spaces removed), not the name's pinyin.
  if (best < RANK.pinyin) {
    const qSyl = pinyinTokens(query); // e.g. ["zou","xin","kai"]
    if (qSyl.length > 0) {
      // contiguous syllable runs of the query, longest first (len ≥ 2 syllables)
      const runs: string[] = [];
      for (let len = qSyl.length; len >= 2; len--) {
        for (let i = 0; i + len <= qSyl.length; i++) runs.push(qSyl.slice(i, i + len).join(""));
      }
      const qWhole = qSyl.join("");
      for (const name of names) {
        const nJoined = normalize(name).replace(/\s+/g, "");
        if (!nJoined) continue;
        if (nJoined.includes(qWhole) || qWhole.includes(nJoined) || runs.some((r) => r.length >= 4 && nJoined.includes(r))) {
          bump(RANK.pinyin);
          break;
        }
      }
    }
  }

  if (best > 0 && entry.kind === "channel") best -= 1; // tie-break toward people
  return best;
}

/**
 * Rank a directory against a query, returning matching recipients best-first.
 * Ties broken by label length (shorter = more specific) then label.
 */
export function rankRecipients(query: string, dir: SlackDirectoryEntry[]): SlackRecipient[] {
  const scored: Array<{ entry: SlackDirectoryEntry; score: number }> = [];
  for (const entry of dir) {
    const score = scoreEntry(query, entry);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.label.length !== b.entry.label.length) return a.entry.label.length - b.entry.label.length;
    return a.entry.label.localeCompare(b.entry.label);
  });
  return scored.map(({ entry }) => ({
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    ...(entry.handle ? { handle: entry.handle } : {}),
  }));
}
