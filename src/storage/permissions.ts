// =============================================================================
// Persistent Permission Cache
//
// Saves "always allow" decisions to ~/.hawky/permissions.json (global scope)
// so they persist across sessions. When the user says "Always allow bash",
// it sticks forever — no re-prompting on every session start.
//
// Format:
// {
//   "always_allowed": ["bash", "edit_file"],
//   "allow_all": false,
//   "allowed_commands": { "bash": ["git status", "ls -la"] },
//   "rules": ["Bash(git log *)", "Bash(gog gmail *)"]
// }
//
// `rules` is the modern path. When the user clicks "Allow `<pattern>`
// always", the pattern is appended here instead of as an exact-match
// grant — that's what makes future variants of the same command auto-
// approve without re-prompting. The legacy fields (`always_allowed`,
// `allowed_commands`) still work for older grants and for the simpler
// "Allow this exact always" button.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { PermissionCacheData } from "../agent/tool_executor.js";
import { getConfigDir } from "./config.js";

function getPermissionsPath(): string {
  return join(getConfigDir(), "permissions.json");
}

function getPermissionsTmpPath(): string {
  return join(getConfigDir(), "permissions.json.tmp");
}

/**
 * Load persisted permission cache from disk (synchronous).
 * Must be synchronous so permissions are available before the first tool call.
 * Returns null if no file exists or it's invalid.
 */
export function loadPermissionsSync(): PermissionCacheData | null {
  try {
    const content = readFileSync(getPermissionsPath(), "utf-8");
    const data = JSON.parse(content);
    if (data && typeof data === "object") {
      return {
        always_allowed: Array.isArray(data.always_allowed) ? data.always_allowed : [],
        allow_all: data.allow_all === true,
        allowed_commands: data.allowed_commands && typeof data.allowed_commands === "object"
          ? data.allowed_commands
          : undefined,
        rules: Array.isArray(data.rules)
          ? data.rules.filter((r: unknown): r is string => typeof r === "string")
          : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Alias for backward compat with tests
export const loadPermissions = async (): Promise<PermissionCacheData | null> => loadPermissionsSync();

/**
 * Save permission cache to disk (merge with existing).
 * Read/merge/write with atomic temp+rename to avoid corruption from
 * concurrent sessions. Does NOT persist allow_all — too dangerous
 * for global scope (one mistake disables all prompts everywhere).
 */
export async function savePermissions(data: PermissionCacheData): Promise<void> {
  try {
    mkdirSync(getConfigDir(), { recursive: true });

    // Read existing permissions and merge (additive only)
    const existing = loadPermissionsSync();

    // Merge command-level allowlists
    const mergedCommands: Record<string, string[]> = { ...(existing?.allowed_commands ?? {}) };
    for (const [tool, cmds] of Object.entries(data.allowed_commands ?? {})) {
      const existingCmds = new Set(mergedCommands[tool] ?? []);
      for (const cmd of cmds) existingCmds.add(cmd);
      mergedCommands[tool] = [...existingCmds];
    }

    // Merge the pattern-rule list — additive, deduplicated, order
    // preserved (existing first, then new). Pattern grants compound
    // across sessions, which is the whole point of this layer.
    const mergedRules = [
      ...(existing?.rules ?? []),
      ...((data.rules ?? []).filter((r) => !(existing?.rules ?? []).includes(r))),
    ];

    const merged: PermissionCacheData = {
      always_allowed: [...new Set([
        ...(existing?.always_allowed ?? []),
        ...data.always_allowed,
      ])],
      allow_all: false, // Never persist allow_all globally
      allowed_commands: Object.keys(mergedCommands).length > 0 ? mergedCommands : undefined,
      rules: mergedRules.length > 0 ? mergedRules : undefined,
    };

    // Atomic write: temp file + rename
    writeFileSync(getPermissionsTmpPath(), JSON.stringify(merged, null, 2) + "\n", "utf-8");
    renameSync(getPermissionsTmpPath(), getPermissionsPath());
  } catch {
    // Silently fail — permissions are nice-to-have, not critical
  }
}
