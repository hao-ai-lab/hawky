// =============================================================================
// Skills Runtime Tests (6.2)
//
// Tests for: env var injection/revert, slash command dispatch from skills,
// command name sanitization, skill watcher dirty flag.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySkillEnvOverrides } from "../src/skills/env.js";
import { buildSkillCommands, sanitizeCommandName, formatSkillInvocation } from "../src/skills/commands.js";
import { isSkillsDirty, markSkillsDirty, clearSkillsDirty } from "../src/skills/watcher.js";
import { createSkill } from "../src/skills/create.js";
import { loadAllSkills, resetBinCache } from "../src/skills/loader.js";
import type { SkillEntry } from "../src/skills/types.js";

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-skills-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSkillEntry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "test-skill",
    description: "A test skill",
    path: "/tmp/test/SKILL.md",
    source: "workspace",
    eligible: true,
    missing: [],
    config: {},
    userInvocable: true,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = makeTempDir();
  resetBinCache();
  clearSkillsDirty();
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// Env Var Injection
// =============================================================================

describe("applySkillEnvOverrides", () => {
  test("injects env vars from config", () => {
    const skills = [makeSkillEntry({ name: "my-skill" })];
    const config = { "my-skill": { env: { MY_TEST_VAR: "hello" } } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.MY_TEST_VAR).toBe("hello");

    revert();
    expect(process.env.MY_TEST_VAR).toBeUndefined();
  });

  test("reverts env vars after revert() called", () => {
    const skills = [makeSkillEntry({ name: "s1" })];
    const config = { s1: { env: { REVERT_TEST_A: "a", REVERT_TEST_B: "b" } } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.REVERT_TEST_A).toBe("a");
    expect(process.env.REVERT_TEST_B).toBe("b");

    revert();
    expect(process.env.REVERT_TEST_A).toBeUndefined();
    expect(process.env.REVERT_TEST_B).toBeUndefined();
  });

  test("does not overwrite existing env vars", () => {
    process.env.EXISTING_VAR_TEST = "original";
    const skills = [makeSkillEntry({ name: "s1" })];
    const config = { s1: { env: { EXISTING_VAR_TEST: "overwritten" } } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.EXISTING_VAR_TEST).toBe("original"); // NOT overwritten

    revert();
    expect(process.env.EXISTING_VAR_TEST).toBe("original"); // Still original
    delete process.env.EXISTING_VAR_TEST;
  });

  test("blocks dangerous env vars (PATH, HOME, SHELL)", () => {
    const originalPath = process.env.PATH;
    const skills = [makeSkillEntry({ name: "evil" })];
    const config = { evil: { env: { PATH: "/tmp/evil", HOME: "/tmp", SHELL: "/bin/evil" } } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.PATH).toBe(originalPath); // NOT changed

    revert();
  });

  test("maps apiKey to primaryEnv", () => {
    const skills = [makeSkillEntry({
      name: "api-skill",
      config: { primaryEnv: "MY_API_KEY" },
    })];
    const config = { "api-skill": { apiKey: "secret-key-123" } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.MY_API_KEY).toBe("secret-key-123");

    revert();
    expect(process.env.MY_API_KEY).toBeUndefined();
  });

  test("maps apiKey to first requires.env if no primaryEnv", () => {
    const skills = [makeSkillEntry({
      name: "env-skill",
      config: { requires: { env: ["SLACK_BOT_TOKEN"] } },
    })];
    const config = { "env-skill": { apiKey: "xoxb-test-token" } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");

    revert();
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  test("skips ineligible skills", () => {
    const skills = [makeSkillEntry({ name: "disabled", eligible: false })];
    const config = { disabled: { env: { SHOULD_NOT_SET: "bad" } } };

    const revert = applySkillEnvOverrides(skills, config);
    expect(process.env.SHOULD_NOT_SET).toBeUndefined();

    revert();
  });

  test("handles missing config gracefully", () => {
    const skills = [makeSkillEntry({ name: "no-config" })];
    const revert = applySkillEnvOverrides(skills, undefined);
    revert(); // Should not throw
  });

  test("handles empty skills array", () => {
    const revert = applySkillEnvOverrides([], {});
    revert(); // Should not throw
  });
});

// =============================================================================
// Slash Command Name Sanitization
// =============================================================================

describe("sanitizeCommandName", () => {
  test("lowercases name", () => {
    expect(sanitizeCommandName("GitHub")).toBe("github");
  });

  test("replaces hyphens with underscores", () => {
    expect(sanitizeCommandName("git-commit")).toBe("git_commit");
  });

  test("replaces special chars with underscores", () => {
    expect(sanitizeCommandName("my.skill@v2")).toBe("my_skill_v2");
  });

  test("collapses multiple underscores", () => {
    expect(sanitizeCommandName("a--b__c")).toBe("a_b_c");
  });

  test("trims leading/trailing underscores", () => {
    expect(sanitizeCommandName("_leading_")).toBe("leading");
  });

  test("limits to 32 chars", () => {
    const long = "a".repeat(50);
    expect(sanitizeCommandName(long).length).toBeLessThanOrEqual(32);
  });

  test("returns 'skill' for empty input", () => {
    expect(sanitizeCommandName("")).toBe("skill");
    expect(sanitizeCommandName("___")).toBe("skill");
  });
});

// =============================================================================
// Skill Slash Commands
// =============================================================================

describe("buildSkillCommands", () => {
  test("creates commands from user-invocable skills", () => {
    const skills = [
      makeSkillEntry({ name: "github", description: "GitHub CLI" }),
      makeSkillEntry({ name: "commit", description: "Git commit" }),
    ];
    const commands = buildSkillCommands(skills);
    expect(commands.length).toBe(2);
    expect(commands[0].name).toBe("github");
    expect(commands[1].name).toBe("commit");
  });

  test("skips non-user-invocable skills", () => {
    const skills = [
      makeSkillEntry({ name: "hidden", userInvocable: false }),
      makeSkillEntry({ name: "visible", userInvocable: true }),
    ];
    const commands = buildSkillCommands(skills);
    expect(commands.length).toBe(1);
    expect(commands[0].name).toBe("visible");
  });

  test("deduplicates colliding names", () => {
    const skills = [
      makeSkillEntry({ name: "test", description: "First" }),
      makeSkillEntry({ name: "test", description: "Second" }),
    ];
    const commands = buildSkillCommands(skills);
    expect(commands.length).toBe(2);
    expect(commands[0].name).toBe("test");
    expect(commands[1].name).toBe("test_2");
  });

  test("does not override reserved commands", () => {
    const skills = [
      makeSkillEntry({ name: "help", description: "Should not override" }),
      makeSkillEntry({ name: "exit", description: "Should not override" }),
    ];
    const commands = buildSkillCommands(skills);
    // Both should get suffixed since help/exit are reserved
    expect(commands[0].name).toBe("help_2");
    expect(commands[1].name).toBe("exit_2");
  });

  test("truncates description to 100 chars", () => {
    const longDesc = "a".repeat(200);
    const skills = [makeSkillEntry({ name: "long", description: longDesc })];
    const commands = buildSkillCommands(skills);
    expect(commands[0].description.length).toBeLessThanOrEqual(100);
  });
});

describe("formatSkillInvocation", () => {
  test("formats with user args", () => {
    const cmd = { name: "commit", skillName: "commit", description: "", skillPath: "" };
    const msg = formatSkillInvocation(cmd, "fix auth bug");
    expect(msg).toContain("commit");
    expect(msg).toContain("fix auth bug");
  });

  test("formats without args", () => {
    const cmd = { name: "github", skillName: "github", description: "", skillPath: "" };
    const msg = formatSkillInvocation(cmd, "");
    expect(msg).toContain("github");
    expect(msg).not.toContain("User instruction:");
  });
});

// =============================================================================
// Skills Dirty Flag (Watcher State)
// =============================================================================

describe("Skills dirty flag", () => {
  test("starts clean", () => {
    clearSkillsDirty();
    expect(isSkillsDirty()).toBe(false);
  });

  test("markSkillsDirty sets dirty", () => {
    markSkillsDirty();
    expect(isSkillsDirty()).toBe(true);
  });

  test("clearSkillsDirty clears dirty", () => {
    markSkillsDirty();
    clearSkillsDirty();
    expect(isSkillsDirty()).toBe(false);
  });
});

// =============================================================================
// Integration: Skill Commands from Real Skills
// =============================================================================

describe("Skill commands from workspace skills", () => {
  test("workspace skills become slash commands", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills", "my-tool");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: my-tool\ndescription: A custom tool\n---\n# My Tool");

    const skills = loadAllSkills(wsDir);
    const mySkill = skills.find((s) => s.name === "my-tool");
    expect(mySkill).toBeDefined();

    const commands = buildSkillCommands(skills);
    const myCmd = commands.find((c) => c.skillName === "my-tool");
    expect(myCmd).toBeDefined();
    expect(myCmd!.name).toBe("my_tool"); // Hyphen → underscore
  });
});

// =============================================================================
// Skill Creation
// =============================================================================

describe("createSkill", () => {
  test("creates skill directory and SKILL.md in the given workspace", () => {
    const wsDir = join(tempDir, "workspace");
    const result = createSkill("sample-skill", "A sample skill", "workspace", wsDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(wsDir, "skills", "sample-skill", "SKILL.md"));
      expect(existsSync(result.path)).toBe(true);
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("name: sample-skill");
      expect(content).toContain("description: A sample skill");
    }
  });

  test("refuses to overwrite an existing skill", () => {
    const wsDir = join(tempDir, "workspace");
    const first = createSkill("dup", "first", "workspace", wsDir);
    expect(first.ok).toBe(true);
    const second = createSkill("dup", "second", "workspace", wsDir);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already exists");
  });

  test("rejects empty name", () => {
    const result = createSkill("", undefined, "workspace", join(tempDir, "workspace"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("required");
  });

  test("rejects name with special characters", () => {
    const result = createSkill("bad skill; rm -rf", undefined, "workspace", join(tempDir, "workspace"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("letters");
  });

  test("rejects name with spaces", () => {
    const result = createSkill("has spaces", undefined, "workspace", join(tempDir, "workspace"));
    expect(result.ok).toBe(false);
  });

  test("accepts valid name with hyphens and dots", () => {
    const wsDir = join(tempDir, "workspace");
    const result = createSkill("valid-skill.v2", "ok", "workspace", wsDir);
    expect(result.ok).toBe(true);
  });
});
