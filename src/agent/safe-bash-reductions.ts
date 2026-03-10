// =============================================================================
// Safe-bash reductions
//
// Two transformations that turn a real-world bash command into a form the
// allowlist (or a user-defined rule pattern) can usefully match:
//
//   1. Strip leading `KEY=VALUE ` env-var assignments — but only when KEY
//      is on the SAFE_ENV_VARS whitelist. Stops at the first non-whitelist
//      key so dangerous assignments (`GIT_EXTERNAL_DIFF=touch`,
//      `LD_PRELOAD=/evil`) stay attached to the leaf and fail to match.
//
//   2. Peel off scheduling / timing wrappers (`timeout`, `nice`, `time`)
//      whose only effect is to run the same inner command. After peeling,
//      the inner command can be re-checked. Deliberately NOT peeled:
//      `nohup` (creates `nohup.out` in cwd — filesystem side effect).
//
// Both functions are pure. Used by:
//   - `isSafeBashPart` in `tool_executor.ts` — to evaluate the
//     allowlist on each progressively-reduced form.
//   - `permission-patterns.ts` — so a user rule like `Bash(git log *)`
//     matches `timeout 30 NODE_ENV=test git log --oneline -5` without
//     forcing the user to encode the wrapper / env in the pattern.
//
// `reduceBashForMatch` returns the de-duplicated list of forms a caller
// should try in order: raw → env-stripped → wrapper-unwrapped → env-stripped
// again (handles `time TZ=UTC git log` where the env var lives inside the
// shell-keyword's scope).
// =============================================================================

import { isSafeEnvVar } from "./safe-env-vars.js";

/** Tokenize a single command into argv-like tokens. Respects single and
 *  double quotes (including the contents verbatim) and strips the quotes
 *  from the resulting tokens. Backslash escapes the next character.
 *  Shared between tool_executor (for safety checks) and
 *  permission-patterns (for suggesting allow-rule patterns). */
export function tokenizeShellLite(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { buf += s[i + 1]; i++; continue; }
    if (!inD && c === "'") { inS = !inS; continue; }
    if (!inS && c === '"') { inD = !inD; continue; }
    if (!inS && !inD && /\s/.test(c)) {
      if (buf.length) { out.push(buf); buf = ""; }
      continue;
    }
    buf += c;
  }
  if (buf.length) out.push(buf);
  return out;
}

/**
 * Strip leading `KEY=VALUE ` env-var assignments from a command — but ONLY
 * when KEY is on the safe-env-var whitelist. Stops at the first non-
 * whitelisted key.
 */
export function stripEnvAssignments(cmd: string): string {
  let work = cmd;
  while (true) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=[^\s;`$"'<>|&]* +/.exec(work);
    if (!m) break;
    if (!isSafeEnvVar(m[1])) break;
    work = work.slice(m[0].length);
  }
  return work;
}

/**
 * Peel off `timeout`, `nice`, `time` wrappers. Iterates so stacked
 * wrappers (`time timeout 30 git log`) all unwrap. NOT peeled: `nohup`
 * (writes `nohup.out` in cwd).
 */
export function stripSafeWrappers(cmd: string): string {
  let work = cmd.trimStart();
  for (let i = 0; i < 4; i++) {
    // timeout DUR cmd  — DUR is a positive number optionally with s/m/h/d suffix
    const t = /^timeout\s+[0-9]+(?:\.[0-9]+)?[smhd]?\s+/.exec(work);
    if (t) { work = work.slice(t[0].length).trimStart(); continue; }
    // nice [-n N] cmd
    const n = /^nice(?:\s+-n\s+-?[0-9]+)?\s+/.exec(work);
    if (n) { work = work.slice(n[0].length).trimStart(); continue; }
    // time cmd  (bash builtin form; require an alphanumeric start so we
    // don't accidentally peel `time -v` style flag forms)
    const tm = /^time\s+(?=[A-Za-z_])/.exec(work);
    if (tm) { work = work.slice(tm[0].length).trimStart(); continue; }
    break;
  }
  return work;
}

/**
 * Best-effort split of a bash script into the command pieces it
 * contains, for permission-RULE matching only. Unlike `parseSafeBash`
 * (which fails closed on heredocs, file redirections, subshells, etc.
 * because those are unsafe to auto-approve), this routine pulls out
 * whatever command names are recognizable so that a `permissions.deny`
 * or `permissions.ask` rule can fire on them. Auto-approval still
 * goes through the strict safety parser; this layer is purely about
 * tightening policy on what the user wrote.
 *
 * Splits on top-level `&&` / `||` / `;` / `|`, respecting quotes and
 * `$(...)` substitutions. For each piece, drops everything from the
 * first unquoted `>` / `<` redirection onwards so `git log > out` still
 * surfaces `git log` to the rule matcher. Empty pieces are dropped.
 */
export function extractCommandPieces(cmd: string): string[] {
  const pieces: string[] = [];
  let buf = "";
  let inS = false, inD = false, dollarDepth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && i + 1 < cmd.length) { buf += c + cmd[i + 1]; i++; continue; }
    if (!inD && c === "'") { inS = !inS; buf += c; continue; }
    if (!inS && c === '"') { inD = !inD; buf += c; continue; }
    if (!inS && !inD) {
      if (c === "$" && cmd[i + 1] === "(") { dollarDepth++; buf += "$("; i++; continue; }
      if (dollarDepth > 0) {
        if (c === ")") dollarDepth--;
        buf += c;
        continue;
      }
      if (c === "&" && cmd[i + 1] === "&") { pieces.push(buf); buf = ""; i++; continue; }
      if (c === "|" && cmd[i + 1] === "|") { pieces.push(buf); buf = ""; i++; continue; }
      if (c === ";" || c === "|" || c === "\n") { pieces.push(buf); buf = ""; continue; }
    }
    buf += c;
  }
  if (buf) pieces.push(buf);

  const cleaned = pieces.map((p) => {
    // Strip from the first unquoted redirection onwards, plus a
    // leading-whitespace-only `# comment` tail.
    let out = "";
    let inSp = false, inDp = false;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "\\" && i + 1 < p.length) { out += c + p[i + 1]; i++; continue; }
      if (!inDp && c === "'") { inSp = !inSp; out += c; continue; }
      if (!inSp && c === '"') { inDp = !inDp; out += c; continue; }
      if (!inSp && !inDp) {
        if (c === ">" || c === "<") break;
        if (c === "#" && (i === 0 || /\s/.test(p[i - 1]))) break;
      }
      out += c;
    }
    return out.trim();
  }).filter((p) => p.length > 0);

  // Recurse into `$(...)` substitutions — they execute too, so a
  // deny / ask rule on `Bash(git log *)` should fire on
  // `echo $(git log --oneline)` even though the outer leaf is `echo`.
  // (Codex round 14 P1.) Nested `$(...)` is handled by recursion.
  const out: string[] = [];
  for (const piece of cleaned) {
    out.push(piece);
    collectSubstitutionPieces(piece, out);
  }
  return out;
}

function collectSubstitutionPieces(s: string, out: string[]): void {
  // Tracks single-quote scope only — `$()` and backtick substitutions
  // both execute even when wrapped in double quotes (`"$(git log)"`,
  // `"\`git log\`"`), so we must descend through them. Single quotes
  // DO suppress substitution, so single-quoted text is skipped.
  let i = 0;
  let inS = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { i += 2; continue; }
    if (c === "'") { inS = !inS; i++; continue; }
    if (!inS && c === "$" && s[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "\\" && j + 1 < s.length) { j += 2; continue; }
        if (s[j] === "$" && s[j + 1] === "(") { depth++; j += 2; continue; }
        if (s[j] === ")") { depth--; if (depth === 0) break; }
        j++;
      }
      const inner = s.slice(i + 2, j);
      for (const innerPiece of extractCommandPieces(inner)) {
        out.push(innerPiece);
      }
      i = j + 1;
      continue;
    }
    // Legacy backtick substitution: `cmd` runs cmd. Find the matching
    // closing backtick (no nesting in real bash — we treat it as a
    // simple delimited region).
    if (!inS && c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== "`") {
        if (s[j] === "\\" && j + 1 < s.length) { j += 2; continue; }
        j++;
      }
      const inner = s.slice(i + 1, j);
      for (const innerPiece of extractCommandPieces(inner)) {
        out.push(innerPiece);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
}

/**
 * Return the progressively-reduced forms of a bash command, deduplicated,
 * in the order callers should try them: raw → env-stripped →
 * wrapper-unwrapped → env-stripped-again.
 *
 * The double env-strip handles `time TZ=UTC git log`: `time` is a shell
 * keyword whose scope contains the env assignment, so the assignment
 * doesn't appear at the outer start until after the wrapper peels.
 */
export function reduceBashForMatch(cmd: string): string[] {
  const envStripped = stripEnvAssignments(cmd);
  const unwrapped = stripSafeWrappers(envStripped);
  const reStripped = stripEnvAssignments(unwrapped);
  const out: string[] = [];
  for (const c of [cmd, envStripped, unwrapped, reStripped]) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}
