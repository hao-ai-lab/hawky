import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLAUDE_HEARTBEAT_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  isClaudeModel,
  isOpenAIModel,
  normalizeProviderModels,
  resolveHeartbeatModel,
} from "../src/agent/model-compat.js";
import type { HawkyConfig } from "../src/agent/types.js";

function baseConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    provider: "anthropic",
    model: DEFAULT_CLAUDE_MODEL,
    max_tokens: 8192,
    max_iterations: 80,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp/ws",
    gateway_port: 4242,
    heartbeat: {
      enabled: true,
      interval_minutes: 30,
      model: DEFAULT_CLAUDE_HEARTBEAT_MODEL,
      keep_recent_messages: 32,
      active_hours: { start: "00:00", end: "23:59", timezone: "local" },
      consolidation_enabled: false,
      distillation_enabled: false,
    },
    ...overrides,
  } as HawkyConfig;
}

describe("model compatibility helpers", () => {
  test("classifies Claude and OpenAI model families", () => {
    expect(isClaudeModel("claude-sonnet-4-6")).toBe(true);
    expect(isClaudeModel("gpt-5.5")).toBe(false);
    expect(isOpenAIModel("gpt-5.5")).toBe(true);
    expect(isOpenAIModel("o3-mini")).toBe(true);
    expect(isOpenAIModel("claude-opus-4-7")).toBe(false);
  });

  test("normalizes OpenAI provider away from Claude main and heartbeat models", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai",
      model: "claude-opus-4-7",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "claude-sonnet-4-6",
      },
    }));

    expect(cfg.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(cfg.heartbeat.model).toBeNull();
    expect(resolveHeartbeatModel(cfg)).toBe(DEFAULT_OPENAI_MODEL);
  });

  test("normalizes Anthropic provider away from OpenAI models", () => {
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
  });

  test("normalizes direct providers away from OpenAI-compatible custom models", () => {
    const openai = normalizeProviderModels(baseConfig({
      provider: "openai",
      model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
      },
    }));
    expect(openai.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(openai.heartbeat.model).toBeNull();

    const anthropic = normalizeProviderModels(baseConfig({
      provider: "anthropic",
      model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
      },
    }));
    expect(anthropic.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(anthropic.heartbeat.model).toBe(DEFAULT_CLAUDE_HEARTBEAT_MODEL);
  });

  test("uses OpenAI-compatible profile model when switching from Claude", () => {
    const cfg = normalizeProviderModels(baseConfig({
      provider: "openai_compatible",
      model: "claude-opus-4-7",
      openai_compatible: {
        active_profile: "runpod",
        profiles: {
          runpod: { base_url: "https://control.example/internal/provider/openai/v1", api_key: "token", model: "gpt-5.4-mini" },
        },
      },
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "claude-sonnet-4-6",
      },
    }));

    expect(cfg.model).toBe("gpt-5.4-mini");
    expect(cfg.heartbeat.model).toBe("gpt-5.4-mini");
  });
});
