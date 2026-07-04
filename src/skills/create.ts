// =============================================================================
// Skill Creation Helper
//
// Generates a skeleton SKILL.md for custom skills.
// Used by: /skill-create slash command or hawky skill create CLI.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../storage/config.js";

/**
 * Create a new custom skill with a skeleton SKILL.md.
 * @param name - Skill name (becomes directory name)
 * @param description - One-line description
 * @param target - "workspace" (default) or "user"
 * @param workspacePath - Workspace directory (defaults to ~/.hawky/workspace)
 * @returns Path to created SKILL.md, or error message
 */
export function createSkill(
  name: string,
  description?: string,
  target: "workspace" | "user" = "workspace",
  workspacePath?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  // Validate name
  if (!name || name.length === 0) {
    return { ok: false, error: "Skill name is required" };
  }
  if (/[^a-zA-Z0-9._-]/.test(name)) {
    return { ok: false, error: "Skill name can only contain letters, numbers, dots, hyphens, and underscores" };
  }

  const defaultWorkspace = join(getConfigDir(), "workspace");
  const baseDir = target === "user"
    ? join(getConfigDir(), "skills")
    : join(workspacePath ?? defaultWorkspace, "skills");

  const skillDir = join(baseDir, name);

  if (existsSync(join(skillDir, "SKILL.md"))) {
    return { ok: false, error: `Skill '${name}' already exists at ${skillDir}` };
  }

  // Create directory
  mkdirSync(skillDir, { recursive: true });

  // Generate skeleton SKILL.md
  const desc = description || `Custom skill: ${name}`;
  const content = `---
name: ${name}
description: ${desc}
metadata: '{"hawky":{}}'
---

# ${name}

## When to Use

Use this skill when the user asks about: (describe your trigger conditions here)

## How to Use

(Add your instructions here. The agent will read this file and follow these steps.)

### Example Commands

\`\`\`bash
# Add CLI commands the agent should run
echo "Hello from ${name}!"
\`\`\`

## Setup

(Describe any setup required: CLI tools to install, config files to create, API keys to set)

## Tips

- (Add usage tips here)
`;

  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");

  return { ok: true, path: join(skillDir, "SKILL.md") };
}
