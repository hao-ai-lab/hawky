// =============================================================================
// Tests: Auto-Approve Indicator + Persistent Permissions (10.2j)
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { PermissionCache } from "../src/agent/tool_executor.js";
import { loadPermissions, savePermissions } from "../src/storage/permissions.js";
import { setConfigDir, resetConfigDir } from "../src/storage/config.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".test-permissions");

// =============================================================================
// PermissionCache — approval reason tracking
// =============================================================================

describe("PermissionCache", () => {
  test("isAllowAll returns false by default", () => {
    const cache = new PermissionCache();
    expect(cache.isAllowAll()).toBe(false);
  });

  test("isAllowAll returns true after allow_all decision", () => {
    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_all");
    expect(cache.isAllowAll()).toBe(true);
  });

  test("isAlwaysAllowed returns false by default", () => {
    const cache = new PermissionCache();
    expect(cache.isAlwaysAllowed("bash")).toBe(false);
  });

  test("isAlwaysAllowed returns true after allow_always decision", () => {
    const cache = new PermissionCache();
    cache.recordDecision("bash", "allow_always");
    // Bash without a command argument falls through to tool-level approval.
    // (In practice the dialog always passes a command, but the tool-level
    // path must still work for symmetry with other tools.)
    expect(cache.isAlwaysAllowed("bash")).toBe(true);
    // File edits are a separate class — not extended from bash.
    expect(cache.isAlwaysAllowed("edit_file")).toBe(false);
    expect(cache.isAlwaysAllowed("write_file")).toBe(false);
  });

  test("serialize and restore roundtrip", () => {
    const cache = new PermissionCache();
    cache.recordDecision("read_file", "allow_always");
    cache.recordDecision("edit_file", "allow_always");
    const data = cache.serialize();

    const restored = new PermissionCache();
    restored.restore(data);
    expect(restored.isAlwaysAllowed("read_file")).toBe(true);
    expect(restored.isAlwaysAllowed("edit_file")).toBe(true);
    // edit_file and write_file are one permission class — approving one
    // extends to the other by design.
    expect(restored.isAlwaysAllowed("write_file")).toBe(true);
  });
});

// =============================================================================
// Persistent permissions (save/load from disk)
// Isolated from production via setConfigDir → temp directory
// =============================================================================

describe("Persistent permissions", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    setConfigDir(TEST_DIR);
  });

  afterEach(() => {
    resetConfigDir();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("save and load roundtrip", async () => {
    const data = { always_allowed: ["bash", "edit_file"], allow_all: false };
    await savePermissions(data);
    const loaded = await loadPermissions();
    expect(loaded).not.toBeNull();
    expect(loaded!.always_allowed).toEqual(["bash", "edit_file"]);
    expect(loaded!.allow_all).toBe(false);
  });

  test("load returns null when file doesn't exist", async () => {
    const loaded = await loadPermissions();
    expect(loaded).toBeNull();
  });

  test("load handles invalid JSON gracefully", async () => {
    const permPath = join(TEST_DIR, "permissions.json");
    await Bun.write(permPath, "not json!!!");
    const loaded = await loadPermissions();
    expect(loaded).toBeNull();
  });

  test("save creates directory if needed", async () => {
    const data = { always_allowed: ["grep"], allow_all: false };
    await savePermissions(data);
    const loaded = await loadPermissions();
    expect(loaded!.always_allowed).toEqual(["grep"]);
  });

  // ---------------------------------------------------------------------------
  // Pattern-rule persistence (Part 17.3)
  // ---------------------------------------------------------------------------

  test("rules round-trip through save + load", async () => {
    await savePermissions({
      always_allowed: [],
      allow_all: false,
      rules: ["Bash(git log *)", "Bash(gog gmail messages search *)"],
    });
    const loaded = await loadPermissions();
    expect(loaded?.rules).toEqual(["Bash(git log *)", "Bash(gog gmail messages search *)"]);
  });

  test("savePermissions merges rule lists (additive, deduped)", async () => {
    await savePermissions({
      always_allowed: [],
      allow_all: false,
      rules: ["Bash(git log *)"],
    });
    await savePermissions({
      always_allowed: [],
      allow_all: false,
      rules: ["Bash(git log *)", "Bash(gog *)"],
    });
    const loaded = await loadPermissions();
    expect(loaded?.rules).toEqual(["Bash(git log *)", "Bash(gog *)"]);
  });

  test("legacy file (no rules field) still loads cleanly", async () => {
    // Mimic an older permissions.json from before the rules field existed.
    const permPath = join(TEST_DIR, "permissions.json");
    await Bun.write(permPath, JSON.stringify({
      always_allowed: ["read_file"],
      allow_all: false,
      allowed_commands: { bash: ["git status"] },
    }));
    const loaded = await loadPermissions();
    expect(loaded?.always_allowed).toEqual(["read_file"]);
    expect(loaded?.rules).toBeUndefined(); // no rules — legacy format respected
  });

  test("non-string entries in rules are filtered out (typo defense)", async () => {
    const permPath = join(TEST_DIR, "permissions.json");
    await Bun.write(permPath, JSON.stringify({
      always_allowed: [],
      allow_all: false,
      rules: ["Bash(git log *)", 42, null, "Bash(gog *)"],
    }));
    const loaded = await loadPermissions();
    expect(loaded?.rules).toEqual(["Bash(git log *)", "Bash(gog *)"]);
  });
});
