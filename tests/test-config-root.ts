// =============================================================================
// Config Root (HAWKY_HOME) Tests
//
// Guards against the "split-brain" regression where some modules derived state
// paths from a hardcoded ~/.hawky while others honored the configured root
// (HAWKY_HOME / getConfigDir). When the root is overridden, EVERY subsystem must
// follow it — otherwise state lands in two homes with no error.
// =============================================================================

import { describe, expect, test, afterEach } from "bun:test";
import { readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigDir,
  getConfigPath,
  setConfigDir,
  resetConfigDir,
} from "../src/storage/config.js";
import { getSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { getWorkspaceDir, resetWorkspaceDir } from "../src/storage/workspace.js";
import { defaultCronStorePath } from "../src/gateway/cron-store.js";
import { resolveMediaRoot } from "../src/gateway/media-root.js";
import { createSkill } from "../src/skills/create.js";
import { loadAllSkills, resetBinCache } from "../src/skills/loader.js";

const SRC_DIR = join(import.meta.dir, "..", "src");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("no module hardcodes ~/.hawky", () => {
  // The only place allowed to reference homedir()+".hawky" is the canonical
  // root resolver in storage/config.ts (the HAWKY_HOME fallback).
  test("no src file builds a path from homedir() + \".hawky\" except config.ts", () => {
    // Matches join(homedir(), ".hawky" ...) across possible whitespace/newlines.
    const pattern = /homedir\(\)\s*,\s*["']\.hawky["']/;
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_DIR)) {
      if (file.endsWith(join("storage", "config.ts"))) continue;
      const text = readFileSync(file, "utf-8");
      if (pattern.test(text)) offenders.push(file.slice(SRC_DIR.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});

describe("overriding the config root relocates all state paths", () => {
  let prevMediaRootEnv: string | undefined;

  afterEach(() => {
    resetConfigDir();
    resetSessionsDir();
    resetWorkspaceDir();
    if (prevMediaRootEnv === undefined) delete process.env.HAWKY_MEDIA_ROOT;
    else process.env.HAWKY_MEDIA_ROOT = prevMediaRootEnv;
  });

  test("every derived path follows setConfigDir(), none stays under ~/.hawky", () => {
    const root = join(tmpdir(), `hawky-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Ensure media-root's env short-circuit doesn't mask the config-root path.
    prevMediaRootEnv = process.env.HAWKY_MEDIA_ROOT;
    delete process.env.HAWKY_MEDIA_ROOT;
    resetSessionsDir();
    resetWorkspaceDir();
    setConfigDir(root);

    const paths: Record<string, string> = {
      configDir: getConfigDir(),
      configPath: getConfigPath(),
      sessionsDir: getSessionsDir(),
      workspaceDir: getWorkspaceDir(),
      cronStore: defaultCronStorePath(),
      mediaRoot: resolveMediaRoot(),
    };

    // Any path not under the override root is a split-brain leak.
    const leaked = Object.entries(paths).filter(([, p]) => !p.startsWith(root));
    expect(leaked).toEqual([]);
  });
});

// Skills discovery is a core subsystem whose user-skills dir derives from the
// config root; assert an override relocates both writing (createSkill) and
// reading (loadAllSkills), end-to-end.
describe("user skills follow the config root", () => {
  let root: string;

  afterEach(() => {
    resetConfigDir();
    resetBinCache();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("a user skill created under an overridden root is discovered there", () => {
    root = join(tmpdir(), `hawky-skills-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setConfigDir(root);

    const created = createSkill("relocated-skill", "config-root probe", "user");
    expect(created.ok).toBe(true);
    if (created.ok) {
      // Written under the overridden root, not ~/.hawky.
      expect(created.path.startsWith(root)).toBe(true);
    }

    // Discovery reads from the same overridden user-skills dir.
    const skills = loadAllSkills();
    const found = skills.find((s) => s.name === "relocated-skill");
    expect(found?.source).toBe("user");
  });
});
