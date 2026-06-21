// =============================================================================
// test-surface-scenarios.ts — M9 "9d" offline regression test.
//
// Asserts DeterministicLatentRecognizer + DeterministicRelevanceGate behavior
// on the unambiguous cases from tests/fixtures/surface-scenarios.jsonl.
// Runs without a model key (deterministic only).
//
// Run: bun test ./tests/test-surface-scenarios.ts
// =============================================================================

import { describe, expect, test } from "bun:test";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import {
  DeterministicLatentRecognizer,
  type RecognizerInput,
} from "../src/ambient/latent-recognizer.js";
import {
  DeterministicRelevanceGate,
  type RelevanceInput,
} from "../src/ambient/relevance-gate.js";
import type { Intention } from "../src/ambient/intention.js";

// ---------------------------------------------------------------------------
// Corpus loader
// ---------------------------------------------------------------------------

interface ArmedLatentSpec {
  id: string;
  content: string;
  topic: string;
  confidence: number;
}

interface ScenarioRecord {
  id: string;
  label: string;
  window: { role: "user" | "assistant"; text: string; ts: string }[];
  armedLatents: ArmedLatentSpec[];
  goldMint: string[];
  goldSurface: string[];
  note: string;
}

async function loadCorpus(): Promise<ScenarioRecord[]> {
  const path = join(import.meta.dir, "fixtures", "surface-scenarios.jsonl");
  const records: ScenarioRecord[] = [];
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) records.push(JSON.parse(trimmed) as ScenarioRecord);
  }
  return records;
}

function buildIntention(spec: ArmedLatentSpec): Intention {
  return {
    id: spec.id,
    content: spec.content,
    trigger: {
      all: [{ kind: "topic", topic: spec.topic, provenance: "inferred", confidence: spec.confidence }],
    },
    strength: "soft",
    origin: "latent",
    state: "armed",
    evidence: { ts: "2026-06-07T00:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-07T00:00:00Z",
  };
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Unambiguous recognizer test cases — deterministic should pass these exactly
// (excludes sc05/sc22 which have known deterministic limitations documented in corpus)
// ---------------------------------------------------------------------------

const RECOGNIZER_SKIP = new Set([
  "sc05", // pronoun anaphora: "bought some" — deterministic can't resolve "some" → expected FP
  "sc22", // already-armed: deterministic mints even when armed — handled by downstream dedup
  "sc13", // armed latent present; gold is "buy coffee" (deterministic mints; model skips by design)
]);

// Gate test cases that are deterministic-only (no LLM paraphrase needed)
const GATE_SKIP = new Set([
  "sc12", // paraphrase: "java" → coffee — deterministic gate can't handle paraphrase; LLM-only
  "sc15", // suppressed-context: "talked about milk already, moving on" — LLM-only intent
  "sc24", // paraphrase: "brew" → coffee — LLM-only
  "sc39", // paraphrase: "caffeine" → coffee — LLM-only
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const rec = new DeterministicLatentRecognizer();
const gate = new DeterministicRelevanceGate();

let corpus: ScenarioRecord[] = [];
const corpusReady = loadCorpus().then((c) => { corpus = c; });

describe("DeterministicLatentRecognizer — surface-scenarios corpus", () => {
  // Positive cases: should mint at least the expected items
  const positives = [
    "sc01", "sc02", "sc03", "sc04", "sc14", "sc19", "sc21", "sc28", "sc34", "sc35", "sc38", "sc44",
  ];

  for (const id of positives) {
    test(`${id}: mints expected item(s)`, async () => {
      await corpusReady;
      const scenario = corpus.find((s) => s.id === id);
      if (!scenario) throw new Error(`Scenario ${id} not found in corpus`);

      const input: RecognizerInput = {
        window: scenario.window,
        recentIntentions: scenario.armedLatents.map(buildIntention),
        now: Date.parse("2026-06-07T10:00:00Z"),
        tz: "America/Los_Angeles",
      };
      const minted = await rec.recognize(input);
      const mintedNorm = minted.map((m) => norm(m.content));

      for (const expected of scenario.goldMint) {
        expect(mintedNorm).toContain(norm(expected));
      }
    });
  }

  // Negative cases: should NOT mint anything
  const negatives = [
    "sc06", "sc07", "sc08", "sc09", "sc10", "sc16", "sc17", "sc18",
    "sc20", "sc27", "sc29", "sc30", "sc31", "sc32", "sc37", "sc40", "sc41", "sc42", "sc43",
  ];

  for (const id of negatives) {
    test(`${id}: mints nothing`, async () => {
      await corpusReady;
      const scenario = corpus.find((s) => s.id === id);
      if (!scenario) throw new Error(`Scenario ${id} not found in corpus`);

      const input: RecognizerInput = {
        window: scenario.window,
        recentIntentions: scenario.armedLatents.map(buildIntention),
        now: Date.parse("2026-06-07T10:00:00Z"),
        tz: "America/Los_Angeles",
      };
      const minted = await rec.recognize(input);
      expect(minted).toHaveLength(0);
    });
  }

  // Multi-need: exactly the right items minted
  test("sc04: both needs minted (coffee + milk)", async () => {
    await corpusReady;
    const scenario = corpus.find((s) => s.id === "sc04")!;
    const input: RecognizerInput = {
      window: scenario.window,
      recentIntentions: [],
      now: Date.parse("2026-06-07T10:00:00Z"),
      tz: "America/Los_Angeles",
    };
    const minted = await rec.recognize(input);
    const contents = minted.map((m) => norm(m.content));
    expect(contents).toContain("buy coffee");
    expect(contents).toContain("buy milk");
  });

  // Satisfaction removes the right item but not others
  test("sc21: coffee satisfied → only milk minted", async () => {
    await corpusReady;
    const scenario = corpus.find((s) => s.id === "sc21")!;
    const input: RecognizerInput = {
      window: scenario.window,
      recentIntentions: [],
      now: Date.parse("2026-06-07T10:00:00Z"),
      tz: "America/Los_Angeles",
    };
    const minted = await rec.recognize(input);
    const contents = minted.map((m) => norm(m.content));
    expect(contents).toContain("buy milk");
    expect(contents).not.toContain("buy coffee");
  });
});

describe("DeterministicRelevanceGate — surface-scenarios corpus", () => {
  // Surfaces when topic is directly mentioned
  const shouldSurface = ["sc13", "sc14", "sc22", "sc26", "sc44"];

  for (const id of shouldSurface) {
    test(`${id}: surfaces expected latents`, async () => {
      await corpusReady;
      const scenario = corpus.find((s) => s.id === id);
      if (!scenario || scenario.armedLatents.length === 0) return;

      const input: RelevanceInput = {
        armed: scenario.armedLatents.map(buildIntention),
        window: scenario.window,
        now: Date.parse("2026-06-07T10:00:00Z"),
        tz: "America/Los_Angeles",
      };
      const verdicts = await gate.evaluate(input);
      const surfaced = new Set(verdicts.filter((v) => v.surface).map((v) => v.id));

      for (const id of scenario.goldSurface) {
        expect(surfaced.has(id)).toBe(true);
      }
    });
  }

  // Does not surface on unrelated conversation
  test("sc33: unrelated conversation — no armed latents surface", async () => {
    await corpusReady;
    const scenario = corpus.find((s) => s.id === "sc33")!;
    const input: RelevanceInput = {
      armed: scenario.armedLatents.map(buildIntention),
      window: scenario.window,
      now: Date.parse("2026-06-07T10:00:00Z"),
      tz: "America/Los_Angeles",
    };
    const verdicts = await gate.evaluate(input);
    const anySurfaced = verdicts.some((v) => v.surface);
    expect(anySurfaced).toBe(false);
  });

  // Does not surface when grocery store is mentioned but not the specific item
  test("sc25: grocery store mentioned but eggs not mentioned → eggs latent does not surface", async () => {
    await corpusReady;
    const scenario = corpus.find((s) => s.id === "sc25")!;
    const input: RelevanceInput = {
      armed: scenario.armedLatents.map(buildIntention),
      window: scenario.window,
      now: Date.parse("2026-06-07T10:00:00Z"),
      tz: "America/Los_Angeles",
    };
    const verdicts = await gate.evaluate(input);
    const surfaced = verdicts.filter((v) => v.surface);
    expect(surfaced).toHaveLength(0);
  });
});
