import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const packageJsonPath = join(repoRoot, "package.json");
const releaseWorkflowPath = join(repoRoot, ".github", "workflows", "release.yml");
const prepareScriptPath = join(repoRoot, "scripts", "prepare-publish-package.sh");

describe("release package preparation", () => {
  test("prepublishOnly delegates to the idempotent package preparation script", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.prepublishOnly).toBe("bash scripts/prepare-publish-package.sh");
    expect(existsSync(prepareScriptPath)).toBe(true);
    expect(statSync(prepareScriptPath).mode & 0o111).not.toBe(0);
  });

  test("package preparation script clears generated package assets before copying", () => {
    const script = readFileSync(prepareScriptPath, "utf-8");

    expect(script).toContain("rm -rf dist templates skill-templates web-dist");
    expect(script).toContain("cp -R src/templates templates");
    expect(script).toContain("cp -R src/skill-templates skill-templates");
    expect(script).toContain("cp -R web/dist web-dist");
  });

  test("release workflow lets npm publish run the single package preparation path", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf-8");

    expect(workflow).toContain("run: npm publish --access public");
    expect(workflow).not.toContain("cp -r src/templates templates");
    expect(workflow).not.toContain("cp -r src/skill-templates skill-templates");
    expect(workflow).not.toContain("cp -r web/dist web-dist");
  });

  test("package preparation script has valid shell syntax", () => {
    execFileSync("bash", ["-n", prepareScriptPath], { cwd: repoRoot });
  });
});
