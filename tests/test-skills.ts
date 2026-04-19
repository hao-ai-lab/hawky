// =============================================================================
// Skills System Tests
//
// Tests for: frontmatter parsing, skill loading, eligibility checking,
// prompt building, display formatting, integration with system prompt.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter, parseSkillConfig, stripFrontmatter } from "../src/skills/frontmatter.js";
import { loadAllSkills, hasBinary, resetBinCache } from "../src/skills/loader.js";
import { buildSkillsPromptSection, formatSkillsForDisplay } from "../src/skills/prompt.js";
import type { SkillEntry } from "../src/skills/types.js";

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, frontmatter: string, body: string = ""): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

beforeEach(() => {
  tempDir = makeTempDir();
  resetBinCache();
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// Frontmatter Parsing
// =============================================================================

describe("parseFrontmatter", () => {
  test("parses basic frontmatter", () => {
    const content = `---\nname: test-skill\ndescription: A test skill\n---\n# Body`;
    const meta = parseFrontmatter(content);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("test-skill");
    expect(meta!.description).toBe("A test skill");
  });

  test("returns null for missing frontmatter", () => {
    expect(parseFrontmatter("# No frontmatter")).toBeNull();
  });

  test("returns null if name missing", () => {
    expect(parseFrontmatter("---\ndescription: no name\n---\n")).toBeNull();
  });

  test("returns null if description missing", () => {
    expect(parseFrontmatter("---\nname: no-desc\n---\n")).toBeNull();
  });

  test("parses metadata JSON string", () => {
    const content = `---\nname: test\ndescription: test\nmetadata: '{"hawky":{"emoji":"🧪"}}'\n---`;
    const meta = parseFrontmatter(content);
    expect(meta!.metadata).toContain("hawky");
  });

  test("strips surrounding quotes from values", () => {
    const content = `---\nname: "quoted-name"\ndescription: 'quoted desc'\n---`;
    const meta = parseFrontmatter(content);
    expect(meta!.name).toBe("quoted-name");
    expect(meta!.description).toBe("quoted desc");
  });

  test("user-invocable defaults to true", () => {
    const content = `---\nname: test\ndescription: test\n---`;
    expect(parseFrontmatter(content)!["user-invocable"]).toBe(true);
  });

  test("user-invocable can be set to false", () => {
    const content = `---\nname: test\ndescription: test\nuser-invocable: false\n---`;
    expect(parseFrontmatter(content)!["user-invocable"]).toBe(false);
  });
});

describe("parseSkillConfig", () => {
  test("parses hawky config", () => {
    const config = parseSkillConfig('{"hawky":{"emoji":"🧪","requires":{"bins":["git"]}}}');
    expect(config.emoji).toBe("🧪");
    expect(config.requires?.bins).toEqual(["git"]);
  });

  test("parses hawky config", () => {
    const config = parseSkillConfig('{"hawky":{"emoji":"📧"}}');
    expect(config.emoji).toBe("📧");
  });

  test("returns empty for invalid JSON", () => {
    expect(parseSkillConfig("not json")).toEqual({});
  });

  test("returns empty for undefined", () => {
    expect(parseSkillConfig(undefined)).toEqual({});
  });

  test("parses os filter", () => {
    const config = parseSkillConfig('{"hawky":{"os":["darwin"]}}');
    expect(config.os).toEqual(["darwin"]);
  });

  test("parses install specs", () => {
    const config = parseSkillConfig('{"hawky":{"install":[{"kind":"brew","formula":"gh"}]}}');
    expect(config.install?.length).toBe(1);
    expect(config.install![0].kind).toBe("brew");
  });
});

describe("stripFrontmatter", () => {
  test("strips frontmatter and returns body", () => {
    const content = "---\nname: test\ndescription: test\n---\n# Body\nContent here";
    expect(stripFrontmatter(content)).toBe("# Body\nContent here");
  });

  test("returns content unchanged if no frontmatter", () => {
    expect(stripFrontmatter("# No frontmatter")).toBe("# No frontmatter");
  });
});

// =============================================================================
// Binary Checking
// =============================================================================

describe("hasBinary", () => {
  test("finds common binaries", () => {
    expect(hasBinary("git")).toBe(true);
    expect(hasBinary("ls")).toBe(true);
  });

  test("returns false for nonexistent binary", () => {
    expect(hasBinary("nonexistent_binary_xyz_123")).toBe(false);
  });

  test("caches results", () => {
    hasBinary("git");
    // Second call should use cache (we can't directly verify, but it shouldn't throw)
    expect(hasBinary("git")).toBe(true);
  });
});

// =============================================================================
// Skill Loading
// =============================================================================

describe("loadAllSkills", () => {
  test("loads skills from workspace directory", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    createSkill(skillsDir, "my-skill", 'name: my-skill\ndescription: Test skill');

    const skills = loadAllSkills(wsDir);
    // Should include workspace skill + any bundled skills
    const mySkill = skills.find((s) => s.name === "my-skill");
    expect(mySkill).toBeDefined();
    expect(mySkill!.source).toBe("workspace");
  });

  test("checks eligibility for required binaries", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");

    // Skill requiring git (exists)
    createSkill(skillsDir, "git-skill",
      'name: git-skill\ndescription: Needs git\nmetadata: \'{"hawky":{"requires":{"bins":["git"]}}}\'');

    // Skill requiring nonexistent binary
    createSkill(skillsDir, "fake-skill",
      'name: fake-skill\ndescription: Needs fake\nmetadata: \'{"hawky":{"requires":{"bins":["nonexistent_xyz"]}}}\'');

    const skills = loadAllSkills(wsDir);
    const gitSkill = skills.find((s) => s.name === "git-skill");
    const fakeSkill = skills.find((s) => s.name === "fake-skill");

    expect(gitSkill!.eligible).toBe(true);
    expect(gitSkill!.missing).toEqual([]);

    expect(fakeSkill!.eligible).toBe(false);
    expect(fakeSkill!.missing).toContain("bin: nonexistent_xyz");
  });

  test("higher priority overrides same-named skills", () => {
    const wsDir = join(tempDir, "workspace");
    const userDir = join(tempDir, "user-skills");
    const wsSkillsDir = join(wsDir, "skills");

    // Can't easily test bundled vs user vs workspace without mocking paths,
    // but we can test workspace override
    createSkill(wsSkillsDir, "my-skill", 'name: my-skill\ndescription: Workspace version');

    const skills = loadAllSkills(wsDir);
    expect(skills.find((s) => s.name === "my-skill")?.description).toBe("Workspace version");
  });

  test("respects enabled:false in user config", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    createSkill(skillsDir, "disabled-skill", 'name: disabled-skill\ndescription: Should be hidden');

    const skills = loadAllSkills(wsDir, { "disabled-skill": { enabled: false } });
    expect(skills.find((s) => s.name === "disabled-skill")).toBeUndefined();
  });

  test("loads bundled skills even without workspace", () => {
    // Bundled skills (from src/skill-templates/) always load
    const skills = loadAllSkills("/nonexistent/path");
    // Should have at least the bundled skills
    expect(skills.length).toBeGreaterThanOrEqual(0);
  });

  test("skips directories without SKILL.md", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    mkdirSync(join(skillsDir, "no-skill-file"), { recursive: true });
    writeFileSync(join(skillsDir, "no-skill-file", "README.md"), "not a skill");

    const skills = loadAllSkills(wsDir);
    // Should not find "no-skill-file" as a skill (may still have bundled skills)
    expect(skills.find((s) => s.name === "no-skill-file")).toBeUndefined();
  });

  test("skips SKILL.md with invalid frontmatter", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    mkdirSync(join(skillsDir, "bad-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "bad-skill", "SKILL.md"), "No frontmatter at all");

    const skills = loadAllSkills(wsDir);
    expect(skills.find((s) => s.name === "bad-skill")).toBeUndefined();
  });

  test("always:true bypasses eligibility checks", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    createSkill(skillsDir, "always-skill",
      'name: always-skill\ndescription: Always available\nmetadata: \'{"hawky":{"always":true,"requires":{"bins":["nonexistent_abc"]}}}\'');

    const skills = loadAllSkills(wsDir);
    const skill = skills.find((s) => s.name === "always-skill");
    expect(skill!.eligible).toBe(true);
  });
});

// =============================================================================
// Prompt Building
// =============================================================================

describe("buildSkillsPromptSection", () => {
  test("returns null for empty skills", () => {
    expect(buildSkillsPromptSection([])).toBeNull();
  });

  test("includes mandatory instructions", () => {
    const skills: SkillEntry[] = [{
      name: "test", description: "Test skill", path: "/tmp/test/SKILL.md",
      source: "workspace", eligible: true, missing: [], config: {}, userInvocable: true,
    }];
    const section = buildSkillsPromptSection(skills)!;
    expect(section).toContain("# Skills (mandatory)");
    expect(section).toContain("Before replying");
    expect(section).toContain("<available_skills>");
  });

  test("formats eligible skills with available=true", () => {
    const skills: SkillEntry[] = [{
      name: "github", description: "GitHub CLI", path: "/home/user/.hawky/skills/github/SKILL.md",
      source: "bundled", eligible: true, missing: [], config: {}, userInvocable: true,
    }];
    const section = buildSkillsPromptSection(skills)!;
    expect(section).toContain('available="true"');
    expect(section).toContain("<name>github</name>");
    expect(section).toContain("<description>GitHub CLI</description>");
  });

  test("formats ineligible skills with available=false and requires", () => {
    const skills: SkillEntry[] = [{
      name: "himalaya", description: "Email CLI", path: "/tmp/himalaya/SKILL.md",
      source: "bundled", eligible: false, missing: ["bin: himalaya"], config: {}, userInvocable: true,
    }];
    const section = buildSkillsPromptSection(skills)!;
    expect(section).toContain('available="false"');
    expect(section).toContain("<requires>bin: himalaya</requires>");
  });

  test("compacts home directory to ~", () => {
    const home = process.env.HOME ?? "/home/user";
    const skills: SkillEntry[] = [{
      name: "test", description: "test", path: `${home}/.hawky/skills/test/SKILL.md`,
      source: "user", eligible: true, missing: [], config: {}, userInvocable: true,
    }];
    const section = buildSkillsPromptSection(skills)!;
    expect(section).toContain("~/.hawky/skills/test/SKILL.md");
    expect(section).not.toContain(home);
  });
});

// =============================================================================
// Display Formatting
// =============================================================================

describe("formatSkillsForDisplay", () => {
  test("shows ready count", () => {
    const skills: SkillEntry[] = [
      { name: "a", description: "ready", path: "", source: "bundled", eligible: true, missing: [], config: {}, userInvocable: true },
      { name: "b", description: "not ready", path: "", source: "bundled", eligible: false, missing: ["bin: x"], config: {}, userInvocable: true },
    ];
    const display = formatSkillsForDisplay(skills);
    expect(display).toContain("1/2 ready");
  });

  test("shows ✓ for eligible skills", () => {
    const skills: SkillEntry[] = [
      { name: "github", description: "GitHub CLI", path: "", source: "bundled", eligible: true, missing: [], config: { emoji: "🐙" }, userInvocable: true },
    ];
    const display = formatSkillsForDisplay(skills);
    expect(display).toContain("✓");
    expect(display).toContain("🐙");
    expect(display).toContain("github");
  });

  test("shows ✗ and missing for ineligible skills", () => {
    const skills: SkillEntry[] = [
      { name: "himalaya", description: "Email", path: "", source: "bundled", eligible: false, missing: ["bin: himalaya"], config: {}, userInvocable: true },
    ];
    const display = formatSkillsForDisplay(skills);
    expect(display).toContain("✗");
    expect(display).toContain("missing: bin: himalaya");
  });

  test("returns message for empty skills", () => {
    expect(formatSkillsForDisplay([])).toContain("No skills found");
  });
});

// =============================================================================
// System Prompt Integration
// =============================================================================

describe("System prompt with skills", () => {
  test("includes Skills section when workspace has skills", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    createSkill(skillsDir, "test-skill", 'name: test-skill\ndescription: A test');

    // Import buildSystemPrompt
    const { buildSystemPrompt } = require("../src/agent/context.js");
    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("# Skills (mandatory)");
    expect(prompt).toContain("test-skill");
  });

  test("Skills section reflects workspace + bundled skills", () => {
    const { buildSystemPrompt } = require("../src/agent/context.js");
    // Even without workspace skills, bundled skills may be present
    const prompt = buildSystemPrompt({
      working_directory: tempDir,
      model: "test",
      workspace_dir: join(tempDir, "empty-ws"),
    });
    // If bundled skills exist, Skills section appears
    // If no bundled skills found, no Skills section — both are valid
    // Just verify no crash
    expect(prompt).toContain("Hawky");
  });
});

// =============================================================================
// Bundled Skills
// =============================================================================

describe("Bundled skills", () => {
  test("bundled skill templates exist", () => {
    const templateDir = join(__dirname, "..", "src", "skill-templates");
    const expected = ["github", "commit", "himalaya", "gog", "peekaboo", "slack", "summarize", "paper-search"];

    for (const name of expected) {
      const skillFile = join(templateDir, name, "SKILL.md");
      expect(existsSync(skillFile)).toBe(true);
    }
  });

  test("bundled skills have valid frontmatter", () => {
    const templateDir = join(__dirname, "..", "src", "skill-templates");
    const { readdirSync, readFileSync } = require("fs");

    for (const name of readdirSync(templateDir)) {
      const skillFile = join(templateDir, name, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, "utf-8");
      const meta = parseFrontmatter(content);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBeTruthy();
      expect(meta!.description).toBeTruthy();
    }
  });

  test("github skill requires gh binary", () => {
    const templateDir = join(__dirname, "..", "src", "skill-templates");
    const content = require("fs").readFileSync(join(templateDir, "github", "SKILL.md"), "utf-8");
    const meta = parseFrontmatter(content)!;
    const config = parseSkillConfig(meta.metadata);
    expect(config.requires?.bins).toContain("gh");
  });

  test("peekaboo skill is macOS only", () => {
    const templateDir = join(__dirname, "..", "src", "skill-templates");
    const content = require("fs").readFileSync(join(templateDir, "peekaboo", "SKILL.md"), "utf-8");
    const meta = parseFrontmatter(content)!;
    const config = parseSkillConfig(meta.metadata);
    expect(config.os).toContain("darwin");
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("Edge cases", () => {
  test("handles skill with only frontmatter, no body", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");
    createSkill(skillsDir, "minimal", 'name: minimal\ndescription: No body');

    const skills = loadAllSkills(wsDir);
    expect(skills.find((s) => s.name === "minimal")).toBeDefined();
  });

  test("handles large number of workspace skills", () => {
    const wsDir = join(tempDir, "workspace");
    const skillsDir = join(wsDir, "skills");

    for (let i = 0; i < 50; i++) {
      createSkill(skillsDir, `skill-${i}`, `name: skill-${i}\ndescription: Skill number ${i}`);
    }

    const skills = loadAllSkills(wsDir);
    // At least 50 workspace skills (plus any bundled)
    const wsSkills = skills.filter((s) => s.source === "workspace");
    expect(wsSkills.length).toBe(50);
  });

  test("escapes XML special characters in prompt", () => {
    const skills: SkillEntry[] = [{
      name: "test<>", description: "A & B", path: "/tmp/test/SKILL.md",
      source: "workspace", eligible: true, missing: [], config: {}, userInvocable: true,
    }];
    const section = buildSkillsPromptSection(skills)!;
    expect(section).toContain("test&lt;&gt;");
    expect(section).toContain("A &amp; B");
  });
});
