// =============================================================================
// Skill Slash Commands
//
// Each user-invocable skill becomes a /command.
// When invoked, sends "Use the '<skill>' skill. User instruction: <args>"
// to the agent as a regular message.
//
// Command names are sanitized (lowercase, alphanumeric + underscore) and
// deduplicated (append _2, _3 if collision).
// =============================================================================

import type { SkillEntry } from "./types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_COMMAND_LENGTH = 32;

// Commands that are already registered and should not be overridden
const RESERVED_COMMANDS = new Set([
  "help", "exit", "quit", "clear", "new", "resume", "model",
  "status", "compact", "usage", "skills", "tasks",
]);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SkillCommand {
  /** Sanitized command name (e.g., "commit") */
  name: string;
  /** Original skill name */
  skillName: string;
  /** Skill description (for /help) */
  description: string;
  /** Path to SKILL.md */
  skillPath: string;
}

// -----------------------------------------------------------------------------
// Command Name Sanitization
// -----------------------------------------------------------------------------

/**
 * Sanitize a skill name into a valid slash command name.
 * - Lowercase
 * - Replace non-alphanumeric with underscore
 * - Collapse multiple underscores
 * - Trim leading/trailing underscores
 * - Max 32 chars
 */
export function sanitizeCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, MAX_COMMAND_LENGTH) || "skill";
}

/**
 * Resolve a unique command name, appending _2, _3 etc. if collision.
 */
function resolveUniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;

  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const maxBase = Math.max(1, MAX_COMMAND_LENGTH - suffix.length);
    const candidate = base.slice(0, maxBase) + suffix;
    if (!used.has(candidate)) return candidate;
  }

  return base.slice(0, MAX_COMMAND_LENGTH - 2) + "_x";
}

// -----------------------------------------------------------------------------
// Build Commands
// -----------------------------------------------------------------------------

/**
 * Build slash commands from skill entries.
 * Each user-invocable skill becomes a /command.
 */
export function buildSkillCommands(skills: SkillEntry[]): SkillCommand[] {
  const used = new Set(RESERVED_COMMANDS);
  const commands: SkillCommand[] = [];

  for (const skill of skills) {
    if (!skill.userInvocable) continue;

    const base = sanitizeCommandName(skill.name);
    const name = resolveUniqueName(base, used);
    used.add(name);

    commands.push({
      name,
      skillName: skill.name,
      description: skill.description.slice(0, 100),
      skillPath: skill.path,
    });
  }

  return commands;
}

/**
 * Format the agent message when a skill command is invoked.
 * This is sent as a regular user message to the agent.
 */
export function formatSkillInvocation(command: SkillCommand, args: string): string {
  const instruction = args.trim()
    ? `Use the '${command.skillName}' skill. User instruction: ${args.trim()}`
    : `Use the '${command.skillName}' skill.`;
  return instruction;
}
