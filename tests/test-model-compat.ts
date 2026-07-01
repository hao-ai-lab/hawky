import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CLAUDE_HEARTBEAT_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
  normalizeProviderModels,
  resolveHeartbeatModel,
  resolveModelMaxOutputTokens,
  resolveOpenAICompletionTokenParam,
} from "../src/agent/model-compat.js";
import type { HawkyConfig } from "../src/agent/types.js";

function baseConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" },
    api_base_url: "https://api.anthropic.com",
    provider: "anthropic",
    model: "claude-opus-4-7",
    max_tokens: 8192,
    max_iterations: 80,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp/ws",
    gateway_port: 4242,
    heartbeat: {
      enabled: true,
      interval_minutes: 30,
      model: "claude-sonnet-4-6",
      keep_recent_messages: 8,
      active_hours: { start: "00:00", end: "23:59", timezone: "local" },
    },
    ...overrides,
  } as HawkyConfig;
}

describe("provider/model compatibility", () => {
  test("normalizes OpenAI provider away from Claude main and heartbeat models", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai",
      model: "claude-opus-4-7",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "claude-sonnet-4-6",
      },
    }));

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.heartbeat.model).toBeNull();
    expect(resolveHeartbeatModel(cfg)).toBe(DEFAULT_OPENAI_MODEL);
  });

  test("normalizes Anthropic provider away from OpenAI main and heartbeat models", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "anthropic",
      model: "gpt-5.5",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "gpt-5.4-mini",
      },
    }));

    expect(cfg.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(cfg.heartbeat.model).toBe(DEFAULT_CLAUDE_HEARTBEAT_MODEL);
    expect(resolveHeartbeatModel(cfg)).toBe(DEFAULT_CLAUDE_HEARTBEAT_MODEL);
  });

  test("keeps compatible OpenAI heartbeat override", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai",
      model: "gpt-5.5",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "gpt-5.4-mini",
      },
    }));

    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.heartbeat.model).toBe("gpt-5.4-mini");
    expect(resolveHeartbeatModel(cfg)).toBe("gpt-5.4-mini");
  });

  test("uses active openai-compatible profile model when the current model is Claude", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai_compatible",
      model: "claude-opus-4-7",
      openai_compatible: {
        active_profile: "runpod",
        profiles: {
          runpod: {
            base_url: "https://gateway.example/v1",
            api_key: "token",
            model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
          },
        },
      },
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "claude-sonnet-4-6",
      },
    }));

    expect(cfg.model).toBe("Qwen/Qwen3-Omni-30B-A3B-Instruct");
    expect(cfg.heartbeat.model).toBe("Qwen/Qwen3-Omni-30B-A3B-Instruct");
    expect(resolveHeartbeatModel(cfg)).toBe("Qwen/Qwen3-Omni-30B-A3B-Instruct");
  });

  test("keeps the default gpt-5.5 output token budget", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai",
      model: "gpt-5.5",
      max_tokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
    }));

    expect(resolveModelMaxOutputTokens(cfg)).toBe(DEFAULT_OPENAI_MAX_OUTPUT_TOKENS);
    expect(cfg.max_tokens).toBe(DEFAULT_OPENAI_MAX_OUTPUT_TOKENS);
  });

  test("caps legacy gpt-4o family output tokens to its model limit", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai",
      model: "gpt-4o-mini",
      max_tokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
    }));

    expect(resolveModelMaxOutputTokens(cfg)).toBe(16_384);
    expect(cfg.max_tokens).toBe(16_384);
  });

  test("does not clamp unknown openai-compatible model output tokens", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai_compatible",
      model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
      max_tokens: 64_000,
    }));

    expect(resolveModelMaxOutputTokens(cfg)).toBeNull();
    expect(cfg.max_tokens).toBe(64_000);
  });

  test("uses modern completion-token parameter for gpt-5 family", () => {
    expect(resolveOpenAICompletionTokenParam("gpt-5")).toBe("max_completion_tokens");
    expect(resolveOpenAICompletionTokenParam("gpt-5.5")).toBe("max_completion_tokens");
    expect(resolveOpenAICompletionTokenParam("gpt-5-mini")).toBe("max_completion_tokens");
    expect(resolveOpenAICompletionTokenParam("gpt-5.4-mini")).toBe("max_completion_tokens");
  });

  test("keeps legacy max_tokens parameter for gpt-4o and unknown compatible models", () => {
    expect(resolveOpenAICompletionTokenParam("gpt-4o-mini")).toBe("max_tokens");
    expect(resolveOpenAICompletionTokenParam("Qwen/Qwen3-Omni-30B-A3B-Instruct")).toBe("max_tokens");
  });
});
