import { describe, expect, test } from "bun:test";

// =============================================================================
// Version string tests
//
// Tests that `hawky --version` shows the correct format.
// In dev mode (running from source): "hawky v0.1.0-dev (COMMIT)"
// In production (npm install): "hawky v0.1.0"
// =============================================================================

describe("Version string", () => {
  test("--version outputs a version string", () => {
    const result = Bun.spawnSync(["bun", "run", "src/index.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString().trim();
    expect(output).toMatch(/^hawky v\d+\.\d+\.\d+/);
  });

  test("dev mode includes commit hash and subject", () => {
    const result = Bun.spawnSync(["bun", "run", "src/index.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString().trim();
    // In dev mode: "hawky v0.1.0-dev (abc1234: Commit subject)"
    expect(output).toMatch(/^hawky v\d+\.\d+\.\d+-dev \([a-f0-9]+: .+\)$/);
  });

  test("commit hash matches current HEAD", () => {
    const gitResult = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
    });
    const expectedCommit = gitResult.stdout.toString().trim();

    const versionResult = Bun.spawnSync(["bun", "run", "src/index.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = versionResult.stdout.toString().trim();
    expect(output).toContain(expectedCommit);
  });
});
