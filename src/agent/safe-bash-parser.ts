// =============================================================================
// Safe Bash Parser
//
// Decomposes a bash command into the set of "leaf" simple commands that will
// actually execute, so each leaf can be matched against a read-only allowlist.
//
// Supports the subset the agent typically writes:
//   - line comments (# ...)
//   - newlines, ;, &&, ||, |  as command separators
//   - leading env-var assignments  (KEY=VALUE foo bar)
//   - $(...) command substitution  (each substitution is also a leaf)
//   - `for VAR in WORDS; do BODY; done` loops (BODY contributes its leaves)
//   - safe stderr redirections (2>&1, 2>/dev/null)
//
// What it intentionally does NOT support — the caller must reject these:
//   - here-docs ( <<EOF, <<-EOF )
//   - file redirections ( > file, >> file, < file )
//   - process substitution ( <(...), >(...) )
//   - backtick substitution ( `...` ) — ambiguous with our quoting; reject
//   - subshells ( (...) ), groups ( {...; } )
//   - case / if / while / function definitions
//   - eval, exec, source, .
//
// The output is { leaves, residual } where:
//   - `leaves` are the simple commands ready for allowlist matching
//   - `residual` is non-empty if the parser saw constructs it cannot reason
//     about. A non-empty residual MUST cause the caller to reject the command.
// =============================================================================

import { isSafeEnvVar } from "./safe-env-vars.js";

export interface ParseResult {
  leaves: string[];
  /** Non-empty if any unsupported construct was seen. Reject if non-empty. */
  residual: string[];
}

/**
 * Parse a bash command string into the set of simple commands that will run.
 * Conservative: any unrecognized construct ends up in `residual`, signaling
 * that the caller must NOT auto-approve.
 */
export function parseSafeBash(input: string): ParseResult {
  const leaves: string[] = [];
  const residual: string[] = [];

  // 1. Strip safe stderr redirections so the rest of the parser doesn't see them.
  let work = input
    .replace(/\s+2>&1\b/g, " ")
    .replace(/\s+2>\/dev\/null\b/g, " ");

  // 2. Reject obvious unsupported constructs early. We check on the original
  //    so things like `cat foo<bar` aren't accidentally allowed.
  if (/<<-?\s*['"]?[A-Za-z_]/.test(work)) {
    residual.push("heredoc");
    return { leaves, residual };
  }
  if (/(?<![\w])`/.test(work)) {
    // backtick substitution — rejected for parser simplicity
    residual.push("backtick-substitution");
    return { leaves, residual };
  }
  if (/<\(|>\(/.test(work)) {
    residual.push("process-substitution");
    return { leaves, residual };
  }
  // File redirections that aren't the safe stderr forms we already stripped.
  // Any remaining `>` (with or without an FD prefix like `1>` / `3>`) is a
  // write, so reject. We previously only matched bare `>` and missed
  // descriptor-prefixed redirections — those bypassed the policy.
  if (/(^|[^&])>/.test(work) || /<\s*[^&]/.test(work) || /(^|\s|[0-9])>>/.test(work)) {
    residual.push("file-redirection");
    return { leaves, residual };
  }
  // Subshells and command groups
  if (/\(\s*[^)]/.test(work) && !/\$\(/.test(matchOnly(work, /\(\s*[^)]/))) {
    // Allow $( ... ) but reject bare ( ... )
    if (hasBareSubshell(work)) {
      residual.push("subshell");
      return { leaves, residual };
    }
  }

  // 3. Strip line comments.
  work = stripLineComments(work);

  // 4. Walk the script extracting leaves.
  walkScript(work, leaves, residual);

  return { leaves, residual };
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

function walkScript(script: string, leaves: string[], residual: string[]): void {
  // Split on top-level command separators. We must not split inside quotes or
  // $( ... ), so we use a quote/depth-aware splitter.
  const segments = splitTopLevel(script, [";", "&&", "||", "\n"]);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Recognize `for VAR in WORDS; do BODY; done`. The BODY is what runs, so
    // we recurse into it. WORDS may contain things like $(...) — those count
    // as additional leaves to validate.
    const forMatch = matchForLoop(trimmed);
    if (forMatch) {
      // Iterable words may include $(...) substitutions
      extractSubstitutionsAsLeaves(forMatch.words, leaves, residual);
      walkScript(forMatch.body, leaves, residual);
      continue;
    }

    // A pipeline: `a | b | c`. Split on top-level `|` and recurse on each.
    // Important: only recurse if splitTopLevel actually produced more than one
    // part. If `|` only appears inside quotes / $() / for-loop bodies, it
    // returns a single part — recursing on the same unchanged string would
    // loop forever. Fall through to the simple-command path instead.
    const pipeParts = splitTopLevel(trimmed, ["|"]);
    if (pipeParts.length > 1) {
      for (const part of pipeParts) walkScript(part, leaves, residual);
      continue;
    }

    // Detect and reject any control-flow construct we can't reason about.
    if (/^(if|while|until|case|function)\b/.test(trimmed)) {
      residual.push(`unsupported-control:${trimmed.split(/\s+/)[0]}`);
      continue;
    }

    // Otherwise it's a simple command — but it may have $(...) substitutions
    // and leading env-var assignments to peel off.
    const stripped = stripLeadingAssignments(trimmed, leaves, residual);
    if (!stripped) continue;
    extractSubstitutionsAsLeaves(stripped, leaves, residual);
    leaves.push(stripSubstitutions(stripped).trim());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip `# ...` line comments (but not inside quotes). */
function stripLineComments(src: string): string {
  const out: string[] = [];
  let inS = false, inD = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      out.push(c, src[i + 1]); i++; continue;
    }
    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    if (!inS && !inD && c === "#") {
      // Comments only count when preceded by whitespace or at start
      const prev = i === 0 ? "\n" : src[i - 1];
      if (/\s/.test(prev) || prev === "\n") {
        // Skip until newline
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
    }
    out.push(c);
  }
  return out.join("");
}

/**
 * Split `s` at any top-level occurrence of one of the multi-char separators
 * in `seps`, ignoring separators inside quotes, `$(...)`, or `for ... done`
 * blocks (so a `for` body is preserved as a single segment for the loop
 * matcher).
 *
 * The longer separators (e.g. "&&", "||") MUST come first or single-char
 * matches will eat them.
 */
function splitTopLevel(s: string, seps: string[]): string[] {
  const sortedSeps = [...seps].sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  let buf = "";
  let inS = false, inD = false, dollarDepth = 0;
  let blockDepth = 0; // depth of for/while/until ... done blocks

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { buf += c + s[i + 1]; i++; continue; }
    if (!inD && c === "'") { inS = !inS; buf += c; continue; }
    if (!inS && c === '"') { inD = !inD; buf += c; continue; }

    if (!inS && !inD) {
      // Track $( ... ) depth
      if (c === "$" && s[i + 1] === "(") { dollarDepth++; buf += "$("; i++; continue; }
      if (dollarDepth > 0 && c === ")") { dollarDepth--; buf += c; continue; }
      if (dollarDepth > 0) { buf += c; continue; }

      // Track for/while/until ... done block depth so separators inside the
      // block don't break the loop body apart.
      if (atKeyword(s, i, ["for", "while", "until"])) {
        blockDepth++;
        const kw = s.startsWith("for", i) ? "for" : s.startsWith("while", i) ? "while" : "until";
        buf += kw;
        i += kw.length - 1;
        continue;
      }
      if (atKeyword(s, i, ["done"])) {
        blockDepth = Math.max(0, blockDepth - 1);
        buf += "done";
        i += 3;
        continue;
      }

      // Inside a for-loop body — never split.
      if (blockDepth > 0) { buf += c; continue; }

      // Check separators
      let matched = false;
      for (const sep of sortedSeps) {
        if (s.startsWith(sep, i)) {
          parts.push(buf);
          buf = "";
          i += sep.length - 1;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    buf += c;
  }
  if (buf.length) parts.push(buf);
  return parts;
}

/** Returns true iff the keyword starts at position i in *command position*
 *  (i.e. it's the first token of a command, not an argument). The left
 *  boundary must be start-of-string or one of `;`, `\n`, `&`, `|` — plain
 *  whitespace doesn't qualify, since `grep for README` would otherwise treat
 *  the `for` argument as a loop opener. */
function atKeyword(s: string, i: number, keywords: string[]): boolean {
  // Must be at command position on the left.
  if (i > 0) {
    // Skip whitespace backwards to find the previous non-space char.
    let p = i - 1;
    while (p >= 0 && (s[p] === " " || s[p] === "\t")) p--;
    if (p >= 0) {
      const prev = s[p];
      // Only command separators count; plain whitespace doesn't.
      if (!/[\n;&|]/.test(prev)) return false;
    }
  }
  for (const kw of keywords) {
    if (s.startsWith(kw, i)) {
      const after = s[i + kw.length];
      // Must be followed by whitespace, ;, &, |, or end-of-string.
      if (after === undefined || /[\s;|&]/.test(after)) return true;
    }
  }
  return false;
}

/** Recognize `for VAR in WORDS; do BODY; done`. Returns null if not a for-loop. */
function matchForLoop(cmd: string): { var: string; words: string; body: string } | null {
  // Match: for X in WORDS ; do BODY ; done
  // The separator before `do` may be `;` or newline.
  const m = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]*?)(?:;|\n)\s*do\s+([\s\S]*?)(?:;|\n)\s*done\s*$/.exec(
    cmd.trim(),
  );
  if (!m) return null;
  return { var: m[1], words: m[2].trim(), body: m[3].trim() };
}

/** Extract all `$(...)` substitutions as leaves. Recurses into nested ones. */
function extractSubstitutionsAsLeaves(
  src: string,
  leaves: string[],
  residual: string[],
): void {
  let i = 0;
  while (i < src.length) {
    if (src[i] === "$" && src[i + 1] === "(") {
      // Find matching ')'
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "$" && src[j + 1] === "(") { depth++; j += 2; continue; }
        if (src[j] === ")") { depth--; if (depth === 0) break; }
        j++;
      }
      if (depth !== 0) { residual.push("unbalanced-substitution"); return; }
      const inner = src.slice(i + 2, j);
      // Recurse — every command inside the substitution is also a leaf.
      walkScript(inner, leaves, residual);
      i = j + 1;
    } else {
      i++;
    }
  }
}

/**
 * Remove `$(...)` runs from a command string so the leaf can be matched
 * against the prefix allowlist without the substitution noise.
 * Replaces each substitution with the placeholder " * " so prefix matching
 * still sees the surrounding tokens.
 */
function stripSubstitutions(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "$" && src[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "$" && src[j + 1] === "(") { depth++; j += 2; continue; }
        if (src[j] === ")") { depth--; if (depth === 0) break; }
        j++;
      }
      out += "*";
      i = j + 1;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/**
 * Strip leading KEY=VALUE assignments. If the value contains `$(...)`, that
 * substitution is recorded as a leaf (since it executes too).
 *
 * **Only strips keys on the safe-env-var whitelist.** An unknown key (e.g.
 * `GIT_EXTERNAL_DIFF`, `LD_PRELOAD`, `PATH`) stays attached to the leaf;
 * the caller's allowlist match then fails because no safe prefix starts
 * with `KEY=`, and the command prompts. Before this gate, a blind strip
 * let `GIT_EXTERNAL_DIFF=touch git diff` auto-approve and then execute
 * `touch` via git's diff-driver hook.
 *
 * Returns the command after the assignments, or "" if the line was assignments
 * only (which we treat as a no-op leaf — variable-only assignments are safe).
 */
function stripLeadingAssignments(
  cmd: string,
  leaves: string[],
  residual: string[],
): string {
  let pos = 0;
  while (pos < cmd.length) {
    // Match KEY= at current position
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(cmd.slice(pos));
    if (!keyMatch) break;
    // Stop as soon as we see a KEY that isn't on the whitelist — leave
    // the unsafe assignment attached so the allowlist match rejects it.
    if (!isSafeEnvVar(keyMatch[1])) break;
    const valueStart = pos + keyMatch[0].length;

    // Read the value: everything up to the next unquoted whitespace.
    let i = valueStart;
    let inS = false, inD = false, depth = 0;
    while (i < cmd.length) {
      const c = cmd[i];
      if (c === "\\" && i + 1 < cmd.length) { i += 2; continue; }
      if (!inD && c === "'") { inS = !inS; i++; continue; }
      if (!inS && c === '"') { inD = !inD; i++; continue; }
      if (!inS && !inD) {
        if (c === "$" && cmd[i + 1] === "(") { depth++; i += 2; continue; }
        if (depth > 0 && c === ")") { depth--; i++; continue; }
        if (depth === 0 && /\s/.test(c)) break;
      }
      i++;
    }

    const value = cmd.slice(valueStart, i);
    // If the value contains a $(...) substitution, treat the inner as a leaf.
    extractSubstitutionsAsLeaves(value, leaves, residual);
    // Skip whitespace
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    pos = i;
  }
  return cmd.slice(pos);
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function matchOnly(s: string, re: RegExp): string {
  const m = re.exec(s);
  return m ? m[0] : "";
}

/** Detect `(...)` subshells that are NOT preceded by `$` (which would be
 *  command substitution, handled separately). */
function hasBareSubshell(src: string): boolean {
  let inS = false, inD = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) { i++; continue; }
    if (!inD && c === "'") { inS = !inS; continue; }
    if (!inS && c === '"') { inD = !inD; continue; }
    if (!inS && !inD && c === "(") {
      const prev = i === 0 ? "" : src[i - 1];
      if (prev !== "$") return true;
    }
  }
  return false;
}
