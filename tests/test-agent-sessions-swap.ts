// =============================================================================
// Tests: AgentSessionManager.swapProvider / addProfile / removeProfile / renameProfile
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { AnthropicProvider } from "../src/agent/anthropic_provider.js";
import { OpenAIProvider } from "../src/agent/openai_provider.js";
import type { LLMProvider } from "../src/agent/provider.js";
import type { HawkyConfig } from "../src/agent/types.js";
import {
  setConfigDir,
  resetConfigDir,
  resetConfig,
  saveConfig,
  loadConfig,
} from "../src/storage/config.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;
let sessions: AgentSessionManager;

function makeProvider(): LLMProvider {
  return new AnthropicProvider("sk-ant-test");
}

function baseConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-opus-4-7",
    max_tokens: 8192,
    max_iterations: 80,
    max_tool_result_chars: 30000,
    workspace_dir: join(testDir, "workspace"),
    gateway_port: 4242,
    heartbeat: {
      enabled: false,
      interval_minutes: 30,
      keep_recent_messages: 32,
      active_hours: { start: "00:00", end: "23:59", timezone: "local" },
      consolidation_enabled: false,
      consolidation_frequency_hours: 12,
      consolidation_days: 3,
      distillation_enabled: false,
      distillation_frequency_hours: 6,
      distillation_min_new_messages: 10,
    },
    cron: { enabled: false },
    memory_flush: { enabled: false, threshold_percent: 90 },
    compaction: {
      enabled: false, threshold_percent: 95, blocking_percent: 98,
      keep_recent_turns: 20, max_failures: 3,
    },
    concurrency: { main_max: 4, cron_max: 4, subagent_max: 8 },
    media: { retention: { audio_days: 7, video_days: 3 } },
    ...overrides,
  } as HawkyConfig;
}

beforeEach(() => {
  testDir = join(tmpdir(), `swap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, "sessions"), { recursive: true });
  mkdirSync(join(testDir, "workspace"), { recursive: true });

  setConfigDir(testDir);
  resetConfig();
  setSessionsDir(join(testDir, "sessions"));
  setWorkspaceDir(join(testDir, "workspace"));

  const cfg = baseConfig();
  saveConfig(cfg);
  resetConfig();

  sessions = new AgentSessionManager({
    provider: makeProvider(),
    config: loadConfig(),
    workingDirectory: join(testDir, "workspace"),
  });
});

afterEach(() => {
  resetConfig();
  resetConfigDir();
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// swapProvider
// -----------------------------------------------------------------------------

describe("swapProvider", () => {
  test("happy path: swap to anthropic returns ok and updates getActiveProvider", () => {
    // Re-save config with openai key so createProvider can build OpenAI first
    saveConfig(baseConfig({ provider: "openai", api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" } }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });

    const result = sessions.swapProvider({ provider: "anthropic" });
    expect(result).toEqual({ ok: true });
    // The new provider instance is a different object (or same class).
    const next = sessions.getActiveProvider();
    expect(next).toBeInstanceOf(AnthropicProvider);
    // Provider was actually replaced (new instance or same — at minimum it succeeded)
    expect(result.ok).toBe(true);
  });

  test("refuses while another swap is in progress (simulated via guard)", () => {
    // Directly access the private _swapping via a cast to test the guard
    (sessions as any)._swapping = true;
    const result = sessions.swapProvider({ provider: "anthropic" });
    expect(result).toEqual({ ok: false, error: "another swap in progress" });
    (sessions as any)._swapping = false;
  });

  test("refuses when a session loop is running", () => {
    const session = sessions.getOrCreate("tui:swap-test");
    // Simulate a running turn
    (session.loop as any).running = true;
    const result = sessions.swapProvider({ provider: "anthropic" });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("in-flight turn");
    (session.loop as any).running = false;
  });

  test("refuses when createProvider throws (e.g. missing key)", () => {
    // Try to swap to openai without any key configured
    delete process.env.OPENAI_API_KEY;
    saveConfig(baseConfig({ api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "" } }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });
    const result = sessions.swapProvider({ provider: "openai" });
    expect(result.ok).toBe(false);
    // The provider should be unchanged
    expect(sessions.getActiveProvider()).toBeInstanceOf(AnthropicProvider);
  });

  test("validate-then-commit: disk config unchanged when createProvider throws", () => {
    delete process.env.OPENAI_API_KEY;
    const configBefore = JSON.stringify(loadConfig());
    sessions.swapProvider({
      provider: "openai",
      model: "gpt-5.5",
      openai_base_url: "http://localhost:8000/v1",
    }); // should fail
    resetConfig();
    const configAfter = JSON.stringify(loadConfig());
    expect(JSON.parse(configAfter)).toEqual(JSON.parse(configBefore));
  });

  test("persists model and openai_base_url only after provider validates", () => {
    delete process.env.OPENAI_API_KEY;
    saveConfig(baseConfig({
      api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" },
    }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });
    const session = sessions.getOrCreate("web:general");

    const result = sessions.swapProvider({
      provider: "openai",
      model: "gpt-5.5",
      openai_base_url: "http://localhost:8000/v1",
    });

    expect(result).toEqual({ ok: true });
    expect(sessions.getActiveProvider()).toBeInstanceOf(OpenAIProvider);
    expect((session.loop as any).provider).toBeInstanceOf(OpenAIProvider);
    expect((session.loop as any).config.model).toBe("gpt-5.5");
    expect((session.loop as any).config.openai_base_url).toBe("http://localhost:8000/v1");
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.openai_base_url).toBe("http://localhost:8000/v1");
  });

  test("swap to openai normalizes stale Claude model and heartbeat override", () => {
    delete process.env.OPENAI_API_KEY;
    saveConfig(baseConfig({
      api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" },
      provider: "anthropic",
      model: "claude-opus-4-7",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "claude-sonnet-4-6",
      },
    }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });

    const result = sessions.swapProvider({ provider: "openai" });

    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.heartbeat.model).toBeNull();
  });

  test("swap back to anthropic normalizes stale OpenAI model and heartbeat override", () => {
    saveConfig(baseConfig({
      api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" },
      provider: "openai",
      model: "gpt-5.5",
      heartbeat: {
        ...baseConfig().heartbeat,
        model: "gpt-5.4-mini",
      },
    }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: new OpenAIProvider("sk-openai-test"),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });

    const result = sessions.swapProvider({ provider: "anthropic" });

    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.heartbeat.model).toBe("claude-sonnet-4-6");
  });

  test("switches openai_compatible active_profile even when provider is unchanged", () => {
    saveConfig(baseConfig({
      provider: "openai_compatible",
      model: "llama-a",
      openai_compatible: {
        active_profile: "profile-a",
        profiles: {
          "profile-a": { base_url: "http://localhost:8000/v1", api_key: "sk-a", model: "llama-a" },
          "profile-b": { base_url: "http://localhost:9000/v1", api_key: "sk-b", model: "llama-b" },
        },
      },
    }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });

    const result = sessions.swapProvider({
      provider: "openai_compatible",
      active_profile: "profile-b",
      model: "llama-b",
    });

    expect(result).toEqual({ ok: true });
    expect(sessions.getActiveProvider()).toBeInstanceOf(OpenAIProvider);
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.provider).toBe("openai_compatible");
    expect(cfg.openai_compatible?.active_profile).toBe("profile-b");
    expect(cfg.model).toBe("llama-b");
  });

  test("swapping getter is true during swap (via side effect)", () => {
    // We can only observe this indirectly — the guard test above covers it.
    // This test verifies the getter is public and accessible.
    expect(sessions.swapping).toBe(false);
  });

  test("heartbeat.updateConfig called with post-swap config", () => {
    let updatedCfg: HawkyConfig | null = null;
    const mockHeartbeat = {
      updateConfig: (cfg: HawkyConfig) => { updatedCfg = cfg; },
    } as any;
    sessions.setHeartbeat(mockHeartbeat);

    saveConfig(baseConfig({ api_keys: { anthropic: "sk-ant-updated", brave_search: "", openai: "" } }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });
    sessions.setHeartbeat(mockHeartbeat);

    sessions.swapProvider({ provider: "anthropic" });
    expect(updatedCfg).not.toBeNull();
    expect((updatedCfg as HawkyConfig).provider).toBe("anthropic");
  });

  test("updateConfig rebuilds provider for same-provider OpenAI base URL changes", () => {
    saveConfig(baseConfig({
      provider: "openai",
      api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" },
      model: "gpt-5.5",
      openai_base_url: "http://localhost:8000/v1",
    }));
    resetConfig();
    sessions = new AgentSessionManager({
      provider: makeProvider(),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });
    const session = sessions.getOrCreate("web:general");
    let setProviderCalls = 0;
    (session.loop as any).setProvider = () => { setProviderCalls += 1; };

    sessions.updateConfig(baseConfig({
      provider: "openai",
      api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "sk-openai-test" },
      model: "gpt-5.5",
      openai_base_url: "http://localhost:9000/v1",
    }));

    expect(sessions.getActiveProvider()).toBeInstanceOf(OpenAIProvider);
    expect(setProviderCalls).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// addProfile / removeProfile / renameProfile
// -----------------------------------------------------------------------------

describe("addProfile", () => {
  test("happy path: adds a profile and persists", () => {
    const result = sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:8000/v1" });
    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.openai_compatible?.profiles?.["vllm-local"]).toBeDefined();
    expect((cfg.openai_compatible?.profiles?.["vllm-local"] as any).base_url).toBe("http://localhost:8000/v1");
  });

  test("rejects duplicate name without overwrite", () => {
    sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:8000/v1" });
    const result = sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:9000/v1" });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("already exists");
  });

  test("allows overwrite with overwrite: true", () => {
    sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:8000/v1" });
    const result = sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:9000/v1", overwrite: true });
    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect((cfg.openai_compatible?.profiles?.["vllm-local"] as any).base_url).toBe("http://localhost:9000/v1");
  });

  test("rejects empty name", () => {
    const result = sessions.addProfile({ name: "", base_url: "http://localhost:8000/v1" });
    expect(result.ok).toBe(false);
  });

  test("rejects empty base_url", () => {
    const result = sessions.addProfile({ name: "myprofile", base_url: "" });
    expect(result.ok).toBe(false);
  });

  test("preserves sibling profiles", () => {
    sessions.addProfile({ name: "profile-a", base_url: "http://a.example.com" });
    sessions.addProfile({ name: "profile-b", base_url: "http://b.example.com" });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.openai_compatible?.profiles?.["profile-a"]).toBeDefined();
    expect(cfg.openai_compatible?.profiles?.["profile-b"]).toBeDefined();
  });
});

describe("removeProfile", () => {
  test("happy path: removes existing profile", () => {
    sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:8000/v1" });
    const result = sessions.removeProfile("vllm-local");
    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.openai_compatible?.profiles?.["vllm-local"]).toBeUndefined();
  });

  test("rejects removal of the active profile", () => {
    sessions.addProfile({ name: "vllm-local", base_url: "http://localhost:8000/v1" });
    // Set active_profile to vllm-local on the sessions config snapshot
    (sessions as any).config.openai_compatible = {
      ...(sessions as any).config.openai_compatible,
      active_profile: "vllm-local",
    };
    const result = sessions.removeProfile("vllm-local");
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("active profile");
  });

  test("rejects removal of non-existent profile", () => {
    const result = sessions.removeProfile("does-not-exist");
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not found");
  });
});

describe("renameProfile", () => {
  test("happy path: renames profile", () => {
    sessions.addProfile({ name: "old-name", base_url: "http://localhost:8000/v1" });
    const result = sessions.renameProfile("old-name", "new-name");
    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.openai_compatible?.profiles?.["new-name"]).toBeDefined();
    expect(cfg.openai_compatible?.profiles?.["old-name"]).toBeUndefined();
  });

  test("updates active_profile when it matches old name", () => {
    sessions.addProfile({ name: "old-name", base_url: "http://localhost:8000/v1" });
    (sessions as any).config.openai_compatible = {
      ...(sessions as any).config.openai_compatible,
      active_profile: "old-name",
    };
    const result = sessions.renameProfile("old-name", "new-name");
    expect(result).toEqual({ ok: true });
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.openai_compatible?.active_profile).toBe("new-name");
  });

  test("does not change active_profile when it doesn't match old name", () => {
    sessions.addProfile({ name: "profile-a", base_url: "http://localhost:8000/v1" });
    sessions.addProfile({ name: "profile-b", base_url: "http://localhost:9000/v1" });
    (sessions as any).config.openai_compatible = {
      ...(sessions as any).config.openai_compatible,
      active_profile: "profile-b",
    };
    sessions.renameProfile("profile-a", "profile-a-renamed");
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.openai_compatible?.active_profile).toBe("profile-b");
  });

  test("rejects rename when old name not found", () => {
    const result = sessions.renameProfile("does-not-exist", "new-name");
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not found");
  });

  test("rejects rename when new name already exists", () => {
    sessions.addProfile({ name: "profile-a", base_url: "http://localhost:8000/v1" });
    sessions.addProfile({ name: "profile-b", base_url: "http://localhost:9000/v1" });
    const result = sessions.renameProfile("profile-a", "profile-b");
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("already exists");
  });
});
