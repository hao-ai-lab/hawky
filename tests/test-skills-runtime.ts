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
import { buildSkillEnv } from "../src/skills/env.js";
import { buildSkillCommands, sanitizeCommandName, formatSkillInvocation } from "../src/skills/commands.js";
import { isSkillsDirty, markSkillsDirty, clearSkillsDirty, startSkillsWatcher, stopSkillsWatcher, makeIgnored } from "../src/skills/watcher.js";
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

describe("buildSkillEnv", () => {
  test("returns env vars from config WITHOUT mutating process.env", () => {
    const skills = [makeSkillEntry({ name: "my-skill" })];
    const config = { "my-skill": { env: { MY_TEST_VAR: "hello" } } };

    const env = buildSkillEnv(skills, config);
    expect(env.MY_TEST_VAR).toBe("hello");
    // The global is never touched — this is the whole point of the fix.
    expect(process.env.MY_TEST_VAR).toBeUndefined();
  });

  test("collects multiple vars", () => {
    const skills = [makeSkillEntry({ name: "s1" })];
    const config = { s1: { env: { A: "a", B: "b" } } };

    const env = buildSkillEnv(skills, config);
    expect(env).toEqual({ A: "a", B: "b" });
    expect(process.env.A).toBeUndefined();
    expect(process.env.B).toBeUndefined();
  });

  test("does not shadow existing real env vars (real env wins)", () => {
    process.env.EXISTING_VAR_TEST = "original";
    try {
      const skills = [makeSkillEntry({ name: "s1" })];
      const config = { s1: { env: { EXISTING_VAR_TEST: "overwritten" } } };

      const env = buildSkillEnv(skills, config);
      expect(env.EXISTING_VAR_TEST).toBeUndefined(); // real env wins → not claimed
      expect(process.env.EXISTING_VAR_TEST).toBe("original");
    } finally {
      delete process.env.EXISTING_VAR_TEST;
    }
  });

  test("blocks dangerous env vars (PATH, HOME, SHELL)", () => {
    const skills = [makeSkillEntry({ name: "evil" })];
    const config = { evil: { env: { PATH: "/tmp/evil", HOME: "/tmp", SHELL: "/bin/evil" } } };

    const env = buildSkillEnv(skills, config);
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
  });

  test("blocks code-execution / loader-injection env vars", () => {
    // bash -c sources $BASH_ENV; sh sources $ENV; DYLD_INSERT_LIBRARIES / LD_AUDIT
    // preload attacker code into every child — none may be set from skill config.
    const skills = [makeSkillEntry({ name: "evil" })];
    const config = {
      evil: {
        env: {
          BASH_ENV: "/tmp/evil.sh",
          ENV: "/tmp/evil.sh",
          DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
          LD_AUDIT: "/tmp/evil.so",
          BASH_XTRACEFD: "3",
        },
      },
    };
    expect(buildSkillEnv(skills, config)).toEqual({});
  });

  test("maps apiKey to primaryEnv", () => {
    const skills = [makeSkillEntry({ name: "api-skill", config: { primaryEnv: "MY_API_KEY" } })];
    const env = buildSkillEnv(skills, { "api-skill": { apiKey: "secret-key-123" } });
    expect(env.MY_API_KEY).toBe("secret-key-123");
    expect(process.env.MY_API_KEY).toBeUndefined();
  });

  test("maps apiKey to first requires.env if no primaryEnv", () => {
    const skills = [makeSkillEntry({ name: "env-skill", config: { requires: { env: ["SLACK_BOT_TOKEN"] } } })];
    const env = buildSkillEnv(skills, { "env-skill": { apiKey: "xoxb-test-token" } });
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
  });

  test("skips ineligible skills", () => {
    const skills = [makeSkillEntry({ name: "disabled", eligible: false })];
    const env = buildSkillEnv(skills, { disabled: { env: { SHOULD_NOT_SET: "bad" } } });
    expect(env.SHOULD_NOT_SET).toBeUndefined();
  });

  test("handles missing config / empty skills gracefully", () => {
    expect(buildSkillEnv([makeSkillEntry({ name: "no-config" })], undefined)).toEqual({});
    expect(buildSkillEnv([], {})).toEqual({});
  });

  // Regression for #13: two skills configured in two different sessions must NOT
  // see each other's secrets. buildSkillEnv is pure (no global), so each
  // session's map is independent and the global is never touched.
  test("two sessions' env maps are isolated and the global is untouched", () => {
    const sessionA = buildSkillEnv(
      [makeSkillEntry({ name: "slack", config: { primaryEnv: "SLACK_TOKEN" } })],
      { slack: { apiKey: "tokenA" } },
    );
    const sessionB = buildSkillEnv(
      [makeSkillEntry({ name: "slack", config: { primaryEnv: "SLACK_TOKEN" } })],
      { slack: { apiKey: "tokenB" } },
    );

    expect(sessionA.SLACK_TOKEN).toBe("tokenA");
    expect(sessionB.SLACK_TOKEN).toBe("tokenB"); // NOT "tokenA" — no cross-leak
    expect(process.env.SLACK_TOKEN).toBeUndefined(); // never leaked to the global
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
// Integration: Real Skill Watcher (chokidar over the filesystem)
//
// Regression guard for #9 — the watcher previously passed glob strings to
// chokidar v5 (globs unsupported since v4), so it registered but never fired.
// =============================================================================

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

describe("Skill watcher fires on real file changes", () => {
  afterEach(() => {
    stopSkillsWatcher();
    clearSkillsDirty();
  });

  test("editing a workspace SKILL.md marks skills dirty", async () => {
    const skillDir = join(tempDir, "skills", "demo");
    mkdirSync(skillDir, { recursive: true });

    clearSkillsDirty();
    startSkillsWatcher(tempDir);

    // Let chokidar finish its initial scan before writing (ignoreInitial: true).
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(skillDir, "SKILL.md"), "# demo skill\n");

    expect(await waitFor(() => isSkillsDirty())).toBe(true);
  });

  test("editing a non-SKILL.md file does not mark dirty", async () => {
    const skillDir = join(tempDir, "skills", "demo");
    mkdirSync(skillDir, { recursive: true });

    clearSkillsDirty();
    startSkillsWatcher(tempDir);

    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(skillDir, "notes.md"), "not a skill\n");

    // Give the watcher + 250ms debounce time to (not) fire.
    await new Promise((r) => setTimeout(r, 1200));
    expect(isSkillsDirty()).toBe(false);
  });

  // Regression for the over-broad ignore: "prompt-builder" contains the
  // substring "build", which the old unanchored /build/ regex pruned.
  test("skill dir whose name contains an ignored word (prompt-builder) still fires", async () => {
    const skillDir = join(tempDir, "skills", "prompt-builder");
    mkdirSync(skillDir, { recursive: true });

    clearSkillsDirty();
    startSkillsWatcher(tempDir);

    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(skillDir, "SKILL.md"), "# prompt-builder\n");

    expect(await waitFor(() => isSkillsDirty())).toBe(true);
  });

  // A skill named exactly like a reserved dir must still work: the ignore is
  // scoped to segments *below* the watch root, not the skill folder itself.
  test("skill named exactly 'build' still fires", async () => {
    const skillDir = join(tempDir, "skills", "build");
    mkdirSync(skillDir, { recursive: true });

    clearSkillsDirty();
    startSkillsWatcher(tempDir);

    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(skillDir, "SKILL.md"), "# build\n");

    expect(await waitFor(() => isSkillsDirty())).toBe(true);
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

// chokidar hands the `ignored` predicate a forward-slash path on every platform
// while the watch roots use the native separator. makeIgnored must compare both
// as POSIX so vendored-dir pruning works on Windows too. The skill folder name
// itself (rel[0]) is never junk — only segments nested inside it.
describe("skills makeIgnored is separator-agnostic (Windows paths)", () => {
  test("prunes vendored dirs inside a skill, never the root or the skill folder name", () => {
    const ig = makeIgnored(["/cfg/skills"]);
    expect(ig("/cfg/skills/my-skill/SKILL.md")).toBe(false);       // real skill file
    expect(ig("/cfg/skills/my-skill/node_modules/x.md")).toBe(true); // vendored inside skill
    expect(ig("/cfg/skills/build/SKILL.md")).toBe(false);          // skill folder named "build" is fine
    expect(ig("/cfg/skills")).toBe(false);                          // the root itself

    const win = makeIgnored(["C:\\cfg\\skills"]);
    expect(win("C:/cfg/skills/my-skill/SKILL.md")).toBe(false);
    expect(win("C:/cfg/skills/my-skill/node_modules/x.md")).toBe(true);
    expect(win("C:/cfg/skills/build/SKILL.md")).toBe(false);
  });
});
