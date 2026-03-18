// =============================================================================
// Skill Loader
//
// Discovers and loads skills from 3 directories (by priority):
// 1. Bundled (src/skills/) — lowest
// 2. User (~/.hawky/skills/) — medium
// 3. Workspace (<workspace>/skills/) — highest (overrides same-named)
//
// Each skill is a directory containing SKILL.md with YAML frontmatter.
// Checks eligibility: required binaries on PATH, env vars set, OS match.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, parseSkillConfig } from "./frontmatter.js";
import type { SkillEntry, SkillConfig, SkillUserConfig } from "./types.js";
import { SKILL_LIMITS } from "./types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Bundled skills shipped with Hawky */
function getBundledSkillsDir(): string {
  // Navigate from src/skills/ to src/skill-templates/ (or wherever bundled skills live)
  return join(__dirname, "..", "skill-templates");
}

const USER_SKILLS_DIR = join(homedir(), ".hawky", "skills");

// Cache binary existence checks (expensive: spawns `which`)
const binCache = new Map<string, boolean>();

// -----------------------------------------------------------------------------
// Binary / Environment Checking
// -----------------------------------------------------------------------------

/** Check if a binary exists on PATH. Cached per session. */
export function hasBinary(name: string): boolean {
  // Sanitize: reject names with shell metacharacters to prevent injection
  if (/[^a-zA-Z0-9._-]/.test(name)) return false;

  if (binCache.has(name)) return binCache.get(name)!;

  try {
    execSync(`which ${name}`, { stdio: "pipe", timeout: 3000 });
    binCache.set(name, true);
    return true;
  } catch {
    binCache.set(name, false);
    return false;
  }
}

/** Reset binary cache (for testing). */
export function resetBinCache(): void {
  binCache.clear();
}

// -----------------------------------------------------------------------------
// Skill Discovery
// -----------------------------------------------------------------------------

/**
 * Discover skills from a single directory.
 * Each subdirectory with a SKILL.md is a skill.
 */
function discoverFromDir(
  dir: string,
  source: "bundled" | "user" | "workspace",
): SkillEntry[] {
  if (!existsSync(dir)) return [];

  const entries: SkillEntry[] = [];

  try {
    for (const name of readdirSync(dir)) {
      const skillDir = join(dir, name);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch { continue; }

      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      try {
        const stat = statSync(skillFile);
        if (stat.size > SKILL_LIMITS.maxSkillFileBytes) continue;

        const content = readFileSync(skillFile, "utf-8");
        const meta = parseFrontmatter(content);
        if (!meta) continue;

        const config = parseSkillConfig(meta.metadata);
        const { eligible, missing } = checkEligibility(config);

        entries.push({
          name: meta.name,
          description: meta.description,
          path: skillFile,
          source,
          eligible,
          missing,
          config,
          userInvocable: meta["user-invocable"] !== false,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dir */ }

  return entries;
}

/**
 * Check if a skill's requirements are met.
 */
function checkEligibility(config: SkillConfig): { eligible: boolean; missing: string[] } {
  // Short-circuit: always: true bypasses all checks (saves which calls)
  if (config.always) {
    return { eligible: true, missing: [] };
  }

  const missing: string[] = [];

  // OS check
  if (config.os && config.os.length > 0) {
    if (!config.os.includes(process.platform)) {
      missing.push(`os: ${process.platform} not in [${config.os.join(", ")}]`);
    }
  }

  // Binary checks
  if (config.requires?.bins) {
    for (const bin of config.requires.bins) {
      if (!hasBinary(bin)) {
        missing.push(`bin: ${bin}`);
      }
    }
  }

  // Env var checks
  if (config.requires?.env) {
    for (const envName of config.requires.env) {
      if (!process.env[envName]) {
        missing.push(`env: ${envName}`);
      }
    }
  }

  // Config path checks (e.g., requires.config: ["channels.slack.user_token"])
  // Walks the dot-separated path in ~/.hawky/config.json
  if (config.requires?.config) {
    const configFilePath = join(homedir(), ".hawky", "config.json");
    let configData: Record<string, unknown> = {};
    try {
      configData = JSON.parse(readFileSync(configFilePath, "utf-8"));
    } catch {
      // config.json missing or invalid — all config requirements fail
    }
    for (const configPath of config.requires.config) {
      const parts = configPath.split(".");
      let current: unknown = configData;
      for (const part of parts) {
        if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
          current = (current as Record<string, unknown>)[part];
        } else {
          current = undefined;
          break;
        }
      }
      if (!current) {
        missing.push(`config: ${configPath}`);
      }
    }
  }

  return { eligible: missing.length === 0, missing };
}

// -----------------------------------------------------------------------------
// Main Loader
// -----------------------------------------------------------------------------

/**
 * Load all skills from bundled, user, and workspace directories.
 * Higher-priority sources override same-named skills from lower priority.
 *
 * @param workspacePath - Path to workspace (for workspace-level skills)
 * @param userConfig - Per-skill config from config.json
 */
export function loadAllSkills(
  workspacePath?: string,
  userConfig?: Record<string, SkillUserConfig>,
): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();

  // Priority 1 (lowest): bundled
  const bundledDir = getBundledSkillsDir();
  for (const entry of discoverFromDir(bundledDir, "bundled")) {
    byName.set(entry.name, entry);
  }

  // Priority 2: user-installed
  for (const entry of discoverFromDir(USER_SKILLS_DIR, "user")) {
    byName.set(entry.name, entry); // Overrides bundled
  }

  // Priority 3 (highest): workspace
  if (workspacePath) {
    const wsSkillsDir = join(workspacePath, "skills");
    for (const entry of discoverFromDir(wsSkillsDir, "workspace")) {
      byName.set(entry.name, entry); // Overrides user + bundled
    }
  }

  // Apply user config (enable/disable)
  const result: SkillEntry[] = [];
  for (const entry of byName.values()) {
    const cfg = userConfig?.[entry.name];
    if (cfg?.enabled === false) continue; // Disabled by user
    result.push(entry);
  }

  return result;
}

/**
 * Get skills eligible for prompt injection (available to the agent).
 * Respects prompt limits (max skills, max chars).
 */
export function getEligibleSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills
    .filter((s) => !s.config.always) // always-active handled separately
    .slice(0, SKILL_LIMITS.maxSkillsInPrompt);
}

/**
 * Get always-active skills (loaded into prompt context, not on-demand).
 */
export function getAlwaysActiveSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills.filter((s) => s.config.always && s.eligible);
}
