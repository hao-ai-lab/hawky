// =============================================================================
// Unit tests: AssemblyAI word-timings → ~5s segmentation.
//
// Review finding #7: the previous backend emitted a single segment that
// spanned the whole transcript, making t0/t1 alignment (vision sync,
// diarization) useless. Segmenter closes a window whenever adding the
// next word would push it past SEGMENT_TARGET_MS (5s).
// =============================================================================

import { describe, expect, test } from "bun:test";
import { segmentFromWords } from "../../src/consumers/asr/backends/assemblyai.js";

describe("segmentFromWords", () => {
  test("empty words → single synthetic segment carrying the full text", () => {
    const segs = segmentFromWords([], "fallback text", 0.8);
    expect(segs.length).toBe(1);
    expect(segs[0].text).toBe("fallback text");
    expect(segs[0].t0_ms).toBe(0);
    expect(segs[0].t1_ms).toBe(0);
    expect(segs[0].confidence).toBe(0.8);
  });

  test("words that fit inside 5s collapse to ONE segment", () => {
    const segs = segmentFromWords(
      [
        { start: 0, end: 500, text: "hello", confidence: 0.96 },
        { start: 500, end: 1100, text: "world", confidence: 0.94 },
      ],
      "hello world",
      0.95,
    );
    expect(segs.length).toBe(1);
    expect(segs[0].text).toBe("hello world");
    expect(segs[0].t0_ms).toBe(0);
    expect(segs[0].t1_ms).toBe(1100);
    // mean confidence of the contributing words
    expect(segs[0].confidence).toBeCloseTo(0.95, 5);
  });

  test("words spanning > 5s split across multiple segments at the window boundary", () => {
    // Three windows: 0-4500, 6000-10500, 12000-14500 — each word ~1s.
    const words = [
      ...Array.from({ length: 5 }, (_, i) => ({
        start: i * 900,
        end: (i + 1) * 900,
        text: `a${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        start: 6000 + i * 900,
        end: 6000 + (i + 1) * 900,
        text: `b${i}`,
      })),
      { start: 12000, end: 14500, text: "tail" },
    ];
    const segs = segmentFromWords(words, "unused", undefined);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    // Each segment must honor the 5s ceiling.
    for (const s of segs) {
      expect(s.t1_ms - s.t0_ms).toBeLessThanOrEqual(5_000);
    }
    // Monotonic ordering.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].t0_ms).toBeGreaterThanOrEqual(segs[i - 1].t0_ms);
    }
    // Joined text of all segments equals the full ordered word sequence.
    const joined = segs.map((s) => s.text).join(" ");
    const expected = words.map((w) => w.text).join(" ");
    expect(joined).toBe(expected);
  });

  test("falls back to transcript-level confidence when words lack it", () => {
    const segs = segmentFromWords(
      [
        { start: 0, end: 300, text: "no-conf" },
        { start: 300, end: 700, text: "either" },
      ],
      "unused",
      0.42,
    );
    expect(segs.length).toBe(1);
    expect(segs[0].confidence).toBeCloseTo(0.42, 5);
  });

  test("skips blank-text words without inflating segment count", () => {
    const segs = segmentFromWords(
      [
        { start: 0, end: 100, text: "" },
        { start: 100, end: 200, text: "   " },
        { start: 200, end: 600, text: "real", confidence: 0.9 },
      ],
      "unused",
      undefined,
    );
    expect(segs.length).toBe(1);
    expect(segs[0].text).toBe("real");
    expect(segs[0].confidence).toBeCloseTo(0.9, 5);
  });
});
