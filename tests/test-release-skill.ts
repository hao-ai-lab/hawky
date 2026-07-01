import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const changelogScript = join(repoRoot, "scripts", "changelog.sh");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Hawk Reviewer",
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: "hawk-reviewer@example.com",
};
const botGitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "dependabot[bot]",
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: "49699333+dependabot[bot]@users.noreply.github.com",
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hawky-release-skill-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, env: gitEnv });
  commit(dir, "chore: initial", "initial");
  execFileSync("git", ["tag", "v0.1.0"], { cwd: dir, env: gitEnv });
  return dir;
}

function commit(dir: string, subject: string, content: string): void {
  writeFileSync(join(dir, "file.txt"), `${content}\n`);
  execFileSync("git", ["add", "file.txt"], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-m", subject], { cwd: dir, env: gitEnv });
}

function commitWithEnv(
  dir: string,
  subject: string,
  content: string,
  env: NodeJS.ProcessEnv,
): void {
  writeFileSync(join(dir, "file.txt"), `${content}\n`);
  execFileSync("git", ["add", "file.txt"], { cwd: dir, env });
  execFileSync("git", ["commit", "-m", subject], { cwd: dir, env });
}

describe("release skill changelog", () => {
  test("exposes the documented repo-root changelog wrapper", () => {
    expect(existsSync(changelogScript)).toBe(true);
    expect(statSync(changelogScript).mode & 0o111).not.toBe(0);
  });

  test("continues past empty sections and emits later matching commits", () => {
    const dir = makeRepo();
    commit(dir, "fix(release): keep changelog sections optional", "fix");

    const result = spawnSync(changelogScript, ["v0.1.0", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### Fixes");
    expect(result.stdout).toContain("- fix(release): keep changelog sections optional");
  });

  test("does not fail when a range has no conventional commit sections", () => {
    const dir = makeRepo();
    commit(dir, "Update release notes", "notes");

    const result = spawnSync(changelogScript, ["v0.1.0", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## HEAD");
    expect(result.stdout).toContain("### Contributors");
  });

  test("does not fail when all range contributors are bots", () => {
    const dir = makeRepo();
    commitWithEnv(dir, "chore(deps): update dependency", "deps", botGitEnv);

    const result = spawnSync(changelogScript, ["v0.1.0", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### Contributors");
    expect(result.stdout).toContain("- None");
    expect(result.stdout).not.toContain("dependabot");
  });
});
