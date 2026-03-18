// =============================================================================
// Skill Environment Variable Injection
//
// Injects per-skill env vars before an agent run and reverts after.
// Handles apiKey → primaryEnv mapping.
// Blocks obvious dangerous vars (PATH, HOME, SHELL, etc.).
// =============================================================================

import type { SkillEntry, SkillUserConfig, SkillConfig } from "./types.js";
import { parseSkillConfig } from "./frontmatter.js";

// -----------------------------------------------------------------------------
// Dangerous env var blocking
// -----------------------------------------------------------------------------

const BLOCKED_ENV_VARS = new Set([
  "PATH", "HOME", "SHELL", "USER", "TERM", "LANG",
  "PWD", "OLDPWD", "TMPDIR", "EDITOR", "VISUAL",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "OPENSSL_CONF", "NODE_OPTIONS", "BUN_OPTIONS",
]);

function isDangerous(key: string): boolean {
  return BLOCKED_ENV_VARS.has(key) || key.startsWith("BASH_FUNC_");
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface EnvUpdate {
  key: string;
  prev: string | undefined; // Original value (undefined = didn't exist)
}

// -----------------------------------------------------------------------------
// Injection
// -----------------------------------------------------------------------------

/**
 * Apply per-skill env vars from config. Returns a reverter function.
 *
 * Flow:
 * 1. For each skill, read skills.entries.<name> from config
 * 2. Inject .env vars (only if not already in process.env)
 * 3. Map .apiKey to the skill's primaryEnv var
 * 4. Block dangerous vars
 * 5. Return reverter that restores all changed vars
 */
export function applySkillEnvOverrides(
  skills: SkillEntry[],
  userConfig?: Record<string, SkillUserConfig>,
): () => void {
  const updates: EnvUpdate[] = [];

  for (const skill of skills) {
    if (!skill.eligible) continue;

    const cfg = userConfig?.[skill.name];
    if (!cfg) continue;

    // Inject .env vars
    if (cfg.env) {
      for (const [key, value] of Object.entries(cfg.env)) {
        if (isDangerous(key)) continue;
        if (process.env[key] !== undefined) continue; // Don't overwrite existing

        updates.push({ key, prev: process.env[key] });
        process.env[key] = value;
      }
    }

    // Map apiKey → primaryEnv
    if (cfg.apiKey && skill.config) {
      const primaryEnv = extractPrimaryEnv(skill.config);
      if (primaryEnv && !isDangerous(primaryEnv) && process.env[primaryEnv] === undefined) {
        updates.push({ key: primaryEnv, prev: process.env[primaryEnv] });
        process.env[primaryEnv] = cfg.apiKey;
      }
    }
  }

  // Return reverter
  return () => {
    for (const update of updates) {
      if (update.prev === undefined) {
        delete process.env[update.key];
      } else {
        process.env[update.key] = update.prev;
      }
    }
  };
}

/**
 * Extract primaryEnv from skill config.
 * This is the env var name that apiKey gets mapped to.
 * Falls back to first requires.env entry if primaryEnv not explicitly set.
 */
function extractPrimaryEnv(config: SkillConfig): string | null {
  if (config.primaryEnv) return config.primaryEnv;
  if (config.requires?.env && config.requires.env.length > 0) {
    return config.requires.env[0];
  }
  return null;
}
