// =============================================================================
// Tests for the configuration system (src/storage/config.ts)
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  loadConfig,
  resetConfig,
  getDefaultConfig,
  getConfigDir,
  getConfigPath,
  saveConfig,
  updateConfig,
  setConfigDir,
  resetConfigDir,
} from "../src/storage/config.js";
import { printGatewayBanner } from "../src/gateway/startup-banner.js";
import type { HawkyConfig } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;
let testConfigPath: string;

// Save original env vars so we can restore them (other test files depend on these)
const origAnthropicKey = process.env.ANTHROPIC_API_KEY;
const origBraveKey = process.env.BRAVE_API_KEY;
const origHawkyHome = process.env.HAWKY_HOME;

beforeEach(() => {
  resetConfig();
  // Clear env vars so config tests can verify file-based loading without env interference
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.HAWKY_HOME;
  resetConfigDir();
  testDir = join(tmpdir(), `hawky-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  testConfigPath = join(testDir, "config.json");
});

afterEach(() => {
  resetConfig();
  // Restore env vars to their original values (don't just delete — other test files need them)
  if (origAnthropicKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = origAnthropicKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
  if (origBraveKey !== undefined) {
    process.env.BRAVE_API_KEY = origBraveKey;
  } else {
    delete process.env.BRAVE_API_KEY;
  }
  if (origHawkyHome !== undefined) {
    process.env.HAWKY_HOME = origHawkyHome;
  } else {
    delete process.env.HAWKY_HOME;
  }
  resetConfigDir();
  // Clean up test dir
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function writeTestConfig(obj: Record<string, unknown>): void {
  writeFileSync(testConfigPath, JSON.stringify(obj, null, 2));
}

// =============================================================================
// Default config
// =============================================================================

describe("Default config", () => {
  test("getDefaultConfig returns complete config with all fields", () => {
    const config = getDefaultConfig();
    expect(config.api_keys.anthropic).toBe("");
    expect(config.api_keys.brave_search).toBe("");
    expect(config.model).toBe("claude-opus-4-7");
    expect(config.max_tokens).toBe(32768);
    expect(config.max_iterations).toBe(160);
    expect(config.max_tool_result_chars).toBe(30_000);
    expect(config.gateway_port).toBe(4242);
    expect(config.sandbox).toBeUndefined();
    expect(config.heartbeat.enabled).toBe(true);
    expect(config.heartbeat.interval_minutes).toBe(30);
  });

  test("getDefaultConfig returns a fresh copy each time", () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    expect(a).toEqual(b);
    a.model = "modified";
    a.api_keys.anthropic = "sk-mutated";
    a.heartbeat.enabled = false;
    expect(b.model).toBe("claude-opus-4-7");
    expect(b.api_keys.anthropic).toBe("");
    expect(b.heartbeat.enabled).toBe(true);
  });
});

// =============================================================================
// Loading from file
// =============================================================================

describe("Loading from file", () => {
  test("loads and merges partial config with defaults", () => {
    writeTestConfig({
      api_keys: { anthropic: "sk-test-123" },
      model: "claude-opus-4-20250514",
    });

    const config = loadConfig(testConfigPath);
    expect(config.api_keys.anthropic).toBe("sk-test-123");
    expect(config.api_keys.brave_search).toBe(""); // default
    expect(config.model).toBe("claude-opus-4-20250514");
    expect(config.max_tokens).toBe(32768); // default
    expect(config.gateway_port).toBe(4242); // default
  });

  test("deeply merges nested objects", () => {
    writeTestConfig({
      heartbeat: { enabled: false, interval_minutes: 60 },
    });

    const config = loadConfig(testConfigPath);
    expect(config.heartbeat.enabled).toBe(false);
    expect(config.heartbeat.interval_minutes).toBe(60);
    expect(config.heartbeat.model).toBe("claude-sonnet-4-6"); // default preserved
    expect(config.heartbeat.keep_recent_messages).toBe(32); // default preserved
  });

  test("file values override defaults", () => {
    writeTestConfig({
      max_tokens: 16384,
      max_iterations: 100,
      gateway_port: 9999,
    });

    const config = loadConfig(testConfigPath);
    expect(config.max_tokens).toBe(16384);
    expect(config.max_iterations).toBe(100);
    expect(config.gateway_port).toBe(9999);
  });

  test("heartbeat config merges correctly", () => {
    writeTestConfig({
      heartbeat: { enabled: true, interval_minutes: 15 },
    });

    const config = loadConfig(testConfigPath);
    expect(config.heartbeat.enabled).toBe(true);
    expect(config.heartbeat.interval_minutes).toBe(15);
    expect(config.heartbeat.active_hours).toEqual({ start: "00:00", end: "23:59", timezone: "local" }); // default
  });

  test("empty config file uses all defaults", () => {
    writeTestConfig({});

    const config = loadConfig(testConfigPath);
    expect(config).toEqual(getDefaultConfig());
  });

  test("extra unknown keys in config file are preserved", () => {
    writeTestConfig({ custom_field: "hello" });

    const config = loadConfig(testConfigPath);
    expect((config as any).custom_field).toBe("hello");
    expect(config.model).toBe("claude-opus-4-7");
  });
});

// =============================================================================
// Config file creation
// =============================================================================

describe("Config file creation", () => {
  test("creates config file with sensible defaults when missing", () => {
    const newPath = join(testDir, "subdir", "config.json");
    expect(existsSync(newPath)).toBe(false);

    const config = loadConfig(newPath);

    expect(existsSync(newPath)).toBe(true);
    const written = JSON.parse(readFileSync(newPath, "utf-8"));
    expect(written.api_keys).toBeDefined();
    expect(written.model).toBe("claude-opus-4-7");
    expect(written.max_tokens).toBe(32768);
    expect(written.max_iterations).toBe(160);
    // First-run template now includes all major sections
    expect(written.heartbeat).toBeDefined();
    expect(written.heartbeat.enabled).toBe(true);
    expect(written.cron).toBeDefined();

    // Returned config should have all defaults
    expect(config.sandbox).toBeUndefined();
    expect(config.heartbeat.enabled).toBe(true);
  });

  test("creates parent directories if needed", () => {
    const deepPath = join(testDir, "a", "b", "c", "config.json");
    loadConfig(deepPath);
    expect(existsSync(deepPath)).toBe(true);
  });
});

// =============================================================================
// Environment variable overrides
// =============================================================================

describe("Environment variable overrides", () => {
  test("ANTHROPIC_API_KEY overrides config file", () => {
    writeTestConfig({ api_keys: { anthropic: "from-file" } });
    process.env.ANTHROPIC_API_KEY = "from-env";

    const config = loadConfig(testConfigPath);
    expect(config.api_keys.anthropic).toBe("from-env");
  });

  test("BRAVE_API_KEY overrides config file", () => {
    writeTestConfig({ api_keys: { brave_search: "from-file" } });
    process.env.BRAVE_API_KEY = "from-env";

    const config = loadConfig(testConfigPath);
    expect(config.api_keys.brave_search).toBe("from-env");
  });

  test("env vars override defaults when no config file", () => {
    process.env.ANTHROPIC_API_KEY = "env-only";
    process.env.BRAVE_API_KEY = "brave-env";

    const config = loadConfig(testConfigPath);
    expect(config.api_keys.anthropic).toBe("env-only");
    expect(config.api_keys.brave_search).toBe("brave-env");
  });

  test("empty env var does not override", () => {
    writeTestConfig({ api_keys: { anthropic: "from-file" } });
    process.env.ANTHROPIC_API_KEY = "";

    const config = loadConfig(testConfigPath);
    expect(config.api_keys.anthropic).toBe("from-file");
  });

  test("env vars override but file values for other fields preserved", () => {
    writeTestConfig({
      api_keys: { anthropic: "file-key", brave_search: "file-brave" },
      model: "claude-opus-4-20250514",
    });
    process.env.ANTHROPIC_API_KEY = "env-key";

    const config = loadConfig(testConfigPath);
    expect(config.api_keys.anthropic).toBe("env-key"); // overridden
    expect(config.api_keys.brave_search).toBe("file-brave"); // preserved
    expect(config.model).toBe("claude-opus-4-20250514"); // preserved
  });
});

// =============================================================================
// HAWKY_HOME env var
// =============================================================================

describe("HAWKY_HOME env var", () => {
  test("resetConfigDir() honors HAWKY_HOME when set", () => {
    const fakeHome = join(tmpdir(), `hawky-home-test-${Date.now()}`);
    process.env.HAWKY_HOME = fakeHome;

    setConfigDir("/some/other/path");
    resetConfigDir();

    expect(getConfigDir()).toBe(fakeHome);
    expect(getConfigPath()).toBe(join(fakeHome, "config.json"));
  });

  test("resetConfigDir() falls back to ~/.hawky when HAWKY_HOME is unset", () => {
    delete process.env.HAWKY_HOME;

    setConfigDir("/some/other/path");
    resetConfigDir();

    expect(getConfigDir()).toBe(join(homedir(), ".hawky"));
    expect(getConfigPath()).toBe(join(homedir(), ".hawky", "config.json"));
  });

  test("empty HAWKY_HOME falls back to ~/.hawky", () => {
    process.env.HAWKY_HOME = "";

    setConfigDir("/some/other/path");
    resetConfigDir();

    expect(getConfigDir()).toBe(join(homedir(), ".hawky"));
    expect(getConfigPath()).toBe(join(homedir(), ".hawky", "config.json"));
  });
});

// =============================================================================
// Caching
// =============================================================================

describe("Caching", () => {
  test("loadConfig returns cached result on second call", () => {
    writeTestConfig({ model: "first-load" });

    const first = loadConfig(testConfigPath);
    expect(first.model).toBe("first-load");

    // Modify file — should not affect cached config
    writeTestConfig({ model: "second-load" });
    const second = loadConfig(testConfigPath);
    expect(second.model).toBe("first-load");
    expect(second).toBe(first); // same reference
  });

  test("resetConfig clears cache, next load reads fresh", () => {
    writeTestConfig({ model: "first-load" });
    const first = loadConfig(testConfigPath);
    expect(first.model).toBe("first-load");

    resetConfig();
    writeTestConfig({ model: "second-load" });
    const second = loadConfig(testConfigPath);
    expect(second.model).toBe("second-load");
    expect(second).not.toBe(first);
  });

  test("loadConfig does not reuse cache across explicit config paths", () => {
    const otherConfigPath = join(testDir, "other-config.json");
    writeTestConfig({ model: "first-path" });
    writeFileSync(otherConfigPath, JSON.stringify({ model: "second-path" }, null, 2));

    const first = loadConfig(testConfigPath);
    const second = loadConfig(otherConfigPath);

    expect(first.model).toBe("first-path");
    expect(second.model).toBe("second-path");
    expect(second).not.toBe(first);
  });

  test("setConfigDir invalidates cached default-path config", () => {
    const firstDir = join(testDir, "first");
    const secondDir = join(testDir, "second");
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(join(firstDir, "config.json"), JSON.stringify({ model: "first-dir" }, null, 2));
    writeFileSync(join(secondDir, "config.json"), JSON.stringify({ model: "second-dir" }, null, 2));

    setConfigDir(firstDir);
    const first = loadConfig();

    setConfigDir(secondDir);
    const second = loadConfig();

    expect(first.model).toBe("first-dir");
    expect(second.model).toBe("second-dir");
    expect(second).not.toBe(first);
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("Error handling", () => {
  test("invalid JSON throws descriptive error", () => {
    writeFileSync(testConfigPath, "not valid json {{{");

    expect(() => loadConfig(testConfigPath)).toThrow(/Invalid config file/);
  });

  test("JSON array throws descriptive error", () => {
    writeFileSync(testConfigPath, "[1, 2, 3]");

    expect(() => loadConfig(testConfigPath)).toThrow(/Config must be a JSON object/);
  });

  test("JSON null throws descriptive error", () => {
    writeFileSync(testConfigPath, "null");

    expect(() => loadConfig(testConfigPath)).toThrow(/Config must be a JSON object/);
  });

  test("error message includes file path", () => {
    writeFileSync(testConfigPath, "garbage");

    try {
      loadConfig(testConfigPath);
      expect(true).toBe(false); // should not reach
    } catch (err: unknown) {
      expect((err as Error).message).toContain(testConfigPath);
    }
  });
});

// =============================================================================
// Utility functions
// =============================================================================

describe("Utility functions", () => {
  test("getConfigDir returns ~/.hawky", () => {
    const dir = getConfigDir();
    expect(dir).toContain(".hawky");
    expect(dir).not.toContain("config.json");
  });

  test("getConfigPath returns path ending in config.json", () => {
    const path = getConfigPath();
    expect(path).toContain(".hawky");
    expect(path).toEndWith("config.json");
  });
});

// =============================================================================
// Deep merge edge cases
// =============================================================================

describe("Deep merge edge cases", () => {
  test("nested object values in config are merged correctly", () => {
    writeTestConfig({
      heartbeat: { active_hours: { start: "06:00", end: "20:00" } },
    });

    const config = loadConfig(testConfigPath);
    expect(config.heartbeat.active_hours.start).toBe("06:00");
    expect(config.heartbeat.active_hours.end).toBe("20:00");
  });

  test("null values in config do not crash merge", () => {
    writeTestConfig({ model: null });

    // null should not override — deepMerge skips null
    const config = loadConfig(testConfigPath);
    expect(config.model).toBe("claude-opus-4-7");
  });

  test("nested null does not crash merge", () => {
    writeTestConfig({ heartbeat: null });

    const config = loadConfig(testConfigPath);
    // null is overridden by defaults during deep merge
    expect(config.heartbeat.enabled).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Consolidation defaults
// -----------------------------------------------------------------------------

describe("consolidation defaults", () => {
  // #653: the memory feature now owns daily→global consolidation (single Haiku
  // call on a 6h timer), so the heartbeat's agent-loop consolidation defaults to
  // DISABLED. The frequency/days fields are still present for users who re-enable.
  test("default config includes consolidation fields", () => {
    const config = getDefaultConfig();
    expect(config.heartbeat.consolidation_enabled).toBe(false);
    expect(config.heartbeat.consolidation_frequency_hours).toBe(12);
    expect(config.heartbeat.consolidation_days).toBe(3);
  });

  test("user config without consolidation fields gets defaults", () => {
    writeTestConfig({
      heartbeat: { enabled: true, interval_minutes: 5 },
    });
    const config = loadConfig(testConfigPath);
    expect(config.heartbeat.consolidation_enabled).toBe(false);
    expect(config.heartbeat.consolidation_frequency_hours).toBe(12);
    expect(config.heartbeat.consolidation_days).toBe(3);
  });

  test("user can override consolidation fields", () => {
    writeTestConfig({
      heartbeat: {
        consolidation_enabled: false,
        consolidation_frequency_hours: 12,
        consolidation_days: 7,
      },
    });
    const config = loadConfig(testConfigPath);
    expect(config.heartbeat.consolidation_enabled).toBe(false);
    expect(config.heartbeat.consolidation_frequency_hours).toBe(12);
    expect(config.heartbeat.consolidation_days).toBe(7);
  });
});

// -----------------------------------------------------------------------------
// First-run config template
// -----------------------------------------------------------------------------

describe("first-run config template", () => {
  test("created config includes heartbeat section", () => {
    // Don't create the file — let loadConfig create it on first run
    const freshPath = join(testDir, "fresh-config.json");
    const config = loadConfig(freshPath);

    // Read the file that was created
    const raw = readFileSync(freshPath, "utf-8");
    expect(raw).toContain('"heartbeat"');
    expect(raw).toContain('"consolidation_enabled"');
    expect(raw).toContain('"consolidation_frequency_hours"');
    expect(raw).toContain('"consolidation_days"');
  });

  test("created config includes cron section", () => {
    const freshPath = join(testDir, "fresh-cron.json");
    loadConfig(freshPath);
    const raw = readFileSync(freshPath, "utf-8");
    expect(raw).toContain('"cron"');
    expect(raw).toContain('"enabled"');
  });

  test("created config does not include sandbox section", () => {
    const freshPath = join(testDir, "fresh-sandbox.json");
    loadConfig(freshPath);
    const raw = readFileSync(freshPath, "utf-8");
    expect(raw).not.toContain('"sandbox"');
  });

  test("created config is valid JSON", () => {
    const freshPath = join(testDir, "fresh-valid.json");
    loadConfig(freshPath);
    const raw = readFileSync(freshPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// =============================================================================
// saveConfig
// =============================================================================

describe("saveConfig", () => {
  test("writes config to disk as formatted JSON", () => {
    const config = getDefaultConfig();
    config.model = "custom-model";
    saveConfig(config, testConfigPath);

    const raw = readFileSync(testConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.model).toBe("custom-model");
    // Should be formatted (indented)
    expect(raw).toContain("  ");
    // Should end with newline
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("creates parent directories if needed", () => {
    const deepPath = join(testDir, "deep", "nested", "config.json");
    saveConfig(getDefaultConfig(), deepPath);
    expect(existsSync(deepPath)).toBe(true);
  });

  test("invalidates cache after save", () => {
    writeTestConfig({ model: "old-model" });
    const first = loadConfig(testConfigPath);
    expect(first.model).toBe("old-model");

    const updated = { ...getDefaultConfig(), model: "new-model" };
    saveConfig(updated, testConfigPath);

    // Cache should be cleared — next load reads from disk
    const second = loadConfig(testConfigPath);
    expect(second.model).toBe("new-model");
  });

  test("overwrites existing config file", () => {
    writeTestConfig({ model: "first", max_tokens: 999 });
    const config = getDefaultConfig();
    config.model = "second";
    saveConfig(config, testConfigPath);

    const raw = JSON.parse(readFileSync(testConfigPath, "utf-8"));
    expect(raw.model).toBe("second");
    // Default max_tokens, not the old 999
    expect(raw.max_tokens).toBe(32768);
  });
});

// =============================================================================
// updateConfig
// =============================================================================

describe("updateConfig", () => {
  test("merges updates into existing config", () => {
    writeTestConfig({ model: "original", max_tokens: 4096 });

    const result = updateConfig({ model: "updated" }, testConfigPath);
    expect(result.model).toBe("updated");
    expect(result.max_tokens).toBe(4096); // preserved
  });

  test("deep-merges nested objects", () => {
    writeTestConfig({
      api_keys: { anthropic: "sk-test", brave_search: "brave-key" },
    });

    const result = updateConfig(
      { api_keys: { anthropic: "sk-new" } },
      testConfigPath,
    );
    expect(result.api_keys.anthropic).toBe("sk-new");
    expect(result.api_keys.brave_search).toBe("brave-key"); // preserved
  });

  test("persists updates to disk", () => {
    writeTestConfig({ model: "old" });
    updateConfig({ model: "new" }, testConfigPath);

    resetConfig();
    const reloaded = loadConfig(testConfigPath);
    expect(reloaded.model).toBe("new");
  });

  test("creates config file if it does not exist", () => {
    const freshPath = join(testDir, "fresh-update.json");
    expect(existsSync(freshPath)).toBe(false);

    const result = updateConfig({ model: "from-update" }, freshPath);
    expect(result.model).toBe("from-update");
    expect(existsSync(freshPath)).toBe(true);
  });

  test("fills in defaults for missing fields", () => {
    writeTestConfig({ model: "custom" });

    const result = updateConfig({}, testConfigPath);
    expect(result.model).toBe("custom");
    expect(result.gateway_port).toBe(4242); // default filled in
    expect(result.sandbox).toBeUndefined(); // sandbox not in defaults
  });

  test("returns the new config object", () => {
    writeTestConfig({});
    const result = updateConfig(
      { api_keys: { anthropic: "sk-result" } },
      testConfigPath,
    );
    expect(result.api_keys.anthropic).toBe("sk-result");
  });

  test("throws on corrupt config file instead of silently overwriting", () => {
    writeFileSync(testConfigPath, "not json!!!");

    expect(() => updateConfig({ model: "recovered" }, testConfigPath)).toThrow(
      /Cannot update config.*invalid JSON/,
    );
  });

  test("invalidates cache so next loadConfig reads fresh", () => {
    writeTestConfig({ model: "cached" });
    loadConfig(testConfigPath); // populate cache

    updateConfig({ model: "updated" }, testConfigPath);

    const reloaded = loadConfig(testConfigPath);
    expect(reloaded.model).toBe("updated");
  });
});

// -----------------------------------------------------------------------------
// Gateway startup banner
// -----------------------------------------------------------------------------

describe("printGatewayBanner", () => {
  function makeBannerConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
    return {
      api_keys: { anthropic: "sk-secret", brave_search: "brave-key", openai: "" },
      api_base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      max_iterations: 80,
      max_tool_result_chars: 30_000,
      workspace_dir: "/tmp",
      gateway_port: 4242,
      heartbeat: {
        enabled: true,
        interval_minutes: 30,
        keep_recent_messages: 8,
        active_hours: { start: "08:00", end: "22:00" },
        consolidation_enabled: true,
        consolidation_frequency_hours: 24,
        consolidation_days: 3,
      },
      cron: { enabled: true },
      ...overrides,
    };
  }

  function captureBanner(config: HawkyConfig, cronJobs = 0): string {
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
        configPath: "/home/user/.hawky/config.json",
        logDir: "/home/user/.hawky/logs",
        cronJobCount: cronJobs,
      });
    } finally {
      console.log = origLog;
    }
    return lines.join("\n");
  }

  test("prints version and endpoints", () => {
    const output = captureBanner(makeBannerConfig());
    expect(output).toContain("hawky v0.1.0");
    expect(output).toContain("ws://127.0.0.1:4242");
    expect(output).toContain("http://127.0.0.1:4242/health");
  });

  test("prints config path and log dir", () => {
    const output = captureBanner(makeBannerConfig());
    expect(output).toContain("/home/user/.hawky/config.json");
    expect(output).toContain("/home/user/.hawky/logs");
  });

  test("prints model", () => {
    const output = captureBanner(makeBannerConfig());
    expect(output).toContain("claude-sonnet-4-6");
  });

  test("shows API key presence without revealing values", () => {
    const output = captureBanner(makeBannerConfig());
    expect(output).toContain("anthropic");
    expect(output).toContain("brave");
    // Must NOT contain the actual key
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("brave-key");
  });

  test("shows heartbeat enabled with interval and hours", () => {
    const output = captureBanner(makeBannerConfig());
    expect(output).toContain("every 30m");
    expect(output).toContain("08:00");
    expect(output).toContain("22:00");
  });

  test("shows heartbeat disabled", () => {
    const output = captureBanner(makeBannerConfig({
      heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" }, consolidation_enabled: true, consolidation_frequency_hours: 24, consolidation_days: 3 },
    }));
    expect(output).toMatch(/Heartbeat\s+disabled/);
  });

  test("shows heartbeat consolidation as owned by memory scheduler", () => {
    const output = captureBanner(makeBannerConfig());
    expect(output).toContain("memory scheduler owns this");
    expect(output).not.toContain("every 24h");
  });

  test("shows consolidation disabled when heartbeat off", () => {
    const output = captureBanner(makeBannerConfig({
      heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" }, consolidation_enabled: true, consolidation_frequency_hours: 24, consolidation_days: 3 },
    }));
    expect(output).toContain("heartbeat off");
  });

  test("shows cron with job count", () => {
    const output = captureBanner(makeBannerConfig(), 5);
    expect(output).toContain("5 jobs");
  });

  test("data rows are present and formatted", () => {
    const output = captureBanner(makeBannerConfig());
    // Each data row has the form: "  Label<padding>Value"
    // Verify key rows exist with label-value structure
    const dataLines = output.split("\n").filter(l =>
      l.startsWith("  ") && !l.includes("─") && !l.includes("hawky") && !l.includes("Ctrl+C")
    );
    // Should have at least 8 data rows (gateway, health, config, logs, model, api keys, heartbeat, consolidation, cron)
    expect(dataLines.length).toBeGreaterThanOrEqual(8);
    // Each data row should contain at least two segments separated by multiple spaces
    for (const line of dataLines) {
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });
});
