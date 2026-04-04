// =============================================================================
// Cost Tracker
//
// Tracks API token usage and estimates cost based on official Anthropic pricing.
// Maintains per-session totals and per-day totals. Persists daily usage to
// ~/.hawky/usage/YYYY-MM-DD.json on shutdown and hourly flush.
//
// Pricing verified from docs.anthropic.com (April 2026).
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TokenUsage } from "./types.js";

// -----------------------------------------------------------------------------
// Model pricing (per million tokens, USD)
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// -----------------------------------------------------------------------------

interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;   // 1.25x base input (5-minute cache)
  cacheRead: number;    // 0.1x base input
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Current models
  // Opus 4.7 pricing assumed same as 4.6 until Anthropic publishes
  // an update; adjust when the official rate card changes.
  "claude-opus-4-7":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-6":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-sonnet-4-6": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":  { input: 1,  output: 5,  cacheWrite: 1.25, cacheRead: 0.10 },

  // Legacy models (still in use)
  "claude-opus-4-5":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-sonnet-4-5": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-opus-4-1":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4":     { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-sonnet-4":   { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-3-5":  { input: 0.80, output: 4, cacheWrite: 1.00, cacheRead: 0.08 },

  // OpenAI flagship lineup — source: https://developers.openai.com/api/docs/pricing
  // (verified 2026-05-02). cacheWrite is 0 (OpenAI bills only on cache
  // hits, not writes); cacheRead is the "Cached input" column. Models
  // whose page row shows "—" for cached input bill cache hits at the
  // full input rate, so cacheRead === input for those rows.
  "gpt-5.5":             { input: 5.00, output: 30,  cacheWrite: 0, cacheRead: 0.50  },
  "gpt-5.5-pro":         { input: 30,   output: 180, cacheWrite: 0, cacheRead: 30    },
  "gpt-5.4":             { input: 2.50, output: 15,  cacheWrite: 0, cacheRead: 0.25  },
  "gpt-5.4-pro":         { input: 30,   output: 180, cacheWrite: 0, cacheRead: 30    },
  "gpt-5.4-mini":        { input: 0.75, output: 4.50, cacheWrite: 0, cacheRead: 0.075 },
  "gpt-5.4-nano":        { input: 0.20, output: 1.25, cacheWrite: 0, cacheRead: 0.02  },
  "gpt-5.3-chat-latest": { input: 1.75, output: 14,   cacheWrite: 0, cacheRead: 0.175 },
  "gpt-5.3-codex":       { input: 1.75, output: 14,   cacheWrite: 0, cacheRead: 0.175 },
};

// Default pricing for unknown models (use Sonnet rates as safe middle ground)
const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

// Self-hosted OpenAI-compatible models (vLLM/Ollama/etc.) are slash-namespaced
// like "meta-llama/Llama-3.1-8B-Instruct" or "Qwen/Qwen2.5-72B". Bill at zero.
const ZERO_PRICING: ModelPricing = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

const _warnedUnknownModels = new Set<string>();

/** Periodic disk flush — protects against losing today's accumulated cost
 *  data if the gateway crashes hard before its shutdown handler fires.
 *  Without this, a SIGKILL or OOM mid-day silently drops everything since
 *  the last day-rollover. 5 minutes is the granularity of acceptable loss
 *  for a dev assistant — short enough that you'd notice missing cost data
 *  on a single bad turn, long enough that we're not pegging the disk. */
const PERIODIC_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
}

export interface DailyUsage {
  date: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  costUSD: number;
  /** Per-model breakdown of today's usage. cacheRead / cacheCreation are
   *  optional for backward compatibility with existing on-disk JSON files
   *  written before this field was tracked. */
  byModel: Record<string, {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
    costUSD: number;
  }>;
  apiCalls: number;
}

// -----------------------------------------------------------------------------
// Cost calculation
// -----------------------------------------------------------------------------

/** Look up pricing for a model ID. Strips date suffixes for matching. */
export function getModelPricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Slash-namespaced (e.g. "meta-llama/Llama-3.1-8B") = self-hosted; zero cost.
  if (model.includes("/")) return ZERO_PRICING;

  // Strip date suffix (e.g., claude-sonnet-4-6-20260101 → claude-sonnet-4-6)
  const base = model.replace(/-\d{8}$/, "");
  if (MODEL_PRICING[base]) return MODEL_PRICING[base];

  if (!_warnedUnknownModels.has(model)) {
    _warnedUnknownModels.add(model);
    console.warn(`[cost-tracker] no pricing entry for model "${model}" — billing at default rate`);
  }
  return DEFAULT_PRICING;
}

/** Calculate USD cost for a single API call's token usage. */
export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = getModelPricing(model);

  const inputCost = (usage.input_tokens * pricing.input) / 1_000_000;
  const outputCost = (usage.output_tokens * pricing.output) / 1_000_000;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) * pricing.cacheRead) / 1_000_000;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) * pricing.cacheWrite) / 1_000_000;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

// -----------------------------------------------------------------------------
// Cost Tracker (singleton per gateway)
// -----------------------------------------------------------------------------

export class CostTracker {
  // Per-session totals (keyed by sessionKey)
  private sessions = new Map<string, UsageSnapshot>();

  // Daily totals (reset at midnight)
  private dailyDate = formatDate(new Date());
  private dailyInput = 0;
  private dailyOutput = 0;
  private dailyCacheRead = 0;
  private dailyCacheCreation = 0;
  private dailyCost = 0;
  private dailyApiCalls = 0;
  private dailyByModel: Record<string, {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    costUSD: number;
  }> = {};

  private usageDir: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(usageDir?: string, options?: { periodicFlushMs?: number }) {
    this.usageDir = usageDir ?? join(homedir(), ".hawky", "usage");
    if (!existsSync(this.usageDir)) {
      mkdirSync(this.usageDir, { recursive: true });
    }
    // Load today's existing usage if gateway restarts mid-day
    this.loadDailyFromDisk();
    // Periodic flush so a hard crash (SIGKILL, OOM) before the shutdown
    // hook fires doesn't lose today's accumulated cost data. Interval is
    // configurable for tests; defaults to 5 minutes in production. Set to
    // 0 to disable (useful in unit tests that use throwaway directories).
    const intervalMs = options?.periodicFlushMs ?? PERIODIC_FLUSH_INTERVAL_MS;
    if (intervalMs > 0) {
      this.flushTimer = setInterval(() => {
        try { this.persistDaily(); } catch { /* persistDaily already swallows */ }
      }, intervalMs);
      // Don't keep the event loop alive just to flush — if the process is
      // otherwise idle, we want it to exit cleanly via shutdown handlers.
      this.flushTimer.unref?.();
    }
  }

  /** Stop the periodic flush timer (call on shutdown / before discarding). */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Record usage from a single API call, scoped to a session. */
  addUsage(model: string, usage: TokenUsage, sessionKey?: string): void {
    const cost = calculateCost(model, usage);
    const today = formatDate(new Date());

    // Roll over daily counters at midnight
    if (today !== this.dailyDate) {
      this.persistDaily();
      this.resetDaily(today);
    }

    // Per-session accumulation
    if (sessionKey) {
      const s = this.sessions.get(sessionKey) ?? {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0,
      };
      s.inputTokens += usage.input_tokens;
      s.outputTokens += usage.output_tokens;
      s.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      s.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      s.costUSD += cost;
      this.sessions.set(sessionKey, s);
    }

    // Daily accumulation
    this.dailyInput += usage.input_tokens;
    this.dailyOutput += usage.output_tokens;
    this.dailyCacheRead += usage.cache_read_input_tokens ?? 0;
    this.dailyCacheCreation += usage.cache_creation_input_tokens ?? 0;
    this.dailyCost += cost;
    this.dailyApiCalls++;

    // Per-model breakdown — includes the cache split so analytics can
    // tell which model is benefitting most from prompt caching (cacheRead
    // is billed at ~10% of base, cacheCreation at ~125%; the difference
    // matters for spend forecasting).
    const modelKey = model.replace(/-\d{8}$/, ""); // Normalize
    if (!this.dailyByModel[modelKey]) {
      this.dailyByModel[modelKey] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUSD: 0 };
    }
    this.dailyByModel[modelKey].input += usage.input_tokens;
    this.dailyByModel[modelKey].output += usage.output_tokens;
    this.dailyByModel[modelKey].cacheRead += usage.cache_read_input_tokens ?? 0;
    this.dailyByModel[modelKey].cacheCreation += usage.cache_creation_input_tokens ?? 0;
    this.dailyByModel[modelKey].costUSD += cost;
  }

  /** Get usage snapshot for a specific session. */
  getSessionUsage(sessionKey?: string): UsageSnapshot {
    if (!sessionKey) {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0 };
    }
    return this.sessions.get(sessionKey) ?? {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0,
    };
  }

  /** Get today's daily usage. */
  getDailyUsage(): DailyUsage {
    return {
      date: this.dailyDate,
      tokens: {
        input: this.dailyInput,
        output: this.dailyOutput,
        cacheRead: this.dailyCacheRead,
        cacheCreation: this.dailyCacheCreation,
      },
      costUSD: this.dailyCost,
      byModel: { ...this.dailyByModel },
      apiCalls: this.dailyApiCalls,
    };
  }

  /** Reset session counters for a specific session. */
  resetSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /** Persist today's daily usage to disk atomically (temp + rename).
   *  Called on shutdown + periodic flush. */
  persistDaily(): void {
    const data = this.getDailyUsage();
    const filePath = join(this.usageDir, `${this.dailyDate}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, filePath);
    } catch {
      // Non-fatal — usage is still in memory
    }
  }

  /** Load today's daily totals from disk (for gateway restart mid-day). */
  private loadDailyFromDisk(): void {
    const filePath = join(this.usageDir, `${this.dailyDate}.json`);
    if (!existsSync(filePath)) return;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as DailyUsage;
      this.dailyInput = data.tokens?.input ?? 0;
      this.dailyOutput = data.tokens?.output ?? 0;
      this.dailyCacheRead = data.tokens?.cacheRead ?? 0;
      this.dailyCacheCreation = data.tokens?.cacheCreation ?? 0;
      this.dailyCost = data.costUSD ?? 0;
      this.dailyApiCalls = data.apiCalls ?? 0;
      // Backfill cacheRead/cacheCreation as 0 on entries written before
      // those fields existed — keeps the in-memory shape consistent and
      // lets new accumulation start from the legacy total.
      const loadedByModel = data.byModel ?? {};
      this.dailyByModel = {};
      for (const [k, v] of Object.entries(loadedByModel)) {
        this.dailyByModel[k] = {
          input: v.input ?? 0,
          output: v.output ?? 0,
          cacheRead: (v as any).cacheRead ?? 0,
          cacheCreation: (v as any).cacheCreation ?? 0,
          costUSD: v.costUSD ?? 0,
        };
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  private resetDaily(newDate: string): void {
    this.dailyDate = newDate;
    this.dailyInput = 0;
    this.dailyOutput = 0;
    this.dailyCacheRead = 0;
    this.dailyCacheCreation = 0;
    this.dailyCost = 0;
    this.dailyApiCalls = 0;
    this.dailyByModel = {};
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Format date as YYYY-MM-DD in local timezone (not UTC). */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a token count for display (e.g., 12345 → "12.3K"). */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format a USD cost for display (e.g., 0.0345 → "$0.03"). */
export function formatCost(usd: number): string {
  if (usd < 0.005) return "$0.00";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

// Global singleton (set by gateway startup)
let globalTracker: CostTracker | null = null;

export function setCostTracker(tracker: CostTracker): void {
  globalTracker = tracker;
}

export function getCostTracker(): CostTracker | null {
  return globalTracker;
}
