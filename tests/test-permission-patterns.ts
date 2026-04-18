// =============================================================================
// Tests: permission-patterns.ts
//
// Covers the rule-grammar parser, the wildcard regex compiler, and the
// rule-evaluation function used by `executeTools` to apply user-defined
// `permissions.allow / deny / ask` rules from config.
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  parsePermissionRule,
  compileWildcardPattern,
  evaluateRules,
  suggestRulePattern,
  type ToolCallView,
} from "../src/agent/permission-patterns.js";

const bash = (cmd: string): ToolCallView => ({ name: "bash", input: { command: cmd } });
const read = (p: string): ToolCallView => ({ name: "read_file", input: { file_path: p } });

describe("parsePermissionRule", () => {
  test("bare tool name", () => {
    const r = parsePermissionRule("Bash");
    expect(r).not.toBeNull();
    expect(r!.toolName).toBe("Bash");
    expect(r!.pattern).toBeNull();
  });

  test("ToolName(pattern)", () => {
    const r = parsePermissionRule("Bash(git log)");
    expect(r).not.toBeNull();
    expect(r!.toolName).toBe("Bash");
    expect(r!.pattern).toBe("git log");
  });

  test("pattern containing parens (find -\\(\\))", () => {
    // Patterns may contain unbalanced parens — split at first `(` and
    // last `)` so `Bash(find . \(...\))` is preserved.
    const r = parsePermissionRule(`Bash(find . \\( -name "*.ts" \\))`);
    expect(r).not.toBeNull();
    expect(r!.pattern).toBe(`find . \\( -name "*.ts" \\)`);
  });

  test("malformed: missing closing paren", () => {
    expect(parsePermissionRule("Bash(git log")).toBeNull();
  });

  test("malformed: invalid tool name", () => {
    expect(parsePermissionRule("123Tool")).toBeNull();
    expect(parsePermissionRule("Tool With Space(x)")).toBeNull();
  });

  test("empty / whitespace", () => {
    expect(parsePermissionRule("")).toBeNull();
    expect(parsePermissionRule("   ")).toBeNull();
  });

  test("non-string rules are skipped, not thrown (Codex round 10 P2)", () => {
    // Config files come from user-edited JSON. A typo like
    // `"allow": [1, "Bash(git *)"]` shouldn't crash every tool
    // execution — bad rules are silently skipped.
    expect(parsePermissionRule(1 as any)).toBeNull();
    expect(parsePermissionRule(null as any)).toBeNull();
    expect(parsePermissionRule(undefined as any)).toBeNull();
    expect(parsePermissionRule({} as any)).toBeNull();
    expect(parsePermissionRule([] as any)).toBeNull();
  });

  test("evaluateRules survives a non-string rule mixed with valid ones", () => {
    // The rule list might be heterogeneous; valid rules after the
    // bad one must still match.
    const r = evaluateRules(
      [42 as any, "Bash(git log)"],
      bash("git log"),
    );
    expect(r.matched).toBe(true);
    expect(r.matchedRule).toBe("Bash(git log)");
  });
});

describe("compileWildcardPattern", () => {
  test("literal text matches exactly", () => {
    const re = compileWildcardPattern("git log");
    expect(re.test("git log")).toBe(true);
    expect(re.test("git log --oneline")).toBe(false);
    expect(re.test("git logfile")).toBe(false); // anchored
  });

  test("* matches anything", () => {
    const re = compileWildcardPattern("git *");
    expect(re.test("git add")).toBe(true);
    expect(re.test("git log --oneline -5")).toBe(true);
  });

  test("trailing 'space *' allows the wildcard to be absent (bare prefix matches)", () => {
    // `Bash(git *)` should match BOTH `git add` (with args) AND bare `git`.
    const re = compileWildcardPattern("git *");
    expect(re.test("git")).toBe(true);
    expect(re.test("git add")).toBe(true);
  });

  test("\\* is a literal star", () => {
    const re = compileWildcardPattern("echo \\*");
    expect(re.test("echo *")).toBe(true);
    expect(re.test("echo hello")).toBe(false);
  });

  test("regex metacharacters in pattern are escaped (not interpreted)", () => {
    const re = compileWildcardPattern("foo.bar+baz");
    expect(re.test("foo.bar+baz")).toBe(true);
    expect(re.test("fooXbar+baz")).toBe(false); // `.` is literal
    expect(re.test("foo.barbaz")).toBe(false); // `+` is literal
  });

  test("multi-segment wildcard", () => {
    const re = compileWildcardPattern("docker * --rm");
    expect(re.test("docker run --rm")).toBe(true);
    expect(re.test("docker run -it ubuntu --rm")).toBe(true);
    expect(re.test("docker run")).toBe(false);
  });

  test("matches across newlines (commands sometimes wrap)", () => {
    const re = compileWildcardPattern("for id in *");
    expect(re.test("for id in a b c\n  do echo $id\ndone")).toBe(true);
  });
});

describe("evaluateRules — bash", () => {
  test("matches against the raw command", () => {
    const r = evaluateRules(["Bash(git log *)"], bash("git log --oneline -5"));
    expect(r.matched).toBe(true);
    expect(r.matchedRule).toBe("Bash(git log *)");
  });

  test("matches against env-stripped form (whitelisted env)", () => {
    // The reductions strip safe env vars and let the pattern match the
    // underlying command, so users don't have to encode env in patterns.
    const r = evaluateRules(
      ["Bash(gog gmail get *)"],
      bash("GOG_KEYRING_PASSWORD=secret gog gmail get 19abc --account a@b --json"),
    );
    expect(r.matched).toBe(true);
  });

  test("matches against wrapper-unwrapped form (timeout)", () => {
    const r = evaluateRules(["Bash(git log *)"], bash("timeout 30 git log --oneline -5"));
    expect(r.matched).toBe(true);
  });

  test("matches against env+wrapper combined", () => {
    const r = evaluateRules(
      ["Bash(git log *)"],
      bash("NODE_ENV=test timeout 30 git log --oneline -5"),
    );
    expect(r.matched).toBe(true);
  });

  test("does NOT match a different command", () => {
    const r = evaluateRules(["Bash(git log *)"], bash("git push origin main"));
    expect(r.matched).toBe(false);
  });

  test("does NOT match through a dangerous env var (whitelist gates the reduction)", () => {
    // GIT_EXTERNAL_DIFF is not whitelisted so the env-strip pass leaves
    // it attached. The candidates are all `GIT_EXTERNAL_DIFF=touch git
    // diff` — none reduce to bare `git diff`, so a `Bash(git diff)`
    // rule cannot inadvertently approve the exploit.
    const r = evaluateRules(["Bash(git diff)"], bash("GIT_EXTERNAL_DIFF=touch git diff"));
    expect(r.matched).toBe(false);
  });

  test("bare `Bash` rule matches every bash invocation", () => {
    const r = evaluateRules(["Bash"], bash("anything goes"));
    expect(r.matched).toBe(true);
  });

  test("first matching rule wins (returned in matchedRule)", () => {
    const r = evaluateRules(
      ["Bash(npm install)", "Bash(npm *)"],
      bash("npm test"),
    );
    expect(r.matched).toBe(true);
    expect(r.matchedRule).toBe("Bash(npm *)"); // first one to match
  });
});

describe("evaluateRules — file paths", () => {
  test("Read(path) matches the file_path argument", () => {
    expect(evaluateRules(["Read(/tmp/*)"], read("/tmp/foo.txt")).matched).toBe(true);
    expect(evaluateRules(["Read(/tmp/*)"], read("/etc/passwd")).matched).toBe(false);
  });

  test("Read alias matches the read_file tool", () => {
    expect(evaluateRules(["Read"], read("/anywhere/foo")).matched).toBe(true);
  });

  test("Edit alias targets edit_file", () => {
    const call: ToolCallView = { name: "edit_file", input: { file_path: "/src/foo.ts" } };
    expect(evaluateRules(["Edit(/src/*)"], call).matched).toBe(true);
    expect(evaluateRules(["Edit(/src/*)"], read("/src/foo.ts")).matched).toBe(false);
  });
});

describe("evaluateRules — robustness", () => {
  test("ignores malformed rules and continues evaluating the rest", () => {
    const r = evaluateRules(
      ["NotARule(", "Bash(git log)"],
      bash("git log"),
    );
    expect(r.matched).toBe(true);
    expect(r.matchedRule).toBe("Bash(git log)");
  });

  test("empty rule list returns no match", () => {
    expect(evaluateRules([], bash("anything")).matched).toBe(false);
  });

  test("tool-name match is case-insensitive (`bash` rule matches bash tool)", () => {
    expect(evaluateRules(["bash(git log)"], bash("git log")).matched).toBe(true);
    expect(evaluateRules(["BASH(git log)"], bash("git log")).matched).toBe(true);
  });

  test("does not match a different tool", () => {
    expect(evaluateRules(["Bash(anything)"], read("/tmp/x")).matched).toBe(false);
  });

  test("tool with no input shape returns no match for ToolName(pattern) form", () => {
    // ask_user, agent, etc. — bare `ToolName` is the only way to match.
    const ask: ToolCallView = { name: "ask_user", input: { question: "?" } };
    expect(evaluateRules(["ask_user(?)"], ask).matched).toBe(false);
    expect(evaluateRules(["ask_user"], ask).matched).toBe(true);
  });
});

describe("suggestRulePattern — bash", () => {
  test("git log + flags → Bash(git log *)", () => {
    expect(suggestRulePattern("bash", { command: "git log --oneline -5" }))
      .toBe("Bash(git log *)");
  });

  test("multi-level subcommand chain (gog gmail messages search)", () => {
    expect(suggestRulePattern("bash", {
      command: 'gog gmail messages search "in:inbox" --max 10 --json',
    })).toBe("Bash(gog gmail messages search *)");
  });

  test("cd <path> → Bash(cd *)", () => {
    expect(suggestRulePattern("bash", { command: "cd /Users/example/projects/foo" }))
      .toBe("Bash(cd *)");
  });

  test("safe env-var prefix is reduced before suggesting (Codex round 2 P2)", () => {
    // `NODE_ENV=test` is a safe env assignment that the matcher strips
    // before evaluating rules. The suggester reduces too, so the
    // pattern covers `git log ...` regardless of the env prefix.
    expect(suggestRulePattern("bash", { command: "NODE_ENV=test git log" }))
      .toBe("Bash(git log *)");
  });

  test("safe wrapper (timeout) is reduced before suggesting (Codex round 2 P2)", () => {
    // `timeout 30 git log` reduces to `git log` for matching; the
    // suggested pattern follows suit, so the user's grant covers the
    // command regardless of timeout / nice / time wrappers.
    expect(suggestRulePattern("bash", { command: "timeout 30 git log --oneline -5" }))
      .toBe("Bash(git log *)");
  });

  test("env + wrapper combined reduce away", () => {
    expect(suggestRulePattern("bash", {
      command: "NODE_ENV=test timeout 30 gog gmail messages search foo",
    })).toBe("Bash(gog gmail messages search *)");
  });

  test("interpreter-only first token (bash/python/node/etc.) falls back to literal (Codex round 7 P2)", () => {
    // `bash -c '<script>'` is functionally equivalent to running the
    // script directly. Suggesting `Bash(bash *)` would hand the user
    // a button that auto-approves every future shell snippet. Same
    // for python -c, node -e, perl -e, sed -e, etc. These need a
    // literal suggestion (which the UI then hides).
    const cases: Array<[string, string]> = [
      ["bash -lc 'do stuff'", "Bash(bash -lc 'do stuff')"],
      ["sh -c 'echo hi'", "Bash(sh -c 'echo hi')"],
      ["python -c 'print(1)'", "Bash(python -c 'print(1)')"],
      ["python3 -c 'import os'", "Bash(python3 -c 'import os')"],
      ["node -e 'console.log()'", "Bash(node -e 'console.log()')"],
      ["perl -e 'die'", "Bash(perl -e 'die')"],
      ["ruby -e 'puts 1'", "Bash(ruby -e 'puts 1')"],
      ["sed -e 's/x/y/'", "Bash(sed -e 's/x/y/')"],
      ["awk -e '{print}'", "Bash(awk -e '{print}')"],
    ];
    for (const [cmd, expected] of cases) {
      expect(suggestRulePattern("bash", { command: cmd })).toBe(expected);
    }
  });

  test("compound command (&&) falls back to literal suggestion (Codex round 3 P1)", () => {
    // A wildcard suggestion `Bash(git status *)` would over-broaden:
    // the regex `.*` happily matches `git status && rm -rf` on a
    // future invocation. Compound commands suggest the literal,
    // which the UI then hides because it duplicates the existing
    // "Always allow this exact command" button.
    expect(suggestRulePattern("bash", { command: "git status && rm -rf tmp" }))
      .toBe("Bash(git status && rm -rf tmp)");
  });

  test("compound command (|) falls back to literal", () => {
    expect(suggestRulePattern("bash", { command: "npm test | tee out" }))
      .toBe("Bash(npm test | tee out)");
  });

  test("compound command (;) falls back to literal", () => {
    expect(suggestRulePattern("bash", { command: "ls /tmp ; cat /etc/foo" }))
      .toBe("Bash(ls /tmp ; cat /etc/foo)");
  });

  test("newline-separated script returns no suggestion (supersedes Codex round 4 P1's literal fallback)", () => {
    // `\n` is a top-level command separator in bash — `git
    // status\nrm -rf tmp` runs both. Earlier we fell back to a literal
    // pattern to avoid `Bash(git status rm *)` (over-broad). Now we
    // return empty so the dialog hides BOTH always-allow buttons:
    // a literal multiline grant is also useless (would never match
    // again), and the previous behavior produced visually huge
    // unusable buttons for heredoc / multiline scripts.
    expect(suggestRulePattern("bash", { command: "git status\nrm -rf tmp" }))
      .toBe("");
  });

  test("unsafe env-var prefix stays attached (whitelist gates the reduction)", () => {
    // GIT_EXTERNAL_DIFF isn't on the safe-env-var whitelist, so the
    // matcher doesn't strip it — and neither does the suggester. The
    // resulting pattern is the literal form (with `=` left as-is —
    // it's not a pattern metachar).
    expect(suggestRulePattern("bash", {
      command: "GIT_EXTERNAL_DIFF=touch git diff",
    })).toBe("Bash(GIT_EXTERNAL_DIFF=touch git diff)");
  });

  test("path-based first token falls back to literal", () => {
    expect(suggestRulePattern("bash", { command: "/bin/rm /tmp/foo" }))
      .toBe("Bash(/bin/rm /tmp/foo)");
  });

  test("caps subcommand depth at 4 tokens", () => {
    // Avoids degenerating into `Bash(a b c d e f g *)` for pathological
    // commands. Long chains stop at 4 + wildcard.
    expect(suggestRulePattern("bash", { command: "a b c d e f g h i" }))
      .toBe("Bash(a b c d *)");
  });

  test("empty command → Bash(*)", () => {
    expect(suggestRulePattern("bash", { command: "" })).toBe("Bash(*)");
  });

  test("missing input falls back to literal toolName", () => {
    // No command field — degenerate input. We return the bare-tool form.
    expect(suggestRulePattern("bash", undefined)).toBe("Bash(*)");
  });

  test("multiline / heredoc / very long commands return empty (no useful suggestion)", () => {
    // The heredoc python script in the bug report would otherwise be
    // wrapped as `Bash(<entire 30-line script>)` — visually a disaster
    // and a rule that will never match again. Empty signals the
    // frontend to hide both 'Always allow' buttons; "Allow once" stays.
    const heredoc = `python3 << 'PY'
import sys, os
sys.path.insert(0,'/home/hao/projects/haoskills/student-triage/lib')
print('hi')
PY`;
    expect(suggestRulePattern("bash", { command: heredoc })).toBe("");

    const multiline = "echo a\necho b";
    expect(suggestRulePattern("bash", { command: multiline })).toBe("");

    const veryLong = "printf 'x' " + "&& echo a ".repeat(40);
    expect(suggestRulePattern("bash", { command: veryLong })).toBe("");

    // Non-one-off commands still get a normal pattern.
    expect(suggestRulePattern("bash", { command: "git log --oneline" }))
      .toBe("Bash(git log *)");
  });
});

describe("suggestRulePattern — file paths", () => {
  test("read_file → Read(<dir>/*)", () => {
    expect(suggestRulePattern("read_file", { file_path: "/var/log/syslog" }))
      .toBe("Read(/var/log/*)");
  });

  test("edit_file → Edit(<dir>/*)", () => {
    expect(suggestRulePattern("edit_file", { file_path: "/Users/example/projects/foo/bar.ts" }))
      .toBe("Edit(/Users/example/projects/foo/*)");
  });

  test("write_file → Write(<dir>/*)", () => {
    expect(suggestRulePattern("write_file", { file_path: "/tmp/out.txt" }))
      .toBe("Write(/tmp/*)");
  });

  test("path with no directory falls back to literal", () => {
    expect(suggestRulePattern("read_file", { file_path: "README.md" }))
      .toBe("Read(README.md)");
  });

  test("Windows-style path separator is recognized + properly escaped (Codex round 5 P2 + round 6 P2)", () => {
    // Native Windows paths use `\` as a separator. The directory
    // portion is escaped (one `\` → `\\`), and the separator itself
    // is also escaped to `\\` before the `*` wildcard — otherwise
    // the parser would pair the trailing `\` with `*` and the rule
    // would match `C:\repo*` instead of files under `C:\repo\`.
    const rule = suggestRulePattern("edit_file", { file_path: "C:\\repo\\file.ts" });
    expect(rule).toBe("Edit(C:\\\\repo\\\\*)");

    // Round-trip the rule and verify it matches files under the
    // intended directory (and only those).
    const parsed = parsePermissionRule(rule)!;
    expect(parsed.compiled!.test("C:\\repo\\file.ts")).toBe(true);
    expect(parsed.compiled!.test("C:\\repo\\sub\\nested.ts")).toBe(true);
    // Should NOT match unrelated paths just because they share the prefix.
    expect(parsed.compiled!.test("C:\\reportcard")).toBe(false);
    expect(parsed.compiled!.test("D:\\repo\\file.ts")).toBe(false);
  });

  test("directory containing pattern metachars is escaped (Codex round 1 P3)", () => {
    // `*` and `\` are valid POSIX path chars but pattern metachars.
    // Without escaping the directory portion, allowing `/var/log*/x.txt`
    // would emit `Read(/var/log*/*)` — which would wildcard-match
    // unrelated directories. After escaping it's a literal.
    expect(suggestRulePattern("read_file", { file_path: "/var/log*/x.txt" }))
      .toBe("Read(/var/log\\*/*)");
  });
});

describe("suggestRulePattern — other tools", () => {
  test("falls back to bare-tool form for unrecognized shapes", () => {
    expect(suggestRulePattern("ask_user", { question: "..." })).toBe("ask_user");
    expect(suggestRulePattern("web_search", { query: "..." })).toBe("web_search");
  });

  test("a suggested pattern always parses cleanly via parsePermissionRule", () => {
    // Round-trip: every output of suggestRulePattern should be valid
    // input for parsePermissionRule (no malformed strings leak out).
    const samples: Array<[string, Record<string, unknown> | undefined]> = [
      ["bash", { command: "git log --oneline" }],
      ["bash", { command: "/bin/rm /tmp/foo" }],
      ["bash", { command: "NODE_ENV=test git log" }],
      ["read_file", { file_path: "/var/log/x" }],
      ["edit_file", { file_path: "x.ts" }],
      ["write_file", { file_path: "/tmp/y" }],
      ["bash", undefined],
    ];
    for (const [name, input] of samples) {
      const rule = suggestRulePattern(name, input);
      expect(parsePermissionRule(rule)).not.toBeNull();
    }
  });
});
