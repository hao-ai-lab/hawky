// =============================================================================
// Test: Safe Bash Parser
// Run: bun test tests/test-safe-bash-parser.ts
// =============================================================================

import { describe, expect, test } from "bun:test";
import { parseSafeBash } from "../src/agent/safe-bash-parser.js";

function leaves(input: string): string[] {
  const r = parseSafeBash(input);
  expect(r.residual).toEqual([]);
  return r.leaves.map((l) => l.trim()).filter(Boolean);
}

describe("parseSafeBash — basics", () => {
  test("simple command yields one leaf", () => {
    expect(leaves("ls -la /tmp")).toEqual(["ls -la /tmp"]);
  });

  test("empty input yields no leaves", () => {
    expect(leaves("")).toEqual([]);
    expect(leaves("   \n  ")).toEqual([]);
  });

  test("strips line comments at start", () => {
    expect(leaves("# this is a note\nls /tmp")).toEqual(["ls /tmp"]);
  });

  test("strips inline comments after whitespace", () => {
    expect(leaves("ls /tmp\n# comment\necho done")).toEqual(["ls /tmp", "echo done"]);
  });

  test("does NOT strip # inside quotes", () => {
    expect(leaves(`grep "#hashtag" file`)).toEqual([`grep "#hashtag" file`]);
  });

  test("does NOT strip # mid-token", () => {
    // foo#bar is a single token, not a comment
    expect(leaves("echo foo#bar")).toEqual(["echo foo#bar"]);
  });
});

describe("parseSafeBash — separators", () => {
  test("splits on ;", () => {
    expect(leaves("ls /tmp; cat foo")).toEqual(["ls /tmp", "cat foo"]);
  });

  test("splits on &&", () => {
    expect(leaves("ls /tmp && cat foo")).toEqual(["ls /tmp", "cat foo"]);
  });

  test("splits on ||", () => {
    expect(leaves("ls /tmp || echo missing")).toEqual(["ls /tmp", "echo missing"]);
  });

  test("splits on newline", () => {
    expect(leaves("ls /tmp\ncat foo")).toEqual(["ls /tmp", "cat foo"]);
  });

  test("splits on |", () => {
    expect(leaves("cat foo | jq .data")).toEqual(["cat foo", "jq .data"]);
  });

  test("does NOT split inside quotes", () => {
    expect(leaves(`echo "a; b && c"`)).toEqual([`echo "a; b && c"`]);
  });

  test("does NOT split inside $(...)", () => {
    const r = parseSafeBash("echo $(date; uname)");
    // echo and the substitution leaves
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(3); // date, uname, echo *
  });
});

describe("parseSafeBash — env-var prefixes", () => {
  test("strips a simple whitelisted KEY=VALUE", () => {
    // GOG_KEYRING_PASSWORD is on the whitelist (the gog CLI's auth env var).
    expect(leaves("GOG_KEYRING_PASSWORD=secret gog gmail get 123")).toEqual(["gog gmail get 123"]);
  });

  test("strips multiple whitelisted assignments", () => {
    expect(leaves("NODE_ENV=test TZ=UTC git log")).toEqual(["git log"]);
  });

  test("whitelisted env-var alone is a no-op leaf (only the env survives)", () => {
    // Value-only lines don't push a command leaf.
    expect(leaves("NODE_ENV=test")).toEqual([""].filter(Boolean));
  });

  test("whitelisted KEY=$(safe) records the substitution as a leaf", () => {
    // GOG_KEYRING_PASSWORD is whitelisted, so the assignment is stripped and
    // the substitution inside is extracted as its own leaf.
    const r = parseSafeBash("GOG_KEYRING_PASSWORD=$(jq -r .x /etc/foo) curl https://example.com");
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(2);
    expect(r.leaves[0].trim()).toBe("jq -r .x /etc/foo");
    expect(r.leaves[1].trim()).toBe("curl https://example.com");
  });

  // -----------------------------------------------------------------------
  // Safe-env-var whitelist — security regressions
  //
  // Before the whitelist, stripLeadingAssignments blindly peeled every
  // leading KEY=VALUE pair, which let `GIT_EXTERNAL_DIFF=touch git diff`
  // auto-approve (git diff was on the allowlist; exported diff driver did
  // the mutation). Same class of hole for GIT_PAGER, PAGER, GIT_SSH_COMMAND,
  // LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, BASH_ENV, PATH, NODE_OPTIONS,
  // PYTHONPATH. These regressions lock in "fail closed on unknown keys."
  // -----------------------------------------------------------------------

  test("unknown env var stays attached to the leaf (not stripped)", () => {
    // FOO is not on the whitelist, so the assignment sticks to the leaf.
    // The downstream allowlist match will fail because no safe prefix
    // starts with `FOO=`, and the command prompts.
    expect(leaves("FOO=bar gog gmail get 123")).toEqual(["FOO=bar gog gmail get 123"]);
  });

  test("GIT_EXTERNAL_DIFF=... stays attached (the canonical exploit)", () => {
    expect(leaves("GIT_EXTERNAL_DIFF=touch git diff"))
      .toEqual(["GIT_EXTERNAL_DIFF=touch git diff"]);
  });

  test("LD_PRELOAD / PATH / GIT_SSH_COMMAND / BASH_ENV all stay attached", () => {
    expect(leaves("LD_PRELOAD=/tmp/evil.so ls")).toEqual(["LD_PRELOAD=/tmp/evil.so ls"]);
    expect(leaves("PATH=/evil:$PATH git log")).toEqual(["PATH=/evil:$PATH git log"]);
    expect(leaves("GIT_SSH_COMMAND=malicious git fetch")).toEqual(["GIT_SSH_COMMAND=malicious git fetch"]);
    expect(leaves("BASH_ENV=/tmp/hook bash -c 'echo hi'")).toEqual(["BASH_ENV=/tmp/hook bash -c 'echo hi'"]);
  });

  test("stripping stops at the first unsafe key (whitelisted ones before it are peeled)", () => {
    // NODE_ENV is safe and strips; then LD_PRELOAD hits and we stop.
    expect(leaves("NODE_ENV=test LD_PRELOAD=/evil ls"))
      .toEqual(["LD_PRELOAD=/evil ls"]);
  });
});

describe("parseSafeBash — for loops", () => {
  test("simple for loop yields the body as a leaf", () => {
    const cmd = "for id in a b c; do echo $id; done";
    expect(leaves(cmd)).toEqual(["echo $id"]);
  });

  test("for loop with multi-line body", () => {
    const cmd = `for id in a b c; do
  echo $id
  cat file
done`;
    expect(leaves(cmd)).toEqual(["echo $id", "cat file"]);
  });

  test("for loop containing a $(...) word list adds substitution leaves", () => {
    const cmd = `for id in $(jq -r '.[]' file); do echo $id; done`;
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    // jq leaf and echo leaf
    expect(r.leaves.length).toBe(2);
    expect(r.leaves.some((l) => l.includes("jq"))).toBe(true);
    expect(r.leaves.some((l) => l.includes("echo"))).toBe(true);
  });
});

describe("parseSafeBash — substitution", () => {
  test("$(...) records the inner command as a leaf", () => {
    const r = parseSafeBash("echo $(date)");
    expect(r.residual).toEqual([]);
    // inner `date` leaf + outer `echo *` leaf
    expect(r.leaves.length).toBe(2);
  });

  test("nested $(...) is also extracted", () => {
    const r = parseSafeBash("echo $(uname $(date))");
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(3); // date, uname *, echo *
  });

  test("$(...) inside quotes is still extracted", () => {
    const r = parseSafeBash(`echo "today is $(date)"`);
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(2);
  });
});

describe("parseSafeBash — safe stderr redirection", () => {
  test("strips 2>&1", () => {
    expect(leaves("gog gmail get 1 2>&1")).toEqual(["gog gmail get 1"]);
  });

  test("strips 2>/dev/null", () => {
    expect(leaves("gog gmail get 1 2>/dev/null")).toEqual(["gog gmail get 1"]);
  });
});

describe("parseSafeBash — rejects unsupported", () => {
  test("rejects heredoc", () => {
    const r = parseSafeBash("cat <<EOF\nhi\nEOF");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects backtick substitution", () => {
    const r = parseSafeBash("echo `date`");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects file redirection", () => {
    const r = parseSafeBash("ls > out.txt");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects append redirection", () => {
    const r = parseSafeBash("ls >> out.txt");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects input redirection", () => {
    const r = parseSafeBash("cat < file");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects process substitution", () => {
    const r = parseSafeBash("diff <(ls) <(ls /tmp)");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects subshells", () => {
    const r = parseSafeBash("(cd /tmp && ls)");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects if-statements", () => {
    const r = parseSafeBash("if true; then ls; fi");
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test("rejects while loops", () => {
    const r = parseSafeBash("while true; do ls; done");
    expect(r.residual.length).toBeGreaterThan(0);
  });
});

// Regression: pipe characters inside single-quoted jq filters used to make
// walkScript recurse forever because /\|/.test(trimmed) was true while
// splitTopLevel correctly refused to split inside quotes. The pipe-recursion
// branch now only fires when splitTopLevel actually produced multiple parts.
describe("parseSafeBash — regression: no infinite recursion on quoted pipes", () => {
  test("jq filter with embedded | does not stack overflow", () => {
    const cmd = `curl -s https://example.com | jq -r '.members[] | select(.x == 1) | .name'`;
    // Should return without throwing
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(2);
    expect(r.leaves[0].trim()).toBe("curl -s https://example.com");
    expect(r.leaves[1].trim()).toBe("jq -r '.members[] | select(.x == 1) | .name'");
  });

  test("token-from-jq + curl + jq filter with quoted pipes (real crashing pattern)", () => {
    const cmd = `TOKEN=$(jq -r '.channels.slack.user_token // empty' ~/.hawky/config.json)
curl -s -H "Authorization: Bearer $TOKEN" \\
  "https://slack.com/api/users.list" \\
  | jq -r '.members[] | select(.deleted == false and .is_bot == false and .id != "USLACKBOT") | "\\(.real_name)\\t@\\(.name)"'`;
    // Must not throw RangeError: Maximum call stack size exceeded
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    // jq from the TOKEN substitution + curl + jq filter
    expect(r.leaves.some((l) => l.includes("'.channels.slack.user_token"))).toBe(true);
    expect(r.leaves.some((l) => l.startsWith("curl"))).toBe(true);
    expect(r.leaves.some((l) => l.includes("'.members[]"))).toBe(true);
  });

  test("standalone leaf containing | only inside quotes is treated as one leaf", () => {
    const cmd = `jq '.a | .b'`;
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(1);
    expect(r.leaves[0].trim()).toBe(`jq '.a | .b'`);
  });
});

describe("parseSafeBash — real session patterns", () => {
  test("comment + for loop with gog modify", () => {
    const cmd = `# Archive A1 and A2
for id in 19d978845a21c903 19d9782179c5040b; do
  GOG_KEYRING_PASSWORD=gog gog gmail messages modify $id --remove UNREAD --force --account user@example.com
done`;
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(1);
    expect(r.leaves[0]).toContain("gog gmail messages modify");
  });

  test("for loop with two body commands", () => {
    const cmd = `for id in a b c; do
  GOG_KEYRING_PASSWORD=gog gog gmail messages modify $id --remove UNREAD --force --account x
  GOG_KEYRING_PASSWORD=gog gog gmail messages modify $id --remove INBOX --force --account x
done`;
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(2);
    expect(r.leaves.every((l) => l.includes("gog gmail messages modify"))).toBe(true);
  });

  test("token assignment + curl pipeline", () => {
    const cmd = `TOKEN=$(jq -r '.channels.slack.user_token' ~/.hawky/config.json)
curl -s -H "Authorization: Bearer $TOKEN" https://slack.com/api/conversations.list`;
    const r = parseSafeBash(cmd);
    expect(r.residual).toEqual([]);
    // jq leaf + curl leaf
    expect(r.leaves.length).toBe(2);
    expect(r.leaves.some((l) => l.includes("jq"))).toBe(true);
    expect(r.leaves.some((l) => l.startsWith("curl"))).toBe(true);
  });

  test("command with stderr redirection and pipe", () => {
    const r = parseSafeBash("gog gmail get 123 --json 2>&1 | jq .body");
    expect(r.residual).toEqual([]);
    expect(r.leaves.length).toBe(2);
    expect(r.leaves[0]).toBe("gog gmail get 123 --json");
    expect(r.leaves[1]).toBe("jq .body");
  });
});
