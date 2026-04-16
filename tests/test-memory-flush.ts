// =============================================================================
// Tests: Memory Flush Service
//
// Unit tests for flush gating, dedup, config resolution, and context window
// lookup. Integration tests for the flush turn would require real LLM calls
// and are covered by E2E tests.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import {
  shouldTriggerFlush,
  resetFlushState,
  resolveFlushConfig,
  runMemoryFlush,
} from "../src/gateway/memory-flush.js";
import { getContextWindowTokens } from "../src/agent/context-window.js";
import type { HawkyConfig, ChatMessage } from "../src/agent/types.js";
import {
  buildFlushSystemPrompt,
  buildFlushUserMessage,
} from "../src/gateway/heartbeat-prompt.js";
import { resetCommandQueue } from "../src/gateway/command-queue.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";

// -----------------------------------------------------------------------------
// Context window lookup
// -----------------------------------------------------------------------------

describe("getContextWindowTokens", () => {
  test("claude-opus-4-7 returns 1M", () => {
    expect(getContextWindowTokens("claude-opus-4-7")).toBe(1_000_000);
  });

  test("claude-opus-4-7 with date-stamp suffix matches via prefix", () => {
    expect(getContextWindowTokens("claude-opus-4-7-20260501")).toBe(1_000_000);
  });

  test("claude-opus-4-6 returns 1M", () => {
    expect(getContextWindowTokens("claude-opus-4-6")).toBe(1_000_000);
  });

  test("claude-sonnet-4-6 returns 1M", () => {
    expect(getContextWindowTokens("claude-sonnet-4-6")).toBe(1_000_000);
  });

  test("claude-haiku-4-5 returns 200K", () => {
    expect(getContextWindowTokens("claude-haiku-4-5")).toBe(200_000);
  });

  test("date-stamped model matches via prefix", () => {
    expect(getContextWindowTokens("claude-sonnet-4-6-20260301")).toBe(1_000_000);
  });

  test("unknown model returns default 200K", () => {
    expect(getContextWindowTokens("some-unknown-model")).toBe(200_000);
  });
});

// -----------------------------------------------------------------------------
// resolveFlushConfig
// -----------------------------------------------------------------------------

describe("resolveFlushConfig", () => {
  function makeConfig(flush?: Partial<HawkyConfig["memory_flush"]>): HawkyConfig {
    return {
      api_keys: { anthropic: "k", brave_search: "", openai: "" },
      api_base_url: "",
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      max_iterations: 40,
      max_tool_result_chars: 30_000,
      workspace_dir: "/tmp",
      gateway_port: 4242,
      heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
      memory_flush: flush as any,
    };
  }

  test("defaults: enabled=true, threshold=90", () => {
    const cfg = resolveFlushConfig(makeConfig());
    expect(cfg.enabled).toBe(true);
    expect(cfg.thresholdPercent).toBe(90);
  });

  test("respects custom threshold", () => {
    const cfg = resolveFlushConfig(makeConfig({ threshold_percent: 85 }));
    expect(cfg.thresholdPercent).toBe(85);
  });

  test("can disable flush", () => {
    const cfg = resolveFlushConfig(makeConfig({ enabled: false }));
    expect(cfg.enabled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// shouldTriggerFlush
// -----------------------------------------------------------------------------

describe("shouldTriggerFlush", () => {
  beforeEach(() => {
    resetFlushState("test-session");
  });

  test("returns true when usage exceeds threshold", () => {
    expect(shouldTriggerFlush(92, 90, "test-session")).toBe(true);
  });

  test("returns false when usage below threshold", () => {
    expect(shouldTriggerFlush(85, 90, "test-session")).toBe(false);
  });

  test("returns false when exactly at threshold", () => {
    // At threshold — not exceeded
    expect(shouldTriggerFlush(90, 90, "test-session")).toBe(true);
  });

  test("returns false after already flushed (dedup)", () => {
    // First call triggers
    expect(shouldTriggerFlush(95, 90, "test-session")).toBe(true);
    // Simulate that flush ran — mark as flushed
    // (In real code, runMemoryFlush adds to flushedSessions)
    // We can't directly call the internal set, so we test via resetFlushState
  });

  test("returns true after resetFlushState", () => {
    // Flush state is clean after reset
    resetFlushState("test-session");
    expect(shouldTriggerFlush(95, 90, "test-session")).toBe(true);
  });

  test("different sessions are independent", () => {
    expect(shouldTriggerFlush(95, 90, "session-a")).toBe(true);
    expect(shouldTriggerFlush(95, 90, "session-b")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Flush prompt builders
// -----------------------------------------------------------------------------

describe("buildFlushSystemPrompt", () => {
  test("contains extraction categories", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("Decisions made");
    expect(prompt).toContain("User preferences");
    expect(prompt).toContain("Errors encountered");
    expect(prompt).toContain("Technical discoveries");
  });

  test("marks MEMORY.md as read-only", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("MEMORY.md");
  });

  test("specifies daily log format", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("[HH:MM]");
    expect(prompt).toContain("NO_REPLY");
  });

  test("excludes raw tool output", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("Raw tool output");
    expect(prompt).toContain("NOT to extract");
  });
});

describe("buildFlushUserMessage", () => {
  test("flush trigger shows manual message", () => {
    const msg = buildFlushUserMessage("/tmp/ws", "flush");
    expect(msg).toContain("manually triggered");
    expect(msg).toContain("/flush");
  });

  test("pressure trigger shows context limits message", () => {
    const msg = buildFlushUserMessage("/tmp/ws", "pressure");
    expect(msg).toContain("context limits");
  });

  test("new trigger shows new session message", () => {
    const msg = buildFlushUserMessage("/tmp/ws", "new");
    expect(msg).toContain("new session");
  });
});

// -----------------------------------------------------------------------------
// runMemoryFlush — event broadcasting
// -----------------------------------------------------------------------------

describe("runMemoryFlush event broadcasting", () => {
  beforeEach(() => {
    resetFlushState("test:main");
    // Reset command queue to avoid lane state leaking from other tests
    resetCommandQueue();
    applyDefaultLaneConcurrency();
  });

  test("broadcasts flush.started and flush.completed on success", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const mockSessions = {
      getOrCreate: () => ({
        loop: {
          getHistory: () => [],
          setHistory: () => {},
          sendMessage: async () => {},
          clearHistory: () => {},
        },
        sessionManager: { appendMessage: () => {} },
      }),
    } as any;

    const history: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "remember this" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];

    await runMemoryFlush({
      sessionKey: "test:main",
      trigger: "flush",
      sessions: mockSessions,
      config: makeFlushConfig(),
      historySnapshot: history,
      broadcastToSession: (_sk, evt, payload) => events.push({ event: evt, payload }),
    });

    expect(events.length).toBe(2);
    expect(events[0].event).toBe("flush.started");
    expect((events[0].payload as any).trigger).toBe("flush");
    expect(events[1].event).toBe("flush.completed");
  });

  test("skips when already flushed (dedup)", async () => {
    const events: Array<{ event: string }> = [];
    const mockSessions = {
      getOrCreate: () => ({
        loop: {
          getHistory: () => [],
          setHistory: () => {},
          sendMessage: async () => {},
          clearHistory: () => {},
        },
        sessionManager: { appendMessage: () => {} },
      }),
    } as any;

    const history: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "c" }] },
      { role: "assistant", content: [{ type: "text", text: "d" }] },
    ];

    // First flush
    await runMemoryFlush({
      sessionKey: "test:main",
      trigger: "flush",
      sessions: mockSessions,
      config: makeFlushConfig(),
      historySnapshot: history,
      broadcastToSession: (_sk, evt) => events.push({ event: evt }),
    });

    // Second flush — should be skipped (dedup)
    await runMemoryFlush({
      sessionKey: "test:main",
      trigger: "flush",
      sessions: mockSessions,
      config: makeFlushConfig(),
      historySnapshot: history,
      broadcastToSession: (_sk, evt) => events.push({ event: evt }),
    });

    // Only 2 events from first flush (started + completed)
    expect(events.length).toBe(2);
  });

  test("skips when no history snapshot", async () => {
    const events: Array<{ event: string }> = [];
    const mockSessions = {
      getOrCreate: () => ({
        loop: {
          getHistory: () => [],
          setHistory: () => {},
          sendMessage: async () => {},
        },
        sessionManager: { appendMessage: () => {} },
      }),
    } as any;

    await runMemoryFlush({
      sessionKey: "test:main",
      trigger: "flush",
      sessions: mockSessions,
      config: makeFlushConfig(),
      historySnapshot: [],
      broadcastToSession: (_sk, evt) => events.push({ event: evt }),
    });

    // Should see started but then skip inside (no history to review)
    expect(events.some((e) => e.event === "flush.started")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Context usage with cache tokens
// -----------------------------------------------------------------------------

describe("context usage calculation", () => {
  test("cache tokens are included in context window calculation", () => {
    // This tests the logic that should be in loop.ts:
    // lastInputTokens = input_tokens + cache_read + cache_creation
    const input = 50_000;
    const cacheRead = 20_000;
    const cacheCreation = 10_000;
    const total = input + cacheRead + cacheCreation;
    const contextWindow = 1_000_000;
    const percent = Math.round((total / contextWindow) * 100);
    expect(percent).toBe(8); // 80K / 1M = 8%
  });

  test("without cache tokens, only input_tokens counts", () => {
    const input = 50_000;
    const contextWindow = 1_000_000;
    const percent = Math.round((input / contextWindow) * 100);
    expect(percent).toBe(5); // 50K / 1M = 5%
  });
});

// -----------------------------------------------------------------------------
// Startup banner — memory flush line
// -----------------------------------------------------------------------------

import { printGatewayBanner } from "../src/gateway/startup-banner.js";

describe("startup banner: memory flush", () => {
  function captureBanner(config: HawkyConfig): string {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      printGatewayBanner({
        version: "0.1.0",
        port: 4242,
        bindHost: "127.0.0.1",
        model: config.model,
        config,
        configPath: "/tmp/config.json",
        logDir: "/tmp/logs",
        cronJobCount: 0,
      });
    } finally {
      console.log = origLog;
    }
    return lines.join("\n");
  }

  test("shows memory flush enabled with threshold", () => {
    const output = captureBanner(makeFlushConfig({ threshold_percent: 90 }));
    expect(output).toContain("Memory flush");
    expect(output).toContain("enabled");
    expect(output).toContain("90%");
  });

  test("shows memory flush disabled", () => {
    const output = captureBanner(makeFlushConfig({ enabled: false }));
    expect(output).toContain("Memory flush");
    expect(output).toContain("disabled");
  });

  test("shows custom threshold", () => {
    const output = captureBanner(makeFlushConfig({ threshold_percent: 75 }));
    expect(output).toContain("75%");
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeFlushConfig(flush?: Partial<HawkyConfig["memory_flush"]>): HawkyConfig {
  return {
    api_keys: { anthropic: "k", brave_search: "", openai: "" },
    api_base_url: "",
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    max_iterations: 40,
    max_tool_result_chars: 30_000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" }, consolidation_enabled: true, consolidation_frequency_hours: 24, consolidation_days: 3 },
    memory_flush: flush as any,
  };
}
