// =============================================================================
// Skill Prompt Builder
//
// Formats the <available_skills> XML block for injection into the system prompt.
// Shows: name, description, location, availability status, missing requirements.
// =============================================================================

import { homedir } from "node:os";
import type { SkillEntry } from "./types.js";
import { SKILL_LIMITS } from "./types.js";

/**
 * Escape XML special characters.
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Compact paths: replace home dir with ~ to save tokens.
 */
function compactPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/**
 * Build the skills system prompt section.
 * Includes the mandatory instructions + available_skills list.
 */
export function buildSkillsPromptSection(skills: SkillEntry[]): string | null {
  if (skills.length === 0) return null;

  const lines: string[] = [];

  // Instructions (matching a proven mandatory pattern)
  lines.push("# Skills (mandatory)");
  lines.push("");
  lines.push("Before replying: scan <available_skills> entries.");
  lines.push("- If exactly one skill clearly applies: read its SKILL.md at <location> with `memory_get` or `read_file`, then follow it.");
  lines.push("- If multiple could apply: choose the most specific one, then read/follow it.");
  lines.push("- If none clearly apply: do not read any SKILL.md.");
  lines.push("Constraints: never read more than one skill up front; only read after selecting.");
  lines.push("");

  // Build skills list
  lines.push("<available_skills>");

  let totalChars = 0;
  let skillCount = 0;

  for (const skill of skills) {
    if (skillCount >= SKILL_LIMITS.maxSkillsInPrompt) break;

    const skillXml = formatSkillXml(skill);
    if (totalChars + skillXml.length > SKILL_LIMITS.maxSkillsPromptChars) break;

    lines.push(skillXml);
    totalChars += skillXml.length;
    skillCount++;
  }

  lines.push("</available_skills>");

  return lines.join("\n");
}

/**
 * Format a single skill as XML for the prompt.
 */
function formatSkillXml(skill: SkillEntry): string {
  const name = escapeXml(skill.name);
  const desc = escapeXml(skill.description);
  const location = compactPath(skill.path);

  const lines: string[] = [];
  lines.push(`  <skill available="${skill.eligible}">`);
  lines.push(`    <name>${name}</name>`);
  lines.push(`    <description>${desc}</description>`);
  lines.push(`    <location>${location}</location>`);

  if (!skill.eligible && skill.missing.length > 0) {
    lines.push(`    <requires>${escapeXml(skill.missing.join(", "))}</requires>`);
  }

  lines.push("  </skill>");
  return lines.join("\n");
}

/**
 * Format skills for the /skills slash command output.
 */
export function formatSkillsForDisplay(skills: SkillEntry[]): string {
  if (skills.length === 0) return "No skills found.";

  const lines: string[] = [];
  lines.push(`Skills (${skills.filter((s) => s.eligible).length}/${skills.length} ready)\n`);

  for (const skill of skills) {
    const status = skill.eligible ? "✓" : "✗";
    const missingLabel = skill.eligible ? "" : " [missing: " + skill.missing.join(", ") + "]";
    const emoji = skill.config.emoji ? skill.config.emoji + " " : "";
    lines.push(`  ${status} ${emoji}${skill.name} — ${skill.description}${missingLabel}`);
  }

  return lines.join("\n");
}
