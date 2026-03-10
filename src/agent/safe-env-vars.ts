// =============================================================================
// Safe environment variable whitelist
//
// Leading `KEY=VALUE cmd` assignments are convenient for the model but a
// security hazard: many tools read specific env vars at runtime and mutate
// state or execute arbitrary programs based on them. The canonical example
// is `GIT_EXTERNAL_DIFF=touch git diff` — `git diff` is on the read-only
// allowlist, but git invokes `touch` on its temp-file arguments during the
// diff, mutating the filesystem. Same class of hole for GIT_PAGER, PAGER,
// GIT_SSH_COMMAND, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, BASH_ENV, ENV, PATH,
// NODE_OPTIONS, PYTHONPATH, SHELL — an attacker who can set any of these
// before a safe-looking command can turn that command into code execution.
//
// Policy: strip leading KEY=VALUE pairs from a command ONLY when KEY is
// on this whitelist. Any other key either prompts (if the leaf can't match
// the allowlist after) or outright rejects. Fail-closed against unknowns.
//
// This list mirrors Claude Code's SAFE_ENV_VARS (leaked source at
// src/tools/BashTool/bashPermissions.ts:378-430). Expand sparingly.
// =============================================================================

export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  // Skill / tool authentication — the reason this concept exists.
  "GOG_KEYRING_PASSWORD",
  "ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "OPENAI_API_KEY",
  // Generic credential-holders the model often uses inline. These are
  // user-chosen names whose values are only meaningful to commands that
  // explicitly read them (e.g. `curl -H "Authorization: Bearer $TOKEN"`).
  // Unlike GIT_EXTERNAL_DIFF / LD_PRELOAD, nothing interprets them as
  // "run this program" at the OS or library level.
  "TOKEN",
  "AUTH_TOKEN",
  "API_TOKEN",
  "BEARER_TOKEN",
  // Runtime mode hints that tools respect but don't use to locate executables.
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "CI",
  // Locale / time zone — purely display concerns.
  "TZ",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  // Go build hints — select target, no exec path implications.
  "GOARCH",
  "GOOS",
]);

/**
 * Returns true iff the env var name is safe to strip as a leading assignment.
 * Anything not on the whitelist is treated as potentially executable intent.
 */
export function isSafeEnvVar(name: string): boolean {
  return SAFE_ENV_VARS.has(name);
}
