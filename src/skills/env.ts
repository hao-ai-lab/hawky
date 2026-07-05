// =============================================================================
// Skill Environment Variable Injection
//
// Builds a per-run env map of a run's skill env vars. The map is passed to the
// subprocesses that consume it (the bash tool) via ToolContext — it is NEVER
// written to the shared global process.env, which would leak one session's
// secrets into a concurrently-running session on the multi-session gateway.
// Handles apiKey → primaryEnv mapping. Blocks dangerous vars (PATH, HOME, ...).
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
// Injection
// -----------------------------------------------------------------------------

/**
 * Build the per-run env overrides for a set of skills — WITHOUT touching the
 * global process.env. The returned map is merged over process.env only for the
 * subprocesses that need it (the bash tool), so two sessions running turns
 * concurrently on the shared gateway never see each other's skill secrets.
 *
 * Flow:
 * 1. For each eligible skill, read skills.entries.<name> from config
 * 2. Collect .env vars (skip if already in the real process.env — real env wins)
 * 3. Map .apiKey to the skill's primaryEnv var
 * 4. Block dangerous vars; first skill wins on collisions
 */
export function buildSkillEnv(
  skills: SkillEntry[],
  userConfig?: Record<string, SkillUserConfig>,
): Record<string, string> {
  const env: Record<string, string> = {};

  const claim = (key: string, value: string): void => {
    if (isDangerous(key)) return;
    if (process.env[key] !== undefined) return; // real env wins
    if (env[key] !== undefined) return; // first skill wins
    env[key] = value;
  };

  for (const skill of skills) {
    if (!skill.eligible) continue;

    const cfg = userConfig?.[skill.name];
    if (!cfg) continue;

    if (cfg.env) {
      for (const [key, value] of Object.entries(cfg.env)) claim(key, value);
    }

    // Map apiKey → primaryEnv
    if (cfg.apiKey && skill.config) {
      const primaryEnv = extractPrimaryEnv(skill.config);
      if (primaryEnv) claim(primaryEnv, cfg.apiKey);
    }
  }

  return env;
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
