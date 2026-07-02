// =============================================================================
// Tool Executor
//
// Three-phase tool processing:
//   Phase 1: Sequential permission checking per tool
//   Phase 2: Parallel execution of approved tools
//   Phase 3: Post-processing (future: hooks)
//
// Designed with clean phase boundaries so hooks can slot in later.
// =============================================================================

import { resolve, normalize } from "node:path";
import { realpathSync } from "node:fs";
import type {
  ToolUseRequest,
  ToolResult,
  ToolContext,
  ToolDefinition,
  PermissionLevel,
  PermissionMode,
  PermissionSuggestion,
  StreamEvent,
  ToolUseStartEvent,
} from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { parseSafeBash } from "./safe-bash-parser.js";
import { extractCommandPieces, reduceBashForMatch, stripEnvAssignments, stripSafeWrappers, tokenizeShellLite } from "./safe-bash-reductions.js";
import { evaluateRules, evaluateRulesAgainst, type ToolCallView, type RuleEvalResult } from "./permission-patterns.js";
import type { LoopGuard } from "./loop_guard.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ToolCallResult {
  tool_use_id: string;
  name: string;
  result: ToolResult;
}

export type PermissionDecision = "allow_once" | "allow_always" | "allow_command" | "allow_all" | "accept_edits" | "allow_directory" | "deny";

/**
 * Tools that form a single "file edits" permission class. Privilege-wise
 * they are equivalent: both can replace arbitrary content in any file the
 * agent already has a path for. Keeping them as separate always-allow
 * entries leaks an implementation detail into the UI — the user clicks
 * "Always allow edit_file" and is surprised that the next write_file on
 * the same kind of target prompts again.
 *
 * Decisions on any member of this class record approval for the whole
 * class. Dir-scoped and mode-scoped checks already treat them as one.
 */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file"]);

/**
 * Extract the inner shell command from a `nodes` `system.run` invocation,
 * or "" when the input isn't a `system.run` with a command array. The
 * permission cache (auto-approval + decision recording) and the safety
 * check all need this exact param-shape knowledge; keep it in one place so
 * they can't drift.
 */
function nodesSystemRunCommand(input?: Record<string, unknown>): string {
  if (!input || input.action !== "invoke" || input.command !== "system.run") return "";
  const params = input.params as Record<string, unknown> | undefined;
  return Array.isArray(params?.command) ? (params!.command as string[]).join(" ") : "";
}

/**
 * Pair edit_file ↔ write_file pattern grants: an `Edit(<path>)` rule
 * also creates `Write(<path>)`, and vice versa. This mirrors the
 * legacy "Always allow file edits" button which records both at once.
 * Returns null if the pattern doesn't begin with `Edit(` or `Write(`
 * (i.e., it targets some other tool — no mirroring needed).
 */
function mirrorEditWritePattern(pattern: string): string | null {
  // Match `Edit(...)` or `Write(...)` with a non-greedy body so a
  // pattern like `Edit(C:\\repo\\*)` is preserved verbatim.
  const m = /^(Edit|Write)\(([\s\S]*)\)$/.exec(pattern.trim());
  if (!m) return null;
  const sibling = m[1] === "Edit" ? "Write" : "Edit";
  return `${sibling}(${m[2]})`;
}

/** Response from a permission prompt — decision + optional deny feedback. */
export interface PermissionResponse {
  decision: PermissionDecision;
  /** User-provided reason for denial (sent as tool result instead of generic message). */
  feedback?: string;
  /**
   * Optional rule pattern attached to an `allow_always` decision. When
   * present, the cache records the pattern in `rules` rather than the
   * exact tool/command — so future variants of the same command auto-
   * approve too. The frontend computes the suggested pattern via
   * `suggestRulePattern` and includes it when the user clicks the
   * "Allow `<pattern>` always" button. Ignored on other decisions.
   */
  pattern?: string;
}

export interface PermissionResolver {
  /**
   * Ask the user for permission to execute a tool.
   * Returns their decision + optional feedback.
   * @param suggestions - Context-aware suggestions to offer in the prompt
   */
  ask(toolUseId: string, toolName: string, toolInput: Record<string, unknown>, suggestions?: PermissionSuggestion[]): Promise<PermissionResponse>;
}

// -----------------------------------------------------------------------------
// Session-level permission cache
// -----------------------------------------------------------------------------

export interface PermissionCacheData {
  /** Tool-level always-allowed (edit_file, write_file — NOT bash) */
  always_allowed: string[];
  allow_all: boolean;
  /** Command-level allowlist: { bash: ["git status", "ls -la"] } */
  allowed_commands?: Record<string, string[]>;
  /**
   * Pattern-form allow rules accumulated from "Allow `Bash(<pattern>)`
   * always" decisions. Same grammar as `config.permissions.allow[]`,
   * stored separately so a user-clicked grant doesn't merge into their
   * curated config rules. Compounds across restarts (the whole point
   * of moving from exact-string to pattern grants).
   */
  rules?: string[];
  /** Permission mode */
  mode?: PermissionMode;
  /** Additional working directories approved for auto-edits (session-scoped) */
  additional_directories?: string[];
}

export class PermissionCache {
  /** Tool-level always-allowed (e.g., edit_file, write_file — NOT bash) */
  private alwaysAllowedTools = new Set<string>();
  /** Command-level allowlist for bash (exact command strings) */
  private allowedCommands = new Map<string, Set<string>>();
  private allowAll = false;
  /**
   * Pattern-form allow rules accumulated from "allow as pattern"
   * decisions. Persisted to disk so grants compound across restarts.
   * Grammar matches `config.permissions.allow[]` (see
   * `permission-patterns.ts`).
   */
  private rules: string[] = [];
  /** Gateway-level forced bypass — survives reset() */
  private _forceBypass = false;
  /** Permission mode — controls auto-approval behavior */
  private _mode: PermissionMode = "default";
  /** Additional working directories approved for auto-edits (session-scoped) */
  private _additionalDirs = new Set<string>();

  /**
   * Check if a tool call is auto-approved.
   * For bash: checks command-level allowlist (exact match).
   * For other tools: checks tool-level always-allowed.
   */
  isAutoApproved(toolName: string, permission: PermissionLevel, input?: Record<string, unknown>): boolean {
    if (this._forceBypass || this.allowAll) return true;
    if (permission === "auto_approve") return true;
    // Remote node execution is a different trust boundary — never reuse
    // cached local approvals. Always prompt for host="node".
    if (toolName === "bash" && input?.host === "node") return false;
    // Nodes tool with system.run: don't auto-approve from tool-level cache.
    // Check command-level allowlist instead (specific command was previously approved).
    if (toolName === "nodes" && input?.action === "invoke" && input?.command === "system.run") {
      const innerCmd = nodesSystemRunCommand(input);
      if (innerCmd) {
        const commands = this.allowedCommands.get(toolName);
        if (commands?.has(`system.run:${innerCmd}`)) return true;
      }
      return false; // Defer to isSafeToolCall for safety check
    }
    // Tool-level always-allowed (non-bash tools)
    if (this.alwaysAllowedTools.has(toolName)) return true;
    // Command-level allowlist (bash: exact command match)
    if (toolName === "bash" && input?.command) {
      const commands = this.allowedCommands.get(toolName);
      if (commands?.has(String(input.command))) return true;
    }
    // Pattern rules accumulated from "allow as pattern" decisions.
    // Same matching logic as `config.permissions.allow[]` so a grant
    // compounds across all variants (env-prefixed, wrapped, etc.).
    if (this.rules.length > 0) {
      const r = evaluateRules(this.rules, { name: toolName, input });
      if (r.matched) return true;
    }
    return false;
  }

  /**
   * Record a permission decision.
   * - allow_always: for non-bash tools, saves tool name. For bash, saves exact command.
   *   When a `pattern` is provided (the user clicked "Allow `<pattern>` always"
   *   instead of the default exact form), the pattern is stored in `this.rules`
   *   instead of as an exact-match grant. Patterns compound naturally across
   *   restarts and command variants.
   * - allow_command: saves exact command to command-level allowlist (bash only).
   * - allow_all: session-wide bypass (not persisted).
   * - accept_edits: switch to acceptEdits mode.
   * - allow_directory: add a directory from input.file_path to additional dirs.
   *   This does NOT flip mode — mode is a session-wide setting; the directory
   *   grant is scoped. `isSafeToolCall` auto-approves file edits whose path
   *   is inside additionalDirs regardless of mode.
   */
  recordDecision(
    toolName: string,
    decision: PermissionDecision,
    input?: Record<string, unknown>,
    pattern?: string,
  ): void {
    if (decision === "allow_always") {
      if (pattern) {
        // Pattern grant: store as a rule. Trumps the per-tool exact
        // grant below — the user explicitly chose the broader form.
        this.addRule(pattern);
        // edit_file / write_file are one permission class (see
        // FILE_EDIT_TOOLS below). The legacy "Always allow file
        // edits" button approves both; mirror the same UX for
        // pattern grants so `Edit(/repo/src/*)` also covers
        // `Write(/repo/src/*)` and vice versa. (Codex round 8 P2.)
        if (FILE_EDIT_TOOLS.has(toolName)) {
          const sibling = mirrorEditWritePattern(pattern);
          if (sibling) this.addRule(sibling);
        }
      } else if (toolName === "bash" && input?.command) {
        // Bash: save exact command, not the tool name
        this.addAllowedCommand(toolName, String(input.command));
      } else if (toolName === "nodes" && input?.action === "invoke" && input?.command === "system.run") {
        // Nodes system.run: save the specific inner command, not the tool name.
        // "Always allow nodes" would bypass all future safety checks.
        const innerCmd = nodesSystemRunCommand(input);
        if (innerCmd) {
          this.addAllowedCommand(toolName, `system.run:${innerCmd}`);
        }
      } else if (FILE_EDIT_TOOLS.has(toolName)) {
        // Treat edit_file and write_file as one permission class — approving
        // one extends to the other. See FILE_EDIT_TOOLS for the rationale.
        for (const t of FILE_EDIT_TOOLS) this.alwaysAllowedTools.add(t);
      } else {
        this.alwaysAllowedTools.add(toolName);
      }
    }
    if (decision === "allow_command" && input?.command) {
      this.addAllowedCommand(toolName, String(input.command));
    }
    if (decision === "allow_all") {
      this.allowAll = true;
    }
    if (decision === "accept_edits") {
      this._mode = "accept-edits";
    }
    if (decision === "allow_directory" && input?.file_path) {
      const dir = getDirectoryForPath(String(input.file_path));
      if (dir) this._additionalDirs.add(dir);
    }
  }

  private addAllowedCommand(toolName: string, command: string): void {
    let commands = this.allowedCommands.get(toolName);
    if (!commands) {
      commands = new Set();
      this.allowedCommands.set(toolName, commands);
    }
    commands.add(command);
  }

  private addRule(pattern: string): void {
    if (!pattern) return;
    if (!this.rules.includes(pattern)) this.rules.push(pattern);
  }

  reset(): void {
    this.alwaysAllowedTools.clear();
    this.allowedCommands.clear();
    this.rules = [];
    this.allowAll = false;
    // Note: _forceBypass survives reset — it's a gateway-level flag
    // Note: _mode and _additionalDirs survive reset — they're user choices
  }

  serialize(): PermissionCacheData {
    const allowed_commands: Record<string, string[]> = {};
    for (const [tool, cmds] of this.allowedCommands) {
      allowed_commands[tool] = [...cmds];
    }
    return {
      always_allowed: [...this.alwaysAllowedTools],
      allow_all: this.allowAll,
      allowed_commands,
      rules: this.rules.length > 0 ? [...this.rules] : undefined,
      mode: this._mode,
      additional_directories: this._additionalDirs.size > 0 ? [...this._additionalDirs] : undefined,
    };
  }

  restore(data: PermissionCacheData): void {
    this.alwaysAllowedTools = new Set(data.always_allowed ?? []);
    this.allowAll = data.allow_all ?? false;
    this.allowedCommands.clear();
    if (data.allowed_commands) {
      for (const [tool, cmds] of Object.entries(data.allowed_commands)) {
        this.allowedCommands.set(tool, new Set(cmds));
      }
    }
    this.rules = Array.isArray(data.rules) ? [...data.rules] : [];
    if (data.mode) this._mode = data.mode;
    if (data.additional_directories) {
      this._additionalDirs = new Set(data.additional_directories);
    }
  }

  hasEntries(): boolean {
    return (
      this.alwaysAllowedTools.size > 0 ||
      this.allowedCommands.size > 0 ||
      this.rules.length > 0 ||
      this.allowAll
    );
  }

  /** Read-only view of the persistent pattern rules. For testing/debug. */
  getRules(): readonly string[] {
    return this.rules;
  }

  isAllowAll(): boolean {
    return this._forceBypass || this.allowAll;
  }

  /** True iff this cache is in bypass via the gateway-level
   *  --dangerously-skip-permissions flag (rather than a session-level
   *  "allow all" click). The two are observable together via
   *  isAllowAll(); UI affordances differ — gateway-flag bypass cannot
   *  be turned off from the UI. */
  isForceBypass(): boolean {
    return this._forceBypass;
  }

  /** Set gateway-level forced bypass (survives reset) */
  setForceBypass(enabled: boolean): void {
    this._forceBypass = enabled;
  }

  isAlwaysAllowed(toolName: string): boolean {
    return this.alwaysAllowedTools.has(toolName);
  }

  isCommandAllowed(toolName: string, command: string): boolean {
    return this.allowedCommands.get(toolName)?.has(command) ?? false;
  }

  // --- Permission mode ---

  get mode(): PermissionMode {
    if (this._forceBypass || this.allowAll) return "bypass";
    return this._mode;
  }
  setMode(mode: PermissionMode): void { this._mode = mode; }

  // --- Additional working directories ---

  get additionalDirectories(): ReadonlySet<string> { return this._additionalDirs; }
  addDirectory(dir: string): void { this._additionalDirs.add(normalize(resolve(dir))); }
}

// -----------------------------------------------------------------------------
// Safe command allowlist for bash tool (a proven design pattern)
// Read-only commands that are always safe to auto-approve.
// -----------------------------------------------------------------------------

/** Prefixes for safe bash commands. Matching is word-boundary aware via
 *  `matchesSafePrefix` — an entry without a trailing space matches only when
 *  the candidate equals it or is followed by whitespace. That prevents
 *  `git diff` from matching `git difftool`, `env` from matching `env bash`,
 *  etc. Entries can still include a trailing space for clarity, but it is
 *  no longer required for safety. */
const SAFE_BASH_PREFIXES = [
  // Read-only file system
  "cat ", "head ", "tail ", "wc ", "file ", "stat ",
  "ls ", "realpath ", "readlink ", "du ", "df ",
  "which ", "type ", "basename ", "dirname ",
  // Text processing (truly read-only — no awk/sed/xargs which can execute code)
  "grep ", "rg ", "uniq ", "cut ",
  "diff ", "comm ", "column ", "jq ",
  // Git (read-only)
  "git status", "git log", "git diff", "git show", "git branch",
  "git remote", "git rev-parse", "git describe", "git blame",
  "git shortlog", "git tag", "git stash list", "git config --get",
  // System info (with trailing space to prevent prefix abuse)
  "date ", "uname ", "printenv ", "id ",
  // Package info (read-only)
  "node --version", "bun --version", "npm --version", "python --version",
  "python3 --version", "pip list", "pip3 list", "brew list",
  // gog — read-only Google Workspace CLI commands
  "gog gmail messages search ", "gog gmail messages list ",
  "gog gmail get ",           // full message read (top-level, not under messages)
  "gog gmail search ",        // thread-level search
  "gog gmail drafts list", "gog gmail drafts get ",
  "gog gmail labels ",
  "gog calendar events", "gog calendar calendars",
  "gog calendar get ",
  "gog contacts list", "gog contacts get ",
  "gog drive ls", "gog drive search ",
  "gog sheets get ", "gog sheets metadata ",
  "gog docs cat ",
  "gog auth list",
  // gog — low-risk write commands (reversible, post-approval execution)
  "gog gmail messages modify ",  // mark read, archive, add/remove labels
  "gog gmail archive ",          // convenience: archive multiple IDs
  "gog gmail mark-read ",        // convenience: mark-read multiple IDs
  "gog gmail batch modify ",     // batch: add/remove labels on multiple IDs
  // NOTE: `gog gmail drafts create` is intentionally NOT auto-approved.
  // Even though the user reviews drafts in Gmail before sending, the act of
  // creating a draft uploads arbitrary local content (e.g. via --body-file -)
  // to a remote Gmail account, which is a non-local side effect. Always prompt.
  // --help is read-only for any subcommand; agents poke at help often
  "gog --help", "gog gmail --help", "gog calendar --help",
  "gog drive --help", "gog sheets --help", "gog contacts --help",
  "gog docs --help", "gog auth --help",
  // Shell builtins / navigation — subshell-scoped, no persistent side effects.
  // Any *subsequent* leaf (`cd X && git log`) is still validated independently,
  // so `cd` alone can't smuggle a dangerous command past the allowlist. The
  // common skill-driven pattern `cd <repo> && <read-only git/cat>` was the
  // single biggest source of approval prompts for read-only flows before this.
  //
  // Deliberately NOT on this list: `export`. An exported env var persists for
  // every subsequent leaf in the same script, so an attacker could smuggle
  // executable intent through a "safe" follow-up command — e.g.
  // `export GIT_EXTERNAL_DIFF=touch && git diff` executes `touch` via git's
  // diff driver hook. Inline assignment (`FOO=x cmd`) is scoped to one
  // command and is handled by the existing stripLeadingAssignments path.
  "cd ",        // change directory — the `$(rm -rf /)` risk is handled by the
                // parser, which extracts substitutions as their own leaves.
  "pushd ",     // same argument as cd (stack-based cd)
];

/** Commands that are safe only as exact strings (no arguments). */
const SAFE_BASH_EXACT = new Set([
  "ls", "pwd", "date", "whoami", "hostname", "uname",
  "printenv", "id", "uptime", "sw_vers", "env",
  "popd", "dirs", // directory-stack builtins; bare invocations only
]);

/**
 * Check if a bash command is safe to auto-approve.
 * Only applies to the bash tool. Returns true for purely read-only commands.
 *
 * Strategy: parse the command into individual leaf invocations (handling
 * comments, env-var prefixes, $() substitution, for-loops, pipes, &&/||/;),
 * then verify every leaf matches the allowlist. The dangerous-pattern
 * denylist runs over the whole script as a backstop.
 */
export function isSafeBashCommand(input: Record<string, unknown>): boolean {
  // Remote node execution is a different trust boundary — never auto-approve
  if (input.host === "node") return false;

  const cmd = typeof input.command === "string" ? input.command.trim() : "";
  if (!cmd) return false;

  // Backstop: never auto-approve commands matching the dangerous deny list.
  if (isDangerousCommand(cmd)) return false;

  const parsed = parseSafeBash(cmd);
  // If the parser saw any unsupported construct (heredoc, file redirection,
  // backticks, subshell, if/while/case, etc.) — fail closed.
  if (parsed.residual.length > 0) return false;
  if (parsed.leaves.length === 0) return false;

  return parsed.leaves.every((leaf) => isSafeBashPart(leaf.trim()));
}

// -----------------------------------------------------------------------------
// Dangerous command deny list (for headless/sub-agent mode)
// These commands are NEVER auto-approved in headless mode.
// -----------------------------------------------------------------------------

const DANGEROUS_PATTERNS = [
  /\brm\s+-[^\s]*r/i,          // rm -rf, rm -r, rm -R
  /\brm\s+-[^\s]*f/i,          // rm -f, rm -rf, rm -Rf
  /\bsudo\b/,                   // any sudo usage
  /\bchmod\b/,                  // permission changes
  /\bchown\b/,                  // ownership changes
  /\bmkfs\b/,                   // filesystem format
  /\bdd\b/,                     // disk dump
  />\s*\/dev\/(?!null\b)/,        // write to devices (but allow >/dev/null, 2>/dev/null)
  /\bgit\s+push\s+.*--force/,  // force push
  /\bgit\s+reset\s+--hard/,    // hard reset
  /\bgit\s+clean\s+-[^\s]*f/,  // force clean
  /\bkill\s+-9/,               // force kill
  /\bkillall\b/,               // kill all processes
  /\bshutdown\b/,              // system shutdown
  /\breboot\b/,                // system reboot
  /\bcurl\b.*\|\s*bash/,       // pipe curl to bash
  /\bwget\b.*\|\s*bash/,       // pipe wget to bash
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
}

// stripEnvAssignments and stripSafeWrappers live in safe-bash-reductions.ts
// — they're shared with the user-rule pattern matcher so a rule like
// `Bash(git log *)` matches `timeout 30 NODE_ENV=test git log` after the
// same reductions we apply for the static allowlist below.

/**
 * Slack Web API endpoints we auto-approve. Intentionally narrow:
 * directory and workspace-metadata only. Endpoints that return private
 * message content, file content, search results, or per-user state require
 * an explicit permission prompt — even though they are nominally GET — so
 * the agent cannot silently exfiltrate workspace data using a token that
 * happens to be on disk.
 *
 * Specifically NOT on this list (always prompted):
 *   - conversations.history / conversations.replies   (message content)
 *   - search.messages / search.files                  (workspace search)
 *   - reactions.get                                    (includes message)
 *   - stars.list / files.list / files.info            (personal data)
 *   - bookmarks.list                                   (per-channel state)
 *   - chat.* / reactions.add / conversations.open     (writes)
 */
const SLACK_READ_ENDPOINTS = new Set([
  "auth.test",
  "team.info",
  "users.list",
  "users.info",
  "users.lookupByEmail",
  "users.profile.get",
  "conversations.list",
  "emoji.list",
]);

/**
 * Returns true iff `part` is a curl invocation that:
 *   - uses GET (no -X POST/PUT/DELETE/PATCH; -X GET is fine)
 *   - has no request body (-d, --data*, -F, --form)
 *   - has no upload (-T, --upload-file) — this would PUT local files
 *   - has no output-to-disk flag (-o, --output, -O, --remote-name)
 *   - has no script/cookie load (-K, --config, -b, --cookie-jar)
 *   - the actual target URL — not just any string in the command — is on
 *     slack.com/api/<endpoint>, and the endpoint is on the read-only list
 *
 * Flag parsing is structural: argv is normalized so `-Tfile` and
 * `--upload-file=file` are indistinguishable from `-T file` before the
 * rejection walk, then every token is classified against the reject /
 * value / URL sets. That closes upload and config-load bypasses that a
 * purely regex-based check would miss.
 */

// Short flags that are always rejected (and each takes a single value).
const CURL_REJECT_SHORT = new Set(["d", "F", "T", "o", "O", "K", "c"]);
// Short flags that just consume a value we must skip (not reject-worthy).
const CURL_VALUE_SHORT = new Set([
  "H", "X", "A", "e", "u", "b", "x", "w",
]);

// Long flags rejected outright. Uploads and config-loads belong here.
const CURL_REJECT_LONG = new Set([
  "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "--form", "--form-string",
  "--upload-file",
  "--output", "--remote-name", "--remote-name-all",
  "--config", "--cookie-jar",
]);

// Long flags that consume a value we must skip.
const CURL_VALUE_LONG = new Set([
  "--header", "--request",
  "--user-agent", "--referer", "--user", "--cookie",
  "--max-time", "--connect-timeout",
  "--resolve",
  "--cacert", "--cert", "--key", "--capath", "--ca-native",
  "--proxy",
  "--retry", "--retry-delay", "--retry-max-time",
  "--write-out",
]);

/**
 * Normalize curl argv so glued short flags (-Tfile) and long flags with `=`
 * (--upload-file=x) become two separate tokens. Clustered short flags like
 * `-sL` are left alone — they can't precede a value-taking flag and still
 * accept a glued value, so splitting them is unnecessary.
 */
function normalizeCurlArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (const tok of argv) {
    // --long=value  →  ["--long", "value"]
    if (tok.startsWith("--") && tok.includes("=")) {
      const eq = tok.indexOf("=");
      out.push(tok.slice(0, eq));
      out.push(tok.slice(eq + 1));
      continue;
    }
    // -Tfile (single letter is a value-taking short flag)  →  ["-T", "file"]
    if (tok.length > 2 && tok.startsWith("-") && !tok.startsWith("--")) {
      const first = tok[1];
      if (CURL_REJECT_SHORT.has(first) || CURL_VALUE_SHORT.has(first)) {
        out.push("-" + first);
        out.push(tok.slice(2));
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

function isSafeSlackCurl(part: string): boolean {
  if (!/^curl(\s|$)/.test(part)) return false;

  const rawArgv = tokenizeShellLite(part);
  rawArgv.shift(); // drop "curl"
  const argv = normalizeCurlArgv(rawArgv);

  const urls: string[] = [];
  let method: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    // End-of-flags: everything after is a positional URL candidate.
    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        if (looksLikeUrl(argv[j])) urls.push(argv[j]);
      }
      break;
    }

    // Explicit URL via --url.
    if (tok === "--url") {
      if (i + 1 < argv.length) urls.push(argv[++i]);
      continue;
    }

    // Long flags.
    if (tok.startsWith("--")) {
      if (CURL_REJECT_LONG.has(tok)) return false;
      if (tok === "--request") {
        if (i + 1 < argv.length) method = argv[++i].toUpperCase();
        continue;
      }
      if (CURL_VALUE_LONG.has(tok)) { i++; continue; }
      continue; // boolean long flag
    }

    // Short flags.
    if (tok.startsWith("-") && tok.length > 1) {
      const letter = tok[1];
      // Single-letter short flag after normalization.
      if (tok.length === 2) {
        if (CURL_REJECT_SHORT.has(letter)) return false;
        if (letter === "X") {
          if (i + 1 < argv.length) method = argv[++i].toUpperCase();
          continue;
        }
        if (CURL_VALUE_SHORT.has(letter)) { i++; continue; }
        continue; // boolean short flag (-s, -k, -L, etc.)
      }
      // Clustered short flags (e.g. -sL). If any letter is reject-worthy,
      // fail closed. If any is value-taking, curl would consume the rest
      // of the cluster as the value — in which case we've already
      // normalized it away above, so reaching here means it's boolean-only.
      for (const ch of tok.slice(1)) {
        if (CURL_REJECT_SHORT.has(ch)) return false;
        if (CURL_VALUE_SHORT.has(ch)) return false; // glued but not split — fail closed
      }
      continue;
    }

    // Positional — URL candidate.
    if (looksLikeUrl(tok)) urls.push(tok);
  }

  if (method && method !== "GET") return false;
  if (urls.length === 0) return false;

  for (const url of urls) {
    const m = /^https?:\/\/slack\.com\/api\/([A-Za-z0-9._]+)/.exec(url);
    if (!m) return false;
    if (!SLACK_READ_ENDPOINTS.has(m[1])) return false;
  }
  return true;
}

/**
 * `find` flags that take NO following argument. These are pure predicates
 * or output directives that read what find has and emit to stdout.
 */
const FIND_NULLARY_FLAGS = new Set([
  // Pure predicates
  "-empty", "-readable", "-writable", "-executable",
  "-nouser", "-nogroup",
  "-true", "-false",
  // Traversal control
  "-prune", "-depth", "-mount", "-xdev", "-follow",
  // Output (stdout only)
  "-print", "-print0", "-ls",
  // Logical combinators
  "-not", "-and", "-or", "-a", "-o", "!",
]);

/**
 * `find` flags that take exactly ONE following argument. The argument
 * token MUST be skipped during the flag-validation walk, otherwise
 * something like `find . -mtime -7` rejects because `-7` looks like an
 * unknown flag — or worse, something like `find . -name -delete` would
 * have its value re-interpreted as a dangerous flag.
 */
const FIND_UNARY_FLAGS = new Set([
  // Name / path matching
  "-name", "-iname", "-lname", "-ilname",
  "-path", "-ipath", "-regex", "-iregex",
  "-regextype",
  "-type",
  // Size / time / ownership predicates that take a value
  "-size",
  "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin",
  "-newer", "-newermt", "-newerat", "-newerct",
  "-user", "-group", "-uid", "-gid",
  "-perm",
  // Traversal limits
  "-maxdepth", "-mindepth",
  // Output with a format string
  "-printf",
]);

/**
 * `find` flags that execute external programs or write to disk — NEVER safe.
 * Explicit reject list is redundant (unknown `-flag`s already reject), but
 * it makes the policy auditable and the test matrix clear.
 */
const FIND_UNSAFE_FLAGS = new Set([
  "-exec", "-execdir", "-ok", "-okdir",
  "-delete",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

/**
 * Returns true iff `part` is a `find` invocation that only reads and writes
 * to stdout. Built structurally (argv tokenization) like `isSafeSlackCurl`;
 * a prefix-based allowlist would miss `-delete` slipped anywhere in the
 * predicate chain.
 */
export function isSafeFindCommand(part: string): boolean {
  const stripped = stripEnvAssignments(part);
  const tokens = tokenizeShellLite(stripped);
  if (tokens.length === 0 || tokens[0] !== "find") return false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    // Grouping parens are valid find operators. They usually arrive
    // escaped or quoted (\(, "(") in real invocations; the parser
    // strips the escape so we see bare `(` / `)` here.
    if (t === "(" || t === ")") continue;
    if (FIND_UNSAFE_FLAGS.has(t)) return false;
    if (FIND_NULLARY_FLAGS.has(t)) continue;
    if (FIND_UNARY_FLAGS.has(t)) {
      // Consume the following value token unconditionally. This matches
      // real find semantics: `find . -name <pat>` treats the next token
      // as a pattern, even if it starts with `-`. Skipping here is both
      // correct (no false reject on `-mtime -7`) and safe — find itself
      // wouldn't re-interpret the consumed value as a directive later.
      i++;
      continue;
    }
    // Unknown token that *looks* like a flag — fail closed. Real values
    // (paths, patterns) don't start with '-' except when quoted, in
    // which case they'd be paired with a unary flag and already
    // consumed above.
    if (t.startsWith("-")) return false;
    // Non-flag token — typically the search path. Accept quietly.
  }
  return true;
}

// tokenizeShellLite moved to safe-bash-reductions.ts so the
// permission-pattern suggestion helper can reuse it without
// importing from tool_executor.ts (which would create a cycle).

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

/**
 * Word-boundary aware prefix match. A prefix matches a candidate iff either:
 *   - the prefix ends with whitespace (explicit boundary already), or
 *   - the candidate equals the prefix exactly, or
 *   - the character immediately after the prefix in the candidate is
 *     whitespace (space/tab).
 * Without this, `startsWith("git diff")` would accept `"git difftool ..."`
 * — a different executable that can spawn arbitrary programs.
 */
function matchesSafePrefix(candidate: string, prefix: string): boolean {
  if (!candidate.startsWith(prefix)) return false;
  if (prefix.length > 0 && /\s$/.test(prefix)) return true;
  if (candidate.length === prefix.length) return true;
  const next = candidate.charCodeAt(prefix.length);
  return next === 0x20 /* space */ || next === 0x09 /* tab */;
}

/**
 * Check whether a single pipeline segment is a safe read-only command.
 * This rejects known mutating flags even for otherwise read-only commands.
 * Strips leading env var assignments (e.g., GOG_KEYRING_PASSWORD=gog)
 * before matching against the allowlist.
 */
export function isSafeBashPart(part: string): boolean {
  // Try matching progressively reduced forms:
  //   raw → env-stripped → wrapper-unwrapped → env-stripped-again.
  // The last pass handles wrappers that hide env assignments inside them
  // (`time TZ=UTC git log` — `time` is a shell keyword so the env var
  // lives inside its scope). Each transformation is monotonic so the
  // deny rules below still apply to the most-reduced form.
  const envStripped = stripEnvAssignments(part);
  const unwrapped = stripSafeWrappers(envStripped);
  const reStripped = stripEnvAssignments(unwrapped);
  const candidates: string[] = [];
  for (const c of [part, envStripped, unwrapped, reStripped]) {
    if (!candidates.includes(c)) candidates.push(c);
  }

  let matched = false;
  for (const candidate of candidates) {
    if (SAFE_BASH_EXACT.has(candidate)) { matched = true; break; }
    if (SAFE_BASH_PREFIXES.some((prefix) => matchesSafePrefix(candidate, prefix))) { matched = true; break; }
    if (isSafeSlackCurl(candidate)) { matched = true; break; }
    if (isSafeFindCommand(candidate)) { matched = true; break; }
    // Any `gog <subcommand> ... --help` is read-only.
    if (/^gog\s+\S/.test(candidate) && /\s--help(\s|$)/.test(candidate)) { matched = true; break; }
  }
  if (!matched) return false;

  // `sort -o out.txt` writes to disk; keep sort out of the allowlist entirely.
  // Check each reduction so `timeout 30 sort ...` / `time TZ=UTC sort ...`
  // are still rejected after every step that might strip a prefix.
  if (/^sort(\s|$)/.test(envStripped)) return false;
  if (/^sort(\s|$)/.test(unwrapped)) return false;
  if (/^sort(\s|$)/.test(reStripped)) return false;

  return true;
}

// -----------------------------------------------------------------------------
// Dangerous file paths — always prompt even in acceptEdits mode
// Matches Claude Code's isDangerousFilePathToAutoEdit list.
// -----------------------------------------------------------------------------

const DANGEROUS_DIRS = [".git", ".vscode", ".idea", ".claude"];
const DANGEROUS_FILES = new Set([
  ".gitconfig", ".gitignore", ".bashrc", ".bash_profile", ".zshrc",
  ".zprofile", ".profile", ".npmrc", ".yarnrc", ".env",
  ".env.local", ".env.production", "id_rsa", "id_ed25519",
  "authorized_keys", "known_hosts", "credentials", "credentials.json",
  "config.json", "secrets.json", "token", "token.json",
]);

/** Check if a file path should never be auto-edited (sensitive files). */
export function isDangerousPath(filePath: string): boolean {
  const norm = normalize(filePath);
  const segments = norm.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] ?? "";

  // Check for dangerous directories anywhere in the path
  for (const seg of segments.slice(0, -1)) {
    if (DANGEROUS_DIRS.includes(seg)) return true;
  }

  // Check for dangerous file names
  if (DANGEROUS_FILES.has(fileName)) return true;

  // Dotfiles in home directory (e.g., ~/.zshrc)
  if (norm.startsWith(process.env.HOME ?? "/NO_HOME") && fileName.startsWith(".")) return true;

  return false;
}

// -----------------------------------------------------------------------------
// Path containment check — is a file inside CWD or additional directories?
// -----------------------------------------------------------------------------

/** Resolve a path to absolute, normalized form. */
function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("/")) return normalize(filePath);
  if (filePath.startsWith("~")) return normalize(filePath.replace(/^~/, process.env.HOME ?? "/"));
  return normalize(resolve(cwd, filePath));
}

/**
 * Try to canonicalize a path via realpath (follows symlinks).
 * Falls back to the lexical path if the file doesn't exist yet.
 */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // File may not exist yet (write_file creating new file)
  }
}

/** Check if a file is inside any of the allowed working directories. */
export function isPathInWorkingDirs(
  filePath: string,
  cwd: string,
  additionalDirs: ReadonlySet<string>,
): boolean {
  // Canonicalize to follow symlinks — prevents escaping via in-tree symlinks
  const abs = tryRealpath(resolvePath(filePath, cwd));
  const dirs = [normalize(resolve(cwd)), ...additionalDirs].map(tryRealpath);
  return dirs.some((dir) => abs === dir || abs.startsWith(dir + "/"));
}

/**
 * Check if a file is inside an *explicitly approved* additional directory
 * (one added via the "Allow edits in <dir>" permission button). Unlike
 * isPathInWorkingDirs this does NOT include the session cwd — we only want
 * to auto-approve what the user scoped to, not the whole project.
 *
 * cwd is still needed to resolve relative paths in filePath.
 */
export function isPathInApprovedDir(
  filePath: string,
  cwd: string,
  additionalDirs: ReadonlySet<string>,
): boolean {
  if (additionalDirs.size === 0) return false;
  const abs = tryRealpath(resolvePath(filePath, cwd));
  const dirs = [...additionalDirs].map(tryRealpath);
  return dirs.some((dir) => abs === dir || abs.startsWith(dir + "/"));
}

/** Get the parent directory of a file path. */
function getDirectoryForPath(filePath: string): string {
  const abs = filePath.startsWith("/") ? filePath : resolve(filePath);
  const lastSlash = abs.lastIndexOf("/");
  return lastSlash > 0 ? abs.substring(0, lastSlash) : "/";
}

// -----------------------------------------------------------------------------
// Filesystem bash commands auto-approved in acceptEdits mode
// Matches Claude Code's ACCEPT_EDITS_ALLOWED_COMMANDS.
// -----------------------------------------------------------------------------

const ACCEPT_EDITS_BASH_COMMANDS = new Set([
  "mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed",
]);

function hasPathBearingFlag(parts: string[]): boolean {
  return parts.some((part) => part.startsWith("-") && (part.includes("=") || part.includes("/")));
}

/**
 * Check if a bash command is a filesystem operation auto-approved in acceptEdits mode.
 * Validates that the command targets paths within the allowed working directories
 * (rejects commands targeting absolute paths outside CWD or dangerous paths).
 */
function isFilesystemBashCommand(
  input: Record<string, unknown>,
  cwd: string,
  additionalDirs: ReadonlySet<string>,
): boolean {
  const cmd = typeof input.command === "string" ? input.command.trim() : "";
  if (!cmd) return false;

  // Reject shell operators — these could chain dangerous commands
  if (/[;`<>]|&&|\|\||\$\(/.test(cmd)) return false;

  const parts = cmd.split(/\s+/);
  const baseCmd = parts[0] ?? "";
  if (!ACCEPT_EDITS_BASH_COMMANDS.has(baseCmd)) return false;
  if (hasPathBearingFlag(parts.slice(1))) return false;

  // Extract path arguments (skip flags starting with -)
  const pathArgs = parts.slice(1).filter((p) => !p.startsWith("-"));

  // Resolve EVERY path argument against cwd, then check containment + dangerous
  for (const arg of pathArgs) {
    const resolved = resolvePath(arg, cwd);
    if (!isPathInWorkingDirs(resolved, cwd, additionalDirs)) return false;
    if (isDangerousPath(resolved)) return false;
  }

  return true;
}

// -----------------------------------------------------------------------------
// Mode-aware safe tool call check
// -----------------------------------------------------------------------------

/**
 * Check if a tool call is safe to auto-approve based on its input and the
 * current permission mode + working directory context.
 *
 * Returns { safe, reason, suggestions } where suggestions are offered when
 * the call is NOT safe but could be made safe by a mode/directory change.
 */
function isSafeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  cwd: string,
  additionalDirs: ReadonlySet<string>,
): { safe: boolean; reason?: string; suggestions?: PermissionSuggestion[] } {
  // Bash: read-only safe commands always pass (any mode)
  if (toolName === "bash" && isSafeBashCommand(input)) {
    return { safe: true, reason: "safe_command" };
  }

  // Bash: filesystem commands in acceptEdits mode (with path validation)
  if (toolName === "bash" && mode === "accept-edits" && isFilesystemBashCommand(input, cwd, additionalDirs)) {
    return { safe: true, reason: "accept_edits" };
  }

  // Nodes tool: per-action auto-approval
  if (toolName === "nodes") {
    const action = input.action as string | undefined;
    // Read-only actions always safe
    if (action === "status") return { safe: true, reason: "safe_command" };
    if (action === "invoke") {
      const cmd = input.command as string | undefined;
      // Read-only node commands + screenshot (own device, non-intrusive)
      if (cmd === "device.info" || cmd === "frontmost.app" || cmd === "system.which" || cmd === "screenshot") {
        return { safe: true, reason: "safe_command" };
      }
      // system.run: reuse bash safety check on the inner command
      if (cmd === "system.run") {
        const innerCmd = nodesSystemRunCommand(input);
        if (innerCmd && isSafeBashCommand({ command: innerCmd })) {
          return { safe: true, reason: "safe_command" };
        }
      }
    }
    // All other node actions require approval
  }

  // File edits in an explicitly approved directory — auto-approve regardless
  // of mode. This is what the "Allow edits in <dir>" button grants: the user
  // scoped approval to that directory, we honor exactly that scope. Dangerous
  // paths are still blocked.
  if (toolName === "edit_file" || toolName === "write_file") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    if (filePath && !isDangerousPath(filePath) && isPathInApprovedDir(filePath, cwd, additionalDirs)) {
      return { safe: true, reason: "allow_directory" };
    }
  }

  // File edits in acceptEdits mode — check path is in working dirs and not dangerous
  if ((toolName === "edit_file" || toolName === "write_file") && mode === "accept-edits") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    if (filePath && !isDangerousPath(filePath) && isPathInWorkingDirs(filePath, cwd, additionalDirs)) {
      return { safe: true, reason: "accept_edits" };
    }
  }

  // Not safe — generate suggestions
  const suggestions: PermissionSuggestion[] = [];

  if ((toolName === "edit_file" || toolName === "write_file") && typeof input.file_path === "string") {
    const filePath = input.file_path;
    const inDirs = isPathInWorkingDirs(filePath, cwd, additionalDirs);

    // If in default mode, suggest switching to acceptEdits
    if (mode === "default") {
      suggestions.push({ type: "setMode", mode: "accept-edits" });
    }

    // If outside working dirs (even in acceptEdits), suggest adding the directory
    if (!inDirs && !isDangerousPath(filePath)) {
      const dir = getDirectoryForPath(resolvePath(filePath, cwd));
      suggestions.push({ type: "addDirectory", directory: dir });
    }
  }

  return { safe: false, suggestions: suggestions.length > 0 ? suggestions : undefined };
}

// -----------------------------------------------------------------------------
// Tool Executor
// -----------------------------------------------------------------------------

export async function executeTools(
  toolCalls: ToolUseRequest[],
  registry: ToolRegistry,
  context: ToolContext,
  permissionCache: PermissionCache,
  permissionResolver: PermissionResolver | null,
  loopGuard: LoopGuard,
  emit: (event: StreamEvent) => void,
  /**
   * User-defined allow/deny/ask rules from `config.permissions`. Evaluated
   * before the static safe-bash allowlist so users can broaden the
   * auto-approval surface for their workflows. Pass `undefined` (or
   * omit) to skip the rule layer entirely.
   */
  configRules?: { allow?: string[]; deny?: string[]; ask?: string[] },
): Promise<ToolCallResult[]> {
  // -------------------------------------------------------------------------
  // Phase 1: Sequential permission checking
  // -------------------------------------------------------------------------
  const approved: { call: ToolUseRequest; approvalReason?: string }[] = [];
  const deniedResults: ToolCallResult[] = []; // Track denied tools with their feedback content
  let denyAll = false;

  for (const call of toolCalls) {
    if (context.abort_signal.aborted) break;
    if (denyAll) {
      const content = "Tool execution denied by user.";
      emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
      deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
      continue;
    }

    const tool = registry.get(call.name);
    if (!tool) {
      const content = `Unknown tool: ${call.name}`;
      emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
      deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
      continue;
    }

    // Check tool loop guard
    const loopCheck = loopGuard.recordToolCall(call.name, call.input);
    if (!loopCheck.ok && !loopCheck.warn) {
      // Hard block
      emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content: loopCheck.reason, is_error: true });
      deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content: loopCheck.reason } });
      continue;
    }
    if (!loopCheck.ok && loopCheck.warn) {
      // Warn but continue
      emit({
        type: "system_message",
        content: loopCheck.reason,
        subtype: "info",
      });
    }

    // Check permission: static level → input-aware allowlist → resolver
    // Track the reason for auto-approval (for UI indicator)
    let approvalReason: "auto_approve" | "safe_command" | "always_allowed" | "allow_all" | "accept_edits" | "allow_directory" | "config_allow" | undefined;
    const cacheApproved = permissionCache.isAutoApproved(call.name, tool.permission, call.input);
    const safeCheck = isSafeToolCall(
      call.name, call.input, permissionCache.mode,
      context.working_directory, permissionCache.additionalDirectories,
    );

    // User-defined rules from config.permissions. Evaluated BEFORE
    // the static allowlist (so a config `deny[]` rule can refuse a
    // command the safe-bash allowlist would have approved) but
    // SKIPPED ENTIRELY when the user has explicitly opted out of all
    // prompts via `--dangerously-skip-permissions` or "allow all for
    // this session." Both are stronger user-level opt-outs than any
    // config rule; making bypass mode honor a deny would regress
    // existing semantics. (Codex round 9 P1.)
    //
    // Bash semantics are per-leaf: a compound script like
    // `cd repo && git log` is a sequence of two simple commands, so
    // a rule like `Bash(git log *)` should still apply to that
    // script even though the whole string doesn't match the wildcard.
    //   - `deny` / `ask`: ANY matching leaf wins (tighten policy).
    //   - `allow`: ALL leaves must independently pass (handled in the
    //     floor section below — see Codex round 7 P1).
    let configDecision: "allow" | "deny" | "ask" | "none" = "none";
    let configMatchedRule: string | undefined;
    if (configRules && !permissionCache.isAllowAll()) {
      // Build the candidate sets we'll match against. For bash, this
      // is one set per recognizable command piece plus one for the
      // whole script (covers users who write a rule against the full
      // compound). For other tools, evaluateRules + inputCandidatesFor
      // already returns the right list.
      //
      // We use the lenient `extractCommandPieces` rather than the
      // strict `parseSafeBash` here because tightening rules should
      // see commands the user wrote even when the script also has
      // constructs the safety parser rejects (file redirections,
      // heredocs, subshells). E.g. `cd repo && git log > /tmp/out`
      // — parseSafeBash short-circuits on `>` and returns no leaves;
      // a deny rule on `Bash(git log *)` would miss the leaf and
      // the call would fall through to the static prompt path.
      // Auto-approval is still gated by the strict parser; only the
      // rule-match candidate set is more forgiving. (Codex round 12 P2.)
      const candidateSets: string[][] = [];
      if (call.name === "bash" && typeof call.input?.command === "string") {
        const cmd = call.input.command;
        for (const piece of extractCommandPieces(cmd)) {
          candidateSets.push(reduceBashForMatch(piece));
        }
        candidateSets.push(reduceBashForMatch(cmd));
      }

      const callView: ToolCallView = { name: call.name, input: call.input };
      const matchAny = (rules: string[]) => {
        // For bash use the per-leaf candidate sets; for other tools
        // fall back to evaluateRules (which uses inputCandidatesFor).
        if (candidateSets.length > 0) {
          for (const candidates of candidateSets) {
            const r = evaluateRulesAgainst(rules, call.name, candidates);
            if (r.matched) return r;
          }
          return { matched: false } as RuleEvalResult;
        }
        return evaluateRules(rules, callView);
      };

      if (configRules.deny && configRules.deny.length > 0) {
        const r = matchAny(configRules.deny);
        if (r.matched) { configDecision = "deny"; configMatchedRule = r.matchedRule; }
      }
      if (configDecision === "none" && configRules.allow && configRules.allow.length > 0) {
        const r = matchAny(configRules.allow);
        if (r.matched) { configDecision = "allow"; configMatchedRule = r.matchedRule; }
      }
      if (configDecision === "none" && configRules.ask && configRules.ask.length > 0) {
        const r = matchAny(configRules.ask);
        if (r.matched) { configDecision = "ask"; configMatchedRule = r.matchedRule; }
      }
    }

    if (configDecision === "deny") {
      const content = `Denied by config rule \`${configMatchedRule}\` in \`permissions.deny\`.`;
      emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
      deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
      continue;
    }

    // `permissions.allow` is the user's explicit decision. We trust
    // it: if the rule matches the call, auto-approve. The previous
    // version of this code re-implemented every safety floor that
    // `isSafeBashCommand` already had (env vars, wrappers, per-leaf
    // parsing, path normalization, dispatcher peeling, substitution
    // recursion, mutator base-command checks, host:node, per-path,
    // per-action) — the result was a moving target where each Codex
    // round found another bypass. The simpler model is the one
    // Claude Code uses: a user-written allow rule wins, period.
    //
    // The floors that DO still apply, but at different layers:
    //   - Headless lanes (cron / heartbeat / sub-agents) keep their
    //     own `isDangerousCommand` rejection further down — there's
    //     no human in the loop to second-guess `rm -rf` from a
    //     hallucinating model.
    //   - `--dangerously-skip-permissions` and "allow all session"
    //     short-circuit ALL config rules (handled at the top of
    //     this block via `permissionCache.isAllowAll()`).
    //   - User can tighten with `permissions.deny[]`, which wins.
    const configAllowHonored = configDecision === "allow";

    // An `ask` rule overrides individual cache grants and the static
    // `auto_approve` permission level — but NOT `isAllowAll()` (the
    // user clicked "allow all for this session" or started the
    // gateway with --dangerously-skip-permissions, both of which are
    // more explicit opt-outs). Without this override, a rule like
    // `Read(*)` had no effect because `read_file` is statically
    // auto_approve. (Codex round 8 P1.)
    const askOverridesCache = configDecision === "ask" && !permissionCache.isAllowAll();
    const effectiveCacheApproved = cacheApproved && !askOverridesCache;

    if (effectiveCacheApproved) {
      approvalReason = permissionCache.isAllowAll() ? "allow_all"
        : permissionCache.isAlwaysAllowed(call.name) ? "always_allowed"
        : (call.name === "bash" && call.input?.command && permissionCache.isCommandAllowed(call.name, String(call.input.command))) ? "always_allowed"
        : "auto_approve";
    } else if (configAllowHonored) {
      approvalReason = "config_allow";
    } else if (configDecision !== "ask" && safeCheck.safe) {
      // `ask` overrides the static allowlist — even if the command would
      // otherwise pass `isSafeToolCall`, the user explicitly asked to be
      // prompted on it.
      approvalReason = (
        safeCheck.reason === "accept_edits" ? "accept_edits"
          : safeCheck.reason === "allow_directory" ? "allow_directory"
            : "safe_command"
      ) as typeof approvalReason;
    }

    // Headless dangerous-command floor — independent of config rules.
    // Cron / heartbeat / sub-agent runs have no human in the loop;
    // even an explicit `permissions.allow: ["Bash(rm *)"]` shouldn't
    // execute `rm -rf /` from a hallucinating model in those
    // contexts. Interactive sessions still trust the user's allow
    // rule. (Codex final round P1.)
    if (
      context.headless &&
      !permissionResolver &&
      call.name === "bash" &&
      typeof call.input?.command === "string" &&
      isDangerousCommand(call.input.command.trim())
    ) {
      const content = `Dangerous command blocked in headless mode: ${call.input.command.trim().slice(0, 80)}`;
      emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
      deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
      continue;
    }

    const needsPermission =
      !effectiveCacheApproved &&
      !configAllowHonored &&
      (configDecision === "ask" || !safeCheck.safe);

    if (needsPermission && permissionResolver) {
      // Note: tool_use_start is emitted in Phase 2 before execution.
      // Here we only ask for permission. The UI uses permission_request event to show the prompt.
      //
      // History-invariant contract: we never let a permission-resolver error
      // propagate out of executeTools. Turning the failure into a per-tool
      // error result preserves any results already collected above for the
      // current call AND lets earlier-approved tools in the same batch
      // continue to be processed below. The agent loop's own catch (loop.ts)
      // is only a backstop.
      let response: PermissionResponse;
      try {
        response = await permissionResolver.ask(call.id, call.name, call.input, safeCheck.suggestions);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const content = `Permission check failed: ${msg}`;
        emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
        deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
        continue;
      }
      // For allow_directory, resolve relative paths against session cwd before recording
      const inputForDecision = (response.decision === "allow_directory" && call.input.file_path)
        ? { ...call.input, file_path: resolvePath(String(call.input.file_path), context.working_directory) }
        : call.input;
      permissionCache.recordDecision(call.name, response.decision, inputForDecision, response.pattern);

      if (response.decision === "deny") {
        denyAll = true; // Deny this and all remaining tools in this batch
        const denyContent = response.feedback
          ? `Tool execution denied by user: ${response.feedback}`
          : "Tool execution denied by user.";
        emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content: denyContent, is_error: true });
        deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content: denyContent } });
        continue;
      }
    }

    // In headless mode (sub-agents, heartbeat, cron) with no resolver,
    // auto-approve most tools BUT deny dangerous commands.
    // ask_user is excluded from headless tool lists separately (in loop.ts).
    if (needsPermission && !permissionResolver && context.headless) {
      // Block dangerous bash commands even in headless mode
      if (call.name === "bash" && call.input?.command) {
        const cmd = String(call.input.command).trim();
        if (isDangerousCommand(cmd)) {
          const content = `Dangerous command blocked in headless mode: ${cmd.slice(0, 80)}`;
          emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
          deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
          continue;
        }
      }
      // A `permissions.ask` rule explicitly says "always prompt the user
      // for this." Headless lanes have no user to prompt; silently auto-
      // approving would defeat the rule's purpose. Deny instead — that's
      // what the user asked for. (Codex round 2 P1.)
      if (configDecision === "ask") {
        const content = `Denied in headless mode: rule \`${configMatchedRule}\` in \`permissions.ask\` requires user confirmation, but no resolver is available.`;
        emit({ type: "tool_result", tool_use_id: call.id, name: call.name, content, is_error: true });
        deniedResults.push({ tool_use_id: call.id, name: call.name, result: { type: "error", content } });
        continue;
      }
      // Non-dangerous permissioned tools are auto-approved in headless mode.
      // The parent/system already decided to delegate.
    }

    approved.push({ call, approvalReason });
  }

  // -------------------------------------------------------------------------
  // Phase 2: Parallel execution of approved tools
  // -------------------------------------------------------------------------
  const results: ToolCallResult[] = [];

  // Assign batch ID — all tools in this Promise.all share it for UI grouping
  const batchId = approved.length > 1 ? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined;
  const batchSize = approved.length > 1 ? approved.length : undefined;

  // Pre-allocate slots to maintain order
  const slots: (ToolCallResult | null)[] = approved.map(() => null);

  await Promise.all(
    approved.map(async ({ call, approvalReason }, index) => {
      if (context.abort_signal.aborted) {
        slots[index] = {
          tool_use_id: call.id,
          name: call.name,
          result: { type: "error", content: "Execution cancelled." },
        };
        return;
      }

      // Always emit tool_use_start before execution.
      emit({
        type: "tool_use_start",
        tool_use_id: call.id,
        name: call.name,
        input: call.input,
        approvalReason: approvalReason as ToolUseStartEvent["approvalReason"],
        batchId,
        batchSize,
      });

      // Execute with per-tool context that injects tool_use_id into streaming events
      const toolCtx = {
        ...context,
        emit: (event: StreamEvent) => {
          if (event.type === "tool_streaming" && !event.tool_use_id) {
            emit({ ...event, tool_use_id: call.id });
          } else {
            emit(event);
          }
        },
      };

      // History-invariant contract: registry.execute can throw for a variety
      // of reasons (bug in a tool module, unhandled promise rejection, I/O
      // failure). If we let it propagate, Promise.all rejects and any tools
      // in the same batch that already succeeded have their results
      // discarded — the outer agent loop would then synthesize errors for
      // every tool_use_id, overwriting successful outputs. Catch here, turn
      // the throw into an error-type result, and keep going.
      let result;
      try {
        result = await registry.execute(call.name, call.input, toolCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { type: "error" as const, content: `Tool execution threw: ${msg}` };
      }

      slots[index] = {
        tool_use_id: call.id,
        name: call.name,
        result,
      };

      // Emit result
      emit({
        type: "tool_result",
        tool_use_id: call.id,
        name: call.name,
        content: result.content,
        display_content: result.display_content,
        is_error: result.type === "error",
        metadata: result.metadata,
      });
    }),
  );

  // Collect results in original tool_use order, including denied tools.
  const resultsById = new Map<string, ToolCallResult>();
  for (const slot of slots) {
    if (slot) resultsById.set(slot.tool_use_id, slot);
  }

  for (const denied of deniedResults) {
    if (!resultsById.has(denied.tool_use_id)) resultsById.set(denied.tool_use_id, denied);
  }

  for (const call of toolCalls) {
    results.push(resultsById.get(call.id) ?? {
      tool_use_id: call.id,
      name: call.name,
      result: { type: "error", content: "Tool execution denied or unknown." },
    });
  }

  return results;
}
