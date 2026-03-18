// =============================================================================
// Skill Status Report
//
// Produces a structured report of all skills: eligibility, missing deps,
// and install instructions. Used by /setup wizard and /doctor health check.
// =============================================================================

import { execSync } from "node:child_process";
import { loadAllSkills } from "./loader.js";
import type { SkillEntry, SkillInstallSpec } from "./types.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SkillStatusEntry {
  name: string;
  description: string;
  emoji?: string;
  source: "bundled" | "user" | "workspace";
  /** Binary/env requirements met */
  eligible: boolean;
  /** Auth/config verified (only checked for skills with auth commands) */
  authReady: boolean;
  /** Fully ready = eligible + authReady */
  ready: boolean;
  missing: string[];
  install: SkillInstallSpec[];
  /** Suggested verification command (e.g., "gh auth status") */
  verifyCommand?: string;
}

export interface SkillStatusReport {
  total: number;
  eligible: number;
  missing: number;
  skills: SkillStatusEntry[];
}

// -----------------------------------------------------------------------------
// Verification commands for known skills
// -----------------------------------------------------------------------------

const VERIFY_COMMANDS: Record<string, string> = {
  commit: "git --version",
  github: "gh auth status",
  gog: "gog auth list",
  himalaya: "himalaya account list",
  peekaboo: "peekaboo --version",
  summarize: "summarize --version",
};

/**
 * Skills that need auth verification beyond binary existence.
 * Maps skill name → command that exits 0 only when auth is configured.
 */
const AUTH_CHECK_COMMANDS: Record<string, string> = {
  github: "gh auth status",
  gog: "gog auth list",
};

/** Run an auth check command. Returns true if exit code is 0. */
function checkAuth(command: string): boolean {
  try {
    execSync(command, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Report generation
// -----------------------------------------------------------------------------

/**
 * Build a structured status report for all discovered skills.
 */
export function buildSkillStatusReport(workspacePath?: string): SkillStatusReport {
  const skills = loadAllSkills(workspacePath);

  const entries: SkillStatusEntry[] = skills.map((skill) => {
    // Check auth for eligible skills that require it
    const authCmd = AUTH_CHECK_COMMANDS[skill.name];
    const authReady = skill.eligible && authCmd ? checkAuth(authCmd) : skill.eligible;

    return {
      name: skill.name,
      description: skill.description,
      emoji: skill.config.emoji,
      source: skill.source,
      eligible: skill.eligible,
      authReady,
      ready: skill.eligible && authReady,
      missing: [
        ...skill.missing,
        ...(skill.eligible && !authReady ? ["auth: not configured"] : []),
      ],
      install: skill.config.install ?? [],
      verifyCommand: VERIFY_COMMANDS[skill.name],
    };
  });

  const eligible = entries.filter((e) => e.ready).length;

  return {
    total: entries.length,
    eligible,
    missing: entries.length - eligible,
    skills: entries,
  };
}

/**
 * Format the skill status report as a human-readable string.
 * Used by /setup (injected into agent message) and /doctor.
 */
export function formatSkillStatusReport(report: SkillStatusReport): string {
  const lines: string[] = [];
  lines.push(`Skills: ${report.eligible}/${report.total} ready`);
  lines.push("");

  for (const skill of report.skills) {
    const icon = skill.ready ? "✓" : "✗";
    const emoji = skill.emoji ? `${skill.emoji} ` : "";
    let line = `  ${icon} ${emoji}${skill.name} — ${skill.description}`;

    if (!skill.ready && skill.missing.length > 0) {
      line += ` [${skill.missing.join(", ")}]`;
    }

    lines.push(line);

    if (!skill.ready) {
      if (skill.eligible && !skill.authReady) {
        // Binary present but auth missing — show auth command, not reinstall
        if (skill.verifyCommand) {
          lines.push(`      Auth needed: run \`${skill.verifyCommand}\` to check`);
        }
      } else if (skill.install.length > 0) {
        // Binary missing — show install instructions
        for (const inst of skill.install) {
          const cmd = formatInstallCommand(inst);
          if (cmd) {
            lines.push(`      Install: ${cmd}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Format a single install spec as a CLI command string.
 */
function formatInstallCommand(spec: SkillInstallSpec): string | null {
  switch (spec.kind) {
    case "brew":
      return spec.formula ? `brew install ${spec.formula}` : null;
    case "apt":
      return (spec.package ?? spec.formula) ? `sudo apt install ${spec.package ?? spec.formula}` : null;
    case "node":
      return spec.package ? `npm install -g ${spec.package}` : null;
    case "go":
      return spec.module ? `go install ${spec.module}` : null;
    case "download":
      return spec.url ? `Download from ${spec.url}` : null;
    default:
      return spec.label ?? null;
  }
}
