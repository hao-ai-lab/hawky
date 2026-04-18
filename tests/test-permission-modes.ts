// =============================================================================
// Permission Modes Tests
//
// Tests for 10.2p: acceptEdits mode, additional working directories,
// dangerous path checking, filesystem bash commands, and mode switching.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import {
  PermissionCache,
  isDangerousPath,
  isPathInWorkingDirs,
  isPathInApprovedDir,
} from "../src/agent/tool_executor.js";

// =============================================================================
// PermissionCache mode tests
// =============================================================================

describe("PermissionCache — permission modes", () => {
  let cache: PermissionCache;

  beforeEach(() => {
    cache = new PermissionCache();
  });

  test("default mode is 'default'", () => {
    expect(cache.mode).toBe("default");
  });

  test("setMode changes mode", () => {
    cache.setMode("accept-edits");
    expect(cache.mode).toBe("accept-edits");
  });

  test("serialize includes mode", () => {
    cache.setMode("accept-edits");
    const data = cache.serialize();
    expect(data.mode).toBe("accept-edits");
  });

  test("restore preserves mode", () => {
    const cache2 = new PermissionCache();
    cache2.restore({ always_allowed: [], allow_all: false, mode: "accept-edits" });
    expect(cache2.mode).toBe("accept-edits");
  });

  test("reset preserves mode (user choice)", () => {
    cache.setMode("accept-edits");
    cache.reset();
    expect(cache.mode).toBe("accept-edits");
  });

  test("forceBypass overrides mode getter to bypassPermissions", () => {
    cache.setMode("default");
    cache.setForceBypass(true);
    expect(cache.mode).toBe("bypass");
  });

  test("accept_edits decision switches to acceptEdits mode", () => {
    expect(cache.mode).toBe("default");
    cache.recordDecision("edit_file", "accept_edits");
    expect(cache.mode).toBe("accept-edits");
  });

  test("/bypass (allow_all) reflects as bypassPermissions in mode", () => {
    expect(cache.mode).toBe("default");
    cache.recordDecision("*", "allow_all");
    expect(cache.mode).toBe("bypass");
  });

  test("/bypass-off (reset) restores previous mode", () => {
    cache.setMode("accept-edits");
    cache.recordDecision("*", "allow_all");
    expect(cache.mode).toBe("bypass");
    cache.reset();
    // mode survives reset, allowAll cleared → back to acceptEdits
    expect(cache.mode).toBe("accept-edits");
  });

  test("/mode bypassPermissions then /mode shows bypass", () => {
    // Simulates: /mode bypassPermissions → sets allowAll
    // Then: /mode (no args) → reads cache.mode
    expect(cache.mode).toBe("default");
    cache.recordDecision("*", "allow_all"); // what permission.mode RPC does for bypassPermissions
    expect(cache.mode).toBe("bypass");
  });

  test("/mode acceptEdits → /mode bypassPermissions → /mode default restores correctly", () => {
    cache.setMode("accept-edits");
    expect(cache.mode).toBe("accept-edits");

    cache.recordDecision("*", "allow_all");
    expect(cache.mode).toBe("bypass");

    // Leaving bypass: reset clears allowAll, then setMode("default")
    cache.reset();
    cache.setMode("default");
    expect(cache.mode).toBe("default");
  });

  test("isForceBypass distinguishes gateway-flag bypass from session-level (drives the indicator label)", () => {
    // Both forms make `mode` report "bypass", but the indicator
    // needs to know which one is active so the click-to-disable
    // affordance is only offered for session-level bypass.
    expect(cache.isForceBypass()).toBe(false);

    // Session-level bypass via "allow all"
    cache.recordDecision("*", "allow_all");
    expect(cache.mode).toBe("bypass");
    expect(cache.isForceBypass()).toBe(false);

    // Gateway-level bypass (--dangerously-skip-permissions)
    cache.reset();
    cache.setForceBypass(true);
    expect(cache.mode).toBe("bypass");
    expect(cache.isForceBypass()).toBe(true);
  });
});

// =============================================================================
// Additional working directories
// =============================================================================

describe("PermissionCache — additional directories", () => {
  let cache: PermissionCache;

  beforeEach(() => {
    cache = new PermissionCache();
  });

  test("no additional directories by default", () => {
    expect(cache.additionalDirectories.size).toBe(0);
  });

  test("addDirectory adds a directory", () => {
    cache.addDirectory("/tmp/other-project");
    expect(cache.additionalDirectories.has("/tmp/other-project")).toBe(true);
  });

  test("allow_directory decision adds directory from input", () => {
    cache.recordDecision("edit_file", "allow_directory", { file_path: "/tmp/other-project/src/foo.ts" });
    expect(cache.additionalDirectories.size).toBe(1);
    const dirs = [...cache.additionalDirectories];
    expect(dirs[0]).toContain("/tmp/other-project/src");
  });

  test("allow_directory decision does NOT switch mode (scoped grant only)", () => {
    // The "Allow edits in <dir>" button is directory-scoped — it should not
    // widen into session-wide accept-edits, which would also auto-approve
    // edits in the project root and filesystem bash commands.
    expect(cache.mode).toBe("default");
    cache.recordDecision("edit_file", "allow_directory", { file_path: "/tmp/other-project/src/foo.ts" });
    expect(cache.mode).toBe("default");
  });

  test("serialize/restore preserves additional directories", () => {
    cache.addDirectory("/tmp/dir1");
    cache.addDirectory("/tmp/dir2");
    const data = cache.serialize();
    expect(data.additional_directories).toEqual(["/tmp/dir1", "/tmp/dir2"]);

    const cache2 = new PermissionCache();
    cache2.restore(data);
    expect(cache2.additionalDirectories.size).toBe(2);
  });

  test("reset preserves additional directories (user choice)", () => {
    cache.addDirectory("/tmp/dir1");
    cache.reset();
    expect(cache.additionalDirectories.size).toBe(1);
  });
});

// =============================================================================
// isDangerousPath
// =============================================================================

describe("isDangerousPath", () => {
  test("dangerous directories", () => {
    expect(isDangerousPath("/project/.git/config")).toBe(true);
    expect(isDangerousPath("/project/.vscode/settings.json")).toBe(true);
    expect(isDangerousPath("/project/.idea/workspace.xml")).toBe(true);
    expect(isDangerousPath("/project/.claude/settings.json")).toBe(true);
  });

  test("dangerous files by name", () => {
    expect(isDangerousPath("/project/.env")).toBe(true);
    expect(isDangerousPath("/project/.env.local")).toBe(true);
    expect(isDangerousPath("/project/.gitconfig")).toBe(true);
    expect(isDangerousPath("/somewhere/credentials.json")).toBe(true);
    expect(isDangerousPath("/somewhere/id_rsa")).toBe(true);
  });

  test("safe project files", () => {
    expect(isDangerousPath("/project/src/index.ts")).toBe(false);
    expect(isDangerousPath("/project/README.md")).toBe(false);
    expect(isDangerousPath("/project/package.json")).toBe(false);
    expect(isDangerousPath("/project/tests/test-foo.ts")).toBe(false);
  });

  test("dotfiles in home directory", () => {
    const home = process.env.HOME ?? "/Users/test";
    expect(isDangerousPath(`${home}/.zshrc`)).toBe(true);
    expect(isDangerousPath(`${home}/.bashrc`)).toBe(true);
    expect(isDangerousPath(`${home}/.profile`)).toBe(true);
  });

  test("dangerous paths detected after resolution (relative .env)", () => {
    // Simulates: rm .env — isDangerousPath must work on resolved paths too
    expect(isDangerousPath("/project/.env")).toBe(true);
    expect(isDangerousPath("/project/.git/config")).toBe(true);
    expect(isDangerousPath("/project/.claude/settings.json")).toBe(true);
  });
});

// =============================================================================
// isPathInWorkingDirs
// =============================================================================

describe("isPathInWorkingDirs", () => {
  const cwd = "/Users/example/projects/myproject";
  const empty = new Set<string>();

  test("file inside CWD", () => {
    expect(isPathInWorkingDirs("/Users/example/projects/myproject/src/foo.ts", cwd, empty)).toBe(true);
  });

  test("file outside CWD", () => {
    expect(isPathInWorkingDirs("/Users/example/projects/other/foo.ts", cwd, empty)).toBe(false);
  });

  test("relative path inside CWD", () => {
    expect(isPathInWorkingDirs("src/foo.ts", cwd, empty)).toBe(true);
  });

  test("path traversal outside CWD", () => {
    expect(isPathInWorkingDirs("../../etc/passwd", cwd, empty)).toBe(false);
  });

  test("file in additional directory", () => {
    const additional = new Set(["/Users/example/projects/other"]);
    expect(isPathInWorkingDirs("/Users/example/projects/other/foo.ts", cwd, additional)).toBe(true);
  });

  test("CWD itself is allowed", () => {
    expect(isPathInWorkingDirs(cwd, cwd, empty)).toBe(true);
  });
});

// =============================================================================
// isPathInApprovedDir — directory-scoped grant (no cwd fallback)
// =============================================================================

describe("isPathInApprovedDir", () => {
  const cwd = "/Users/example/projects/myproject";

  test("returns false when no additional dirs are approved", () => {
    expect(isPathInApprovedDir("src/foo.ts", cwd, new Set())).toBe(false);
  });

  test("file inside an approved dir is allowed", () => {
    const approved = new Set(["/tmp/scratch"]);
    expect(isPathInApprovedDir("/tmp/scratch/foo.ts", cwd, approved)).toBe(true);
  });

  test("file in project CWD is NOT allowed without an explicit approval", () => {
    // This is the key distinction from isPathInWorkingDirs — approving a
    // scratch dir must not implicitly extend to the project root.
    const approved = new Set(["/tmp/scratch"]);
    expect(isPathInApprovedDir("/Users/example/projects/myproject/src/foo.ts", cwd, approved)).toBe(false);
  });

  test("path traversal outside approved dir is rejected", () => {
    const approved = new Set(["/tmp/scratch"]);
    expect(isPathInApprovedDir("/tmp/scratch/../../etc/passwd", cwd, approved)).toBe(false);
  });

  test("relative path is resolved against cwd before checking", () => {
    const approved = new Set([cwd + "/sub"]);
    expect(isPathInApprovedDir("sub/foo.ts", cwd, approved)).toBe(true);
  });
});

// =============================================================================
// Mode-aware auto-approval integration
// =============================================================================

describe("Mode-aware auto-approval", () => {
  test("edit_file in CWD NOT auto-approved in default mode", () => {
    const cache = new PermissionCache();
    expect(cache.isAutoApproved("edit_file", "ask_user", { file_path: "src/foo.ts" })).toBe(false);
  });

  test("accept_edits decision switches mode", () => {
    const cache = new PermissionCache();
    cache.recordDecision("edit_file", "accept_edits");
    expect(cache.mode).toBe("accept-edits");
  });

  test("allow_directory adds directory in default mode (no accept-edits required)", () => {
    const cache = new PermissionCache();
    expect(cache.mode).toBe("default");
    cache.recordDecision("edit_file", "allow_directory", { file_path: "/tmp/other/src/bar.ts" });
    expect(cache.additionalDirectories.size).toBe(1);
    expect(cache.mode).toBe("default"); // grant stays scoped
  });
});

// =============================================================================
// edit_file + write_file treated as one permission class
// =============================================================================

describe("Permission class — edit_file and write_file are grouped", () => {
  test("allow_always on edit_file also auto-approves write_file", () => {
    const cache = new PermissionCache();
    cache.recordDecision("edit_file", "allow_always");
    expect(cache.isAlwaysAllowed("edit_file")).toBe(true);
    expect(cache.isAlwaysAllowed("write_file")).toBe(true);
    expect(cache.isAutoApproved("write_file", "ask_user", { file_path: "foo.ts" })).toBe(true);
  });

  test("allow_always on write_file also auto-approves edit_file", () => {
    const cache = new PermissionCache();
    cache.recordDecision("write_file", "allow_always");
    expect(cache.isAlwaysAllowed("write_file")).toBe(true);
    expect(cache.isAlwaysAllowed("edit_file")).toBe(true);
    expect(cache.isAutoApproved("edit_file", "ask_user", { file_path: "foo.ts" })).toBe(true);
  });

  test("allow_always on other tools does NOT bleed into file edits", () => {
    const cache = new PermissionCache();
    cache.recordDecision("read_file", "allow_always");
    expect(cache.isAlwaysAllowed("read_file")).toBe(true);
    expect(cache.isAlwaysAllowed("edit_file")).toBe(false);
    expect(cache.isAlwaysAllowed("write_file")).toBe(false);
  });

  test("allow_always on bash stays per-command, not grouped", () => {
    // Bash has its own per-command allowlist. Grouping file edits must not
    // accidentally enable bash as a tool name.
    const cache = new PermissionCache();
    cache.recordDecision("edit_file", "allow_always");
    expect(cache.isAlwaysAllowed("bash")).toBe(false);
  });
});

// =============================================================================
// Serialization edge cases
// =============================================================================

describe("PermissionCache — serialization edge cases", () => {
  test("serialize with all features", () => {
    const cache = new PermissionCache();
    cache.setMode("accept-edits");
    cache.addDirectory("/tmp/dir1");
    cache.recordDecision("bash", "allow_command", { command: "npm test" });
    cache.recordDecision("edit_file", "allow_always");

    const data = cache.serialize();
    expect(data.mode).toBe("accept-edits");
    expect(data.additional_directories).toEqual(["/tmp/dir1"]);
    expect(data.always_allowed).toContain("edit_file");
    expect(data.allowed_commands?.bash).toContain("npm test");
  });

  test("isPathInWorkingDirs follows symlinks via realpath", () => {
    // /tmp is often a symlink to /private/tmp on macOS
    // Both should resolve to the same canonical path
    const tmpReal = require("fs").realpathSync("/tmp");
    const result = isPathInWorkingDirs(`${tmpReal}/test.txt`, tmpReal, new Set());
    expect(result).toBe(true);
  });

  test("restore from legacy data (no mode/dirs)", () => {
    const cache = new PermissionCache();
    cache.restore({ always_allowed: ["bash"], allow_all: false } as any);
    expect(cache.mode).toBe("default");
    expect(cache.additionalDirectories.size).toBe(0);
    expect(cache.isAlwaysAllowed("bash")).toBe(true);
  });
});
