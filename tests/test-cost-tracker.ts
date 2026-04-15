// =============================================================================
// Tests: Cost Tracker
//
// Unit tests for token/cost tracking, model pricing lookup, cost calculation,
// session accumulation, and daily persistence.
// =============================================================================

import { test, describe, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CostTracker,
  getModelPricing,
  calculateCost,
  formatTokenCount,
  formatCost,
} from "../src/agent/cost-tracker.js";
import type { TokenUsage } from "../src/agent/types.js";

const testDir = join(tmpdir(), `hawky-cost-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// =============================================================================
// Model pricing lookup
// =============================================================================

describe("getModelPricing", () => {
  test("returns exact pricing for known models", () => {
    const opus = getModelPricing("claude-opus-4-6");
    expect(opus.input).toBe(5);
    expect(opus.output).toBe(25);
    expect(opus.cacheRead).toBe(0.50);
    expect(opus.cacheWrite).toBe(6.25);
  });

  test("returns pricing for Sonnet 4.6", () => {
    const sonnet = getModelPricing("claude-sonnet-4-6");
    expect(sonnet.input).toBe(3);
    expect(sonnet.output).toBe(15);
  });

  test("returns pricing for Haiku 4.5", () => {
    const haiku = getModelPricing("claude-haiku-4-5");
    expect(haiku.input).toBe(1);
    expect(haiku.output).toBe(5);
  });

  test("strips date suffix for matching", () => {
    const p = getModelPricing("claude-sonnet-4-6-20260101");
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
  });

  test("returns default pricing for unknown models", () => {
    const p = getModelPricing("unknown-model-xyz");
    expect(p.input).toBe(3); // Default = Sonnet rates
    expect(p.output).toBe(15);
  });

  test("legacy Opus 4.1 has higher pricing", () => {
    const p = getModelPricing("claude-opus-4-1");
    expect(p.input).toBe(15);
    expect(p.output).toBe(75);
  });

  // Exact match for OpenAI flagship lineup
  test("gpt-5.5 exact match", () => {
    const p = getModelPricing("gpt-5.5");
    expect(p.input).toBe(5);
    expect(p.output).toBe(30);
  });

  test("gpt-5.4 exact match", () => {
    const p = getModelPricing("gpt-5.4");
    expect(p.input).toBe(2.5);
    expect(p.output).toBe(15);
  });

  test("gpt-5.4-mini exact match", () => {
    const p = getModelPricing("gpt-5.4-mini");
    expect(p.input).toBe(0.75);
    expect(p.output).toBe(4.5);
  });

  test("gpt-5.4-nano exact match", () => {
    const p = getModelPricing("gpt-5.4-nano");
    expect(p.input).toBe(0.2);
    expect(p.output).toBe(1.25);
  });

  test("gpt-5.4-pro exact match", () => {
    const p = getModelPricing("gpt-5.4-pro");
    expect(p.input).toBe(30);
    expect(p.output).toBe(180);
    expect(p.cacheRead).toBe(30); // "—" cached input → bills at full input rate
  });

  test("gpt-5.5-pro cacheRead equals input rate (page shows '—')", () => {
    const p = getModelPricing("gpt-5.5-pro");
    expect(p.cacheRead).toBe(p.input);
    expect(p.cacheRead).toBe(30);
  });

  test("gpt-5.3-chat-latest exact match", () => {
    const p = getModelPricing("gpt-5.3-chat-latest");
    expect(p.input).toBe(1.75);
    expect(p.output).toBe(14);
    expect(p.cacheRead).toBe(0.175);
  });

  test("gpt-5.3-codex exact match", () => {
    const p = getModelPricing("gpt-5.3-codex");
    expect(p.input).toBe(1.75);
    expect(p.output).toBe(14);
    expect(p.cacheRead).toBe(0.175);
  });

  // Removed models fall through to DEFAULT_PRICING
  test("gpt-4o (removed) falls through to DEFAULT_PRICING", () => {
    const p = getModelPricing("gpt-4o");
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
  });

  // Unknown model falls through to DEFAULT_PRICING (Sonnet rates)
  test("claude-future-9 falls through to DEFAULT_PRICING", () => {
    const p = getModelPricing("claude-future-9");
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
  });

  test("slash-namespaced self-hosted model returns zero pricing", () => {
    const p = getModelPricing("meta-llama/Llama-3.1-8B-Instruct");
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
    expect(p.cacheRead).toBe(0);
    expect(p.cacheWrite).toBe(0);
  });

  test("slash-namespaced Qwen also returns zero pricing", () => {
    const p = getModelPricing("Qwen/Qwen2.5-72B-Instruct");
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
  });

  test("unknown model warns once per process", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      // First lookup: warns
      getModelPricing("totally-unknown-model-once");
      // Second lookup of same model: silent
      getModelPricing("totally-unknown-model-once");
      const matches = warnings.filter((w) => w.includes("totally-unknown-model-once"));
      expect(matches.length).toBe(1);
      expect(matches[0]).toContain("no pricing entry");
    } finally {
      console.warn = orig;
    }
  });
});

// =============================================================================
// Cost calculation
// =============================================================================

describe("calculateCost", () => {
  test("calculates basic input/output cost", () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
    const cost = calculateCost("claude-sonnet-4-6", usage);
    // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 4);
  });

  test("includes cache read tokens", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 10000,
    };
    const cost = calculateCost("claude-sonnet-4-6", usage);
    // input: 1000*3 = 3000, output: 500*15 = 7500, cache_read: 10000*0.30 = 3000
    // total: 13500 / 1M = 0.0135
    expect(cost).toBeCloseTo(0.0135, 4);
  });

  test("includes cache creation tokens", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 5000,
    };
    const cost = calculateCost("claude-sonnet-4-6", usage);
    // input: 3000, output: 7500, cache_write: 5000*3.75 = 18750
    // total: 29250 / 1M = 0.029250
    expect(cost).toBeCloseTo(0.02925, 4);
  });

  test("Opus 4.6 costs more than Sonnet", () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 1000 };
    const opusCost = calculateCost("claude-opus-4-6", usage);
    const sonnetCost = calculateCost("claude-sonnet-4-6", usage);
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  test("zero tokens = zero cost", () => {
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    expect(calculateCost("claude-sonnet-4-6", usage)).toBe(0);
  });
});

// =============================================================================
// CostTracker accumulation
// =============================================================================

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    const dir = join(testDir, `tracker-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    tracker = new CostTracker(dir);
  });

  test("starts with zero usage", () => {
    const session = tracker.getSessionUsage("test:main");
    expect(session.inputTokens).toBe(0);
    expect(session.outputTokens).toBe(0);
    expect(session.costUSD).toBe(0);
  });

  test("accumulates session usage across calls", () => {
    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500 }, "test:main");
    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 2000, output_tokens: 300 }, "test:main");

    const session = tracker.getSessionUsage("test:main");
    expect(session.inputTokens).toBe(3000);
    expect(session.outputTokens).toBe(800);
    expect(session.costUSD).toBeGreaterThan(0);
  });

  test("accumulates daily usage", () => {
    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500 }, "test:main");
    const daily = tracker.getDailyUsage();
    expect(daily.tokens.input).toBe(1000);
    expect(daily.tokens.output).toBe(500);
    expect(daily.apiCalls).toBe(1);
  });

  test("tracks per-model breakdown", () => {
    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500 }, "test:main");
    tracker.addUsage("claude-opus-4-6", { input_tokens: 2000, output_tokens: 300 }, "test:main");

    const daily = tracker.getDailyUsage();
    expect(daily.byModel["claude-sonnet-4-6"]).toBeDefined();
    expect(daily.byModel["claude-opus-4-6"]).toBeDefined();
    expect(daily.byModel["claude-sonnet-4-6"].input).toBe(1000);
    expect(daily.byModel["claude-opus-4-6"].input).toBe(2000);
  });

  test("tracks cache tokens", () => {
    tracker.addUsage("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
    }, "test:main");

    const session = tracker.getSessionUsage("test:main");
    expect(session.cacheReadTokens).toBe(5000);
    expect(session.cacheCreationTokens).toBe(2000);
  });

  test("resetSession clears session but not daily", () => {
    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500 }, "test:main");
    tracker.resetSession("test:main");

    const session = tracker.getSessionUsage("test:main");
    expect(session.inputTokens).toBe(0);
    expect(session.costUSD).toBe(0);

    const daily = tracker.getDailyUsage();
    expect(daily.tokens.input).toBe(1000); // Daily is preserved
  });
});

// =============================================================================
// Daily persistence
// =============================================================================

describe("CostTracker persistence", () => {
  test("persists daily usage to JSON file", () => {
    const dir = join(testDir, `persist-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const tracker = new CostTracker(dir);

    tracker.addUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500 }, "test:main");
    tracker.persistDaily();

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(dir, `${today}.json`);
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(data.tokens.input).toBe(1000);
    expect(data.tokens.output).toBe(500);
    expect(data.costUSD).toBeGreaterThan(0);
    expect(data.apiCalls).toBe(1);
  });

  test("loads existing daily usage on startup", () => {
    const dir = join(testDir, `load-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    // First tracker writes data
    const tracker1 = new CostTracker(dir);
    tracker1.addUsage("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500 });
    tracker1.persistDaily();

    // Second tracker loads it
    const tracker2 = new CostTracker(dir);
    const daily = tracker2.getDailyUsage();
    expect(daily.tokens.input).toBe(1000);
    expect(daily.tokens.output).toBe(500);
  });
});

// =============================================================================
// Formatting
// =============================================================================

describe("formatTokenCount", () => {
  test("small numbers shown as-is", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("thousands shown as K", () => {
    expect(formatTokenCount(1234)).toBe("1.2K");
    expect(formatTokenCount(12345)).toBe("12.3K");
    expect(formatTokenCount(999999)).toBe("1000.0K");
  });

  test("millions shown as M", () => {
    expect(formatTokenCount(1_234_567)).toBe("1.23M");
  });
});

describe("formatCost", () => {
  test("zero cost", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  test("small cost", () => {
    expect(formatCost(0.0345)).toBe("$0.03");
  });

  test("dollar amounts", () => {
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(12.5)).toBe("$12.50");
  });
});

// =============================================================================
// Audit-cleanup additions: per-model cache split + periodic flush + dispose
// =============================================================================

describe("per-model cache breakdown (audit BUG #5)", () => {
  test("dailyByModel tracks cacheRead and cacheCreation per model", () => {
    const t = new CostTracker(testDir, { periodicFlushMs: 0 });
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
    };
    t.addUsage("claude-opus-4-7", usage, "test:s1");
    const daily = t.getDailyUsage();
    const opus = daily.byModel["claude-opus-4-7"];
    expect(opus).toBeDefined();
    expect(opus.cacheRead).toBe(5000);
    expect(opus.cacheCreation).toBe(2000);
    // Sanity: legacy fields still tracked
    expect(opus.input).toBe(100);
    expect(opus.output).toBe(50);
    t.dispose();
  });

  test("loadDailyFromDisk backfills missing cache fields as 0 (legacy JSON)", () => {
    // Older daily JSON files (written before this PR) lack cacheRead /
    // cacheCreation in byModel. Loading them must not crash and the
    // missing fields should default to 0, ready to accumulate forward.
    const isoDir = join(tmpdir(), `hawky-legacy-load-${Date.now()}`);
    mkdirSync(isoDir, { recursive: true });
    // Write a legacy-shape file under today's date
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const filePath = join(isoDir, `${y}-${m}-${d}.json`);
    require("node:fs").writeFileSync(
      filePath,
      JSON.stringify({
        date: `${y}-${m}-${d}`,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
        costUSD: 0.001,
        byModel: { "claude-opus-4-7": { input: 100, output: 50, costUSD: 0.001 } },
        apiCalls: 1,
      }),
    );
    const t = new CostTracker(isoDir, { periodicFlushMs: 0 });
    const daily = t.getDailyUsage();
    expect(daily.byModel["claude-opus-4-7"].cacheRead).toBe(0);
    expect(daily.byModel["claude-opus-4-7"].cacheCreation).toBe(0);
    expect(daily.byModel["claude-opus-4-7"].input).toBe(100);
    t.dispose();
    rmSync(isoDir, { recursive: true, force: true });
  });
});

describe("periodic flush + dispose (audit BUG #7)", () => {
  test("constructor accepts periodicFlushMs option (0 disables timer)", () => {
    // Smoke test: construct with periodicFlushMs:0 and ensure no timer
    // is set (dispose is a no-op).
    const t = new CostTracker(testDir, { periodicFlushMs: 0 });
    t.dispose();
    expect(true).toBe(true); // didn't throw
  });

  test("usageHistory byModel rollup includes cacheRead + cacheCreation (Codex P2 regression)", async () => {
    // Codex caught: status.ts/loadUsageHistory was summing only input+output
    // when rolling up per-model totals across days. With the new cache
    // breakdown landing in the daily JSON, that omission would silently
    // under-report cached workloads in the TUI/web history view.
    const isoDir = join(tmpdir(), `hawky-history-rollup-${Date.now()}`);
    mkdirSync(isoDir, { recursive: true });
    // Run a turn that bills heavy cache_read so the field is non-zero
    const t = new CostTracker(isoDir, { periodicFlushMs: 0 });
    t.addUsage("claude-opus-4-7", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
    }, "s1");
    t.persistDaily();
    t.dispose();
    // Read it back via loadUsageHistory and confirm the rollup includes cache tokens
    const { loadUsageHistory } = await import("../src/gateway/status.js");
    const hist = loadUsageHistory("all", isoDir);
    const opus = hist.summary.byModel["claude-opus-4-7"];
    expect(opus).toBeDefined();
    // 100 input + 50 output + 5000 cacheRead + 2000 cacheCreation = 7150
    expect(opus.tokens).toBe(7150);
    rmSync(isoDir, { recursive: true, force: true });
  });

  test("periodic flush actually writes to disk after the interval", async () => {
    const isoDir = join(tmpdir(), `hawky-flush-test-${Date.now()}`);
    mkdirSync(isoDir, { recursive: true });
    const t = new CostTracker(isoDir, { periodicFlushMs: 50 });
    t.addUsage("claude-opus-4-7", { input_tokens: 10, output_tokens: 5 }, "s1");
    // Wait long enough for the timer to fire at least once.
    await new Promise((r) => setTimeout(r, 120));
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const filePath = join(isoDir, `${y}-${m}-${d}.json`);
    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(written.tokens.input).toBe(10);
    t.dispose();
    rmSync(isoDir, { recursive: true, force: true });
  });
});
