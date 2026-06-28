import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const rootGuard = join(repoRoot, "scripts", "check_commit.sh");
const skillGuard = join(repoRoot, ".claude", "skills", "commit", "scripts", "check_commit.sh");
const skillFile = join(repoRoot, ".claude", "skills", "commit", "SKILL.md");

describe("repo commit skill", () => {
  test("uses an executable repo-root guard", () => {
    expect(existsSync(rootGuard)).toBe(true);
    expect(statSync(rootGuard).mode & 0o111).not.toBe(0);

    const skill = readFileSync(skillFile, "utf-8");
    expect(skill).toContain("scripts/check_commit.sh");
    expect(skill).toContain("GitHub handle");
    expect(skill).toContain("users.noreply.github.com");
    expect(skill).toContain("personal email addresses");
    expect(skill).not.toContain("author_by_area");
    expect(skill).not.toContain("Name <email>");
  });

  test("keeps the legacy skill-local guard as a wrapper", () => {
    const wrapper = readFileSync(skillGuard, "utf-8");
    expect(wrapper).toContain("../../../../scripts/check_commit.sh");
  });

  test("blocks AI/bot co-author trailers", () => {
    execFileSync(rootGuard, [
      "docs(readme): test guard",
      "Human-only body.",
    ], { cwd: repoRoot });

    const result = spawnSync(rootGuard, [
      "docs(readme): test guard",
      "Body.\n\nCo-authored-by: Codex <codex@example.com>",
    ], { cwd: repoRoot, encoding: "utf-8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("COMMIT BLOCKED");
  });
});
