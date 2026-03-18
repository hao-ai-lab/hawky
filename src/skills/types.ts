// =============================================================================
// Skill System Types
// =============================================================================

/** Parsed YAML frontmatter from SKILL.md */
export interface SkillMetadata {
  name: string;
  description: string;
  /** JSON string with nested config */
  metadata?: string;
  /** Whether user can invoke via /command (default: true) */
  "user-invocable"?: boolean;
  /** Hide from model prompt (default: false) */
  "disable-model-invocation"?: boolean;
}

/** Parsed metadata.hawky block */
export interface SkillConfig {
  emoji?: string;
  requires?: {
    bins?: string[];
    env?: string[];
    config?: string[];
  };
  os?: string[];
  always?: boolean;
  primaryEnv?: string;
  install?: SkillInstallSpec[];
}

export interface SkillInstallSpec {
  id?: string;
  kind: "brew" | "apt" | "node" | "go" | "download" | string;
  label?: string;
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  bins?: string[];
  os?: string[];
}

/** A loaded skill entry */
export interface SkillEntry {
  name: string;
  description: string;
  path: string; // Absolute path to SKILL.md
  source: "bundled" | "user" | "workspace";
  eligible: boolean;
  missing: string[]; // Missing requirements (bins, env)
  config: SkillConfig;
  userInvocable: boolean;
}

/** Per-skill config from config.json */
export interface SkillUserConfig {
  enabled?: boolean;
  env?: Record<string, string>;
  apiKey?: string;
}

/** Limits for skill prompt injection */
export const SKILL_LIMITS = {
  maxSkillsInPrompt: 150,
  maxSkillsPromptChars: 30_000,
  maxSkillFileBytes: 256_000,
};
