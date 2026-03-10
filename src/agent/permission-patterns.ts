// =============================================================================
// Permission rule patterns
//
// User-editable allow/deny/ask rules in `~/.hawky/config.json`. Grammar:
//
//   ToolName                     // matches any input to that tool
//   ToolName(pattern)            // matches when the tool's input matches `pattern`
//
// Pattern syntax:
//   *           → match any run of characters (regex `.*`)
//   \*          → literal `*`
//   \\          → literal backslash
//   any other   → literal
//
// Trailing-space-wildcard is optional: `Bash(git *)` matches both `git add`
// (with args) AND bare `git`. This matches Claude Code's
// `matchWildcardPattern` (`src/utils/permissions/shellRuleMatching.ts:90-154`
// in the leaked source).
//
// What "the tool's input" means depends on the tool:
//   - Bash:        the raw command string (after the same env/wrapper
//                  reductions used by the safe-bash allowlist), so users
//                  can write `Bash(cd * && git log *)` and have it match
//                  `timeout 30 cd /repo && git log --oneline -5`.
//   - read_file /
//     edit_file /
//     write_file: the file_path argument.
//   - Anything else: tools without a natural "input" string match by
//                    bare-tool form only (`ToolName` with no parens).
//
// This file is pure: no I/O, no logging, no dependencies on the rest of
// the codebase except the safe-bash reductions for Bash matching.
// =============================================================================

import { extractCommandPieces, reduceBashForMatch, tokenizeShellLite } from "./safe-bash-reductions.js";

// -----------------------------------------------------------------------------
// Rule parsing
// -----------------------------------------------------------------------------

export interface ParsedRule {
  /** Tool name as written, e.g. "Bash", "read_file". Case-sensitive. */
  toolName: string;
  /** The text inside `(...)`. `null` means "match any input to this tool". */
  pattern: string | null;
  /** Compiled regex, or `null` when pattern is null. */
  compiled: RegExp | null;
}

/** Result of evaluating a list of rules against one tool call. */
export interface RuleEvalResult {
  matched: boolean;
  /** The first rule (as originally written) that matched, for debugging. */
  matchedRule?: string;
}

/**
 * Parse a rule string. Returns null on malformed input — caller decides
 * whether to log + skip or fail closed; we don't throw because rule
 * lists come from user-edited config and one bad line shouldn't break
 * the whole file.
 */
export function parsePermissionRule(rule: unknown): ParsedRule | null {
  // Config arrays come from user-edited JSON with no element-type
  // validation upstream. A typo like `"allow": [1, "Bash(git *)"]`
  // would otherwise crash `rule.trim()` and take down every tool
  // execution. Skip non-strings instead. (Codex round 10 P2.)
  if (typeof rule !== "string") return null;
  const trimmed = rule.trim();
  if (!trimmed) return null;

  // Form 1: `ToolName` (bare).
  const bare = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (bare) {
    return { toolName: bare[1], pattern: null, compiled: null };
  }

  // Form 2: `ToolName(pattern)`. Pattern is everything between the FIRST
  // `(` and the LAST `)`. Lets patterns themselves contain unbalanced
  // parens, which `find . \\(...\\)` invocations sometimes have.
  const open = trimmed.indexOf("(");
  if (open <= 0 || !trimmed.endsWith(")")) return null;
  const toolName = trimmed.slice(0, open);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(toolName)) return null;
  const pattern = trimmed.slice(open + 1, trimmed.length - 1);
  return {
    toolName,
    pattern,
    compiled: compileWildcardPattern(pattern),
  };
}

/**
 * Compile a wildcard pattern into a regex anchored at both ends.
 *
 * Trailing-space-wildcard handling: `Bash(git *)` should match BOTH
 * `git add` (the wildcard absorbs ` add`) AND bare `git` (the wildcard
 * is empty so the trailing space disappears too). To get both, we
 * collapse a trailing `\s*\*` into `(?:\s.*)?` so the wildcard can
 * be entirely absent.
 */
export function compileWildcardPattern(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      // Escape: `\*` → literal `*`, `\\` → literal `\`, anything else → literal.
      out += escapeRegex(pattern[i + 1]);
      i += 2;
      continue;
    }
    if (c === "*") {
      // Trailing space-wildcard: collapse so bare-prefix matches too.
      const isLast = i === pattern.length - 1;
      const prevIsSpace = i > 0 && /\s/.test(pattern[i - 1]);
      if (isLast && prevIsSpace) {
        // Drop the trailing space we already emitted, replace with optional group.
        out = out.replace(/\\?[\s ]+$/, "");
        out += "(?:\\s.*)?";
      } else {
        out += ".*";
      }
      i++;
      continue;
    }
    out += escapeRegex(c);
    i++;
  }
  return new RegExp(`^${out}$`, "s");
}

function escapeRegex(c: string): string {
  // Includes `*` because the escape branch above passes literal stars
  // (`\*` in the pattern → `*` in the input to this function) and we
  // need them escaped to keep regex semantics literal.
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

// -----------------------------------------------------------------------------
// Rule evaluation
// -----------------------------------------------------------------------------

export interface ToolCallView {
  /** The tool's name as registered (e.g. "bash", "read_file"). */
  name: string;
  /** Raw input to the tool. */
  input: Record<string, unknown> | undefined;
}

/**
 * Evaluate a list of rules against one tool call. Returns the first rule
 * that matches, or `{ matched: false }` if none do.
 */
export function evaluateRules(rules: string[], call: ToolCallView): RuleEvalResult {
  return evaluateRulesAgainst(rules, call.name, inputCandidatesFor(call));
}

/**
 * Suggest a permission rule pattern for a tool call. Used when the user
 * clicks "Allow as pattern" on a permission prompt — we want to compute
 * a rule that broadens auto-approval to similar future calls without
 * exposing args (passwords, ids, search queries, etc.).
 *
 * Heuristic per tool:
 *
 *   bash: keep up to 4 leading tokens that look like command names —
 *     alphanumeric, no `/`, no `=`, not flag-like, not quoted — then
 *     append `*`. Stops at the first arg-looking token. Examples:
 *       `git log --oneline -5`                    → `Bash(git log *)`
 *       `gog gmail messages search "in:inbox"`     → `Bash(gog gmail messages search *)`
 *       `cd /tmp`                                  → `Bash(cd *)`
 *       `npm install foo`                          → `Bash(npm install foo *)`
 *     If we couldn't extract any clean token (everything was a flag /
 *     quoted / weird), fall back to the literal command in a Bash(...)
 *     wrapper — equivalent to "allow this exact" but expressed as a rule.
 *
 *   read_file / edit_file / write_file: scope to the parent directory
 *     so reading one log file under /var/log/ also covers the others.
 *       `/var/log/syslog` → `Read(/var/log/*)`
 *     If the path has no directory separator, fall back to a literal.
 *
 *   other tools: bare-tool form — `<ToolName>` matches every invocation.
 *     The user can edit if they want narrower.
 *
 * Returns a rule string ready to drop into `permissions.allow[]`.
 */
export function suggestRulePattern(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  const ruleToolName = canonicalRuleToolName(toolName);

  if (toolName === "bash") {
    const cmd = typeof input?.command === "string" ? input.command : "";
    const pattern = suggestBashPattern(cmd);
    // suggestBashPattern returns "" for one-off scripts (multiline /
    // heredoc / very long). Propagate the empty signal so the frontend
    // hides the rule button — wrapping to `Bash()` would defeat that.
    if (!pattern) return "";
    return `${ruleToolName}(${pattern})`;
  }

  if (toolName === "read_file" || toolName === "edit_file" || toolName === "write_file") {
    const p = typeof input?.file_path === "string" ? input.file_path : "";
    return `${ruleToolName}(${suggestPathPattern(p)})`;
  }

  // Unknown tool shape: bare-tool form. User can specialize.
  return ruleToolName;
}

function canonicalRuleToolName(toolName: string): string {
  switch (toolName) {
    case "bash": return "Bash";
    case "read_file": return "Read";
    case "edit_file": return "Edit";
    case "write_file": return "Write";
    default: return toolName;
  }
}

const MAX_BASH_PATTERN_TOKENS = 4;

/**
 * Programs whose first token is the interpreter name and whose actual
 * behavior is determined by `-c '<script>'`, `-e '<expression>'`, or
 * a script file argument. Suggesting `Bash(bash *)` or `Bash(python *)`
 * after seeing one of these would hand the user a button that auto-
 * approves every future script for that interpreter — way broader
 * than a "similar command" grant. For these we fall back to a literal
 * suggestion so the UI hides the pattern button. (Codex round 7 P2.)
 */
const BASH_INTERPRETERS: ReadonlySet<string> = new Set([
  // POSIX shells
  "bash", "sh", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
  // Scripting languages
  "python", "python2", "python3",
  "node", "deno", "bun",
  "perl", "ruby", "lua", "tclsh",
  // Mini-language tools that take `-e <code>` / `-f <script>`
  "awk", "gawk", "mawk", "sed",
]);

/**
 * Heuristic for "this bash command is a one-off script, not a routine
 * invocation worth offering an always-allow rule for." Hits when:
 *   - the command spans multiple lines (typical of inline scripts)
 *   - it contains a heredoc marker (`<< 'EOF'`, `<<-DELIM`, etc.)
 *   - it's very long (> 200 chars after trimming)
 *
 * For these the pattern button would either show the entire script
 * (visually a disaster, see issue: heredoc python script) or generate
 * a pattern that will never match again. The frontend treats an empty
 * suggestion as "no pattern button" — and also uses this same shape
 * to hide the literal-match "Always allow this command" button, since
 * locking in the exact 30-line script is equally useless.
 */
export function isOneOffBashCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (trimmed.length > 200) return true;
  if (trimmed.includes("\n")) return true;
  // `<<` followed by optional `-` then optional whitespace then a word
  // OR a quoted delimiter — the standard heredoc spellings.
  if (/<<-?\s*(['"]?\w)/.test(trimmed)) return true;
  return false;
}

function suggestBashPattern(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return "*";

  // One-off scripts: don't propose a rule. Returning "" here makes the
  // backend broadcast suggestedPattern: "" → frontend hides the
  // "Always allow Bash(<pattern>)" button entirely instead of rendering
  // a 30-line heredoc as a button label.
  if (isOneOffBashCommand(trimmed)) return "";

  // Use the most-reduced form for tokenization so wrappers (timeout,
  // nice, time) and safe env-var prefixes (NODE_ENV=test, TZ=UTC,
  // GOG_KEYRING_PASSWORD=...) don't end up in the suggested pattern.
  // The matcher already reduces commands the same way, so a pattern
  // built from the reduced form catches all variant prefixes — which
  // is the whole point of the "allow as pattern" feature. (Codex P2.)
  const reduced = reduceBashForMatch(trimmed);
  const reducedCmd = (reduced[reduced.length - 1] ?? trimmed).trim();
  if (!reducedCmd) return "*";

  // Compound commands (`a && b`, `a | b`, `a; b`) need a literal
  // suggestion — `Bash(<first> *)` would wildcard-match anything
  // after the separator on future invocations, broadening way beyond
  // what the prompt showed. The user can hand-edit the rule if they
  // really want a wildcard. Falling back to the literal also lets the
  // UI hide the pattern button (it suppresses when the suggestion
  // equals the literal form). (Codex P1, round 3.)
  const pieces = extractCommandPieces(trimmed);
  if (pieces.length > 1) {
    return escapePatternLiterals(trimmed);
  }

  // Tokenize like a shell would for command-position scanning. We only
  // need the leading tokens; once we hit something arg-shaped, stop.
  const tokens = tokenizeShellLite(reducedCmd);
  if (tokens.length > 0 && BASH_INTERPRETERS.has(tokens[0])) {
    // Interpreter-only first token — script content lives in subsequent
    // args. A wildcard would over-broaden. Use the literal pattern.
    return escapePatternLiterals(reducedCmd);
  }
  const kept: string[] = [];
  for (const t of tokens) {
    if (kept.length >= MAX_BASH_PATTERN_TOKENS) break;
    if (!isCleanCommandToken(t, reducedCmd, tokens.indexOf(t))) break;
    kept.push(t);
  }

  if (kept.length === 0) {
    // Everything looked arg-shaped — fall back to a literal pattern.
    // The user can edit if they want broader.
    return escapePatternLiterals(reducedCmd);
  }
  return `${kept.join(" ")} *`;
}

/** A token "looks like a command name" if it's alphanumeric (with the
 *  usual punctuation: `_`, `-`, `.`) and contains no path separator,
 *  no equals (env-var), no quote, no shell metachar. */
function isCleanCommandToken(token: string, original: string, idx: number): boolean {
  if (!token) return false;
  // The tokenizer strips quotes — to know if the original was quoted,
  // we'd need to look at the surrounding characters. Cheap check:
  // does the original have a quote immediately before this token?
  // Skipping this for simplicity; the regex below catches most cases.
  if (/^[-+]/.test(token)) return false;        // flag-shaped
  if (token.includes("/")) return false;        // path
  if (token.includes("=")) return false;        // env or kv arg
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) return false;
  return true;
  // (`idx` and `original` reserved for future quote-detection.)
}

function suggestPathPattern(filePath: string): string {
  if (!filePath) return "*";
  // Find the last directory separator. Accept both POSIX `/` and
  // Windows `\` so native paths like `C:\repo\file.txt` get the same
  // directory-scoped suggestion as the POSIX form.
  const lastFwd = filePath.lastIndexOf("/");
  const lastBwd = filePath.lastIndexOf("\\");
  const lastSep = Math.max(lastFwd, lastBwd);
  if (lastSep < 0) return escapePatternLiterals(filePath);
  // Escape the directory portion so paths containing `*` or
  // backslashes (both valid path chars in their respective worlds)
  // don't accidentally turn into pattern syntax. The separator
  // itself needs the same treatment: `\` MUST be doubled to `\\`
  // before the wildcard, otherwise the parser pairs it with `*`
  // and the rule matches `<dir>*` instead of `<dir>\<anything>`.
  // (Codex round 6 P2.)
  const escapedDir = escapePatternLiterals(filePath.slice(0, lastSep));
  const sep = lastSep === lastFwd ? "/" : "\\\\";
  return `${escapedDir}${sep}*`;
}

/** Escape characters that have meaning in our pattern grammar (`*` and
 *  `\`) so a literal command becomes a literal pattern. */
function escapePatternLiterals(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
}

/**
 * Lower-level rule evaluation: match `rules` against `toolName` and
 * `candidates` (the strings to test the pattern against, e.g. the
 * progressively-reduced forms of a bash leaf). Used by the bash
 * per-leaf check so a `Bash(git *)` rule can be enforced against each
 * individual leaf of a compound command, preventing the
 * `git log && touch /tmp/pwned` bypass where the wildcard absorbs an
 * unrelated mutator after `&&`.
 */
export function evaluateRulesAgainst(
  rules: string[],
  toolName: string,
  candidates: string[],
): RuleEvalResult {
  for (const rule of rules) {
    const parsed = parsePermissionRule(rule);
    if (!parsed) continue; // ignore malformed
    if (!toolNamesMatch(parsed.toolName, toolName)) continue;
    if (parsed.pattern === null) {
      return { matched: true, matchedRule: rule };
    }
    if (parsed.compiled && candidates.some((c) => parsed.compiled!.test(c))) {
      return { matched: true, matchedRule: rule };
    }
  }
  return { matched: false };
}

/**
 * Match rule tool name to internal tool name. Rules are user-facing and
 * traditionally use PascalCase (Bash, Read, Edit) while the registry
 * uses snake_case. Compare case-insensitively and treat `Read` ↔ `read_file`,
 * `Edit` ↔ `edit_file`, `Write` ↔ `write_file` as equivalents.
 */
function toolNamesMatch(ruleName: string, toolName: string): boolean {
  if (ruleName.toLowerCase() === toolName.toLowerCase()) return true;
  const aliases: Record<string, string> = {
    bash: "bash",
    read: "read_file",
    edit: "edit_file",
    write: "write_file",
  };
  const aliasedRuleName = aliases[ruleName.toLowerCase()];
  return aliasedRuleName === toolName;
}

/**
 * Return the list of strings that count as "the tool's input" for
 * pattern matching. A list rather than a single string lets bash match
 * either the raw command or its env/wrapper-reduced forms — so a user
 * rule like `Bash(git log *)` matches `timeout 30 NODE_ENV=test git log
 * --oneline -5` without forcing the user to write the wrapper into the
 * pattern.
 */
function inputCandidatesFor(call: ToolCallView): string[] {
  const input = call.input ?? {};
  if (call.name === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd) return [];
    const reduced = reduceBashForMatch(cmd);
    return reduced;
  }
  // Path-based tools: match against the file path.
  if (call.name === "read_file" || call.name === "edit_file" || call.name === "write_file") {
    const p = typeof input.file_path === "string" ? input.file_path : "";
    return p ? [p] : [];
  }
  // Other tools: no input candidates → bare-tool rule form is the only
  // way to match. Returning [] means a `ToolName(pattern)` rule won't
  // match, which is the right default for tools whose input shape we
  // don't explicitly support yet.
  return [];
}
