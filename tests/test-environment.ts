// =============================================================================
// Tests: Environment Detection
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  detectEnvironment,
  detectGitInfo,
  detectShell,
  detectOsVersion,
  loadProjectInstructions,
} from "../src/agent/environment.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// =============================================================================
// Git detection
// =============================================================================

describe("detectGitInfo", () => {
  test("detects git repo in hawky project", () => {
    const info = detectGitInfo(process.cwd());
    expect(info).not.toBeNull();
    expect(info!.isRepo).toBe(true);
    expect(info!.repoName).toBe("hawky");
    expect(info!.branch).toBeTruthy();
    expect(info!.root).toBeTruthy();
  });

  test("returns null for non-git directory", () => {
    const info = detectGitInfo(tmpdir());
    expect(info).toBeNull();
  });

  test("branch is a non-empty string", () => {
    const info = detectGitInfo(process.cwd());
    expect(info!.branch.length).toBeGreaterThan(0);
    // Should not contain newlines
    expect(info!.branch).not.toContain("\n");
  });

  test("root is an absolute path", () => {
    const info = detectGitInfo(process.cwd());
    expect(info!.root.startsWith("/")).toBe(true);
  });

  test("repoName is worktree-safe (always 'hawky' regardless of cwd)", () => {
    // Regression: the previous implementation used basename(--show-toplevel)
    // for repoName, which returned the worktree directory name (e.g.
    // "vivid-tinkering-tome") when running inside a git worktree. The fix
    // derives repoName from the parent of `--git-common-dir`, which always
    // points at the main `.git/`'s parent — i.e. the actual repo, regardless
    // of whether we're in the main checkout or a worktree.
    const info = detectGitInfo(process.cwd());
    expect(info!.repoName).toBe("hawky");
  });
});

// =============================================================================
// OS / Shell detection
// =============================================================================

describe("detectShell", () => {
  test("returns a non-empty string", () => {
    const shell = detectShell();
    expect(shell.length).toBeGreaterThan(0);
  });

  test("contains a path or executable name", () => {
    const shell = detectShell();
    // Should be something like /bin/zsh, /bin/bash, cmd.exe
    expect(shell).toMatch(/sh|bash|zsh|fish|cmd|powershell/i);
  });
});

describe("detectOsVersion", () => {
  test("returns a non-empty string", () => {
    const version = detectOsVersion();
    expect(version.length).toBeGreaterThan(0);
  });

  test("contains OS name", () => {
    const version = detectOsVersion();
    // Should contain macOS, Windows, or Linux
    expect(version).toMatch(/macOS|Windows|Linux|darwin/i);
  });
});

// =============================================================================
// Full environment detection
// =============================================================================

describe("detectEnvironment", () => {
  test("returns all fields", () => {
    const env = detectEnvironment(process.cwd());
    expect(env.platform).toBeTruthy();
    expect(env.osVersion).toBeTruthy();
    expect(env.architecture).toBeTruthy();
    expect(env.shell).toBeTruthy();
  });

  test("git info present for hawky project", () => {
    const env = detectEnvironment(process.cwd());
    expect(env.git).not.toBeNull();
    expect(env.git!.repoName).toBe("hawky");
  });

  test("git info null for non-repo directory", () => {
    const env = detectEnvironment(tmpdir());
    expect(env.git).toBeNull();
  });
});

// =============================================================================
// Project instructions loading
// =============================================================================

describe("loadProjectInstructions", () => {
  let testDir: string;

  test("returns null when no instruction files exist", () => {
    const dir = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const result = loadProjectInstructions(dir, null);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads HAWKY.md from working directory", () => {
    const dir = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HAWKY.md"), "Always respond in French.");
    try {
      const result = loadProjectInstructions(dir, null);
      expect(result).not.toBeNull();
      expect(result!.content).toBe("Always respond in French.");
      expect(result!.filePath).toContain("HAWKY.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads CLAUDE.md when HAWKY.md doesn't exist", () => {
    const dir = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "Be concise.");
    try {
      const result = loadProjectInstructions(dir, null);
      expect(result).not.toBeNull();
      expect(result!.content).toBe("Be concise.");
      expect(result!.filePath).toContain("CLAUDE.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HAWKY.md takes priority over CLAUDE.md", () => {
    const dir = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HAWKY.md"), "Hawky wins.");
    writeFileSync(join(dir, "CLAUDE.md"), "Claude loses.");
    try {
      const result = loadProjectInstructions(dir, null);
      expect(result!.content).toBe("Hawky wins.");
      expect(result!.filePath).toContain("HAWKY.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("searches git root when working directory has no instructions", () => {
    const root = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    const sub = join(root, "subdir");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "HAWKY.md"), "From git root.");
    try {
      const result = loadProjectInstructions(sub, root);
      expect(result).not.toBeNull();
      expect(result!.content).toBe("From git root.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("working directory takes priority over git root", () => {
    const root = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    const sub = join(root, "subdir");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "HAWKY.md"), "Root version.");
    writeFileSync(join(sub, "HAWKY.md"), "Subdir version.");
    try {
      const result = loadProjectInstructions(sub, root);
      expect(result!.content).toBe("Subdir version.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips empty instruction files", () => {
    const dir = join(tmpdir(), `hawky-env-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HAWKY.md"), "");
    writeFileSync(join(dir, "CLAUDE.md"), "Fallback content.");
    try {
      const result = loadProjectInstructions(dir, null);
      expect(result!.content).toBe("Fallback content.");
      expect(result!.filePath).toContain("CLAUDE.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
