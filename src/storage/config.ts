// =============================================================================
// Configuration System
//
// Loads config from $HAWKY_HOME/config.json, or ~/.hawky/config.json when
// HAWKY_HOME is unset, merges with defaults, and allows environment variable
// overrides. Config is cached after first load.
//
// Priority (highest wins):
//   1. Environment variables (ANTHROPIC_API_KEY, BRAVE_API_KEY)
//   2. Config file ($HAWKY_HOME/config.json or ~/.hawky/config.json)
//   3. Built-in defaults
//
// HAWKY_HOME moves this module's config root and any paths that already
// derive from getConfigDir(). Some legacy paths still hardcode ~/.hawky.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HawkyConfig } from "../agent/types.js";
import { normalizeProviderModels } from "../agent/model-compat.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

function defaultHawkyDir(): string {
  return process.env.HAWKY_HOME || join(homedir(), ".hawky");
}

let HAWKY_DIR = defaultHawkyDir();
let CONFIG_PATH = join(HAWKY_DIR, "config.json");

function buildDefaultConfig(configDir: string): HawkyConfig {
  return {
    api_keys: {
      anthropic: "",
      brave_search: "",
      openai: "",
    },
    api_base_url: "https://api.anthropic.com",
    provider: "anthropic",
    vertex: {
      project_id: "",
      region: "global",
    },
    openai_compatible: {
      active_profile: "",
      profiles: {},
    },
    model: "claude-opus-4-7",
    max_tokens: 32768,
    max_iterations: 160,
    max_tool_result_chars: 30_000,
    workspace_dir: join(configDir, "workspace"),
    gateway_port: 4242,
    heartbeat: {
      enabled: true,
      interval_minutes: 30,
      model: "claude-sonnet-4-6",
      keep_recent_messages: 32,
      active_hours: {
        start: "00:00",
        end: "23:59",
        timezone: "local",
      },
      // Memory feature (#653) now owns session→daily distillation and
      // daily→global consolidation via single Haiku calls (session-end trigger +
      // 6h scheduler). The heartbeat's agent-loop distillation/consolidation are
      // disabled to avoid double-distilling sessions and racing on MEMORY.md.
      consolidation_enabled: false,
      consolidation_frequency_hours: 12,
      consolidation_days: 3,
      distillation_enabled: false,
      distillation_frequency_hours: 6,
      distillation_min_new_messages: 10,
    },
    cron: {
      enabled: true,
    },
    memory_flush: {
      enabled: true,
      threshold_percent: 90,
    },
    compaction: {
      enabled: true,
      threshold_percent: 95,
      blocking_percent: 98,
      keep_recent_turns: 20,
      max_failures: 3,
    },
    concurrency: {
      main_max: 4,
      cron_max: 4,
      subagent_max: 8,
    },
    media: {
      retention: {
        audio_days: 7,
        video_days: 3,
      },
    },
    experiments: {
      agent_runtimes: false,
    },
  };
}

export const DEFAULT_CONFIG: HawkyConfig = buildDefaultConfig(HAWKY_DIR);

function currentDefaultConfig(): HawkyConfig {
  return buildDefaultConfig(HAWKY_DIR);
}

// -----------------------------------------------------------------------------
// Environment variable mapping
// -----------------------------------------------------------------------------

interface EnvMapping {
  env_var: string;
  apply: (config: HawkyConfig, value: string) => void;
}

const ENV_MAPPINGS: EnvMapping[] = [
  {
    env_var: "ANTHROPIC_API_KEY",
    apply: (c, v) => { c.api_keys.anthropic = v; },
  },
  {
    env_var: "BRAVE_API_KEY",
    apply: (c, v) => { c.api_keys.brave_search = v; },
  },
  {
    env_var: "OPENAI_API_KEY",
    apply: (c, v) => { c.api_keys.openai = v; },
  },
  {
    env_var: "HAWKY_API_BASE_URL",
    apply: (c, v) => { c.api_base_url = v; },
  },
  {
    // OPENAI_BASE_URL (unprefixed) is read by the OpenAI SDK directly.
    // Use the hawky-prefixed name to flow the value through config so doctor can show it.
    env_var: "HAWKY_OPENAI_BASE_URL",
    apply: (c, v) => { c.openai_base_url = v; },
  },
];

// -----------------------------------------------------------------------------
// Deep merge utility
// -----------------------------------------------------------------------------

const NULLABLE_CONFIG_PATHS = new Set([
  "effort",
  "heartbeat.model",
]);

function deepMerge(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
  path: string[] = [],
): Record<string, unknown> {
  const result = cloneConfigValue(defaults) as Record<string, unknown>;
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    const def = defaults[key];
    const childPath = [...path, key];
    if (val === null) {
      if (NULLABLE_CONFIG_PATHS.has(childPath.join("."))) {
        result[key] = null;
      }
      continue;
    }
    if (
      val !== undefined &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      def !== null &&
      def !== undefined &&
      typeof def === "object" &&
      !Array.isArray(def)
    ) {
      result[key] = deepMerge(
        def as Record<string, unknown>,
        val as Record<string, unknown>,
        childPath,
      );
    } else if (val !== undefined && val !== null) {
      result[key] = val;
    }
  }
  return result;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneConfigValue(item));
  }
  if (value && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      clone[key] = cloneConfigValue(child);
    }
    return clone;
  }
  return value;
}

// -----------------------------------------------------------------------------
// Config loading
// -----------------------------------------------------------------------------

let cachedConfig: HawkyConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load configuration. Merges config file with defaults, then applies
 * environment variable overrides. Result is cached for subsequent calls.
 *
 * @param configPath - Override config file path (for testing)
 */
export function loadConfig(configPath?: string): HawkyConfig {
  const filePath = configPath ?? CONFIG_PATH;
  if (cachedConfig && cachedConfigPath === filePath) return cachedConfig;
  const defaults = currentDefaultConfig();

  let fileConfig: Record<string, unknown> = {};

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    try {
      fileConfig = JSON.parse(raw);
      if (typeof fileConfig !== "object" || fileConfig === null || Array.isArray(fileConfig)) {
        throw new Error("Config must be a JSON object");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid config file at ${filePath}: ${msg}`);
    }
  } else {
    // Create default config file on first use with helpful structure
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const configContent = `{
  "api_keys": {
    "anthropic": "",
    "openai": "",
    "brave_search": ""
  },

  "provider": "anthropic",
  "vertex": {
    "project_id": "",
    "region": "global"
  },

  "model": "${defaults.model}",
  "max_tokens": ${defaults.max_tokens},
  "max_iterations": ${defaults.max_iterations},
  "gateway_port": ${defaults.gateway_port},

  "heartbeat": {
    "enabled": ${defaults.heartbeat.enabled},
    "interval_minutes": ${defaults.heartbeat.interval_minutes},
    "model": "${defaults.heartbeat.model}",
    "keep_recent_messages": ${defaults.heartbeat.keep_recent_messages},
    "active_hours": {
      "start": "${defaults.heartbeat.active_hours.start}",
      "end": "${defaults.heartbeat.active_hours.end}"
    },
    "consolidation_enabled": ${defaults.heartbeat.consolidation_enabled},
    "consolidation_frequency_hours": ${defaults.heartbeat.consolidation_frequency_hours},
    "consolidation_days": ${defaults.heartbeat.consolidation_days},
    "distillation_enabled": ${defaults.heartbeat.distillation_enabled},
    "distillation_frequency_hours": ${defaults.heartbeat.distillation_frequency_hours},
    "distillation_min_new_messages": ${defaults.heartbeat.distillation_min_new_messages}
  },

  "cron": {
    "enabled": true
  },

  "memory_flush": {
    "enabled": true,
    "threshold_percent": 90
  },

  "compaction": {
    "enabled": ${defaults.compaction!.enabled},
    "threshold_percent": ${defaults.compaction!.threshold_percent},
    "blocking_percent": ${defaults.compaction!.blocking_percent},
    "keep_recent_turns": ${defaults.compaction!.keep_recent_turns},
    "max_failures": ${defaults.compaction!.max_failures}
  },

  "concurrency": {
    "main_max": ${defaults.concurrency!.main_max},
    "cron_max": ${defaults.concurrency!.cron_max},
    "subagent_max": ${defaults.concurrency!.subagent_max}
  },

  "experiments": {
    "agent_runtimes": false
  }
}
`;
      writeFileSync(filePath, configContent, "utf-8");
    } catch {
      // Non-fatal: config file creation is best-effort
    }
  }

  // Merge: defaults ← file
  const config = deepMerge(
    defaults as unknown as Record<string, unknown>,
    fileConfig,
  ) as unknown as HawkyConfig;

  // Apply env var overrides (highest priority)
  for (const mapping of ENV_MAPPINGS) {
    const value = process.env[mapping.env_var];
    if (value !== undefined && value !== "") {
      mapping.apply(config, value);
    }
  }

  cachedConfig = normalizeProviderModels(config);
  cachedConfigPath = filePath;
  return cachedConfig;
}

/**
 * Clear cached config. Next loadConfig() call will re-read from disk.
 */
export function resetConfig(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}

/**
 * Get the default config (useful for tests and reference).
 */
export function getDefaultConfig(): HawkyConfig {
  return deepMerge(
    currentDefaultConfig() as unknown as Record<string, unknown>,
    {},
  ) as unknown as HawkyConfig;
}

/**
 * Get the config directory path.
 */
export function getConfigDir(): string {
  return HAWKY_DIR;
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Override the config directory. For testing only.
 */
export function setConfigDir(dir: string): string {
  const prev = HAWKY_DIR;
  HAWKY_DIR = dir;
  CONFIG_PATH = join(dir, "config.json");
  resetConfig();
  return prev;
}

/**
 * Reset the config directory to default. For testing only.
 */
export function resetConfigDir(): void {
  HAWKY_DIR = defaultHawkyDir();
  CONFIG_PATH = join(HAWKY_DIR, "config.json");
  resetConfig();
}

/**
 * Save a full config object to disk and reset the cache.
 * Creates the config directory if it doesn't exist.
 *
 * @param config - The complete config to persist
 * @param configPath - Override config file path (for testing)
 */
export function saveConfig(config: HawkyConfig, configPath?: string): void {
  const filePath = configPath ?? CONFIG_PATH;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  cachedConfig = null;
}

/**
 * Update specific config fields (deep merge), save to disk, and return
 * the new config. Environment variable overrides are NOT persisted —
 * only the file-level config is updated.
 *
 * @param updates - Partial config to merge into the current file config
 * @param configPath - Override config file path (for testing)
 * @returns The newly saved config (without env var overrides applied)
 */
export function updateConfig(
  updates: Record<string, unknown>,
  configPath?: string,
): HawkyConfig {
  const filePath = configPath ?? CONFIG_PATH;

  // Read current file config (not the cached version with env overrides)
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fileConfig = parsed;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot update config: ${filePath} contains invalid JSON: ${msg}. ` +
        `Fix the file manually or delete it to reset to defaults.`,
      );
    }
  }

  // Merge: defaults ← existing file ← updates
  const merged = deepMerge(
    deepMerge(
      currentDefaultConfig() as unknown as Record<string, unknown>,
      fileConfig,
    ),
    updates,
  ) as unknown as HawkyConfig;

  saveConfig(merged, filePath);
  return merged;
}
