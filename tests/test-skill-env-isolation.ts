// =============================================================================
// test-skill-env-isolation.ts
//
// Regression + e2e guard for #13: skill env vars used to be written to the
// shared global process.env, so two sessions running turns concurrently on the
// gateway leaked each other's secrets (and skipped setting their own because a
// concurrent session had already set the key). The fix passes a per-run env map
// to the bash subprocess via ToolContext and never mutates the global.
//
// These tests drive the REAL bash subprocess (Bun.spawn) end-to-end.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { executeBash } from "../src/tools/bash.js";

function run(env: Record<string, string> | undefined, command: string) {
  return executeBash({
    command,
    working_directory: tmpdir(),
    abort_signal: new AbortController().signal,
    env,
  });
}

describe("skill env reaches the subprocess without touching the global", () => {
  test("a per-run env var is visible to the spawned bash and not to process.env", async () => {
    const key = `HAWKY_SKILL_TEST_${Math.random().toString(36).slice(2)}`;
    const r = await run({ [key]: "sekret" }, `printf '%s' "$${key}"`);

    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe("sekret");
    expect(process.env[key]).toBeUndefined(); // never leaked to the global
  });

  test("no env passed → subprocess still inherits the real environment", async () => {
    // PATH is a real env var; a plain bash run must still see it.
    const r = await run(undefined, `printf '%s' "$HOME_MARKER_UNSET_${Math.random().toString(36).slice(2)}"`);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe(""); // unset var → empty, no crash
  });
});

describe("concurrent runs do not leak env across each other (#13 e2e)", () => {
  test("two overlapping bash runs each see only their OWN secret", async () => {
    const key = `HAWKY_XLEAK_${Math.random().toString(36).slice(2)}`;
    // Sleep first so the two subprocesses are genuinely in flight at the same
    // time — the exact overlap that leaked under the old global-mutation code.
    const cmd = `sleep 0.1; printf '%s' "$${key}"`;

    const [a, b] = await Promise.all([
      run({ [key]: "session-A" }, cmd),
      run({ [key]: "session-B" }, cmd),
    ]);

    expect(a.stdout).toBe("session-A");
    expect(b.stdout).toBe("session-B"); // NOT "session-A"
    expect(process.env[key]).toBeUndefined(); // global never mutated
  });
});
