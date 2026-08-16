// =============================================================================
// Tests for the anti-lossy consolidation gate (#14, Phase A)
//
// Pure functions only — no LLM, no filesystem. Covers factLineCount,
// decideGlobalWrite (the fail-closed gate), and sliceSessionTail.
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  factLineCount,
  decideGlobalWrite,
  sliceSessionTail,
  TRIVIAL_FILE_CHARS,
  MIN_FACTS_FOR_RATIO,
} from "../src/memory/anti-lossy.js";

/** Build a body of `n` distinct bullet facts, each padded to be non-trivial. */
function facts(n: number, prefix = "fact"): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`- ${prefix} number ${i} with descriptive text`);
  return lines.join("\n");
}

describe("factLineCount", () => {
  test("empty string -> 0", () => {
    expect(factLineCount("")).toBe(0);
    expect(factLineCount("   \n  \n")).toBe(0);
  });

  test("bullet list of 3 distinct facts -> 3", () => {
    expect(factLineCount("- apple pie\n- banana bread\n- cherry cake")).toBe(3);
  });

  test("duplicate lines counted once", () => {
    expect(factLineCount("- same fact here\n- same fact here\n- different fact")).toBe(2);
  });

  test("headings are NOT counted as facts (only list items are)", () => {
    // Headings are structure, not facts — they must not inflate the count.
    expect(factLineCount("# heading text\n1. an ordered fact")).toBe(1);
    expect(factLineCount("## alpha bravo\n### charlie delta")).toBe(0);
  });

  test("free prose lines are NOT counted as facts", () => {
    // Only bullets/numbered items count; rambling paragraphs do not.
    expect(factLineCount("this is a prose sentence with no marker\n- a real bullet fact")).toBe(1);
  });

  test("sub-3-char lines are ignored", () => {
    expect(factLineCount("- a\n- ok\n- real fact line")).toBe(1);
  });

  test("unicode / CJK bullet markers count as facts (not just ASCII -*+)", () => {
    // LLMs and CJK users routinely emit these glyphs; they must not read as 0.
    expect(factLineCount("• apple pie\n• banana bread\n• cherry cake")).toBe(3);
    expect(factLineCount("・ 蘋果派\n・ 香蕉麵包")).toBe(2);
    expect(factLineCount("‣ first item\n▪ second item\n● third item")).toBe(3);
  });
});

describe("decideGlobalWrite", () => {
  test("trivial existing (<= TRIVIAL_FILE_CHARS) always writes", () => {
    const tiny = "x".repeat(TRIVIAL_FILE_CHARS);
    const d = decideGlobalWrite(tiny, "- a single tiny fact");
    expect(d.action).toBe("write");
    expect(d.reason).toBe("existing trivial");

    // Even a much shorter candidate against a trivial existing writes.
    expect(decideGlobalWrite("# template\n- placeholder", "- one").action).toBe("write");
  });

  test("substantial existing, candidate ~90% length & similar facts -> write", () => {
    const existing = "# MEMORY\n\n" + facts(12);
    const candidate = "# MEMORY\n\n" + facts(11); // ~92% of facts, close length
    const d = decideGlobalWrite(existing, candidate);
    expect(d.action).toBe("write");
    expect(d.reason).toBe("passed anti-lossy gate");
  });

  test("candidate < 50% length -> propose (length test trips)", () => {
    const existing = "# MEMORY\n\n" + facts(12); // large
    const candidate = facts(11).slice(0, Math.floor(existing.length * 0.3));
    const d = decideGlobalWrite(existing, candidate);
    expect(d.action).toBe("propose");
    expect(d.reason).toMatch(/length/);
  });

  test("candidate similar length but fact count drops 12 -> 4 -> propose (fact test trips)", () => {
    const existing = "# MEMORY\n\n" + facts(12);
    // Pad 4 facts with a long filler line so the length test passes but distinct
    // facts collapse.
    const filler = "the same repeated padding sentence over and over and over. ".repeat(20);
    const candidate = "# MEMORY\n\n" + facts(4) + "\n" + filler;
    const d = decideGlobalWrite(existing, candidate);
    expect(d.oldFacts).toBeGreaterThanOrEqual(12);
    expect(d.newFacts).toBeLessThan(existing.length); // sanity
    expect(d.action).toBe("propose");
    expect(d.reason).toMatch(/facts/);
  });

  test("lossy rewrite: real bullets dropped, padded with headings+prose -> propose", () => {
    // Regression for the reviewed false-negative: an old file with 10 real
    // curated bullets is rewritten down to 3 real bullets but padded with
    // headings and rambling prose so the char-length stays high. Because
    // headings/prose no longer count as facts, the fact-ratio gate now trips.
    const existing = "# MEMORY\n\n" + facts(10, "curated");
    const filler =
      "## Section heading one\n" +
      "This is a rambling prose paragraph that adds length but carries no bullet fact. ".repeat(8) +
      "\n## Section heading two\n" +
      "More filler prose here to keep the character count comparable to the original. ".repeat(8);
    const candidate = "# MEMORY\n\n" + facts(3, "curated") + "\n" + filler;
    const d = decideGlobalWrite(existing, candidate);
    expect(d.oldFacts).toBe(10);
    expect(d.newFacts).toBe(3);
    expect(d.action).toBe("propose");
    expect(d.reason).toMatch(/facts/);
  });

  test("old has < MIN_FACTS_FOR_RATIO facts: fact test skipped, length decides", () => {
    expect(MIN_FACTS_FOR_RATIO).toBe(5);
    // Old has 3 facts but is long enough to be non-trivial.
    const existing = "# MEMORY\n\n" + facts(3) + "\n" + "padding line to exceed trivial threshold. ".repeat(10);
    // New has 1 fact but keeps enough length -> fact test skipped, length ok -> write.
    const candidateOkLength = "# MEMORY\n\n- one lone fact here\n" + "padding line to exceed trivial threshold. ".repeat(10);
    const dWrite = decideGlobalWrite(existing, candidateOkLength);
    expect(dWrite.action).toBe("write");

    // New is very short -> length test trips (fact test still skipped).
    const dShort = decideGlobalWrite(existing, "- one lone fact");
    expect(dShort.action).toBe("propose");
    expect(dShort.reason).toMatch(/length/);
  });

  test("zero-fact candidate against a fact-bearing file -> propose (total fact loss)", () => {
    // Regression: below MIN_FACTS_FOR_RATIO the fact ratio is skipped, so a
    // candidate that drops ALL facts but keeps comparable length used to slip
    // through as 'write'. Total fact loss must always propose, even for a
    // 4-fact (< 5) file and even when the old file is trivially short.
    const filler = "## Section heading\n" +
      "Rambling prose paragraph with no bullet facts whatsoever. ".repeat(6);
    const existingLong = "# MEMORY\n\n" + facts(4, "curated");
    const zeroFactCandidate = "# MEMORY\n\n" + filler;
    const d = decideGlobalWrite(existingLong, zeroFactCandidate);
    expect(d.oldFacts).toBe(4);
    expect(d.newFacts).toBe(0);
    expect(d.action).toBe("propose");
    expect(d.reason).toMatch(/no facts/);

    // Even a small (trivial-length) fact-bearing file cannot be zeroed out.
    const smallReal = "# MEMORY\n\n- alpha fact\n- beta fact\n- gamma fact";
    expect(decideGlobalWrite(smallReal, "## just a heading\n").action).toBe("propose");
  });

  test("unicode-bulleted candidate preserving facts is not falsely rejected", () => {
    // Regression: old uses ASCII bullets, new consolidation uses • bullets with
    // the same facts. Both must be counted so the fact ratio holds and it writes.
    const existing = "# MEMORY\n\n" + facts(6);
    const candidate = "# MEMORY\n\n" +
      Array.from({ length: 6 }, (_, i) => `• fact number ${i} with descriptive text`).join("\n");
    const d = decideGlobalWrite(existing, candidate);
    expect(d.oldFacts).toBe(6);
    expect(d.newFacts).toBe(6);
    expect(d.action).toBe("write");
  });

  test("empty / whitespace candidate -> propose (defensive)", () => {
    const existing = "# MEMORY\n\n" + facts(12);
    expect(decideGlobalWrite(existing, "").action).toBe("propose");
    expect(decideGlobalWrite(existing, "   \n  ").action).toBe("propose");
    expect(decideGlobalWrite(existing, "   \n  ").reason).toMatch(/empty/);
  });
});

describe("sliceSessionTail", () => {
  test("text shorter than max is returned unchanged", () => {
    expect(sliceSessionTail("short", 100)).toBe("short");
  });

  test("longer text returns the TAIL (endsWith kept, startsWith dropped)", () => {
    const text = "FIRST_LINE\n" + "x".repeat(50) + "\nLAST_LINE";
    const out = sliceSessionTail(text, 20);
    expect(out.length).toBe(20);
    expect(text.endsWith(out)).toBe(true);
    expect(out).toContain("LAST_LINE");
    expect(out).not.toContain("FIRST_LINE");
  });

  test("boundary at exactly maxChars is unchanged", () => {
    const text = "abcde";
    expect(sliceSessionTail(text, 5)).toBe("abcde");
  });
});
